use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Request},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use tracing::error;

use super::{ImageView, serve_file};
use crate::{gallery::ImageRecord, management::sharing::ReadState};

/// Bare IDs return metadata; IDs with the source extension serve the file.
/// Resolve through the visibility-filtered index, never through a supplied path.
pub(super) async fn image(
    ReadState(state): ReadState,
    Path(filename): Path<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    let (id, extension) = filename
        .split_once('.')
        .map_or((filename.as_str(), None), |(id, extension)| {
            (id, Some(extension))
        });
    let image = state
        .index
        .read()
        .await
        .image(id)
        .cloned()
        .ok_or(StatusCode::NOT_FOUND)?;
    let Some(extension) = extension else {
        return Ok(Json(ImageView::from(image.as_ref())).into_response());
    };
    if !image
        .path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|actual| actual.eq_ignore_ascii_case(extension))
    {
        return Err(StatusCode::NOT_FOUND);
    }
    serve_original(image, request).await
}

// Keep existing bookmarks and integrations working.
pub(super) async fn original(
    ReadState(state): ReadState,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    let image = state
        .index
        .read()
        .await
        .image(&id)
        .cloned()
        .ok_or(StatusCode::NOT_FOUND)?;
    serve_original(image, request).await
}

async fn serve_original(image: Arc<ImageRecord>, request: Request) -> Result<Response, StatusCode> {
    let metadata = match tokio::fs::metadata(&image.path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(StatusCode::NOT_FOUND);
        }
        Err(error) => {
            error!(path = %image.path.display(), %error, "无法读取原图文件信息");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    if !image.matches_metadata(&metadata) {
        return Err(StatusCode::NOT_FOUND);
    }

    let mut response = serve_file(
        image.path.clone(),
        request,
        &format!("\"original-{}\"", image.id),
        "public, max-age=31536000, immutable",
    )
    .await?;
    if image.video.is_some()
        && let Some(mime) = crate::video::mime_type(&image.path)
    {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    }
    Ok(response)
}
