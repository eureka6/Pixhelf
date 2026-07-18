use crate::db::Database;
use anyhow::Context;
use image::ImageReader;
use std::{path::Path, time::UNIX_EPOCH};
use walkdir::WalkDir;

pub fn scan(root: &Path, db: &Database) -> anyhow::Result<u64> {
    let mut count = 0;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(mime) = mime_guess::from_path(path).first() else {
            continue;
        };
        if mime.type_() != mime::IMAGE {
            continue;
        }
        let Ok(reader) = ImageReader::open(path) else {
            continue;
        };
        let Ok((width, height)) = reader.into_dimensions() else {
            continue;
        };
        let meta = entry.metadata().context("image metadata")?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
            .map(|v| v.as_secs() as i64)
            .unwrap_or(0);
        let relative = path.strip_prefix(root).context("relative image path")?;
        db.upsert(
            relative,
            entry.file_name().to_string_lossy().as_ref(),
            mime.as_ref(),
            width,
            height,
            meta.len(),
            modified,
        )?;
        count += 1;
    }
    tracing::info!(images = count, "scan complete");
    Ok(count)
}
