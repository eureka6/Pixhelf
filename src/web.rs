use std::{
    cmp::Reverse,
    sync::{Arc, Mutex, OnceLock},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
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
    gallery::{Album, GalleryIndex, ImageRecord},
    similarity::{
        DiversityFingerprint, MIN_SIMILARITY_SCORE, redundancy_score, signature_for_thumbnail,
        similarity_score,
    },
    support::{BoundedCache, mutex_lock},
    text_search::{TextSearchEmbedding, text_image_similarity},
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

static SIMILARITY_LIMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();
type SimilarityRanking = Arc<Vec<Arc<ImageRecord>>>;
type SimilarityRankingCache = Mutex<BoundedCache<SimilarityRanking>>;
static SIMILARITY_RANKING_CACHE: OnceLock<SimilarityRankingCache> = OnceLock::new();
type TextSearchRanking = Arc<Vec<Arc<ImageRecord>>>;
type TextSearchRankingCache = Mutex<BoundedCache<TextSearchRanking>>;
static TEXT_SEARCH_RANKING_CACHE: OnceLock<TextSearchRankingCache> = OnceLock::new();

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

#[derive(Clone)]
pub struct AppState {
    pub index: Arc<RwLock<Arc<GalleryIndex>>>,
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
struct SimilarImagesQuery {
    offset: Option<usize>,
    limit: Option<usize>,
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
struct ImageRequest {
    album: Option<String>,
    search: Option<String>,
    sort: ImageSort,
    seed: String,
    offset: usize,
    limit: usize,
}

impl ImagesQuery {
    fn normalize(self) -> Result<ImageRequest, StatusCode> {
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
    width: u32,
    height: u32,
}

impl From<&ImageRecord> for ImageView {
    fn from(record: &ImageRecord) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            width: record.width,
            height: record.height,
        }
    }
}

#[derive(Serialize)]
struct BootstrapResponse {
    summary: GallerySummary,
    status: ThumbnailStatus,
    images: ImagesResponse,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/gallery", get(gallery_summary))
        .route("/api/images", get(images))
        .route("/api/images/{id}/similar", get(similar_images))
        .route("/api/status", get(thumbnail_status))
        .route("/api/images/{id}/thumbnail", get(thumbnail))
        .route("/api/images/{id}/original", get(original))
        .route("/assets/{version}/app.js", get(app_js))
        .route("/assets/{version}/app.css", get(app_css))
        .fallback(frontend)
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
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn gallery_summary(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let index = state.index.read().await;
    let etag = revision_etag("gallery", &index.revision);
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
    }
}

async fn images(
    State(state): State<AppState>,
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
            query.album.as_deref(),
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
                            .is_none_or(|album| record.album == album)
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
                        error!(%error, "natural-language image ranking task stopped");
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
                error!(query = %search, %error, "cannot encode natural-language image query; using filename fallback");
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

async fn similar_images(
    State(state): State<AppState>,
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
            error!(%id, %error, "cannot prepare source thumbnail for similarity search");
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
            error!(%id, %error, "similarity search queue stopped");
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
            error!(%id, %error, "cannot calculate similar images");
            return (StatusCode::INTERNAL_SERVER_ERROR, "无法计算相似图片").into_response();
        }
        Err(error) => {
            error!(%id, %error, "similar image task stopped");
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
    let worker_count = std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().clamp(2, 8))
        .unwrap_or(2)
        .min(candidates.len().max(1));
    let chunk_size = candidates.len().div_ceil(worker_count).max(1);
    let mut ranked = std::thread::scope(|scope| -> anyhow::Result<Vec<_>> {
        let workers = candidates
            .chunks(chunk_size)
            .map(|chunk| {
                let source_id = source.id.as_str();
                let source_signature = &source_signature;
                scope.spawn(move || {
                    let mut matches = Vec::with_capacity(chunk.len());
                    for (candidate, thumbnail) in chunk {
                        if candidate.id == source_id {
                            continue;
                        }
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

fn image_page(index: &GalleryIndex, query: &ImageRequest) -> ImagesResponse {
    let album = query.album.as_deref();
    let search = query.search.as_deref();
    let requested_offset = query.offset;
    let limit = query.limit;

    match query.sort {
        ImageSort::NameAsc if album.is_none() && search.is_none() => {
            page_from_unfiltered_index(index, false, requested_offset, limit)
        }
        ImageSort::NameDesc if album.is_none() && search.is_none() => {
            page_from_unfiltered_index(index, true, requested_offset, limit)
        }
        ImageSort::NameAsc => page_from_ordered_records(
            index.images.iter().map(Arc::as_ref),
            album,
            search,
            requested_offset,
            limit,
        ),
        ImageSort::NameDesc => page_from_ordered_records(
            index.images.iter().rev().map(Arc::as_ref),
            album,
            search,
            requested_offset,
            limit,
        ),
        ImageSort::Newest | ImageSort::Explore => {
            let mut matches: Vec<&ImageRecord> = index
                .images
                .iter()
                .map(Arc::as_ref)
                .filter(|record| record_matches(record, album, search))
                .collect();

            match query.sort {
                ImageSort::Newest => matches.sort_by_key(|record| Reverse(record.modified_ms)),
                ImageSort::Explore => {
                    let seed_key = *blake3::hash(query.seed.as_bytes()).as_bytes();
                    matches.sort_by_cached_key(|record| exploration_rank(&seed_key, &record.id));
                }
                ImageSort::NameAsc | ImageSort::NameDesc => unreachable!(),
            }
            page_from_sorted_records(matches, requested_offset, limit)
        }
    }
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
    let total = ranked.len();
    let offset = query.offset.min(total);
    let end = offset.saturating_add(query.limit).min(total);
    let items = ranked[offset..end]
        .iter()
        .map(|record| ImageView::from(record.as_ref()))
        .collect();
    finish_page(items, total, offset, query.limit)
}

fn page_from_unfiltered_index(
    index: &GalleryIndex,
    reverse: bool,
    requested_offset: usize,
    limit: usize,
) -> ImagesResponse {
    let total = index.images.len();
    let offset = requested_offset.min(total);
    let records: Box<dyn Iterator<Item = &Arc<ImageRecord>> + '_> = if reverse {
        Box::new(index.images.iter().rev().skip(offset).take(limit))
    } else {
        Box::new(index.images.iter().skip(offset).take(limit))
    };
    let items = records
        .map(|record| ImageView::from(record.as_ref()))
        .collect();
    finish_page(items, total, offset, limit)
}

fn record_matches(record: &ImageRecord, album: Option<&str>, search: Option<&str>) -> bool {
    album.is_none_or(|album| record.album == album)
        && search.is_none_or(|search| record.search_key.contains(search))
}

fn page_from_ordered_records<'a>(
    records: impl Iterator<Item = &'a ImageRecord>,
    album: Option<&str>,
    search: Option<&str>,
    requested_offset: usize,
    limit: usize,
) -> ImagesResponse {
    let mut items = Vec::with_capacity(limit);
    let mut total = 0usize;
    for record in records.filter(|record| record_matches(record, album, search)) {
        if total >= requested_offset && items.len() < limit {
            items.push(ImageView::from(record));
        }
        total += 1;
    }
    finish_page(items, total, requested_offset, limit)
}

fn page_from_sorted_records(
    records: Vec<&ImageRecord>,
    requested_offset: usize,
    limit: usize,
) -> ImagesResponse {
    let total = records.len();
    let offset = requested_offset.min(total);
    let end = offset.saturating_add(limit).min(total);
    let items = records[offset..end]
        .iter()
        .map(|record| ImageView::from(*record))
        .collect();
    finish_page(items, total, offset, limit)
}

fn finish_page(
    items: Vec<ImageView>,
    total: usize,
    requested_offset: usize,
    limit: usize,
) -> ImagesResponse {
    let offset = requested_offset.min(total);
    let end = offset.saturating_add(items.len()).min(total);
    ImagesResponse {
        items,
        total,
        offset,
        limit,
        next_offset: (end < total).then_some(end),
    }
}

fn exploration_rank(seed_key: &[u8; 32], image_id: &str) -> [u8; 32] {
    *blake3::keyed_hash(seed_key, image_id.as_bytes()).as_bytes()
}

async fn thumbnail_status(State(state): State<AppState>) -> Response {
    let mut response = Json(state.thumbnails.status()).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
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

async fn original(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    // Resolve the opaque id through the index instead of accepting a filesystem path
    // from the request. Cloning the record releases the read lock before filesystem I/O.
    let image = {
        let index = state.index.read().await;
        index.image(&id).cloned().ok_or(StatusCode::NOT_FOUND)?
    };
    let metadata = match tokio::fs::metadata(&image.path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(StatusCode::NOT_FOUND);
        }
        Err(error) => {
            error!(path = %image.path.display(), %error, "cannot inspect original image");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    if !image.matches_metadata(&metadata) {
        return Err(StatusCode::NOT_FOUND);
    }

    serve_file(
        image.path.clone(),
        request,
        &format!("\"original-{id}\""),
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
    if is_not_modified(request.headers(), etag) {
        return Ok(not_modified(etag, cache_control));
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
            error!(%error, "cannot create ETag response header");
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
    hasher.update(b"pixhelf-images-query-v2\0");
    hasher.update(query.album.as_deref().unwrap_or_default().as_bytes());
    hasher.update(b"\0");
    hasher.update(query.search.as_deref().unwrap_or_default().as_bytes());
    hasher.update(b"\0");
    hasher.update(&[query.sort as u8]);
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
    album: Option<&str>,
    search: &str,
    text_search_token: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"pixhelf-text-search-v1\0");
    hasher.update(revision.as_bytes());
    hasher.update(b"\0");
    hasher.update(album.unwrap_or_default().as_bytes());
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
    hasher.update(b"pixhelf-similar-images-v4\0");
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

async fn app_js(Path(version): Path<String>, headers: HeaderMap) -> Response {
    embedded_asset(
        &version,
        APP_JS,
        "text/javascript; charset=utf-8",
        "js",
        &headers,
    )
}

async fn app_css(Path(version): Path<String>, headers: HeaderMap) -> Response {
    embedded_asset(
        &version,
        APP_CSS,
        "text/css; charset=utf-8",
        "css",
        &headers,
    )
}

fn embedded_asset(
    version: &str,
    content: &'static [u8],
    content_type: &'static str,
    kind: &str,
    headers: &HeaderMap,
) -> Response {
    if version != ASSET_VERSION {
        return StatusCode::NOT_FOUND.into_response();
    }
    let etag = format!("\"asset-{kind}-{ASSET_VERSION}\"");
    if is_not_modified(headers, &etag) {
        return not_modified(&etag, "public, max-age=31536000, immutable");
    }

    let mut response = Response::new(Body::from(content));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    with_cache_headers(response, &etag, "public, max-age=31536000, immutable")
}

async fn frontend(State(state): State<AppState>, request: Request) -> Response {
    if request.uri().path() != "/" {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let index = state.index.read().await;
    let status = state.thumbnails.status();
    let etag = format!(
        "\"index-{ASSET_VERSION}-{}-{}-{}\"",
        index.revision, status.ready, status.failed
    );
    if is_not_modified(request.headers(), &etag) {
        return not_modified(&etag, "private, no-cache");
    }
    let summary = summary_from_index(&index);
    let images = image_page(&index, &ImageRequest::default());

    let preload = images.items.first().map_or_else(String::new, |image| {
        let url = format!("/api/images/{}/thumbnail", image.id);
        format!(r#"<link rel="preload" as="image" href="{url}" fetchpriority="high" />"#)
    });
    let bootstrap = BootstrapResponse {
        summary,
        status,
        images,
    };
    let bootstrap_json = match serde_json::to_string(&bootstrap) {
        Ok(json) => escape_script_json(json),
        Err(error) => {
            error!(%error, "cannot serialize frontend bootstrap");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let inline_styles = format!(
        "<style>{}</style>",
        std::str::from_utf8(APP_CSS).expect("Vite app.css must be UTF-8")
    );
    let html = std::str::from_utf8(INDEX_HTML)
        .expect("Vite index.html must be UTF-8")
        .replace(
            r#"<link rel="stylesheet" crossorigin href="/assets/app.css">"#,
            &inline_styles,
        )
        .replace("/assets/app.js", &format!("/assets/{ASSET_VERSION}/app.js"))
        .replace(
            "/assets/app.css",
            &format!("/assets/{ASSET_VERSION}/app.css"),
        )
        .replace("<!--PIXHELF_IMAGE_PRELOAD-->", &preload)
        .replace("__PIXHELF_BOOTSTRAP__", &bootstrap_json);
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

fn escape_script_json(json: String) -> String {
    json.replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ColourTextSearchModel;

    impl crate::text_search::TextImageModel for ColourTextSearchModel {
        fn embed_thumbnail(
            &mut self,
            thumbnail: &std::path::Path,
        ) -> anyhow::Result<TextSearchEmbedding> {
            let pixel = image::open(thumbnail)?.to_rgb8().get_pixel(0, 0).0;
            let axis = if pixel[0] >= pixel[2] { 0 } else { 1 };
            Ok(TextSearchEmbedding::for_test([(axis, 100)]))
        }

        fn embed_text(&mut self, text: &str) -> anyhow::Result<TextSearchEmbedding> {
            let axis = if text.contains('红') { 0 } else { 1 };
            Ok(TextSearchEmbedding::for_test([(axis, 100)]))
        }
    }

    fn empty_router() -> Router {
        let temp = tempfile::tempdir().unwrap();
        let thumbnails = ThumbnailManager::new(temp.path().to_owned()).unwrap();
        router(AppState {
            index: Arc::new(RwLock::new(Arc::new(GalleryIndex::default()))),
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
    fn image_view_keeps_the_payload_compact() {
        let record = ImageRecord {
            id: "abc".into(),
            path: "photo.jpg".into(),
            relative_path: "album/photo.jpg".into(),
            search_key: "album/photo.jpg".into(),
            name: "photo.jpg".into(),
            album: "album".into(),
            width: 10,
            height: 20,
            size: 30,
            modified_ms: 40,
            modified_ns: 40,
        };
        let view = ImageView::from(&record);
        let json = serde_json::to_string(&view).unwrap();
        assert_eq!(
            json,
            r#"{"id":"abc","name":"photo.jpg","width":10,"height":20}"#
        );
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

    #[test]
    fn diversity_penalty_can_surface_a_distinct_result() {
        assert_eq!(diversity_rank(0.94, REDUNDANCY_PENALTY_START), 0.94);
        assert!(diversity_rank(0.94, 0.0) > diversity_rank(0.99, 1.0));
        assert!(diversity_rank(0.99, 0.90) > diversity_rank(0.94, 0.0));
    }

    #[test]
    fn natural_language_search_ranks_shared_text_image_embeddings() {
        let record = |id: &str, name: &str| {
            Arc::new(ImageRecord {
                id: id.into(),
                path: name.into(),
                relative_path: name.into(),
                search_key: name.to_lowercase(),
                name: name.into(),
                album: String::new(),
                width: 10,
                height: 10,
                size: 1,
                modified_ms: 1,
                modified_ns: 1,
            })
        };
        let query = Arc::new(TextSearchEmbedding::for_test([(0, 100)]));
        let red = Arc::new(TextSearchEmbedding::for_test([(0, 100)]));
        let blue = Arc::new(TextSearchEmbedding::for_test([(1, 100)]));
        let ranked = rank_text_search(
            query,
            vec![
                (record("blue", "first.png"), Some(blue), false),
                (record("red", "second.png"), Some(red), false),
            ],
        );
        assert_eq!(ranked[0].id, "red");
        assert_eq!(ranked[1].id, "blue");
    }

    #[test]
    fn normalizes_image_queries_once() {
        let query = ImagesQuery {
            album: Some("album".into()),
            search: Some("  PHOTO  ".into()),
            offset: Some(usize::MAX),
            limit: Some(usize::MAX),
            ..ImagesQuery::default()
        }
        .normalize()
        .unwrap();

        assert_eq!(query.album.as_deref(), Some("album"));
        assert_eq!(query.search.as_deref(), Some("photo"));
        assert_eq!(query.offset, usize::MAX);
        assert_eq!(query.limit, MAX_PAGE_SIZE);

        let oversized = ImagesQuery {
            search: Some("x".repeat(MAX_QUERY_VALUE_BYTES + 1)),
            ..ImagesQuery::default()
        };
        assert_eq!(oversized.normalize().unwrap_err(), StatusCode::BAD_REQUEST);
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
    async fn status_exposes_optional_text_search_index_progress() {
        let response = request("/api/status").await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(status.get("semantic").is_none());
        assert_eq!(status["textSearch"]["enabled"], false);
        assert_eq!(status["textSearch"]["backgroundComplete"], true);
    }

    #[tokio::test]
    async fn unknown_api_and_image_routes_return_not_found() {
        assert_eq!(
            request("/api/does-not-exist").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request("/api/images/missing/thumbnail").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request("/api/images/missing/original").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request("/api/images/missing/similar").await.status(),
            StatusCode::NOT_FOUND
        );
        let response = request("/missing").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
    }

    #[tokio::test]
    async fn similar_images_are_ranked_exclude_the_source_and_paginate() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        std::fs::create_dir(&gallery).unwrap();
        image::RgbImage::from_pixel(40, 30, image::Rgb([220, 80, 40]))
            .save(gallery.join("source.png"))
            .unwrap();
        image::RgbImage::from_pixel(40, 30, image::Rgb([216, 82, 43]))
            .save(gallery.join("closest.png"))
            .unwrap();
        image::RgbImage::from_pixel(40, 30, image::Rgb([205, 88, 48]))
            .save(gallery.join("nearby.png"))
            .unwrap();
        image::RgbImage::from_pixel(40, 30, image::Rgb([20, 50, 220]))
            .save(gallery.join("blue.png"))
            .unwrap();

        let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
        let source_id = index
            .images
            .iter()
            .find(|image| image.name == "source.png")
            .unwrap()
            .id
            .clone();
        let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        thumbnails.reconcile(&index.images);
        thumbnails.start_workers(1);
        for image in &index.images {
            thumbnails.ensure_ready(&image.id).await.unwrap();
        }
        let app = router(AppState {
            index: Arc::new(RwLock::new(Arc::new(index))),
            thumbnails,
        });

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images/{source_id}/similar?offset=0&limit=1"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(page["total"], 2);
        assert_eq!(page["nextOffset"], 1);
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_eq!(page["items"][0]["name"], "closest.png");
        assert_ne!(page["items"][0]["id"], source_id);

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images/{source_id}/similar?offset=1&limit=1"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(page["total"], 2);
        assert_eq!(page["nextOffset"], serde_json::Value::Null);
        assert_eq!(page["items"][0]["name"], "nearby.png");
    }

    #[tokio::test]
    async fn similar_images_omit_unrelated_candidates() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        std::fs::create_dir(&gallery).unwrap();
        image::RgbImage::from_pixel(40, 30, image::Rgb([220, 80, 40]))
            .save(gallery.join("source.png"))
            .unwrap();
        image::RgbImage::from_pixel(40, 30, image::Rgb([20, 50, 220]))
            .save(gallery.join("unrelated.png"))
            .unwrap();

        let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
        let source_id = index
            .images
            .iter()
            .find(|image| image.name == "source.png")
            .unwrap()
            .id
            .clone();
        let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        thumbnails.reconcile(&index.images);
        thumbnails.start_workers(1);
        for image in &index.images {
            thumbnails.ensure_ready(&image.id).await.unwrap();
        }
        let app = router(AppState {
            index: Arc::new(RwLock::new(Arc::new(index))),
            thumbnails,
        });

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images/{source_id}/similar"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(page["total"], 0);
        assert_eq!(page["nextOffset"], serde_json::Value::Null);
        assert!(page["items"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn natural_language_api_searches_image_content_not_only_filenames() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        std::fs::create_dir(&gallery).unwrap();
        image::RgbImage::from_pixel(40, 30, image::Rgb([230, 25, 20]))
            .save(gallery.join("first.png"))
            .unwrap();
        image::RgbImage::from_pixel(40, 30, image::Rgb([20, 30, 230]))
            .save(gallery.join("second.png"))
            .unwrap();

        let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
        let text_search = crate::text_search::TextSearchIndex::with_test_model(
            Box::new(ColourTextSearchModel),
            [44; 16],
        );
        let thumbnails = ThumbnailManager::new_with_text_search(
            temp.path().join("cache"),
            Some(Arc::clone(&text_search)),
        )
        .unwrap();
        thumbnails.reconcile(&index.images);
        thumbnails.start_workers(1);
        text_search.start_worker();
        for image in &index.images {
            thumbnails.ensure_ready(&image.id).await.unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let status = thumbnails.status();
                if status.background_complete && status.text_search.background_complete {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("text-search index timed out");
        let app = router(AppState {
            index: Arc::new(RwLock::new(Arc::new(index))),
            thumbnails,
        });

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/images?search=%E7%BA%A2%E8%89%B2%E5%9B%BE%E7%89%87&limit=2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(page["items"][0]["name"], "first.png");
        assert_eq!(page["items"][1]["name"], "second.png");
    }

    #[tokio::test]
    async fn indexed_images_expose_original_with_immutable_cache() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        std::fs::create_dir(&gallery).unwrap();
        image::RgbImage::new(20, 10)
            .save(gallery.join("image.png"))
            .unwrap();
        let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
        let id = index.images[0].id.clone();
        let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        thumbnails.reconcile(&index.images);
        let app = router(AppState {
            index: Arc::new(RwLock::new(Arc::new(index))),
            thumbnails,
        });

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images/{id}/original"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(!body.is_empty());
    }

    #[tokio::test]
    async fn stale_image_ids_do_not_serve_replaced_files() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        std::fs::create_dir(&gallery).unwrap();
        let image_path = gallery.join("image.png");
        image::RgbImage::new(20, 10).save(&image_path).unwrap();
        let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
        let id = index.images[0].id.clone();
        let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        thumbnails.reconcile(&index.images);
        let app = router(AppState {
            index: Arc::new(RwLock::new(Arc::new(index))),
            thumbnails,
        });
        std::fs::write(&image_path, "replacement with a different size").unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images/{id}/original"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn versioned_assets_are_immutable() {
        let response = request(&format!("/assets/{ASSET_VERSION}/app.js")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            request("/assets/stale/app.js").await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn frontend_embeds_bootstrap_and_versioned_assets() {
        let response = request("/").await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let html = std::str::from_utf8(&body).unwrap();
        assert!(html.contains(&format!("/assets/{ASSET_VERSION}/app.js")));
        assert!(html.contains("<style>:root"));
        assert!(!html.contains("/assets/app.css"));
        assert!(html.contains(r#""summary":{"total":0"#));
        assert!(!html.contains("__PIXHELF_BOOTSTRAP__"));
    }

    #[test]
    fn bootstrap_json_cannot_close_its_script_element() {
        let escaped = escape_script_json(r#"{"name":"</script><script>"}"#.to_owned());
        assert!(!escaped.contains('<'));
        assert!(escaped.contains(r#"\u003c/script\u003e"#));
    }

    #[tokio::test]
    async fn gallery_etag_supports_conditional_requests() {
        let response = empty_router()
            .oneshot(
                Request::builder()
                    .uri("/api/gallery")
                    .header(header::IF_NONE_MATCH, "\"gallery-\"")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-cache"
        );

        let weak_response = empty_router()
            .oneshot(
                Request::builder()
                    .uri("/api/gallery")
                    .header(header::IF_NONE_MATCH, "W/\"gallery-\"")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(weak_response.status(), StatusCode::NOT_MODIFIED);
    }
}
