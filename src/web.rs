//! HTTP composition. Handlers and their caches live in the owning modules.
mod cache;
mod details;
pub(crate) mod duplicates;
mod frontend;
mod listing;
mod media;
mod models;
pub(crate) mod pagination;
mod readiness;
mod similarity;
mod video;

use crate::{
    auth::{self, AuthConfig, AuthState},
    gallery::GalleryIndex,
    thumbs::ThumbnailManager,
};
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, header},
    middleware,
    routing::{get, post},
};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::{
    compression::{CompressionLayer, CompressionLevel},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

pub(crate) use frontend::authentication_html;
pub(crate) use models::{ImageView, ImagesQuery};

#[derive(Clone)]
pub struct AppState {
    pub index: Arc<RwLock<Arc<GalleryIndex>>>,
    pub thumbnails: Arc<ThumbnailManager>,
}

pub fn router(state: AppState, config: AuthConfig) -> Router {
    let storage = crate::storage::router(state.thumbnails.settings_directory());
    let management = crate::management::router(state.clone());
    let authentication = AuthState::new(config);
    let session_layer = authentication.session_layer();
    let protected = Router::new()
        .route("/api/gallery", get(listing::gallery_summary))
        .route("/api/categories", get(crate::management::categories::read))
        .route("/api/images", get(listing::images))
        .route("/api/images/duplicates", get(duplicates::images))
        .route("/api/images/{id}", get(media::image))
        .route(
            "/api/images/similar",
            post(similarity::uploaded_similar_images)
                .layer(DefaultBodyLimit::max(similarity::MAX_SEARCH_UPLOAD_BYTES)),
        )
        .route("/api/images/{id}/details", get(details::image_details))
        .route("/api/images/{id}/similar", get(similarity::similar_images))
        .route("/api/status", get(listing::thumbnail_status))
        .route("/api/images/{id}/thumbnail", get(media::thumbnail))
        .route("/api/images/{id}/original", get(media::original))
        .route("/api/images/{id}/display", get(media::display_image))
        .route(
            "/api/images/{id}/video/{version}/{kind}",
            get(video::prepared_video),
        )
        .route(
            "/api/images/{id}/motion/original/{version}",
            get(video::motion_video),
        )
        .fallback(frontend::frontend)
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
        .route("/assets/{version}/{*path}", get(frontend::frontend_asset))
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

#[cfg(test)]
mod tests;
