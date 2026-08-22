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
    thumbs::{ThumbnailError, ThumbnailManager, ThumbnailStatus},
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
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImagesQuery {
    album: Option<String>,
    search: Option<String>,
    #[serde(default)]
    sort: ImageSort,
    seed: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ImageSort {
    #[default]
    NameAsc,
    NameDesc,
    Newest,
    Explore,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GallerySummary {
    total: usize,
    albums: Vec<Album>,
    revision: String,
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
        revision: index.revision.clone(),
    })
}

async fn images(
    State(state): State<AppState>,
    Query(query): Query<ImagesQuery>,
) -> Json<ImagesResponse> {
    let records = state.index.read().await.images.clone();
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|search| !search.is_empty())
        .map(str::to_lowercase);
    let album = query.album.as_deref().filter(|album| !album.is_empty());

    let mut matches: Vec<Arc<ImageRecord>> = records
        .into_iter()
        .filter(|record| album.is_none_or(|album| record.album == album))
        .filter(|record| {
            search
                .as_ref()
                .is_none_or(|search| record.relative_path.to_lowercase().contains(search))
        })
        .collect();

    match query.sort {
        ImageSort::NameAsc => {}
        ImageSort::NameDesc => matches.reverse(),
        ImageSort::Newest => matches.sort_by_key(|record| Reverse(record.modified_ms)),
        ImageSort::Explore => {
            let seed_key =
                *blake3::hash(query.seed.as_deref().unwrap_or_default().as_bytes()).as_bytes();
            matches.sort_by_cached_key(|record| exploration_rank(&seed_key, &record.id));
        }
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

fn exploration_rank(seed_key: &[u8; 32], image_id: &str) -> [u8; 32] {
    *blake3::keyed_hash(seed_key, image_id.as_bytes()).as_bytes()
}

async fn thumbnail_status(State(state): State<AppState>) -> Json<ThumbnailStatus> {
    Json(state.thumbnails.status())
}

async fn thumbnail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    let path = match state.thumbnails.ensure_ready(&id).await {
        Ok(path) => path,
        Err(ThumbnailError::NotFound) => return Err(StatusCode::NOT_FOUND),
        Err(error) => {
            error!(%id, %error, "cannot serve thumbnail");
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
    embedded(APP_JS, "text/javascript; charset=utf-8")
}

async fn app_css() -> Response {
    embedded(APP_CSS, "text/css; charset=utf-8")
}

async fn frontend(request: Request) -> Response {
    if request.uri().path() != "/" {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    embedded(INDEX_HTML, "text/html; charset=utf-8")
}

fn embedded(content: &'static [u8], content_type: &'static str) -> Response {
    let mut response = Response::new(Body::from(content));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_router() -> Router {
        let temp = tempfile::tempdir().unwrap();
        let thumbnails = ThumbnailManager::new(temp.path().to_owned()).unwrap();
        router(AppState {
            index: Arc::new(RwLock::new(GalleryIndex::default())),
            thumbnails,
        })
    }

    async fn request(path: &str) -> Response {
        empty_router()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

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
    }

    #[test]
    fn exploration_rank_is_stable_and_seeded() {
        let first_seed = *blake3::hash(b"first-queue").as_bytes();
        let second_seed = *blake3::hash(b"second-queue").as_bytes();

        assert_eq!(
            exploration_rank(&first_seed, "image-1"),
            exploration_rank(&first_seed, "image-1")
        );
        assert_ne!(
            exploration_rank(&first_seed, "image-1"),
            exploration_rank(&second_seed, "image-1")
        );
        assert_ne!(
            exploration_rank(&first_seed, "image-1"),
            exploration_rank(&first_seed, "image-2")
        );
    }

    #[tokio::test]
    async fn rejects_unknown_sort_modes() {
        assert_eq!(
            request("/api/images?sort=name-asc").await.status(),
            StatusCode::OK
        );
        assert_eq!(
            request("/api/images?sort=explore&seed=test").await.status(),
            StatusCode::OK
        );
        assert_eq!(
            request("/api/images?sort=unexpected").await.status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn unknown_api_and_thumbnail_routes_return_not_found() {
        assert_eq!(
            request("/api/does-not-exist").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request("/api/images/missing/thumbnail").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(request("/missing").await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn fixed_asset_names_are_revalidated() {
        let response = request("/assets/app.js").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
    }
}
