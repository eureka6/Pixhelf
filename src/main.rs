mod db;
mod scan;
mod thumbs;

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::Context;
use axum::{
    Router,
    body::Body,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use clap::Parser;
use serde::Deserialize;
use tokio::fs::File;
use tokio_util::io::ReaderStream;
use tower_http::{
    classify::ServerErrorsFailureClass, compression::CompressionLayer, trace::TraceLayer,
};

const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_millis(750);
const RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Parser, Debug)]
#[command(about = "A small, fast gallery for very large local image collections")]
struct Args {
    #[arg(long, env = "GALLERY_ROOT", default_value = "./pictures")]
    root: PathBuf,
    #[arg(long, env = "GALLERY_DATA", default_value = "./data")]
    data: PathBuf,
    #[arg(long, env = "GALLERY_BIND", default_value = "127.0.0.1:3002")]
    bind: String,
    #[arg(long, env = "GALLERY_WORKER_THREADS", default_value_t = 0)]
    worker_threads: usize,
    #[arg(long, env = "GALLERY_SCAN_THREADS", default_value_t = 0)]
    scan_threads: usize,
    #[arg(long, env = "GALLERY_THUMBNAIL_THREADS", default_value_t = 0)]
    thumbnail_threads: usize,
}

#[derive(Clone, Copy)]
struct ThreadConfig {
    available: usize,
    runtime: usize,
    blocking: usize,
    scan: usize,
    thumbnails: usize,
}

impl ThreadConfig {
    fn resolve(args: &Args) -> Self {
        let available = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        Self::from_values(
            available,
            args.worker_threads,
            args.scan_threads,
            args.thumbnail_threads,
        )
    }

    fn from_values(
        available: usize,
        requested_runtime: usize,
        requested_scan: usize,
        requested_thumbnails: usize,
    ) -> Self {
        let available = available.max(1);
        let runtime = if requested_runtime == 0 {
            available.min(8)
        } else {
            requested_runtime.clamp(1, 32)
        };
        let scan = if requested_scan == 0 {
            available.min(8)
        } else {
            requested_scan.clamp(1, 32)
        };
        let thumbnails = if requested_thumbnails == 0 {
            available.div_ceil(2).clamp(1, 3)
        } else {
            requested_thumbnails.clamp(1, 8)
        };
        let blocking = (runtime + thumbnails + 2).clamp(4, 24);
        Self {
            available,
            runtime,
            blocking,
            scan,
            thumbnails,
        }
    }
}

struct AppState {
    root: PathBuf,
    data: PathBuf,
    db: db::Database,
    shutting_down: AtomicBool,
    warming_thumbnails: AtomicBool,
    scan_threads: usize,
    scanning: AtomicBool,
    last_scan_removed: AtomicU64,
    database_slot: tokio::sync::Semaphore,
    thumbnail_parallelism: usize,
    thumbnail_slots: tokio::sync::Semaphore,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let threads = ThreadConfig::resolve(&args);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads.runtime)
        .max_blocking_threads(threads.blocking)
        .thread_name("pixhelf-io")
        .enable_all()
        .build()?;
    let result = runtime.block_on(run(args, threads));
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN_TIMEOUT);
    result
}

async fn run(args: Args, threads: ThreadConfig) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("pixhelf=info".parse()?),
        )
        .init();
    tracing::info!(
        available_cpus = threads.available,
        runtime_threads = threads.runtime,
        blocking_threads = threads.blocking,
        scan_threads = threads.scan,
        thumbnail_threads = threads.thumbnails,
        "thread budgets configured"
    );
    tokio::fs::create_dir_all(&args.root).await?;
    tokio::fs::create_dir_all(args.data.join("thumbs")).await?;
    let db = db::Database::open(args.data.join("gallery.sqlite"))?;
    let state = Arc::new(AppState {
        root: args.root,
        data: args.data,
        db,
        shutting_down: AtomicBool::new(false),
        warming_thumbnails: AtomicBool::new(false),
        scan_threads: threads.scan,
        scanning: AtomicBool::new(true),
        last_scan_removed: AtomicU64::new(0),
        database_slot: tokio::sync::Semaphore::new(1),
        thumbnail_parallelism: threads.thumbnails,
        thumbnail_slots: tokio::sync::Semaphore::new(threads.thumbnails),
    });

    let bootstrap_scan = state.db.stats()?.images == 0;
    let trace_state = state.clone();

    let app = Router::new()
        .route("/", get(index))
        .route(
            "/favicon.svg",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/svg+xml")],
                    include_str!("../assets/favicon.svg"),
                )
            }),
        )
        .route(
            "/assets/app.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../assets/app.css"),
                )
            }),
        )
        .route(
            "/assets/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../assets/app.js"),
                )
            }),
        )
        .route(
            "/assets/stage.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../assets/stage.css"),
                )
            }),
        )
        .route("/api/images", get(list_images))
        .route("/api/folders", get(folders))
        .route("/api/stats", get(stats))
        .route("/api/config", get(config))
        .route("/api/scan", post(rescan))
        .route("/image/{id}", get(original))
        .route("/thumb/{id}", get(thumbnail))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http().on_failure(
            move |classification: ServerErrorsFailureClass,
                  latency: Duration,
                  _span: &tracing::Span| {
                if trace_state.shutting_down.load(Ordering::Acquire) {
                    tracing::debug!(
                        %classification,
                        latency_milliseconds = latency.as_millis(),
                        "request cancelled during shutdown"
                    );
                } else {
                    tracing::error!(
                        %classification,
                        latency_milliseconds = latency.as_millis(),
                        "response failed"
                    );
                }
            },
        ))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(&args.bind)
        .await
        .with_context(|| format!("cannot bind {}", args.bind))?;
    start_initial_scan(state.clone(), bootstrap_scan);
    tracing::info!(address = %args.bind, "pixhelf ready");
    let shutdown_requested = {
        let (shutdown_sender, shutdown_receiver) = tokio::sync::oneshot::channel();
        let server = async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_receiver.await;
                })
                .await
        };
        tokio::pin!(server);

        tokio::select! {
            result = &mut server => {
                result?;
                false
            },
            _ = wait_for_shutdown_signal() => {
                state.shutting_down.store(true, Ordering::Release);
                // Wake thumbnail requests queued behind generation slots. Their
                // shutdown-only 503 responses are filtered from error logging.
                state.thumbnail_slots.close();
                tracing::info!(
                    drain_milliseconds = SHUTDOWN_DRAIN_TIMEOUT.as_millis(),
                    "shutdown requested; briefly draining active requests"
                );
                let _ = shutdown_sender.send(());
                tokio::select! {
                    result = &mut server => result?,
                    _ = wait_for_shutdown_signal() => {
                        tracing::warn!("second shutdown signal received; closing immediately");
                    }
                    _ = tokio::time::sleep(SHUTDOWN_DRAIN_TIMEOUT) => {
                        tracing::info!("closing remaining image transfers");
                    }
                }
                true
            }
        }
    };
    state.database_slot.close();
    state.thumbnail_slots.close();
    if shutdown_requested {
        tracing::info!("shutdown complete");
    }
    Ok(())
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../assets/index.html"))
}

#[derive(Deserialize)]
struct ListQuery {
    cursor: Option<i64>,
    limit: Option<u32>,
    q: Option<String>,
    folder: Option<String>,
    random: Option<bool>,
    seed: Option<i64>,
    offset: Option<u32>,
}

async fn list_images(
    State(s): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(40).clamp(1, 100);
    let db = s.db.clone();
    match run_database(&s, move || {
        db.list(
            q.cursor,
            limit,
            q.q.as_deref(),
            q.folder.as_deref(),
            q.random.unwrap_or(false),
            q.seed.unwrap_or(1),
            q.offset.unwrap_or(0),
        )
    })
    .await
    {
        Ok(rows) => (StatusCode::OK, axum::Json(rows)).into_response(),
        Err(e) => error(e),
    }
}

async fn folders(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    let db = s.db.clone();
    match run_database(&s, move || db.folders()).await {
        Ok(folders) => (StatusCode::OK, axum::Json(folders)).into_response(),
        Err(e) => error(e),
    }
}

async fn stats(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    let db = s.db.clone();
    match run_database(&s, move || db.stats()).await {
        Ok(v) => (StatusCode::OK, axum::Json(v)).into_response(),
        Err(e) => error(e),
    }
}

async fn config(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "scanning": s.scanning.load(Ordering::Acquire),
        "last_scan_removed": s.last_scan_removed.load(Ordering::Acquire)
    }))
}

async fn rescan(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    if s.scanning
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({ "error": "scan already running" })),
        )
            .into_response();
    }

    s.last_scan_removed.store(0, Ordering::Release);
    let receiver = match spawn_scan(s.clone(), scan::ScanMode::Refresh) {
        Ok(receiver) => receiver,
        Err(spawn_error) => {
            s.scanning.store(false, Ordering::Release);
            return error(spawn_error);
        }
    };
    let result = receiver.await;
    match result {
        Ok(Ok(summary)) => {
            warm_thumbnail_cache(s);
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({
                    "indexed": summary.indexed,
                    "removed": summary.removed
                })),
            )
                .into_response()
        }
        Ok(Err(e)) => error(e),
        Err(e) => error(e.into()),
    }
}

fn start_initial_scan(state: Arc<AppState>, bootstrap: bool) {
    let mode = if bootstrap {
        scan::ScanMode::Bootstrap
    } else {
        scan::ScanMode::Refresh
    };
    let complete_receiver = match spawn_scan(state.clone(), mode) {
        Ok(receiver) => receiver,
        Err(error) => {
            state.scanning.store(false, Ordering::Release);
            tracing::error!(%error, "cannot start background scan");
            return;
        }
    };

    tokio::spawn(async move {
        let succeeded = match complete_receiver.await {
            Ok(Ok(_summary)) => true,
            Ok(Err(error)) => {
                if state.shutting_down.load(Ordering::Acquire) {
                    tracing::info!("background scan cancelled");
                } else {
                    tracing::error!(%error, "background scan failed");
                }
                false
            }
            Err(error) => {
                tracing::error!(%error, "background scan stopped");
                false
            }
        };
        if succeeded {
            warm_thumbnail_cache(state);
        }
    });
}

fn spawn_scan(
    state: Arc<AppState>,
    mode: scan::ScanMode,
) -> anyhow::Result<tokio::sync::oneshot::Receiver<anyhow::Result<scan::ScanSummary>>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("pixhelf-scan".into())
        .spawn(move || {
            let result = scan::scan_with_cancel(
                &state.root,
                &state.db,
                state.scan_threads,
                mode,
                &state.shutting_down,
            );
            if let Ok(summary) = &result {
                state
                    .last_scan_removed
                    .store(summary.removed, Ordering::Release);
            }
            state.scanning.store(false, Ordering::Release);
            let _ = sender.send(result);
        })?;
    Ok(receiver)
}

fn warm_thumbnail_cache(state: Arc<AppState>) {
    if state.shutting_down.load(Ordering::Acquire)
        || state.warming_thumbnails.swap(true, Ordering::AcqRel)
    {
        return;
    }

    // Keep this work outside Tokio's blocking pool. Tokio waits indefinitely for
    // started blocking tasks while its runtime shuts down, which otherwise makes
    // Ctrl-C finish the entire thumbnail queue before the process can exit.
    std::thread::spawn(move || {
        struct WarmupGuard<'a>(&'a AtomicBool);
        impl Drop for WarmupGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = WarmupGuard(&state.warming_thumbnails);

        // Give visible, request-driven thumbnails a head start after scanning.
        std::thread::sleep(Duration::from_secs(2));
        if state.shutting_down.load(Ordering::Acquire) {
            return;
        }

        let total = match state.db.stats() {
            Ok(stats) => stats.images as usize,
            Err(error) => {
                tracing::error!(%error, "cannot count thumbnails for cache warmup");
                return;
            }
        };
        let mut generated = 0usize;
        let mut failed = 0usize;
        let mut cursor = 0i64;
        loop {
            if state.shutting_down.load(Ordering::Acquire) {
                tracing::info!(generated, failed, total, "thumbnail cache warmup cancelled");
                return;
            }
            let sources = match state.db.thumbnail_sources_after(cursor, 512) {
                Ok(sources) => sources,
                Err(error) => {
                    tracing::error!(%error, "cannot list thumbnails for cache warmup");
                    return;
                }
            };
            if sources.is_empty() {
                break;
            }
            for (id, path) in sources {
                cursor = id;
                if state.shutting_down.load(Ordering::Acquire) {
                    tracing::info!(generated, failed, total, "thumbnail cache warmup cancelled");
                    return;
                }
                let relative = PathBuf::from(path);
                let source = state.root.join(&relative);
                let dest = thumbs::cache_path(&state.data.join("thumbs"), &relative);
                if thumbs::is_fresh(&source, &dest) {
                    continue;
                }
                // Warmup yields whenever foreground generation owns a slot.
                while state.thumbnail_slots.available_permits() < state.thumbnail_parallelism {
                    if state.shutting_down.load(Ordering::Acquire) {
                        tracing::info!(
                            generated,
                            failed,
                            total,
                            "thumbnail cache warmup cancelled"
                        );
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                let Ok(_permit) = state.thumbnail_slots.try_acquire() else {
                    continue;
                };
                match thumbs::create(&source, &dest) {
                    Ok(()) => generated += 1,
                    Err(error) => {
                        failed += 1;
                        tracing::debug!(id, %error, "thumbnail generation failed");
                    }
                }
            }
        }
        tracing::info!(generated, failed, total, "thumbnail cache warmup complete");
    });
}

async fn original(State(s): State<Arc<AppState>>, Path(id): Path<i64>) -> Response {
    let db = s.db.clone();
    let Ok(Some(row)) = run_database(&s, move || db.by_id(id)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    stream_file(s.root.join(row.path), row.mime, true).await
}

async fn thumbnail(State(s): State<Arc<AppState>>, Path(id): Path<i64>) -> Response {
    let db = s.db.clone();
    let Ok(Some(row)) = run_database(&s, move || db.by_id(id)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let relative = PathBuf::from(row.path);
    let source = s.root.join(&relative);
    let dest = thumbs::cache_path(&s.data.join("thumbs"), &relative);
    if !thumbs::is_fresh(&source, &dest) {
        let Ok(_permit) = s.thumbnail_slots.acquire().await else {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        };
        if thumbs::is_fresh(&source, &dest) {
            return stream_file(dest, "image/webp".into(), false).await;
        }
        let output = dest.clone();
        match tokio::task::spawn_blocking(move || thumbs::create(&source, &output)).await {
            Ok(Ok(())) => {}
            Ok(Err(error_value)) => return error(error_value),
            Err(error_value) => return error(error_value.into()),
        }
    }
    stream_file(dest, "image/webp".into(), false).await
}

async fn stream_file(path: PathBuf, mime: String, original: bool) -> Response {
    match File::open(path).await {
        Ok(file) => {
            let content_length = file.metadata().await.ok().map(|metadata| metadata.len());
            let cache = if original {
                "private, max-age=3600"
            } else {
                "public, max-age=31536000, immutable"
            };
            let mut response = Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, cache)
                .header("X-Content-Type-Options", "nosniff");
            if let Some(content_length) = content_length {
                response = response.header(header::CONTENT_LENGTH, content_length);
            }
            response
                .body(Body::from_stream(ReaderStream::new(file)))
                .unwrap()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

fn error(e: anyhow::Error) -> Response {
    tracing::error!(error = %e, "request failed");
    (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
}

async fn run_blocking<T, F>(operation: F) -> anyhow::Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation).await?
}

async fn run_database<T, F>(state: &AppState, operation: F) -> anyhow::Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    let _permit = state
        .database_slot
        .acquire()
        .await
        .map_err(|_| anyhow::anyhow!("database scheduler closed"))?;
    run_blocking(operation).await
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(error) => {
                tracing::warn!(%error, "cannot install SIGTERM handler");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::ThreadConfig;

    #[test]
    fn automatic_thread_budgets_scale_without_unbounded_growth() {
        let single = ThreadConfig::from_values(1, 0, 0, 0);
        assert_eq!(
            (
                single.runtime,
                single.blocking,
                single.scan,
                single.thumbnails
            ),
            (1, 4, 1, 1)
        );

        let many = ThreadConfig::from_values(16, 0, 0, 0);
        assert_eq!(
            (many.runtime, many.blocking, many.scan, many.thumbnails),
            (8, 13, 8, 3)
        );
    }

    #[test]
    fn explicit_thread_budgets_are_safely_bounded() {
        let threads = ThreadConfig::from_values(4, 100, 100, 100);
        assert_eq!(
            (
                threads.runtime,
                threads.blocking,
                threads.scan,
                threads.thumbnails
            ),
            (32, 24, 32, 8)
        );
    }
}
