use std::{fs, path::Path, process::Command, time::Duration};

use anyhow::{Context, Result, bail, ensure};

use crate::gallery::ImageRecord;

pub(crate) fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("heic") || extension.eq_ignore_ascii_case("heif")
        })
}

struct PrimaryImage {
    width: u32,
    height: u32,
    number: usize,
    count: usize,
}

fn run(command: &mut Command) -> Result<Vec<u8>> {
    crate::video::run_cancellable(command, 64 * 1024, Duration::from_secs(30), &|| false).context(
        "cannot read HEIC/HEIF; install libheif tools (heif-info and heif-dec/heif-convert)",
    )
}

fn primary_image(path: &Path) -> Result<PrimaryImage> {
    let output = run(Command::new("heif-info").arg(path.canonicalize()?))?;
    parse_info(std::str::from_utf8(&output).context("invalid HEIF metadata")?)
}

fn parse_info(info: &str) -> Result<PrimaryImage> {
    let mut primary = None;
    let mut count = 0;
    let mut pixels = 0u64;
    // heif-info enumerates top-level images in the same order as heif-dec.
    // Tiles, thumbnails and auxiliary gain maps must never become the cover.
    for image in info.lines().filter_map(|line| line.strip_prefix("image: ")) {
        count += 1;
        let dimensions = image
            .split_whitespace()
            .next()
            .context("missing HEIF dimensions")?;
        let (width, height) = dimensions
            .split_once('x')
            .context("invalid HEIF dimensions")?;
        let (width, height) = (width.parse::<u32>()?, height.parse::<u32>()?);
        ensure!(
            width > 0 && height > 0 && width <= 65536 && height <= 65536,
            "invalid HEIF dimensions"
        );
        pixels = pixels.saturating_add(u64::from(width) * u64::from(height));
        ensure!(
            count <= 32 && pixels <= 100_000_000,
            "HEIF image exceeds decoding limits"
        );
        if image.ends_with(", primary") {
            ensure!(primary.is_none(), "HEIF has multiple primary images");
            primary = Some(PrimaryImage {
                width,
                height,
                number: count,
                count: 0,
            });
        }
    }
    let mut primary = primary.context("HEIF has no primary image")?;
    primary.count = count;
    Ok(primary)
}

pub(crate) fn dimensions(path: &Path) -> Result<(u32, u32)> {
    let primary = primary_image(path)?;
    Ok((primary.width, primary.height))
}

// Only derived JPEGs enter the cache. Keep the original HEIF and paired MOV
// intact for downloads and management operations.
pub(crate) fn prepare_display(record: &ImageRecord, output: &Path) -> Result<()> {
    record.ensure_source_is_current()?;
    if image::image_dimensions(output).ok() == Some((record.width, record.height)) {
        return Ok(());
    }
    let primary = primary_image(&record.path)?;
    ensure!(
        (primary.width, primary.height) == (record.width, record.height),
        "HEIF changed since the gallery scan"
    );
    let parent = output.parent().context("invalid HEIF cache path")?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::Builder::new()
        .prefix(".heif-")
        .tempdir_in(parent)?;
    let decoded = temporary.path().join("display.jpg");
    let source = record.path.canonicalize()?;
    let decode = |program| {
        run(Command::new(program)
            .args(["--quiet", "-q", "95"])
            .arg(&source)
            .arg(&decoded))
    };
    // Older distributions (including Debian Bookworm) use the previous name.
    if let Err(error) = decode("heif-dec") {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            decode("heif-convert")?;
        } else {
            return Err(error);
        }
    }
    let decoded = if primary.count == 1 {
        decoded
    } else {
        temporary
            .path()
            .join(format!("display-{}.jpg", primary.number))
    };
    if image::image_dimensions(&decoded)? != (record.width, record.height) {
        bail!("HEIF decoder returned unexpected image dimensions");
    }
    record.ensure_source_is_current()?;
    fs::rename(decoded, output).context("cannot store HEIF display image")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_selects_the_primary_image_not_tiles_thumbnails_or_gain_maps() {
        let info = "MIME type: image/heic\nimage: 300x200 (id=2)\n  thumbnail: 32x24\nimage: 4032x3024 (id=49), primary\n  tiles: 8x6, tile size: 512x512\n  auxiliary image: 2016x1512\n";
        let image = parse_info(info).unwrap();
        assert_eq!(
            (image.width, image.height, image.number, image.count),
            (4032, 3024, 2, 2)
        );
        for invalid in [
            "",
            "image: 0x1 (id=1), primary",
            "image: 65536x65536 (id=1), primary",
            "image: 4x3 (id=1)",
            "image: 4x3 (id=1), primary\nimage: 4x3 (id=2), primary",
        ] {
            assert!(parse_info(invalid).is_err(), "{invalid}");
        }
    }
}
