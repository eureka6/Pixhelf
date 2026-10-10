use std::{
    io::{Cursor, Write},
    path::Path,
    sync::Arc,
};

use anyhow::{Context, Result, bail, ensure};
use axum::{
    body::Bytes,
    extract::{Query, State},
    response::Response,
};
use serde::Deserialize;
use serde_json::json;

use super::{Failure, Management, files, private_json};
use crate::gallery::scan_gallery;

pub(super) const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UploadQuery {
    name: String,
    #[serde(default)]
    destination: String,
}

pub(super) async fn save(
    State(store): State<Arc<Management>>,
    Query(query): Query<UploadQuery>,
    bytes: Bytes,
) -> Result<Response, Failure> {
    validate(&query, bytes.len())?;
    let updates = store.updates.clone().lock_owned().await;
    let mut index = store.app.index.clone().write_owned().await;
    let thumbnails = store.app.thumbnails.clone();
    let path = tokio::task::spawn_blocking(move || -> Result<String> {
        let _updates = updates;
        let root = index.root.clone();
        let directory = files::gallery_path(&root, &query.destination, false)?;
        ensure!(directory.is_dir(), "上传目录不存在，请重新选择");
        let extension = Path::new(&query.name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        ensure!(
            matches!(
                extension.as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "gif" | "heic" | "heif"
            ),
            "请选择 JPG、PNG、WebP、GIF 或 HEIC 图片"
        );
        // An unrecognized suffix keeps incomplete uploads out of background scans.
        let mut temporary = tempfile::Builder::new()
            .prefix(".pixhelf-upload-")
            .suffix(".tmp")
            .tempfile_in(&directory)?;
        temporary.write_all(&bytes).context("无法写入图片")?;
        // Downloads can have a different suffix from their encoded format. Validate
        // the actual image, then normalize its name without re-encoding the original.
        let detected_extension = match image::guess_format(&bytes) {
            Ok(
                format @ (image::ImageFormat::Jpeg
                | image::ImageFormat::Png
                | image::ImageFormat::WebP
                | image::ImageFormat::Gif),
            ) => {
                let mut reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(32768);
                limits.max_image_height = Some(32768);
                limits.max_alloc = Some(256 * 1024 * 1024);
                reader.limits(limits);
                reader.decode().context("图片损坏或尺寸过大，无法上传")?;
                format.extensions_str()[0]
            }
            Ok(_) => bail!("暂不支持这张图片的实际格式，请选择 JPG、PNG、WebP、GIF 或 HEIC 图片"),
            Err(_) => {
                crate::heif::dimensions(temporary.path())
                    .context("无法识别图片内容，请检查文件是否完整")?;
                "heic"
            }
        };
        let matching_extension = extension == detected_extension
            || (detected_extension == "jpg" && extension == "jpeg")
            || (detected_extension == "heic" && extension == "heif");
        let name = if matching_extension {
            query.name
        } else {
            Path::new(&query.name)
                .with_extension(detected_extension)
                .to_string_lossy()
                .into_owned()
        };
        ensure!(name.len() <= 255, "图片文件名过长，请缩短后重试");
        let relative = if query.destination.is_empty() {
            name
        } else {
            format!("{}/{}", query.destination, name)
        };
        let target = files::gallery_path(&root, &relative, true)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(&target)
            .map_err(|error| anyhow::Error::from(error.error))?;
        let updated =
            scan_gallery(&root, Some(&index)).context("图片已保存，但图库刷新失败，请刷新查看")?;
        thumbnails.reconcile(&updated.images);
        thumbnails.start_similarity_warmup();
        *index = Arc::new(updated);
        Ok(relative)
    })
    .await
    .context("上传中断，请刷新图库查看结果")??;
    Ok(private_json(json!({ "path": path })))
}

fn validate(query: &UploadQuery, size: usize) -> Result<()> {
    ensure!(
        !query.name.is_empty()
            && query.name.len() <= 255
            && query.name == query.name.trim()
            && !query.name.starts_with('.')
            && !query.name.contains(['/', '\\'])
            && !query.name.chars().any(char::is_control),
        "图片文件名无效"
    );
    ensure!(query.destination.len() <= 4096, "上传目录无效");
    ensure!(
        size > 0 && size <= MAX_UPLOAD_BYTES,
        "每张图片需大于 0 字节且不超过 50 MB"
    );
    Ok(())
}
