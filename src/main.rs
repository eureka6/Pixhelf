mod config;
mod gallery;
mod thumbs;
mod web;

use std::sync::Arc;

use anyhow::{Context, Result};
use config::Config;
use gallery::scan_gallery;
use thumbs::ThumbnailManager;
use tokio::{net::TcpListener, sync::RwLock};
use tracing::{error, info, warn};
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
        warn!(
            gallery = %config.gallery_dir.display(),
            "gallery is empty; waiting for supported images"
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
    {
        let current = index.read().await;
        thumbnails.reconcile(&current.images);
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
    };
    let cleanup_manager = Arc::clone(&thumbnails);
    tokio::spawn(async move {
        cleanup_manager.cleanup_stale().await;
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
        let scan = tokio::task::spawn_blocking(move || {
            let updated = scan_gallery(&root, Some(&previous));
            (previous, updated)
        })
        .await;

        let (previous, updated) = match scan {
            Ok((previous, Ok(updated))) => (previous, updated),
            Ok((_, Err(error))) => {
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
        *state.index.write().await = updated;
        state.thumbnails.cleanup_stale().await;
        info!(old_count, new_count, "gallery changes indexed");
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    () = wait_for_ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(error) => {
                error!(%error, "cannot install SIGTERM handler");
                wait_for_ctrl_c().await;
            }
        }
    }

    #[cfg(not(unix))]
    wait_for_ctrl_c().await;
}

async fn wait_for_ctrl_c() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        error!(%error, "cannot install shutdown handler");
        std::future::pending::<()>().await;
    }
}
