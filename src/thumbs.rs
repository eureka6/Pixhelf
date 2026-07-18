use anyhow::Context;
use image::{ImageReader, codecs::webp::WebPEncoder};
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

pub const SIZE: u32 = 720;
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

pub fn create(source: &Path, dest: &Path) -> anyhow::Result<()> {
    if dest.exists() {
        return Ok(());
    }
    // Declared before the image buffers so this guard is dropped after them.
    let mut allocator_trim = AllocatorTrimGuard(false);
    let image = ImageReader::open(source)?.with_guessed_format()?.decode()?;
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
    std::fs::rename(tmp, dest)?;
    Ok(())
}
