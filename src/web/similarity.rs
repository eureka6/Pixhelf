//! Similar-image endpoints, ranking cache and diversity scoring.
use super::{
    cache::{is_not_modified, not_modified, with_cache_headers},
    models::{DEFAULT_PAGE_SIZE, ImageView, ImagesResponse, MAX_PAGE_SIZE},
    pagination::finish_page,
};
use crate::{
    gallery::ImageRecord,
    management::sharing::ReadState,
    similarity::{
        DiversityFingerprint, ImageSignature, MIN_SIMILARITY_SCORE, redundancy_score,
        signature_for_thumbnail, signature_for_upload, similarity_score,
    },
    support::{BoundedCache, mutex_lock},
    thumbs::ThumbnailError,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Semaphore;
use tracing::error;

const DIVERSIFIED_SIMILARITY_RESULTS: usize = 120;
const REDUNDANCY_PENALTY_START: f32 = 0.86;
const MAX_REDUNDANCY_PENALTY: f32 = 0.08;
const SIMILARITY_RANKING_CACHE_LIMIT: usize = 8;

pub(super) const MAX_SEARCH_UPLOAD_BYTES: usize = 20 * 1024 * 1024;

static SIMILARITY_LIMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();
type SimilarityRanking = Arc<Vec<Arc<ImageRecord>>>;
type SimilarityRankingCache = Mutex<BoundedCache<SimilarityRanking>>;
static SIMILARITY_RANKING_CACHE: OnceLock<SimilarityRankingCache> = OnceLock::new();

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

#[derive(Debug, Default, Deserialize)]
pub(super) struct SimilarImagesQuery {
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

pub(super) async fn uploaded_similar_images(
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

pub(super) async fn similar_images(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diversity_penalty_can_surface_a_distinct_result() {
        assert_eq!(diversity_rank(0.94, REDUNDANCY_PENALTY_START), 0.94);
        assert!(diversity_rank(0.94, 0.0) > diversity_rank(0.99, 1.0));
        assert!(diversity_rank(0.99, 0.90) > diversity_rank(0.94, 0.0));
    }
}
