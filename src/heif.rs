use std::{
    fs,
    io::{Read, Write},
    path::Path,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use heic_rs::{MatrixCoefficients, Nclx, PixelLayout, Range, context::Context as HeifContext};
use image::ImageEncoder;

use crate::{
    gallery::ImageRecord,
    media_runtime::{self, Tool},
};

const MAX_INPUT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PIXELS: u64 = 100_000_000;

pub(crate) fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("heic") || extension.eq_ignore_ascii_case("heif")
        })
}

fn read_source(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    ensure!(
        file.metadata()?.len() <= MAX_INPUT_BYTES,
        "HEIF file exceeds input limit"
    );
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_INPUT_BYTES,
        "HEIF file exceeds input limit"
    );
    Ok(bytes)
}

fn check_dimensions(width: u32, height: u32) -> Result<()> {
    ensure!(
        width > 0
            && height > 0
            && width <= 65536
            && height <= 65536
            && u64::from(width) * u64::from(height) <= MAX_PIXELS,
        "HEIF image exceeds decoding limits"
    );
    Ok(())
}

pub(crate) fn dimensions(path: &Path) -> Result<(u32, u32)> {
    let bytes = read_source(path)?;
    let info = heic_rs::probe(&bytes).context("cannot read HEIF primary image")?;
    check_dimensions(info.width, info.height)?;
    Ok((info.width, info.height))
}

// heic-rs 0.1.1 ignores HEVC VUI colour. Apple images often carry only an ICC
// profile in the container; treating their full-range BT.601 as limited-range
// BT.709 clips shadows. Use the embedded parser on the first primary tile.
// Pixel decoding, composition, transforms and JPEG encoding remain Rust.
fn coded_colour(ctx: &HeifContext<'_>, id: u32, directory: &Path) -> Result<Nclx> {
    let props = ctx.props(id)?;
    if let Some(nclx) = props.nclx {
        return Ok(nclx);
    }
    let hvcc = props
        .hvcc
        .as_ref()
        .context("HEIF image has no HEVC configuration")?;
    let data = ctx.item_data(id)?;
    let nals = hvcc.split_nals(&data)?;
    let mut input = tempfile::Builder::new()
        .prefix("colour-")
        .suffix(".hevc")
        .tempfile_in(directory)?;
    for nal in hvcc.parameter_sets().into_iter().chain(nals) {
        input.write_all(&[0, 0, 0, 1])?;
        input.write_all(nal)?;
    }
    input.flush()?;
    let mut command = media_runtime::command(Tool::Ffprobe)?;
    command.args(["-v", "error"]);
    crate::video::input_options(&mut command, input.path())?;
    command.args([
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=color_range,color_space",
        "-of",
        "json",
    ]);
    let output =
        crate::video::run_cancellable(&mut command, 64 * 1024, Duration::from_secs(30), &|| false)?;
    let metadata: serde_json::Value = serde_json::from_slice(&output)?;
    let stream = metadata["streams"]
        .as_array()
        .and_then(|streams| streams.first())
        .context("missing HEVC colour information")?;
    let matrix_code = match stream["color_space"].as_str() {
        Some("bt709") => 1,
        Some("fcc") => 4,
        Some("bt470bg") => 5,
        Some("smpte170m") => 6,
        Some("smpte240m") => 7,
        Some("bt2020nc") => 9,
        Some("gbr") => 0,
        _ => 6,
    };
    Ok(Nclx {
        matrix: MatrixCoefficients::from_code(matrix_code),
        matrix_code,
        range: if stream["color_range"] == "pc" {
            Range::Full
        } else {
            Range::Limited
        },
        ..Nclx::default()
    })
}

fn decode(bytes: &[u8], directory: &Path) -> Result<(heic_rs::Image, Option<Vec<u8>>)> {
    let info = heic_rs::probe(bytes)?;
    check_dimensions(info.width, info.height)?;
    let ctx = HeifContext::open(bytes)?;
    let primary = ctx.meta.primary;
    let props = ctx.props(primary)?;
    ensure!(
        ctx.meta.props.unknown_essential(primary).is_none(),
        "unsupported essential HEIF property"
    );
    let grid = ctx.grid(primary)?;
    let (width, height) = ctx.coded_size(primary, &props)?;
    check_dimensions(width, height)?;
    let ids = grid
        .as_ref()
        .map(|(_, ids)| ids.clone())
        .unwrap_or_else(|| vec![primary]);
    ensure!(
        !ids.is_empty() && ids.len() <= 4096,
        "invalid HEIF tile count"
    );

    // Check coded dimensions before the decoder allocates any planes.
    let mut pixels = 0u64;
    for &id in &ids {
        let tile = ctx.props(id)?;
        ensure!(
            ctx.meta.props.unknown_essential(id).is_none(),
            "unsupported essential HEIF tile property"
        );
        let hvcc = tile.hvcc.context("HEIF tile has no HEVC configuration")?;
        let info = heic_rs::hevc::probe(&hvcc.parameter_sets())?;
        check_dimensions(info.width, info.height)?;
        pixels = pixels.saturating_add(u64::from(info.width) * u64::from(info.height));
        ensure!(pixels <= MAX_PIXELS, "HEIF tiles exceed decoding limits");
    }
    let colour = if let Some(colour) = props.nclx {
        colour
    } else {
        coded_colour(&ctx, ids[0], directory)?
    };
    let mut image = heic_rs::Image {
        width,
        height,
        layout: PixelLayout::Rgb8,
        data: vec![0; width as usize * height as usize * 3],
    };
    let mut tile_size = None;
    // Convert one tile at a time to keep memory bounded even for large photos.
    for (index, id) in ids.into_iter().enumerate() {
        let tile = ctx.props(id)?;
        let hvcc = tile.hvcc.context("HEIF tile has no HEVC configuration")?;
        let data = ctx.item_data(id)?;
        let frame = heic_rs::hevc::decode_still(&hvcc.parameter_sets(), &hvcc.split_nals(&data)?)?;
        let decoded =
            heic_rs::color::convert(&frame, None, colour, PixelLayout::Rgb8, MAX_PIXELS, Some(1))?;
        let size = *tile_size.get_or_insert((decoded.width, decoded.height));
        ensure!(
            size == (decoded.width, decoded.height),
            "HEIF tiles have inconsistent dimensions"
        );
        let (x, y) = if let Some((grid, _)) = &grid {
            (
                (index as u32 % grid.columns) * size.0,
                (index as u32 / grid.columns) * size.1,
            )
        } else {
            (0, 0)
        };
        ensure!(
            x < width && y < height,
            "HEIF tile lies outside primary image"
        );
        let copy_width = size.0.min(width - x) as usize * 3;
        for row in 0..size.1.min(height - y) as usize {
            let source = row * size.0 as usize * 3;
            let destination = ((y as usize + row) * width as usize + x as usize) * 3;
            image.data[destination..destination + copy_width]
                .copy_from_slice(&decoded.data[source..source + copy_width]);
        }
    }
    if let Some((grid, _)) = &grid {
        let (tw, th) = tile_size.context("HEIF grid has no tiles")?;
        ensure!(
            u64::from(tw) * u64::from(grid.columns) >= u64::from(width)
                && u64::from(th) * u64::from(grid.rows) >= u64::from(height),
            "HEIF grid does not cover primary image"
        );
    } else {
        ensure!(
            tile_size == Some((width, height)),
            "HEIF coded dimensions disagree with primary image"
        );
    }
    let image = heic_rs::transform::apply_all(image, &props.transforms)?;
    ensure!(
        (image.width, image.height) == (info.width, info.height),
        "HEIF transformed dimensions disagree"
    );
    Ok((image, props.icc.map(<[u8]>::to_vec)))
}

// Only derived JPEGs enter the cache. Original HEIF and paired MOV are untouched.
pub(crate) fn prepare_display(record: &ImageRecord, output: &Path) -> Result<()> {
    record.ensure_source_is_current()?;
    if image::image_dimensions(output).ok() == Some((record.width, record.height)) {
        return Ok(());
    }
    let parent = output.parent().context("invalid HEIF cache path")?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::Builder::new()
        .prefix(".heif-")
        .tempdir_in(parent)?;
    let bytes = read_source(&record.path)?;
    let (decoded, icc) =
        decode(&bytes, temporary.path()).context("cannot decode HEIF primary image")?;
    ensure!(
        (decoded.width, decoded.height) == (record.width, record.height),
        "HEIF changed since the gallery scan"
    );
    let decoded_path = temporary.path().join("display.jpg");
    let mut file = fs::File::create(&decoded_path)?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 95);
    if let Some(icc) = icc {
        encoder.set_icc_profile(icc)?;
    }
    encoder.encode(
        &decoded.data,
        decoded.width,
        decoded.height,
        image::ExtendedColorType::Rgb8,
    )?;
    file.sync_all()?;
    drop(file);
    record.ensure_source_is_current()?;
    fs::rename(decoded_path, output).context("cannot store HEIF display image")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiled_primary_image_decodes_in_rust_without_heif_tools() {
        let bytes = include_bytes!("../frontend/scripts/fixtures/live-photo.heic");
        let temporary = tempfile::tempdir().unwrap();
        let (image, _) = decode(bytes, temporary.path()).unwrap();
        assert_eq!((image.width, image.height), (120, 90));
        assert_eq!(image.data.len(), 120 * 90 * 3);
        assert!(image.data.iter().any(|&value| value > 100));
        assert!(decode(b"incomplete HEIF", temporary.path()).is_err());
    }

    #[test]
    fn unreasonable_dimensions_are_rejected_before_decoding() {
        assert!(check_dimensions(0, 1).is_err());
        assert!(check_dimensions(65536, 65536).is_err());
        assert!(check_dimensions(12000, 9000).is_err());
    }

    #[test]
    fn codec_colour_is_used_when_container_colour_is_missing() {
        // Same grid and HEVC samples, with only the NCLX property associations
        // removed. Ignoring VUI changes the contrast and clips the dark pixels.
        let original = include_bytes!("../frontend/scripts/fixtures/live-photo.heic");
        let no_nclx = include_bytes!("../frontend/scripts/fixtures/heif-vui.heic");
        let context = HeifContext::open(no_nclx).unwrap();
        assert!(context.props(context.meta.primary).unwrap().nclx.is_none());
        let temporary = tempfile::tempdir().unwrap();
        let expected = decode(original, temporary.path()).unwrap().0;
        let actual = decode(no_nclx, temporary.path()).unwrap().0;
        assert_eq!(actual, expected);
    }
}
