//! Gallery listings, filename search and semantic text ranking.
use super::{
    cache::{is_not_modified, not_modified, revision_etag, with_cache_headers},
    models::{GallerySummary, ImageRequest, ImageSort, ImageView, ImagesQuery, ImagesResponse},
    pagination::{self, finish_page, image_page},
};
use crate::{
    gallery::{GalleryIndex, ImageRecord},
    management::sharing::ReadState,
    support::{BoundedCache, mutex_lock},
    text_search::{TextSearchEmbedding, text_image_similarity},
    thumbs::ThumbnailStatus,
};
use axum::{
    Json,
    extract::Query,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use std::sync::{Arc, Mutex, OnceLock};
use tracing::error;

const TEXT_SEARCH_RANKING_CACHE_LIMIT: usize = 16;
const TEXT_SEARCH_RESULT_LIMIT: usize = 600;
const FILENAME_MATCH_BOOST: f32 = 3.0;

type TextSearchRanking = Arc<Vec<Arc<ImageRecord>>>;
type TextSearchRankingCache = Mutex<BoundedCache<TextSearchRanking>>;
static TEXT_SEARCH_RANKING_CACHE: OnceLock<TextSearchRankingCache> = OnceLock::new();

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

pub(super) async fn gallery_summary(ReadState(state): ReadState, headers: HeaderMap) -> Response {
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

pub(super) fn summary_from_index(index: &GalleryIndex) -> GallerySummary {
    GallerySummary {
        total: index.images.len(),
        albums: index.albums.clone(),
        revision: index.revision.clone(),
        initializing: index.initializing,
    }
}

pub(super) async fn images(
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

pub(super) async fn thumbnail_status(ReadState(state): ReadState) -> Response {
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

#[cfg(test)]
mod tests {
    use super::*;

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
                motion: None,
                video: None,
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
}
