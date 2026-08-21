use std::{cmp::Reverse, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower::ServiceExt;
use tower_http::{compression::CompressionLayer, services::ServeFile, trace::TraceLayer};
use tracing::error;

use crate::{
    gallery::{Album, GalleryIndex, ImageRecord},
    thumbs::{ThumbnailManager, ThumbnailStatus, ViewerPreviewManager},
};

const INDEX_HTML: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/frontend/dist/index.html"
));
const APP_JS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/frontend/dist/assets/app.js"
));
const APP_CSS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/frontend/dist/assets/app.css"
));

#[derive(Clone)]
pub struct AppState {
    pub index: Arc<RwLock<GalleryIndex>>,
    pub thumbnails: Arc<ThumbnailManager>,
    pub previews: Arc<ViewerPreviewManager>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImagesQuery {
    album: Option<String>,
    search: Option<String>,
    sort: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GallerySummary {
    total: usize,
    albums: Vec<Album>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImagesResponse {
    items: Vec<ImageView>,
    total: usize,
    offset: usize,
    limit: usize,
    next_offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageView {
    id: String,
    name: String,
    album: String,
    relative_path: String,
    width: u32,
    height: u32,
    size: u64,
    modified_ms: u64,
    thumbnail_url: String,
    preview_url: String,
    original_url: String,
}

impl From<&ImageRecord> for ImageView {
    fn from(record: &ImageRecord) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            album: record.album.clone(),
            relative_path: record.relative_path.clone(),
            width: record.width,
            height: record.height,
            size: record.size,
            modified_ms: record.modified_ms,
            thumbnail_url: format!("/api/images/{}/thumbnail", record.id),
            preview_url: format!("/api/images/{}/preview", record.id),
            original_url: format!("/api/images/{}/original", record.id),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/gallery", get(gallery_summary))
        .route("/api/images", get(images))
        .route("/api/status", get(thumbnail_status))
        .route("/api/images/{id}/thumbnail", get(thumbnail))
        .route("/api/images/{id}/preview", get(preview))
        .route("/api/images/{id}/original", get(original))
        .route("/assets/app.js", get(app_js))
        .route("/assets/app.css", get(app_css))
        .fallback(frontend)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn gallery_summary(State(state): State<AppState>) -> Json<GallerySummary> {
    let index = state.index.read().await;
    Json(GallerySummary {
        total: index.images.len(),
        albums: index.albums.clone(),
    })
}

async fn images(
    State(state): State<AppState>,
    Query(query): Query<ImagesQuery>,
) -> Json<ImagesResponse> {
    let index = state.index.read().await;
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|search| !search.is_empty())
        .map(str::to_lowercase);
    let album = query.album.as_deref().filter(|album| !album.is_empty());

    let mut matches: Vec<&Arc<ImageRecord>> = index
        .images
        .iter()
        .filter(|record| album.is_none_or(|album| record.album == album))
        .filter(|record| {
            search
                .as_ref()
                .is_none_or(|search| record.relative_path.to_lowercase().contains(search))
        })
        .collect();

    match query.sort.as_deref() {
        Some("name-desc") => matches.reverse(),
        Some("newest") => matches.sort_by_key(|record| Reverse(record.modified_ms)),
        _ => {}
    }

    let total = matches.len();
    let offset = query.offset.unwrap_or(0).min(total);
    let limit = query.limit.unwrap_or(60).clamp(1, 200);
    let end = offset.saturating_add(limit).min(total);
    let items = matches[offset..end]
        .iter()
        .map(|record| ImageView::from(record.as_ref()))
        .collect();

    Json(ImagesResponse {
        items,
        total,
        offset,
        limit,
        next_offset: (end < total).then_some(end),
    })
}

async fn thumbnail_status(State(state): State<AppState>) -> Json<ThumbnailStatus> {
    Json(state.thumbnails.status())
}

async fn thumbnail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    if state.index.read().await.get(&id).is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    let path = state.thumbnails.ensure_ready(&id).await.map_err(|error| {
        error!(%id, %error, "cannot serve thumbnail");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    serve_file(
        path,
        request,
        &format!("\"thumb-{id}\""),
        "public, max-age=31536000, immutable",
    )
    .await
}

async fn preview(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    if state.index.read().await.get(&id).is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    let path = state.previews.ensure_ready(&id).await.map_err(|error| {
        error!(%id, %error, "cannot serve viewer preview");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    serve_file(
        path,
        request,
        &format!("\"preview-{id}\""),
        "public, max-age=31536000, immutable",
    )
    .await
}

async fn original(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    let record = state
        .index
        .read()
        .await
        .get(&id)
        .ok_or(StatusCode::NOT_FOUND)?;
    serve_file(
        record.path.clone(),
        request,
        &format!("\"image-{id}\""),
        "private, max-age=3600",
    )
    .await
}

async fn serve_file(
    path: std::path::PathBuf,
    request: Request,
    etag: &str,
    cache_control: &'static str,
) -> Result<Response, StatusCode> {
    if request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(etag)
    {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        add_cache_headers(&mut response, etag, cache_control)?;
        return Ok(response);
    }

    let response = ServeFile::new(path)
        .oneshot(request)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (parts, body) = response.into_parts();
    let mut response = Response::from_parts(parts, Body::new(body));
    add_cache_headers(&mut response, etag, cache_control)?;
    Ok(response)
}

fn add_cache_headers(
    response: &mut Response,
    etag: &str,
    cache_control: &'static str,
) -> Result<(), StatusCode> {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(etag).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(())
}

async fn app_js() -> Response {
    embedded(APP_JS, "text/javascript; charset=utf-8", true)
}

async fn app_css() -> Response {
    embedded(APP_CSS, "text/css; charset=utf-8", true)
}

async fn frontend(request: Request) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    embedded(INDEX_HTML, "text/html; charset=utf-8", false)
}

fn embedded(content: &'static [u8], content_type: &'static str, immutable: bool) -> Response {
    let mut response = Response::new(Body::from(content));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_view_uses_versioned_id_urls() {
        let record = ImageRecord {
            id: "abc".into(),
            path: "photo.jpg".into(),
            relative_path: "album/photo.jpg".into(),
            name: "photo.jpg".into(),
            album: "album".into(),
            width: 10,
            height: 20,
            size: 30,
            modified_ms: 40,
            modified_ns: 40,
        };
        let view = ImageView::from(&record);
        assert_eq!(view.thumbnail_url, "/api/images/abc/thumbnail");
        assert_eq!(view.preview_url, "/api/images/abc/preview");
        assert_eq!(view.original_url, "/api/images/abc/original");
    }
}
