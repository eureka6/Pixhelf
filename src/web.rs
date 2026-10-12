pub(crate) mod duplicates;
mod media;
pub(crate) mod pagination;
mod readiness;

use std::sync::{Arc, Mutex, OnceLock};

use pagination::{finish_page, image_page};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, Request},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, Semaphore};
use tower::ServiceExt;
use tower_http::{
    compression::{CompressionLayer, CompressionLevel},
    services::ServeFile,
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use tracing::error;

use crate::{
    assets,
    auth::{self, AuthConfig, AuthState, AuthView},
    gallery::{Album, GalleryIndex, ImageRecord},
    management::sharing::ReadState,
    photo_details::PhotoDetails,
    similarity::{
        DiversityFingerprint, ImageSignature, MIN_SIMILARITY_SCORE, redundancy_score,
        signature_for_thumbnail, signature_for_upload, similarity_score,
    },
    support::{BoundedCache, mutex_lock},
    text_search::{TextSearchEmbedding, text_image_similarity},
    thumbs::{ThumbnailError, ThumbnailManager, ThumbnailStatus},
};

const INDEX_HTML: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/frontend/dist/index.html"
));
const APP_CSS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/frontend/dist/assets/app.css"
));
const ASSET_VERSION: &str = env!("PIXHELF_ASSET_VERSION");
const DEFAULT_PAGE_SIZE: usize = 60;
const MAX_PAGE_SIZE: usize = 200;
const DIVERSIFIED_SIMILARITY_RESULTS: usize = 120;
const REDUNDANCY_PENALTY_START: f32 = 0.86;
const MAX_REDUNDANCY_PENALTY: f32 = 0.08;
const SIMILARITY_RANKING_CACHE_LIMIT: usize = 8;
const TEXT_SEARCH_RANKING_CACHE_LIMIT: usize = 16;
const TEXT_SEARCH_RESULT_LIMIT: usize = 600;
const FILENAME_MATCH_BOOST: f32 = 3.0;
const MAX_QUERY_VALUE_BYTES: usize = 4096;
const PHOTO_DETAILS_CACHE_LIMIT: usize = 64;
const MAX_SEARCH_UPLOAD_BYTES: usize = 20 * 1024 * 1024;

static SIMILARITY_LIMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();
type SimilarityRanking = Arc<Vec<Arc<ImageRecord>>>;
type SimilarityRankingCache = Mutex<BoundedCache<SimilarityRanking>>;
static SIMILARITY_RANKING_CACHE: OnceLock<SimilarityRankingCache> = OnceLock::new();
type TextSearchRanking = Arc<Vec<Arc<ImageRecord>>>;
type TextSearchRankingCache = Mutex<BoundedCache<TextSearchRanking>>;
static TEXT_SEARCH_RANKING_CACHE: OnceLock<TextSearchRankingCache> = OnceLock::new();
type PhotoDetailsCache = Mutex<BoundedCache<Arc<PhotoDetails>>>;
static PHOTO_DETAILS_CACHE: OnceLock<PhotoDetailsCache> = OnceLock::new();

fn similarity_limit() -> Arc<Semaphore> {
    Arc::clone(SIMILARITY_LIMIT.get_or_init(|| Arc::new(Semaphore::new(1))))
}

fn similarity_ranking_cache() -> &'static SimilarityRankingCache {
    SIMILARITY_RANKING_CACHE
        .get_or_init(|| Mutex::new(BoundedCache::new(SIMILARITY_RANKING_CACHE_LIMIT)))
}

fn cached_similarity_ranking(key: &str) -> Option<SimilarityRanking> {
    mutex_lock(similarity_ranking_cache()).get_cloned(key)
}

fn cache_similarity_ranking(key: String, ranking: SimilarityRanking) {
    mutex_lock(similarity_ranking_cache()).insert(key, ranking);
}

fn text_search_ranking_cache() -> &'static TextSearchRankingCache {
    TEXT_SEARCH_RANKING_CACHE
        .get_or_init(|| Mutex::new(BoundedCache::new(TEXT_SEARCH_RANKING_CACHE_LIMIT)))
}

fn cached_text_search_ranking(key: &str) -> Option<TextSearchRanking> {
    mutex_lock(text_search_ranking_cache()).get_cloned(key)
}

fn cache_text_search_ranking(key: String, ranking: TextSearchRanking) {
    mutex_lock(text_search_ranking_cache()).insert(key, ranking);
}

fn photo_details_cache() -> &'static PhotoDetailsCache {
    PHOTO_DETAILS_CACHE.get_or_init(|| Mutex::new(BoundedCache::new(PHOTO_DETAILS_CACHE_LIMIT)))
}

fn cached_photo_details(key: &str) -> Option<Arc<PhotoDetails>> {
    mutex_lock(photo_details_cache()).get_cloned(key)
}

fn cache_photo_details(key: String, details: Arc<PhotoDetails>) {
    mutex_lock(photo_details_cache()).insert(key, details);
}

#[derive(Clone)]
pub struct AppState {
    pub index: Arc<RwLock<Arc<GalleryIndex>>>,
    pub thumbnails: Arc<ThumbnailManager>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagesQuery {
    album: Option<String>,
    search: Option<String>,
    #[serde(default)]
    kind: ImageKind,
    #[serde(default)]
    orientation: ImageOrientation,
    #[serde(default)]
    sort: ImageSort,
    seed: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
struct SimilarImagesQuery {
    offset: Option<usize>,
    limit: Option<usize>,
    exclude: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct SimilarImagesRequest {
    offset: usize,
    limit: usize,
}

impl SimilarImagesQuery {
    fn normalize(self) -> SimilarImagesRequest {
        SimilarImagesRequest {
            offset: self.offset.unwrap_or(0),
            limit: self
                .limit
                .unwrap_or(DEFAULT_PAGE_SIZE)
                .clamp(1, MAX_PAGE_SIZE),
        }
    }
}

#[derive(Debug)]
pub(crate) struct ImageRequest {
    album: Option<String>,
    search: Option<String>,
    kind: ImageKind,
    orientation: ImageOrientation,
    sort: ImageSort,
    seed: String,
    offset: usize,
    limit: usize,
}

impl ImagesQuery {
    pub(crate) fn normalize(self) -> Result<ImageRequest, StatusCode> {
        if [&self.album, &self.search, &self.seed]
            .into_iter()
            .flatten()
            .any(|value| value.len() > MAX_QUERY_VALUE_BYTES)
        {
            return Err(StatusCode::BAD_REQUEST);
        }

        Ok(ImageRequest {
            album: self.album.filter(|album| !album.is_empty()),
            search: self
                .search
                .as_deref()
                .map(str::trim)
                .filter(|search| !search.is_empty())
                .map(str::to_lowercase),
            kind: self.kind,
            orientation: self.orientation,
            sort: self.sort,
            seed: self.seed.unwrap_or_default(),
            offset: self.offset.unwrap_or(0),
            limit: self
                .limit
                .unwrap_or(DEFAULT_PAGE_SIZE)
                .clamp(1, MAX_PAGE_SIZE),
        })
    }
}

impl Default for ImageRequest {
    fn default() -> Self {
        Self {
            album: None,
            search: None,
            kind: ImageKind::default(),
            orientation: ImageOrientation::default(),
            sort: ImageSort::default(),
            seed: String::new(),
            offset: 0,
            limit: DEFAULT_PAGE_SIZE,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[repr(u8)]
#[serde(rename_all = "kebab-case")]
enum ImageSort {
    #[default]
    Default,
    NameAsc,
    NameDesc,
    Newest,
    Oldest,
    Explore,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[repr(u8)]
#[serde(rename_all = "kebab-case")]
enum ImageKind {
    #[default]
    All,
    Photo,
    Live,
    Video,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[repr(u8)]
#[serde(rename_all = "kebab-case")]
enum ImageOrientation {
    #[default]
    All,
    Landscape,
    Portrait,
    Square,
}

impl ImageRequest {
    fn matches_filters(&self, record: &ImageRecord) -> bool {
        let kind = match self.kind {
            ImageKind::All => true,
            ImageKind::Photo => record.video.is_none() && !record.is_live(),
            ImageKind::Live => record.is_live(),
            ImageKind::Video => record.video.is_some(),
        };
        let orientation = match self.orientation {
            ImageOrientation::All => true,
            ImageOrientation::Landscape => record.width > record.height,
            ImageOrientation::Portrait => record.width < record.height,
            ImageOrientation::Square => record.width == record.height,
        };
        kind && orientation
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GallerySummary {
    total: usize,
    albums: Vec<Album>,
    revision: String,
    initializing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagesResponse {
    items: Vec<ImageView>,
    total: usize,
    offset: usize,
    limit: usize,
    next_offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageView {
    id: String,
    name: String,
    width: u32,
    height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    motion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    video: Option<crate::video::VideoMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    playback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display: Option<String>,
}

impl From<&ImageRecord> for ImageView {
    fn from(record: &ImageRecord) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            width: record.width,
            height: record.height,
            display: crate::heif::is_image(&record.path)
                .then(|| format!("/api/images/{}/display", record.id)),
            video: record.video.clone(),
            playback: crate::video_jobs::url(record, crate::video_jobs::VideoKind::Playback),
            preview: crate::video_jobs::url(record, crate::video_jobs::VideoKind::Preview),
            motion: record
                .motion
                .as_ref()
                .map(|motion| format!("/api/images/{}/motion/original/{}", record.id, motion.id)),
        }
    }
}

#[derive(Serialize)]
struct BootstrapResponse {
    summary: GallerySummary,
    status: ThumbnailStatus,
    images: ImagesResponse,
}

pub fn router(state: AppState, config: AuthConfig) -> Router {
    let storage = crate::storage::router(state.thumbnails.settings_directory());
    let management = crate::management::router(state.clone());
    let authentication = AuthState::new(config);
    let session_layer = authentication.session_layer();
    let protected = Router::new()
        .route("/api/gallery", get(gallery_summary))
        .route("/api/categories", get(crate::management::categories::read))
        .route("/api/images", get(images))
        .route("/api/images/duplicates", get(duplicates::images))
        .route("/api/images/{id}", get(media::image))
        .route(
            "/api/images/similar",
            post(uploaded_similar_images).layer(DefaultBodyLimit::max(MAX_SEARCH_UPLOAD_BYTES)),
        )
        .route("/api/images/{id}/details", get(image_details))
        .route("/api/images/{id}/similar", get(similar_images))
        .route("/api/status", get(thumbnail_status))
        .route("/api/images/{id}/thumbnail", get(thumbnail))
        .route("/api/images/{id}/original", get(media::original))
        .route("/api/images/{id}/display", get(display_image))
        .route(
            "/api/images/{id}/video/{version}/{kind}",
            get(prepared_video),
        )
        .route(
            "/api/images/{id}/motion/original/{version}",
            get(motion_video),
        )
        .fallback(frontend)
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            readiness::require_ready,
        ))
        .layer(middleware::from_fn_with_state(
            authentication.clone(),
            auth::require_auth,
        ));
    let application = protected
        .merge(
            management
                .layer(middleware::from_fn_with_state(
                    state,
                    readiness::require_ready,
                ))
                .layer(middleware::from_fn_with_state(
                    authentication.clone(),
                    auth::require_admin,
                )),
        )
        .merge(storage.layer(middleware::from_fn_with_state(
            authentication.clone(),
            auth::require_admin,
        )))
        .merge(auth::router(authentication.clone()))
        .layer(middleware::from_fn(auth::session_cookie_security))
        .layer(session_layer);
    Router::new()
        .route("/api/health", get(health))
        .route("/assets/{version}/{*path}", get(frontend_asset))
        .merge(application)
        .layer(middleware::from_fn(auth::response_security))
        .layer(CompressionLayer::new().quality(CompressionLevel::Precise(5)))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(TraceLayer::new_for_http())
}

async fn health() -> &'static str {
    "ok"
}

async fn gallery_summary(ReadState(state): ReadState, headers: HeaderMap) -> Response {
    let index = state.index.read().await;
    let etag = revision_etag("gallery-previews-v1", &index.revision);
    if is_not_modified(&headers, &etag) {
        return not_modified(&etag, "private, no-cache");
    }

    with_cache_headers(
        Json(summary_from_index(&index)).into_response(),
        &etag,
        "private, no-cache",
    )
}

fn summary_from_index(index: &GalleryIndex) -> GallerySummary {
    GallerySummary {
        total: index.images.len(),
        albums: index.albums.clone(),
        revision: index.revision.clone(),
        initializing: index.initializing,
    }
}

async fn images(
    ReadState(state): ReadState,
    Query(query): Query<ImagesQuery>,
    headers: HeaderMap,
) -> Response {
    let query = match query.normalize() {
        Ok(query) => query,
        Err(status) => return status.into_response(),
    };
    let index = {
        let index = state.index.read().await;
        Arc::clone(&index)
    };
    let status = state.thumbnails.status();
    let text_search_active = query.search.is_some()
        && status.background_complete
        && status.text_search.enabled
        && status.text_search.background_complete
        && status.text_search.ready > 0;
    let text_search_token = text_search_active.then(|| state.thumbnails.text_search_cache_token());
    let etag = images_etag(&index.revision, &query, text_search_token.as_deref());
    if is_not_modified(&headers, &etag) {
        return not_modified(&etag, "private, no-cache");
    }

    if text_search_active && let Some(search) = query.search.as_deref() {
        let ranking_key = text_search_ranking_key(
            &index.revision,
            &query,
            search,
            text_search_token.as_deref().unwrap_or("off"),
        );
        if let Some(ranking) = cached_text_search_ranking(&ranking_key) {
            return with_cache_headers(
                Json(text_search_image_page(&ranking, &query)).into_response(),
                &etag,
                "private, no-cache",
            );
        }

        match state.thumbnails.text_query_embedding(search).await {
            Ok(Some(query_embedding)) => {
                let candidates = index
                    .images
                    .iter()
                    .filter(|record| {
                        query
                            .album
                            .as_deref()
                            .is_none_or(|album| record.belongs_to_album(album))
                            && query.matches_filters(record)
                    })
                    .filter_map(|record| {
                        let embedding = state.thumbnails.text_search_embedding(&record.id);
                        let filename_match = record.search_key.contains(search);
                        (embedding.is_some() || filename_match)
                            .then(|| (Arc::clone(record), embedding, filename_match))
                    })
                    .collect::<Vec<_>>();
                let ranking = match tokio::task::spawn_blocking(move || {
                    rank_text_search(query_embedding, candidates)
                })
                .await
                {
                    Ok(ranking) => Arc::new(ranking),
                    Err(error) => {
                        error!(%error, "文字搜图排序任务中断");
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                };
                cache_text_search_ranking(ranking_key, Arc::clone(&ranking));
                return with_cache_headers(
                    Json(text_search_image_page(&ranking, &query)).into_response(),
                    &etag,
                    "private, no-cache",
                );
            }
            Ok(None) => {}
            Err(error) => {
                error!(%error, "文字搜图查询失败，改用文件名搜索");
                let mut response = Json(image_page(&index, &query)).into_response();
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                return response;
            }
        }
    }

    with_cache_headers(
        Json(image_page(&index, &query)).into_response(),
        &etag,
        "private, no-cache",
    )
}

async fn uploaded_similar_images(
    ReadState(state): ReadState,
    Query(query): Query<SimilarImagesQuery>,
    bytes: Bytes,
) -> Response {
    let exclude = query.exclude.clone();
    let query = query.normalize();
    let index = Arc::clone(&*state.index.read().await);
    let source_id = format!("upload-{}", blake3::hash(&bytes).to_hex());
    let permit = match similarity_limit().acquire_owned().await {
        Ok(permit) => permit,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let status = state.thumbnails.status();
    let key = similar_ranking_key(&index.revision, &source_id, status.ready, status.failed);
    let ranking = if let Some(ranking) = cached_similarity_ranking(&key) {
        ranking
    } else {
        let candidates = index
            .images
            .iter()
            .filter_map(|candidate| {
                state
                    .thumbnails
                    .ready_path(&candidate.id)
                    .map(|path| (Arc::clone(candidate), path))
            })
            .collect();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let signature = signature_for_upload(&bytes).map_err(|_| {
                (
                    StatusCode::BAD_REQUEST,
                    "图片无法读取或尺寸过大，请选择 JPG、PNG、WebP 或 GIF 图片",
                )
            })?;
            rank_similar_signature(&signature, candidates).map_err(|error| {
                error!(%error, "上传图片相似度计算失败");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "无法计算相似图片，请重试",
                )
            })
        })
        .await;
        let ranking = match result {
            Ok(Ok(ranking)) => Arc::new(ranking),
            Ok(Err((status, message))) => {
                return (status, Json(serde_json::json!({ "error": message }))).into_response();
            }
            Err(error) => {
                error!(%error, "上传图片搜索任务中断");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        cache_similarity_ranking(key, Arc::clone(&ranking));
        ranking
    };
    // Keep the cached ranking reusable for ordinary uploads and video frames.
    // Exclude the source video before pagination so totals and offsets agree.
    let ranking = if let Some(exclude) = exclude {
        Arc::new(
            ranking
                .iter()
                .filter(|image| image.id != exclude)
                .cloned()
                .collect(),
        )
    } else {
        ranking
    };
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(similar_image_page(&ranking, query)),
    )
        .into_response()
}

async fn similar_images(
    ReadState(state): ReadState,
    Path(id): Path<String>,
    Query(query): Query<SimilarImagesQuery>,
    headers: HeaderMap,
) -> Response {
    let query = query.normalize();
    let index = {
        let index = state.index.read().await;
        Arc::clone(&index)
    };
    let Some(source) = index.image(&id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let source_thumbnail = match state.thumbnails.ensure_ready(&id).await {
        Ok(path) => path,
        Err(ThumbnailError::NotFound) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            error!(%id, %error, "无法准备相似图片搜索所需的缩略图");
            return (StatusCode::INTERNAL_SERVER_ERROR, "无法读取查询图片").into_response();
        }
    };
    let initial_status = state.thumbnails.status();
    let initial_ranking_key = similar_ranking_key(
        &index.revision,
        &id,
        initial_status.ready,
        initial_status.failed,
    );
    let initial_etag = similar_images_etag(
        &index.revision,
        &id,
        initial_status.ready,
        initial_status.failed,
        query,
    );
    if is_not_modified(&headers, &initial_etag) {
        return not_modified(&initial_etag, "private, no-cache");
    }
    if let Some(ranking) = cached_similarity_ranking(&initial_ranking_key) {
        return with_cache_headers(
            Json(similar_image_page(&ranking, query)).into_response(),
            &initial_etag,
            "private, no-cache",
        );
    }

    let permit = match similarity_limit().acquire_owned().await {
        Ok(permit) => permit,
        Err(error) => {
            error!(%id, %error, "相似图片搜索队列中断");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    // Thumbnail generation can finish while this request waits for the single
    // ranking worker. Refresh the key and conditional response before doing
    // any expensive descriptor work.
    let thumbnail_status = state.thumbnails.status();
    let ranking_key = similar_ranking_key(
        &index.revision,
        &id,
        thumbnail_status.ready,
        thumbnail_status.failed,
    );
    let etag = similar_images_etag(
        &index.revision,
        &id,
        thumbnail_status.ready,
        thumbnail_status.failed,
        query,
    );
    if is_not_modified(&headers, &etag) {
        return not_modified(&etag, "private, no-cache");
    }
    if let Some(ranking) = cached_similarity_ranking(&ranking_key) {
        return with_cache_headers(
            Json(similar_image_page(&ranking, query)).into_response(),
            &etag,
            "private, no-cache",
        );
    }

    let candidates = index
        .images
        .iter()
        .filter(|candidate| candidate.id != source.id)
        .filter_map(|candidate| {
            state
                .thumbnails
                .ready_path(&candidate.id)
                .map(|path| (Arc::clone(candidate), path))
        })
        .collect::<Vec<_>>();
    let ranking = match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        rank_similar_images(source, source_thumbnail, candidates)
    })
    .await
    {
        Ok(Ok(ranking)) => Arc::new(ranking),
        Ok(Err(error)) => {
            error!(%id, %error, "相似图片计算失败");
            return (StatusCode::INTERNAL_SERVER_ERROR, "无法计算相似图片").into_response();
        }
        Err(error) => {
            error!(%id, %error, "相似图片计算任务中断");
            return (StatusCode::INTERNAL_SERVER_ERROR, "无法计算相似图片").into_response();
        }
    };
    cache_similarity_ranking(ranking_key, Arc::clone(&ranking));
    let page = similar_image_page(&ranking, query);

    with_cache_headers(Json(page).into_response(), &etag, "private, no-cache")
}

struct RankedSimilarity {
    record: Arc<ImageRecord>,
    score: f32,
    fingerprint: DiversityFingerprint,
}

fn rank_similar_images(
    source: Arc<ImageRecord>,
    source_thumbnail: std::path::PathBuf,
    candidates: Vec<(Arc<ImageRecord>, std::path::PathBuf)>,
) -> anyhow::Result<Vec<Arc<ImageRecord>>> {
    let source_signature = signature_for_thumbnail(source.as_ref(), &source_thumbnail)?;
    rank_similar_signature(&source_signature, candidates)
}

fn rank_similar_signature(
    source_signature: &ImageSignature,
    candidates: Vec<(Arc<ImageRecord>, std::path::PathBuf)>,
) -> anyhow::Result<Vec<Arc<ImageRecord>>> {
    let worker_count = std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().clamp(2, 8))
        .unwrap_or(2)
        .min(candidates.len().max(1));
    let chunk_size = candidates.len().div_ceil(worker_count).max(1);
    let mut ranked = std::thread::scope(|scope| -> anyhow::Result<Vec<_>> {
        let workers = candidates
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    let mut matches = Vec::with_capacity(chunk.len());
                    for (candidate, thumbnail) in chunk {
                        // A malformed candidate should not make the whole gallery
                        // unusable. It is omitted until a rescan fixes or removes it.
                        let Ok(candidate_signature) =
                            signature_for_thumbnail(candidate.as_ref(), thumbnail)
                        else {
                            continue;
                        };
                        let score = similarity_score(source_signature, &candidate_signature);
                        if score < MIN_SIMILARITY_SCORE {
                            continue;
                        }
                        matches.push(RankedSimilarity {
                            record: Arc::clone(candidate),
                            score,
                            fingerprint: candidate_signature.diversity_fingerprint(),
                        });
                    }
                    matches
                })
            })
            .collect::<Vec<_>>();
        let mut matches = Vec::with_capacity(candidates.len().saturating_sub(1));
        for worker in workers {
            matches.extend(
                worker
                    .join()
                    .map_err(|_| anyhow::anyhow!("similarity worker stopped"))?,
            );
        }
        Ok(matches)
    })?;
    ranked.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.record.id.cmp(&right.record.id))
    });
    diversify_similarity_results(&mut ranked);

    Ok(ranked
        .into_iter()
        .map(|candidate| candidate.record)
        .collect())
}

fn similar_image_page(ranked: &[Arc<ImageRecord>], query: SimilarImagesRequest) -> ImagesResponse {
    let total = ranked.len();
    let offset = query.offset.min(total);
    let end = offset.saturating_add(query.limit).min(total);
    let items = ranked[offset..end]
        .iter()
        .map(|record| ImageView::from(record.as_ref()))
        .collect();
    finish_page(items, total, offset, query.limit)
}

fn diversify_similarity_results(ranked: &mut Vec<RankedSimilarity>) {
    let target = ranked.len().min(DIVERSIFIED_SIMILARITY_RESULTS);
    if target < 2 {
        return;
    }

    let mut remaining = std::mem::take(ranked)
        .into_iter()
        .map(|candidate| (candidate, 0.0_f32))
        .collect::<Vec<_>>();
    let mut selected = Vec::with_capacity(target);
    while selected.len() < target {
        let Some(next) = remaining
            .iter()
            .enumerate()
            .max_by(
                |(_, (left, left_redundancy)), (_, (right, right_redundancy))| {
                    diversity_rank(left.score, *left_redundancy)
                        .total_cmp(&diversity_rank(right.score, *right_redundancy))
                        .then_with(|| right.record.id.cmp(&left.record.id))
                },
            )
            .map(|(index, _)| index)
        else {
            break;
        };
        let (candidate, _) = remaining.swap_remove(next);
        let fingerprint = candidate.fingerprint;
        selected.push(candidate);
        for (remaining_candidate, maximum_redundancy) in &mut remaining {
            *maximum_redundancy = maximum_redundancy.max(redundancy_score(
                fingerprint,
                remaining_candidate.fingerprint,
            ));
        }
    }

    remaining.sort_by(|(left, _), (right, _)| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.record.id.cmp(&right.record.id))
    });
    selected.extend(remaining.into_iter().map(|(candidate, _)| candidate));
    *ranked = selected;
}

fn diversity_rank(relevance: f32, redundancy: f32) -> f32 {
    let penalty = ((redundancy - REDUNDANCY_PENALTY_START) / (1.0 - REDUNDANCY_PENALTY_START))
        .clamp(0.0, 1.0)
        .powi(2)
        * MAX_REDUNDANCY_PENALTY;
    relevance - penalty
}

struct RankedTextSearch {
    record: Arc<ImageRecord>,
    score: f32,
}

fn rank_text_search(
    query: Arc<TextSearchEmbedding>,
    candidates: Vec<(Arc<ImageRecord>, Option<Arc<TextSearchEmbedding>>, bool)>,
) -> Vec<Arc<ImageRecord>> {
    let mut ranked = candidates
        .into_iter()
        .map(|(record, embedding, filename_match)| {
            let semantic = embedding
                .as_deref()
                .map_or(-1.0, |embedding| text_image_similarity(&query, embedding));
            let score = semantic
                + if filename_match {
                    FILENAME_MATCH_BOOST
                } else {
                    0.0
                };
            RankedTextSearch { record, score }
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.record.id.cmp(&right.record.id))
    });
    ranked
        .into_iter()
        .take(TEXT_SEARCH_RESULT_LIMIT)
        .map(|ranked| ranked.record)
        .collect()
}

fn text_search_image_page(ranked: &[Arc<ImageRecord>], query: &ImageRequest) -> ImagesResponse {
    if !matches!(query.sort, ImageSort::Default) {
        // A semantic ranking is already filtered, but is not in filename order.
        let mut records: Vec<_> = ranked.iter().map(Arc::as_ref).collect();
        records.sort_by(|left, right| {
            natord::compare_ignore_case(&left.relative_path, &right.relative_path)
        });
        return pagination::sorted_image_page(records.into_iter(), query);
    }
    let total = ranked.len();
    let offset = query.offset.min(total);
    let end = offset.saturating_add(query.limit).min(total);
    let items = ranked[offset..end]
        .iter()
        .map(|record| ImageView::from(record.as_ref()))
        .collect();
    finish_page(items, total, offset, query.limit)
}

async fn thumbnail_status(ReadState(state): ReadState) -> Response {
    let status = if state.index.read().await.initializing {
        ThumbnailStatus::pending()
    } else {
        state.thumbnails.status()
    };
    let mut response = Json(status).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn image_details(
    ReadState(state): ReadState,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let image = {
        let index = state.index.read().await;
        let Some(image) = index.image(&id).cloned() else {
            return StatusCode::NOT_FOUND.into_response();
        };
        image
    };
    let metadata = match tokio::fs::metadata(&image.path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return StatusCode::NOT_FOUND.into_response();
        }
        Err(error) => {
            error!(path = %image.path.display(), %error, "无法读取图片详情源文件");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if !image.matches_metadata(&metadata) {
        return StatusCode::NOT_FOUND.into_response();
    }

    let etag = format!("\"details-v1-{id}\"");
    if is_not_modified(&headers, &etag) {
        return not_modified(&etag, "private, max-age=31536000, immutable");
    }

    let cache_key = format!("{}:{}", image.path.display(), image.id);
    if let Some(details) = cached_photo_details(&cache_key) {
        return with_cache_headers(
            Json(details.as_ref()).into_response(),
            &etag,
            "private, max-age=31536000, immutable",
        );
    }

    let thumbnail = if image.video.is_some() {
        // Video details do not depend on a poster or an image histogram.
        image.path.clone()
    } else {
        match state.thumbnails.ensure_ready(&id).await {
            Ok(path) => path,
            Err(ThumbnailError::NotFound) => return StatusCode::NOT_FOUND.into_response(),
            Err(error) => {
                error!(%id, %error, "无法准备直方图源图片");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    };
    let details = match tokio::task::spawn_blocking({
        let image = Arc::clone(&image);
        move || PhotoDetails::read(&image, &thumbnail)
    })
    .await
    {
        Ok(Ok(details)) => Arc::new(details),
        Ok(Err(error)) => {
            if image.ensure_source_is_current().is_err() {
                return StatusCode::NOT_FOUND.into_response();
            }
            error!(%id, %error, "无法读取图片详情");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        Err(error) => {
            error!(%id, %error, "图片详情任务中断");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    cache_photo_details(cache_key, Arc::clone(&details));
    with_cache_headers(
        Json(details.as_ref()).into_response(),
        &etag,
        "private, max-age=31536000, immutable",
    )
}

async fn thumbnail(
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

async fn display_image(
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

#[derive(Default, Deserialize)]
struct VideoQuery {
    #[serde(default)]
    status: bool,
    retry: Option<String>,
}

async fn prepared_video(
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

async fn motion_video(
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

async fn serve_file(
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

fn with_cache_headers(mut response: Response, etag: &str, cache_control: &'static str) -> Response {
    let etag = match HeaderValue::from_str(etag) {
        Ok(etag) => etag,
        Err(error) => {
            error!(%error, "无法生成 ETag 响应头");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    response.headers_mut().insert(header::ETAG, etag);
    response
}

fn revision_etag(kind: &str, revision: &str) -> String {
    format!("\"{kind}-{revision}\"")
}

fn images_etag(revision: &str, query: &ImageRequest, text_search_token: Option<&str>) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"pixhelf-images-query-v4\0");
    hasher.update(query.album.as_deref().unwrap_or_default().as_bytes());
    hasher.update(b"\0");
    hasher.update(query.search.as_deref().unwrap_or_default().as_bytes());
    hasher.update(b"\0");
    hasher.update(&[query.sort as u8, query.kind as u8, query.orientation as u8]);
    hasher.update(query.seed.as_bytes());
    hasher.update(b"\0");
    hasher.update(text_search_token.unwrap_or("filename").as_bytes());
    hasher.update(&query.offset.to_le_bytes());
    hasher.update(&query.limit.to_le_bytes());
    let query_hash = hasher.finalize().to_hex();
    format!("\"images-{revision}-{}\"", &query_hash[..16])
}

fn text_search_ranking_key(
    revision: &str,
    query: &ImageRequest,
    search: &str,
    text_search_token: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"pixhelf-text-search-v2\0");
    hasher.update(revision.as_bytes());
    hasher.update(b"\0");
    hasher.update(query.album.as_deref().unwrap_or_default().as_bytes());
    hasher.update(&[query.kind as u8, query.orientation as u8]);
    hasher.update(b"\0");
    hasher.update(search.as_bytes());
    hasher.update(b"\0");
    hasher.update(text_search_token.as_bytes());
    hasher.finalize().to_hex().to_string()
}

fn similar_images_etag(
    revision: &str,
    source_id: &str,
    ready: usize,
    failed: usize,
    query: SimilarImagesRequest,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"pixhelf-similar-images-v5\0");
    hasher.update(source_id.as_bytes());
    hasher.update(&ready.to_le_bytes());
    hasher.update(&failed.to_le_bytes());
    hasher.update(&query.offset.to_le_bytes());
    hasher.update(&query.limit.to_le_bytes());
    let query_hash = hasher.finalize().to_hex();
    format!("\"similar-{revision}-{}\"", &query_hash[..16])
}

fn similar_ranking_key(revision: &str, source_id: &str, ready: usize, failed: usize) -> String {
    format!("{revision}:{source_id}:{ready}:{failed}")
}

fn is_not_modified(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|values| {
            values
                .split(',')
                .map(str::trim)
                .any(|value| value == "*" || value.strip_prefix("W/").unwrap_or(value) == etag)
        })
}

fn not_modified(etag: &str, cache_control: &'static str) -> Response {
    with_cache_headers(
        StatusCode::NOT_MODIFIED.into_response(),
        etag,
        cache_control,
    )
}

async fn frontend_asset(
    Path((version, path)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if version != ASSET_VERSION {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(asset) = assets::find(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let etag = format!("\"asset-{path}-{ASSET_VERSION}\"");
    if is_not_modified(&headers, &etag) {
        return not_modified(&etag, "public, max-age=31536000, immutable");
    }
    let content = match asset.read().await {
        Ok(content) => content,
        Err(error) => {
            error!(%path, %error, "无法读取内置前端资源");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let content_type = if path.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else {
        "text/plain; charset=utf-8"
    };
    let mut response = Response::new(Body::from(content));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    with_cache_headers(response, &etag, "public, max-age=31536000, immutable")
}

async fn frontend(ReadState(state): ReadState, request: Request) -> Response {
    if request.uri().path() != "/" {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let authentication = request
        .extensions()
        .get::<AuthView>()
        .cloned()
        .unwrap_or_default();
    let index = state.index.read().await;
    let status = if index.initializing {
        ThumbnailStatus::pending()
    } else {
        state.thumbnails.status()
    };
    let etag = format!(
        "\"index-{ASSET_VERSION}-{}-{}-{}\"",
        index.revision, status.ready, status.failed
    );
    if !authentication.enabled && is_not_modified(request.headers(), &etag) {
        return not_modified(&etag, "private, no-cache");
    }
    let summary = summary_from_index(&index);
    let images = image_page(&index, &ImageRequest::default());

    let mut preload = images.items.first().map_or_else(String::new, |image| {
        let url = format!("/api/images/{}/thumbnail", image.id);
        format!(r#"<link rel="preload" as="image" href="{url}" fetchpriority="high" />"#)
    });
    if !index.initializing {
        // Start the authenticated gallery assets with the document, before its entry module runs.
        preload.push_str(&format!(
            r#"<link rel="modulepreload" crossorigin href="/assets/{ASSET_VERSION}/GalleryApp.js" /><link rel="stylesheet" crossorigin href="/assets/{ASSET_VERSION}/GalleryApp.css" />"#
        ));
    }
    let bootstrap = BootstrapResponse {
        summary,
        status,
        images,
    };
    let bootstrap_json = match serde_json::to_string(&bootstrap) {
        Ok(json) => escape_script_json(json),
        Err(error) => {
            error!(%error, "无法生成页面初始数据");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let html = frontend_document(&bootstrap_json, &authentication, &preload);
    drop(index);

    let body = if request.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(html)
    };
    let mut response = Response::new(body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    with_cache_headers(response, &etag, "private, no-cache")
}

pub(crate) fn authentication_html(authentication: &AuthView) -> Response {
    // Keep login independent of a potentially large browser cache purge. Protected
    // media revalidates authentication, and explicit logout still clears caches.
    let title = if authentication.setup_required {
        "<title>欢迎使用 · Pixhelf</title>"
    } else {
        "<title>登录 · Pixhelf</title>"
    };
    let html =
        frontend_document("null", authentication, "").replace("<title>Pixhelf</title>", title);
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        html,
    )
        .into_response()
}

fn frontend_document(bootstrap_json: &str, authentication: &AuthView, preload: &str) -> String {
    let authentication = escape_script_json(
        serde_json::to_string(authentication).expect("serializable authentication view"),
    );
    let inline_styles = format!(
        "<style>{}</style>",
        std::str::from_utf8(APP_CSS).expect("Vite app.css must be UTF-8")
    );
    let template = std::str::from_utf8(INDEX_HTML)
        .expect("Vite index.html must be UTF-8")
        .replace(
            r#"<link rel="stylesheet" crossorigin href="./assets/app.css">"#,
            &inline_styles,
        )
        .replace("./assets/", &format!("/assets/{ASSET_VERSION}/"))
        .replace("<!--PIXHELF_IMAGE_PRELOAD-->", preload);
    // Substitute each template slot once without interpreting markers inside usernames or filenames.
    let (before_auth, remainder) = template
        .split_once("__PIXHELF_AUTH__")
        .expect("authentication template slot");
    let (between, after_bootstrap) = remainder
        .split_once("__PIXHELF_BOOTSTRAP__")
        .expect("gallery template slot");
    format!("{before_auth}{authentication}{between}{bootstrap_json}{after_bootstrap}")
}

fn escape_script_json(json: String) -> String {
    json.replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests;
