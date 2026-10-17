//! Prepared video and embedded live-photo byte-range responses.
use super::{
    cache::{is_not_modified, not_modified, with_cache_headers},
    media::serve_file,
};
use crate::management::sharing::ReadState;
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, Request},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::services::ServeFile;

#[derive(Default, Deserialize)]
pub(super) struct VideoQuery {
    #[serde(default)]
    status: bool,
    retry: Option<String>,
}

pub(super) async fn prepared_video(
    ReadState(state): ReadState,
    Path((id, version, kind)): Path<(String, String, String)>,
    Query(query): Query<VideoQuery>,
    request: Request,
) -> Result<Response, StatusCode> {
    use crate::video_jobs::{self, PreparedAsset, VideoKind};
    let kind = match kind.as_str() {
        "playback.mp4" => VideoKind::Playback,
        "preview.mp4" => VideoKind::Preview,
        _ => return Err(StatusCode::NOT_FOUND),
    };
    let record = {
        let index = state.index.read().await;
        index.image(&id).cloned().ok_or(StatusCode::NOT_FOUND)?
    };
    if video_jobs::version(&record).as_deref() != Some(&version) {
        return Err(StatusCode::NOT_FOUND);
    }
    let current = Arc::clone(&record);
    tokio::task::spawn_blocking(move || video_jobs::ensure_current(&current))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let asset = state
        .thumbnails
        .videos
        .request(&record, kind, query.retry.is_some())
        .ok_or(StatusCode::NOT_FOUND)?;
    let (status, phase) = match asset {
        PreparedAsset::Ready(path) if !query.status => {
            return serve_file(
                path,
                request,
                &format!("\"video-{version}-{}\"", kind.name()),
                "private, max-age=31536000, immutable",
            )
            .await;
        }
        PreparedAsset::Ready(_) => (StatusCode::OK, "ready"),
        PreparedAsset::Pending(phase) => (StatusCode::ACCEPTED, phase),
        PreparedAsset::Failed => (StatusCode::UNPROCESSABLE_ENTITY, "failed"),
    };
    let mut response = (status, Json(serde_json::json!({ "state": phase }))).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if status == StatusCode::ACCEPTED {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
    }
    Ok(response)
}

pub(super) async fn motion_video(
    ReadState(state): ReadState,
    Path((id, version)): Path<(String, String)>,
    mut request: Request,
) -> Result<Response, StatusCode> {
    let image = {
        let index = state.index.read().await;
        index.image(&id).cloned().ok_or(StatusCode::NOT_FOUND)?
    };
    let motion = image
        .motion
        .as_ref()
        .filter(|motion| motion.id == version)
        .ok_or(StatusCode::NOT_FOUND)?;
    let image_metadata = tokio::fs::metadata(&image.path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let video_metadata = tokio::fs::metadata(&motion.path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !image.matches_metadata(&image_metadata) || !motion.matches_metadata(&video_metadata) {
        return Err(StatusCode::NOT_FOUND);
    }
    // Let the browser reuse original bytes when a fresh decoder is needed or
    // the user returns to a previous photo. The versioned URL and this validator
    // are separate from retired previews and earlier uncacheable responses.
    let etag = format!("\"original-motion-v2-{version}\"");
    let cache_control = "private, max-age=31536000, immutable";
    if is_not_modified(request.headers(), &etag) {
        return Ok(not_modified(&etag, cache_control));
    }
    // ServeFile's date validator refers to the containing JPEG/MOV, not this
    // clip representation. Only the clip's own ETag can validate a response.
    request.headers_mut().remove(header::IF_NONE_MATCH);
    request.headers_mut().remove(header::IF_MODIFIED_SINCE);

    let range = if request.method() == Method::GET
        && request
            .headers()
            .get(header::IF_RANGE)
            .is_none_or(|value| value == etag.as_str())
    {
        request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
    } else {
        None
    };
    // Multipart ranges may be ignored. The browser uses single ranges to buffer and seek.
    let range = if let Some(range) = range.filter(|range| !range.contains(',')) {
        match http_range_header::parse_range_header(range)
            .and_then(|range| range.validate(motion.length))
        {
            Ok(ranges) => ranges.into_iter().next(),
            Err(_) => {
                let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    format!("bytes */{}", motion.length).parse().unwrap(),
                );
                return Ok(response);
            }
        }
    } else {
        None
    };
    let start = range.as_ref().map_or(0, |range| *range.start());
    let end = range
        .as_ref()
        .map_or(motion.length - 1, |range| *range.end());
    request.headers_mut().remove(header::IF_RANGE);
    request.headers_mut().insert(
        header::RANGE,
        format!("bytes={}-{}", motion.offset + start, motion.offset + end)
            .parse()
            .unwrap(),
    );
    // ServeFile streams the selected bytes, including when the clip is inside a JPEG.
    let response = ServeFile::new(&motion.path)
        .oneshot(request)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (parts, body) = response.into_parts();
    let mut response = Response::from_parts(parts, Body::new(body));
    if !response.status().is_success() {
        return Ok(response);
    }
    *response.status_mut() = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(motion.mime));
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if range.is_some() {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", motion.length)
                .parse()
                .unwrap(),
        );
    } else {
        response.headers_mut().remove(header::CONTENT_RANGE);
    }
    Ok(with_cache_headers(response, &etag, cache_control))
}
