use anyhow::Context;
use image::{
    DynamicImage, ImageDecoder, ImageReader, codecs::webp::WebPEncoder, metadata::Orientation,
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub const SIZE: u32 = 720;
const CACHE_VERSION: u8 = 2;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
const TRIM_THRESHOLD_BYTES: u64 = 64 * 1024 * 1024;

struct AllocatorTrimGuard(bool);

impl Drop for AllocatorTrimGuard {
    fn drop(&mut self) {
        #[cfg(target_env = "gnu")]
        // Image decoding can briefly allocate hundreds of MiB. glibc may retain
        // that free heap indefinitely unless explicitly asked to release it.
        if self.0 {
            unsafe {
                libc::malloc_trim(0);
            }
        }
    }
}

fn path_key(relative_path: &Path) -> blake3::Hash {
    blake3::hash(relative_path.to_string_lossy().as_bytes())
}

pub fn cache_path(cache_dir: &Path, relative_path: &Path) -> PathBuf {
    cache_dir.join(format!(
        "{}-v{CACHE_VERSION}-{SIZE}.webp",
        path_key(relative_path).to_hex()
    ))
}

pub fn version(relative_path: &Path, modified: i64, bytes: u64) -> String {
    format!(
        "v{CACHE_VERSION}-{}-{modified:x}-{bytes:x}",
        path_key(relative_path).to_hex()
    )
}

fn swaps_dimensions(orientation: Orientation) -> bool {
    matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

pub fn dimensions(source: &Path) -> anyhow::Result<(u32, u32)> {
    let mut decoder = ImageReader::open(source)?
        .with_guessed_format()?
        .into_decoder()?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    Ok(if swaps_dimensions(orientation) {
        (height, width)
    } else {
        (width, height)
    })
}

pub fn is_fresh(source: &Path, dest: &Path) -> bool {
    let Ok(source_modified) = source.metadata().and_then(|metadata| metadata.modified()) else {
        return false;
    };
    let Ok(dest_modified) = dest.metadata().and_then(|metadata| metadata.modified()) else {
        return false;
    };
    dest_modified >= source_modified
}

pub fn create(source: &Path, dest: &Path) -> anyhow::Result<()> {
    if is_fresh(source, dest) {
        return Ok(());
    }
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    // Declared before the image buffers so this guard is dropped after them.
    let mut allocator_trim = AllocatorTrimGuard(false);
    let mut decoder = ImageReader::open(source)?
        .with_guessed_format()?
        .into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let decoded_bytes = u64::from(image.width())
        .saturating_mul(u64::from(image.height()))
        .saturating_mul(u64::from(image.color().bytes_per_pixel()));
    allocator_trim.0 = decoded_bytes >= TRIM_THRESHOLD_BYTES;
    let thumb = image.thumbnail(SIZE, SIZE).to_rgba8();
    let temp_id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let tmp = dest.with_extension(format!("{}-{temp_id}.tmp", std::process::id()));
    let file = std::fs::File::create(&tmp)?;
    let encoded = WebPEncoder::new_lossless(file)
        .encode(
            &thumb,
            thumb.width(),
            thumb.height(),
            image::ExtendedColorType::Rgba8,
        )
        .context("encode thumbnail");
    if let Err(error) = encoded {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&tmp, dest) {
        // Another request may have completed the same thumbnail first.
        if is_fresh(source, dest) {
            let _ = std::fs::remove_file(&tmp);
        } else {
            let _ = std::fs::remove_file(&tmp);
            return Err(error.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quarter_turn_orientations_swap_display_dimensions() {
        for orientation in [
            Orientation::Rotate90,
            Orientation::Rotate270,
            Orientation::Rotate90FlipH,
            Orientation::Rotate270FlipH,
        ] {
            assert!(swaps_dimensions(orientation));
        }
        for orientation in [
            Orientation::NoTransforms,
            Orientation::Rotate180,
            Orientation::FlipHorizontal,
            Orientation::FlipVertical,
        ] {
            assert!(!swaps_dimensions(orientation));
        }
    }

    #[test]
    fn cache_identity_includes_the_processing_version() {
        let path = Path::new("album/photo.jpg");
        assert!(version(path, 1, 2).starts_with("v2-"));
        assert!(
            cache_path(Path::new("thumbs"), path)
                .to_string_lossy()
                .contains("-v2-720.webp")
        );
    }
}
