use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use tracing::{error, info, warn};

use crate::{
    config::{Config, TextSearchSource},
    gallery::{GalleryIndex, scan_gallery},
    text_search::{self, TextSearchIndex},
    thumbs::ThumbnailManager,
    web::AppState,
};

const AUTOMATIC_MODEL_RETRY_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Serve authentication immediately; publish the first gallery only when its
/// media index and cache entries are ready. Never clean caches against an empty index.
pub async fn run(state: AppState, config: Config) {
    loop {
        let root = config.gallery_dir.clone();
        let manager = Arc::clone(&state.thumbnails);
        let scanned = tokio::task::spawn_blocking(move || -> Result<GalleryIndex> {
            manager.cleanup_startup();
            let index = scan_gallery(&root, None)?;
            manager.reconcile(&index.images);
            Ok(index)
        })
        .await
        .context("gallery initialization task stopped")
        .and_then(|result| result);
        let index = match scanned {
            Ok(index) => index,
            Err(error) => {
                error!(%error, "图库初始化失败，稍后重试");
                tokio::time::sleep(config.scan_interval).await;
                continue;
            }
        };
        let initial_ids = index
            .images
            .iter()
            .take(config.initial_batch)
            .map(|record| record.id.clone())
            .collect::<Vec<_>>();
        if index.images.is_empty() {
            warn!(gallery = %config.gallery_dir.display(), "图库为空，添加 JPEG、PNG、WebP、GIF、HEIC 图片或视频后会自动更新");
        }
        info!(
            images = index.images.len(),
            albums = index.albums.len(),
            "图库扫描完成"
        );
        *state.index.write().await = Arc::new(index);
        state.thumbnails.start_workers(config.workers);
        state.thumbnails.start_similarity_warmup();
        let manager = Arc::clone(&state.thumbnails);
        tokio::spawn(async move {
            manager.prepare_initial(&initial_ids).await;
        });
        break;
    }

    if let Some(source) = config.text_search.clone() {
        tokio::spawn(prepare_text_search(Arc::clone(&state.thumbnails), source));
    }
    state.thumbnails.cleanup_stale().await;
    rescan_gallery(state, config).await;
}

async fn prepare_text_search(thumbnails: Arc<ThumbnailManager>, source: TextSearchSource) {
    let (files, automatic) = match source {
        TextSearchSource::Local(files) => (files, false),
        TextSearchSource::AutoDownload(files) => (files, true),
    };
    loop {
        let prepared: Result<bool> = async {
            if automatic {
                text_search::ensure_automatic_model(&files).await?;
            }
            let files = files.clone();
            let manager = Arc::clone(&thumbnails);
            tokio::task::spawn_blocking(move || {
                let index = TextSearchIndex::load(&files.model, &files.vocabulary)?;
                Ok(manager.enable_text_search(index))
            })
            .await
            .context("natural-language search setup task stopped")?
        }
        .await;
        match prepared {
            Ok(enabled) => {
                if enabled {
                    info!("文字搜图已启用，模型将按需加载");
                }
                return;
            }
            Err(error) if automatic => {
                warn!(
                    retry_seconds = AUTOMATIC_MODEL_RETRY_INTERVAL.as_secs(),
                    error = %format!("{error:#}"),
                    "文字搜图模型准备失败，稍后自动重试；文件名搜索仍可用"
                );
                tokio::time::sleep(AUTOMATIC_MODEL_RETRY_INTERVAL).await;
            }
            Err(error) => {
                warn!(error = %format!("{error:#}"), "文字搜图模型不可用，继续使用文件名搜索");
                return;
            }
        }
    }
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
        let snapshot = Arc::clone(&previous);
        let scanned = tokio::task::spawn_blocking(move || scan_gallery(&root, Some(&snapshot)))
            .await
            .context("gallery scan task stopped")
            .and_then(|result| result);
        let updated = match scanned {
            Ok(updated) => updated,
            Err(error) => {
                error!(%error, "图库刷新失败，保留上一次索引");
                continue;
            }
        };
        if previous.revision == updated.revision {
            continue;
        }

        let new_count = updated.images.len();
        let mut current = state.index.write().await;
        // A management operation may have replaced the index during this scan.
        if !Arc::ptr_eq(&previous, &current) {
            continue;
        }
        let updated = Arc::new(updated);
        let manager = Arc::clone(&state.thumbnails);
        let records = Arc::clone(&updated);
        if let Err(error) =
            tokio::task::spawn_blocking(move || manager.reconcile(&records.images)).await
        {
            error!(%error, "缩略图索引刷新失败");
            continue;
        }
        state.thumbnails.start_similarity_warmup();
        *current = updated;
        drop(current);
        state.thumbnails.cleanup_stale().await;
        info!(previous = old_count, images = new_count, "图库已更新");
    }
}
