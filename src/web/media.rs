use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::{Path, Request},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use tracing::error;

use super::{
    cache::{is_not_modified, not_modified, with_cache_headers},
    models::ImageView,
};
use crate::{gallery::ImageRecord, management::sharing::ReadState, thumbs::ThumbnailError};
use tower::ServiceExt;
use tower_http::services::ServeFile;

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

pub(super) async fn thumbnail(
    ReadState(state): ReadState,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    if state.index.read().await.image(&id).is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    let path = match state.thumbnails.ensure_ready(&id).await {
        Ok(path) => path,
        Err(ThumbnailError::NotFound) => return Err(StatusCode::NOT_FOUND),
        Err(error) => {
            error!(%id, %error, "无法提供缩略图");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    serve_file(
        path,
        request,
        &format!("\"thumb-{id}\""),
        "public, max-age=31536000, immutable",
    )
    .await
}

pub(super) async fn display_image(
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
    if !crate::heif::is_image(&image.path) {
        return Err(StatusCode::NOT_FOUND);
    }
    let metadata = tokio::fs::metadata(&image.path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !image.matches_metadata(&metadata) {
        return Err(StatusCode::NOT_FOUND);
    }
    let thumbnail = state.thumbnails.ensure_ready(&id).await.map_err(|error| {
        error!(%id, %error, "无法提供 HEIF 预览");
        match error {
            ThumbnailError::NotFound => StatusCode::NOT_FOUND,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    })?;
    serve_file(
        thumbnail.with_extension("jpg"),
        request,
        &format!("\"heif-display-v1-{id}\""),
        "public, max-age=31536000, immutable",
    )
    .await
}

pub(super) async fn serve_file(
    path: std::path::PathBuf,
    mut request: Request,
    etag: &str,
    cache_control: &'static str,
) -> Result<Response, StatusCode> {
    if is_not_modified(request.headers(), etag) {
        return Ok(not_modified(etag, cache_control));
    }

    // ServeFile knows file dates but not our content-version ETags. Resolve ETag
    // If-Range here so seeking resumes only the representation the browser has.
    if let Some(validator) = request
        .headers()
        .get(header::IF_RANGE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.starts_with('"') || value.starts_with("W/"))
    {
        if validator != etag {
            request.headers_mut().remove(header::RANGE);
        }
        request.headers_mut().remove(header::IF_RANGE);
    }
    if request.method() != Method::GET {
        request.headers_mut().remove(header::RANGE);
    }

    let response = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (parts, body) = response.into_parts();
    Ok(with_cache_headers(
        Response::from_parts(parts, Body::new(body)),
        etag,
        cache_control,
    ))
}
