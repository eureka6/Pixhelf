mod auth;
mod config;
mod gallery;
mod logging;
mod motion;
mod photo_details;
mod similarity;
mod storage;
mod support;
mod text_search;
mod thumbs;
mod web;

use std::{path::PathBuf, process::ExitCode, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use config::{Config, TextSearchFiles, TextSearchSource};
use gallery::{GalleryIndex, scan_gallery};
use text_search::TextSearchIndex;
use thumbs::ThumbnailManager;
use tokio::{net::TcpListener, sync::RwLock};
use tracing::{error, info, warn};
use web::AppState;

const AUTOMATIC_MODEL_RETRY_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[tokio::main]
async fn main() -> ExitCode {
    logging::init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            error!(
                target: logging::FATAL_TARGET,
                error = %format!("{error:#}"),
                "Pixhelf 运行失败"
            );
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--hash-password") {
        anyhow::ensure!(
            std::env::args().len() == 2,
            "--hash-password does not accept arguments; enter the password at the prompt or via stdin"
        );
        return auth::print_password_hash();
    }
    let config = Config::from_env_and_args()?;
    // Fail before scanning or displaying setup instructions if the port cannot be bound.
    let listener = TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("cannot listen on {}", config.listen))?;
    info!(version = env!("CARGO_PKG_VERSION"), "启动 Pixhelf");
    info!(path = %config.gallery_dir.display(), "扫描图库");
    let index = scan_gallery_async(config.gallery_dir.clone(), None).await?;
    if index.images.is_empty() {
        warn!(
            gallery = %config.gallery_dir.display(),
            "图库为空，添加 JPEG、PNG 或 WebP 图片后会自动更新"
        );
    }
    info!(
        images = index.images.len(),
        albums = index.albums.len(),
        "图库扫描完成"
    );

    let initial_ids: Vec<String> = index
        .images
        .iter()
        .take(config.initial_batch)
        .map(|record| record.id.clone())
        .collect();
    let index = Arc::new(RwLock::new(Arc::new(index)));
    let (text_search, automatic_text_search) = match config.text_search.as_ref() {
        Some(TextSearchSource::Local(files)) => (load_text_search(files), None),
        Some(TextSearchSource::AutoDownload(files)) => (None, Some(files.clone())),
        None => (None, None),
    };
    let thumbnails = ThumbnailManager::new_with_text_search(
        config.cache_dir.clone(),
        text_search.as_ref().map(Arc::clone),
    )?;
    {
        let current = index.read().await;
        thumbnails.reconcile(&current.images);
    }
    info!(listen = %listener.local_addr()?, "服务已就绪");
    if config.auth.setup.is_some() {
        info!("首次使用：打开网页，创建管理员账号即可进入图库");
    } else if config.auth.enabled() {
        info!("登录保护已启用");
    } else {
        warn!("内置登录已关闭，请通过带认证的反向代理保护图库");
    }

    // Keep the startup and setup messages together, before background workers can log.
    thumbnails.start_workers(config.workers);
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

    if let Some(files) = automatic_text_search {
        start_automatic_text_search(Arc::clone(&thumbnails), files);
    }

    axum::serve(
        listener,
        web::router(state, config.auth)
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    info!("Pixhelf 已停止");
    Ok(())
}

fn load_text_search(files: &TextSearchFiles) -> Option<Arc<TextSearchIndex>> {
    match TextSearchIndex::load(&files.model, &files.vocabulary) {
        Ok(index) => {
            info!("文字搜图已启用，模型将按需加载");
            Some(index)
        }
        Err(error) => {
            warn!(
                model = %files.model.display(),
                vocabulary = %files.vocabulary.display(),
                %error,
                "文字搜图模型不可用，继续使用文件名搜索"
            );
            None
        }
    }
}

fn start_automatic_text_search(thumbnails: Arc<ThumbnailManager>, files: TextSearchFiles) {
    tokio::spawn(async move {
        loop {
            match prepare_automatic_text_search(&files).await {
                Ok(index) => {
                    if thumbnails.enable_text_search(index) {
                        info!("文字搜图已启用，模型将按需加载");
                    }
                    return;
                }
                Err(error) => {
                    warn!(
                        retry_seconds = AUTOMATIC_MODEL_RETRY_INTERVAL.as_secs(),
                        error = %format!("{error:#}"),
                        "文字搜图模型准备失败，稍后自动重试；文件名搜索仍可用"
                    );
                    tokio::time::sleep(AUTOMATIC_MODEL_RETRY_INTERVAL).await;
                }
            }
        }
    });
}

async fn prepare_automatic_text_search(files: &TextSearchFiles) -> Result<Arc<TextSearchIndex>> {
    text_search::ensure_automatic_model(files).await?;
    let model = files.model.clone();
    let vocabulary = files.vocabulary.clone();
    tokio::task::spawn_blocking(move || TextSearchIndex::load(&model, &vocabulary))
        .await
        .context("natural-language search setup task stopped")?
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
                error!(%error, "图库刷新失败，保留上一次索引");
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
        info!(previous = old_count, images = new_count, "图库已更新");
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
                error!(%error, "无法监听 SIGTERM 停止信号");
                wait_for_ctrl_c().await;
            }
        }
    }

    #[cfg(not(unix))]
    wait_for_ctrl_c().await;

    info!("收到停止信号，正在结束服务");
}

async fn wait_for_ctrl_c() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        error!(%error, "无法监听停止信号");
        std::future::pending::<()>().await;
    }
}
