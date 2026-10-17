//! HTTP validators shared by JSON, media and frontend responses.
use axum::{
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use tracing::error;

pub(super) fn with_cache_headers(
    mut response: Response,
    etag: &str,
    cache_control: &'static str,
) -> Response {
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

pub(super) fn revision_etag(kind: &str, revision: &str) -> String {
    format!("\"{kind}-{revision}\"")
}

pub(super) fn is_not_modified(headers: &HeaderMap, etag: &str) -> bool {
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

pub(super) fn not_modified(etag: &str, cache_control: &'static str) -> Response {
    with_cache_headers(
        StatusCode::NOT_MODIFIED.into_response(),
        etag,
        cache_control,
    )
}
