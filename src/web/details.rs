//! Metadata and histogram responses with a bounded cache.
use super::cache::{is_not_modified, not_modified, with_cache_headers};
use crate::{
    management::sharing::ReadState,
    photo_details::PhotoDetails,
    support::{BoundedCache, mutex_lock},
    thumbs::ThumbnailError,
};
use axum::{
    Json,
    extract::Path,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::sync::{Arc, Mutex, OnceLock};
use tracing::error;

const PHOTO_DETAILS_CACHE_LIMIT: usize = 64;

type PhotoDetailsCache = Mutex<BoundedCache<Arc<PhotoDetails>>>;
static PHOTO_DETAILS_CACHE: OnceLock<PhotoDetailsCache> = OnceLock::new();

fn photo_details_cache() -> &'static PhotoDetailsCache {
    PHOTO_DETAILS_CACHE.get_or_init(|| Mutex::new(BoundedCache::new(PHOTO_DETAILS_CACHE_LIMIT)))
}

fn cached_photo_details(key: &str) -> Option<Arc<PhotoDetails>> {
    mutex_lock(photo_details_cache()).get_cloned(key)
}

fn cache_photo_details(key: String, details: Arc<PhotoDetails>) {
    mutex_lock(photo_details_cache()).insert(key, details);
}

pub(super) async fn image_details(
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
