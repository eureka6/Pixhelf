mod config;
mod gallery;
mod thumbs;
mod web;

use std::sync::Arc;

use anyhow::{Context, Result, bail};
use config::Config;
use gallery::scan_gallery;
use thumbs::{ThumbnailManager, ViewerPreviewManager};
use tokio::{net::TcpListener, sync::RwLock};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;
use web::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("pixhelf=info,tower_http=info")),
        )
        .compact()
        .init();

    let config = Config::from_env_and_args()?;
    info!(gallery = %config.gallery_dir.display(), "scanning gallery");
    let gallery_dir = config.gallery_dir.clone();
    let index = tokio::task::spawn_blocking(move || scan_gallery(&gallery_dir, None))
        .await
        .context("gallery scan task stopped")??;
    if index.images.is_empty() {
        bail!(
            "no supported images found in {}",
            config.gallery_dir.display()
        );
    }
    info!(
        images = index.images.len(),
        albums = index.albums.len(),
        "gallery indexed"
    );

    let initial_ids: Vec<String> = index
        .images
        .iter()
        .take(config.initial_batch)
        .map(|record| record.id.clone())
        .collect();
    let index = Arc::new(RwLock::new(index));
    let thumbnails = ThumbnailManager::new(config.cache_dir.clone())?;
    let previews = ViewerPreviewManager::new(config.cache_dir.clone())?;
    {
        let current = index.read().await;
        thumbnails.reconcile(&current.images);
        previews.reconcile(&current.images);
    }
    thumbnails.start_workers(config.workers);
    let initial_thumbnail_manager = Arc::clone(&thumbnails);
    tokio::spawn(async move {
        initial_thumbnail_manager
            .prepare_initial(&initial_ids)
            .await;
    });

    let state = AppState {
        index: Arc::clone(&index),
        thumbnails: Arc::clone(&thumbnails),
        previews: Arc::clone(&previews),
    };
    let cleanup_manager = Arc::clone(&thumbnails);
    tokio::spawn(async move {
        cleanup_manager.cleanup_stale().await;
    });
    let preview_cleanup_manager = Arc::clone(&previews);
    tokio::spawn(async move {
        preview_cleanup_manager.cleanup_stale().await;
    });
    tokio::spawn(rescan_gallery(state.clone(), config.clone()));

    let listener = TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("cannot listen on {}", config.listen))?;
    info!(listen = %config.listen, "Pixhelf is ready");

    axum::serve(listener, web::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn rescan_gallery(state: AppState, config: Config) {
    loop {
        tokio::time::sleep(config.scan_interval).await;
        let previous = state.index.read().await.clone();
        let root = config.gallery_dir.clone();
        let previous_for_scan = previous.clone();
        let scan =
            tokio::task::spawn_blocking(move || scan_gallery(&root, Some(&previous_for_scan)))
                .await;

        let updated = match scan {
            Ok(Ok(index)) => index,
            Ok(Err(error)) => {
                error!(%error, "gallery rescan failed");
                continue;
            }
            Err(error) => {
                error!(%error, "gallery rescan task stopped");
                continue;
            }
        };
        if previous.same_revision(&updated) {
            continue;
        }

        let old_count = previous.images.len();
        let new_count = updated.images.len();
        state.thumbnails.reconcile(&updated.images);
        state.previews.reconcile(&updated.images);
        *state.index.write().await = updated;
        state.thumbnails.cleanup_stale().await;
        state.previews.cleanup_stale().await;
        info!(old_count, new_count, "gallery changes indexed");
    }
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        error!(%error, "cannot install shutdown handler");
    }
}
