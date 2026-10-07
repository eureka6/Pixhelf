use axum::{
    Json,
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::AppState;

/// Authentication runs before this guard. Clients can log in and poll progress
/// while the first scan runs, but cannot read or mutate a partial gallery.
pub(super) async fn require_ready(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let progress = matches!(
        request.uri().path(),
        "/" | "/api/gallery" | "/api/status" | "/api/categories"
    );
    if !progress && state.index.read().await.initializing {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [
                (header::RETRY_AFTER, "1"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            Json(serde_json::json!({"error": "图库正在准备，请稍后重试"})),
        )
            .into_response();
    }
    next.run(request).await
}
