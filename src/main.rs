mod config;
mod gallery;
mod semantic;
mod similarity;
mod text_search;
mod thumbs;
mod web;

use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use config::Config;
use gallery::{GalleryIndex, scan_gallery};
use semantic::SemanticIndex;
use text_search::TextSearchIndex;
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
    let index = scan_gallery_async(config.gallery_dir.clone(), None).await?;
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
    let index = Arc::new(RwLock::new(Arc::new(index)));
    let semantic = match config.semantic_model.as_deref() {
        Some(model_path) => match SemanticIndex::load(model_path) {
            Ok(index) => Some(index),
            Err(error) => {
                warn!(path = %model_path.display(), %error, "semantic model unavailable; using local visual fallback");
                None
            }
        },
        None => None,
    };
    let text_search = match config.text_search.as_ref() {
        Some(files) => match TextSearchIndex::load(&files.model, &files.vocabulary) {
            Ok(index) => Some(index),
            Err(error) => {
                warn!(
                    model = %files.model.display(),
                    vocabulary = %files.vocabulary.display(),
                    %error,
                    "natural-language search model unavailable; using filename search"
                );
                None
            }
        },
        None => None,
    };
    let thumbnails = ThumbnailManager::new_with_indexes(
        config.cache_dir.clone(),
        semantic.as_ref().map(Arc::clone),
        text_search.as_ref().map(Arc::clone),
    )?;
    {
        let current = index.read().await;
        thumbnails.reconcile(&current.images);
    }
    thumbnails.start_workers(config.workers);
    if let Some(semantic) = semantic {
        semantic.start_worker();
    }
    if let Some(text_search) = text_search {
        text_search.start_worker();
    }
    thumbnails.start_similarity_warmup();
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
        let previous = {
            let index = state.index.read().await;
            Arc::clone(&index)
        };
        let old_count = previous.images.len();
        let root = config.gallery_dir.clone();
        let updated = match scan_gallery_async(root, Some(Arc::clone(&previous))).await {
            Ok(updated) => updated,
            Err(error) => {
                error!(%error, "gallery rescan failed");
                continue;
            }
        };
        if previous.revision == updated.revision {
            continue;
        }

        let new_count = updated.images.len();
        state.thumbnails.reconcile(&updated.images);
        state.thumbnails.start_similarity_warmup();
        *state.index.write().await = Arc::new(updated);
        state.thumbnails.cleanup_stale().await;
        info!(old_count, new_count, "gallery changes indexed");
    }
}

async fn scan_gallery_async(
    root: PathBuf,
    previous: Option<Arc<GalleryIndex>>,
) -> Result<GalleryIndex> {
    tokio::task::spawn_blocking(move || scan_gallery(&root, previous.as_deref()))
        .await
        .context("gallery scan task stopped")?
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
