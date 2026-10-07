mod assets;
mod auth;
mod background;
mod config;
mod gallery;
mod heif;
mod logging;
mod management;
mod motion;
mod photo_details;
mod similarity;
mod storage;
mod support;
mod text_search;
mod thumbs;
mod video;
mod video_jobs;
mod web;

use std::{process::ExitCode, sync::Arc};

use anyhow::{Context, Result};
use config::Config;
use gallery::GalleryIndex;
use thumbs::ThumbnailManager;
use tokio::{net::TcpListener, sync::RwLock};
use tracing::{error, info, warn};
use web::AppState;

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
    let thumbnails = ThumbnailManager::new_with_text_search(config.cache_dir.clone(), None)?;
    let state = AppState {
        index: Arc::new(RwLock::new(Arc::new(GalleryIndex::pending(
            config.gallery_dir.clone(),
        )))),
        thumbnails: Arc::clone(&thumbnails),
    };
    let application = web::router(state.clone(), config.auth.clone());
    info!(listen = %listener.local_addr()?, "服务已就绪");
    if config.auth.setup.is_some() {
        info!("首次使用：打开网页，创建管理员账号即可进入图库");
    } else if config.auth.enabled() {
        info!("登录保护已启用");
    } else {
        warn!("内置登录已关闭，请通过带认证的反向代理保护图库");
    }

    info!(path = %config.gallery_dir.display(), "后台扫描图库");
    let background = tokio::spawn(background::run(state, config));

    let shutdown_videos = Arc::clone(&thumbnails.videos);
    axum::serve(
        listener,
        application.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        shutdown_videos.shutdown();
    })
    .await?;
    background.abort();
    info!("Pixhelf 已停止");
    Ok(())
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
