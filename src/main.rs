mod db;
mod scan;
mod thumbs;

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
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
use tower_http::{compression::CompressionLayer, trace::TraceLayer};

#[derive(Parser, Debug)]
#[command(about = "A small, fast gallery for very large local image collections")]
struct Args {
    #[arg(long, env = "GALLERY_ROOT", default_value = "./pictures")]
    root: PathBuf,
    #[arg(long, env = "GALLERY_DATA", default_value = "./data")]
    data: PathBuf,
    #[arg(long, env = "GALLERY_BIND", default_value = "127.0.0.1:3002")]
    bind: String,
}

struct AppState {
    root: PathBuf,
    data: PathBuf,
    db: db::Database,
    shutting_down: AtomicBool,
    warming_thumbnails: AtomicBool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("pixhelf=info".parse()?),
        )
        .init();
    let args = Args::parse();
    tokio::fs::create_dir_all(&args.root).await?;
    tokio::fs::create_dir_all(args.data.join("thumbs")).await?;
    let db = db::Database::open(args.data.join("gallery.sqlite"))?;
    let state = Arc::new(AppState {
        root: args.root,
        data: args.data,
        db,
        shutting_down: AtomicBool::new(false),
        warming_thumbnails: AtomicBool::new(false),
    });

    let initial = state.clone();
    tokio::task::spawn_blocking(move || scan::scan(&initial.root, &initial.db)).await??;

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
        .route("/api/scan", post(rescan))
        .route("/image/{id}", get(original))
        .route("/thumb/{id}", get(thumbnail))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(&args.bind)
        .await
        .with_context(|| format!("cannot bind {}", args.bind))?;
    warm_thumbnail_cache(state.clone());
    tracing::info!(address = %args.bind, "pixhelf ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown(state))
        .await?;
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
    match s.db.list(
        q.cursor,
        limit,
        q.q.as_deref(),
        q.folder.as_deref(),
        q.random.unwrap_or(false),
        q.seed.unwrap_or(1),
        q.offset.unwrap_or(0),
    ) {
        Ok(rows) => (StatusCode::OK, axum::Json(rows)).into_response(),
        Err(e) => error(e),
    }
}

async fn folders(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    match s.db.paths() {
        Ok(paths) => {
            let mut folders = std::collections::BTreeSet::new();
            for path in paths {
                let mut parts = path.split('/').collect::<Vec<_>>();
                parts.pop();
                for end in 1..=parts.len() {
                    folders.insert(parts[..end].join("/"));
                }
            }
            (
                StatusCode::OK,
                axum::Json(folders.into_iter().collect::<Vec<_>>()),
            )
                .into_response()
        }
        Err(e) => error(e),
    }
}

async fn stats(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    match s.db.stats() {
        Ok(v) => (StatusCode::OK, axum::Json(v)).into_response(),
        Err(e) => error(e),
    }
}

async fn rescan(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    let state = s.clone();
    match tokio::task::spawn_blocking(move || scan::scan(&state.root, &state.db)).await {
        Ok(Ok(count)) => {
            warm_thumbnail_cache(s);
            (
                StatusCode::OK,
                axum::Json(serde_json::json!({ "indexed": count })),
            )
                .into_response()
        }
        Ok(Err(e)) => error(e),
        Err(e) => error(e.into()),
    }
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

        let sources = match state.db.thumbnail_sources() {
            Ok(sources) => sources,
            Err(error) => {
                tracing::error!(%error, "cannot list thumbnails for cache warmup");
                return;
            }
        };
        let total = sources.len();
        let mut generated = 0usize;
        for (id, path) in sources {
            if state.shutting_down.load(Ordering::Acquire) {
                tracing::info!(generated, total, "thumbnail cache warmup cancelled");
                return;
            }
            let dest = state
                .data
                .join("thumbs")
                .join(format!("{id}-{}.webp", thumbs::SIZE));
            if dest.exists() {
                continue;
            }
            match thumbs::create(&state.root.join(path), &dest) {
                Ok(()) => generated += 1,
                Err(error) => tracing::warn!(id, %error, "thumbnail generation failed"),
            }
        }
        tracing::info!(generated, total, "thumbnail cache warmup complete");
    });
}

async fn original(State(s): State<Arc<AppState>>, Path(id): Path<i64>) -> Response {
    let Some(row) = s.db.by_id(id).ok().flatten() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    stream_file(s.root.join(row.path), row.mime, true).await
}

async fn thumbnail(State(s): State<Arc<AppState>>, Path(id): Path<i64>) -> Response {
    let Some(row) = s.db.by_id(id).ok().flatten() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let source = s.root.join(&row.path);
    let dest = s
        .data
        .join("thumbs")
        .join(format!("{id}-{}.webp", thumbs::SIZE));
    if !dest.exists() {
        let output = dest.clone();
        match tokio::task::spawn_blocking(move || thumbs::create(&source, &output)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return error(e),
            Err(e) => return error(e.into()),
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

async fn shutdown(state: Arc<AppState>) {
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

    state.shutting_down.store(true, Ordering::Release);
    tracing::info!("shutdown requested; cancelling thumbnail cache warmup");
}
