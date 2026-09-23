use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, Seek},
    pin::Pin,
    sync::Arc,
    task::{Context as TaskContext, Poll},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderValue, header},
    response::Response,
};
use futures_core::Stream;
use tokio::sync::OwnedSemaphorePermit;
use tokio_util::io::ReaderStream;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use super::{
    Failure, Management, Selection, SelectionKind, albums, files, private_json, validate_selection,
};

pub(super) struct Archive {
    file: File,
    size: u64,
    expires: Instant,
    permit: OwnedSemaphorePermit,
}

struct DownloadStream {
    reader: ReaderStream<tokio::fs::File>,
    _permit: OwnedSemaphorePermit,
}
impl Stream for DownloadStream {
    type Item = Result<Bytes, io::Error>;
    fn poll_next(
        mut self: Pin<&mut Self>,
        context: &mut TaskContext<'_>,
    ) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.reader).poll_next(context)
    }
}

pub(super) async fn prepare(
    State(store): State<Arc<Management>>,
    Json(selection): Json<Selection>,
) -> Result<Response, Failure> {
    validate_selection(&selection.ids, selection.kind)?;
    store
        .downloads
        .lock()
        .await
        .retain(|_, archive| archive.expires > Instant::now());
    let permit = store
        .download_limit
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow::anyhow!("已有下载正在准备或传输，请稍后重试"))?;
    let updates = store.updates.clone().lock_owned().await;
    let index = Arc::clone(&*store.app.index.read().await);
    let directory = store.directory.clone();
    let archive = tokio::task::spawn_blocking(move || -> Result<_> {
        let _updates = updates;
        std::fs::create_dir_all(&directory)?;
        let file = tempfile::tempfile_in(directory)?;
        let mut zip = ZipWriter::new(file);
        let mut added = BTreeSet::new();
        for id in &selection.ids {
            let sources = if selection.kind == SelectionKind::Albums {
                ensure!(
                    index.albums.iter().any(|album| album.path == *id),
                    "相册已变化，请刷新后重试"
                );
                if super::selected_tree(id, &selection.ids) != id {
                    continue;
                }
                albums::contents(&files::gallery_path(&index.root, id, false)?)?
                    .into_iter()
                    .map(|path| {
                        let name = path
                            .strip_prefix(&index.root)?
                            .to_str()
                            .context("相册路径无效")?
                            .replace('\\', "/");
                        Ok((name, path))
                    })
                    .collect::<Result<Vec<_>>>()?
            } else {
                let record = index.image(id).context("所选文件已变化，请刷新后重试")?;
                files::source_files(&index.root, record)?
            };
            for (name, path) in sources {
                if !added.insert(name.clone()) {
                    continue;
                }
                if path.is_dir() {
                    zip.add_directory(format!("{name}/"), SimpleFileOptions::default())?;
                    continue;
                }
                let mut input = File::open(path)?;
                let before = input.metadata()?;
                let options = SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Stored)
                    .large_file(before.len() >= u32::MAX.into());
                zip.start_file(name, options)?;
                io::copy(&mut input, &mut zip)?;
                ensure!(
                    input.metadata()?.len() == before.len()
                        && input.metadata()?.modified()? == before.modified()?,
                    "下载准备期间文件发生变化，请重试"
                );
            }
        }
        let mut file = zip.finish()?;
        let size = file.metadata()?.len();
        file.rewind()?;
        Ok(Archive {
            file,
            size,
            expires: Instant::now() + Duration::from_secs(900),
            permit,
        })
    })
    .await
    .context("准备下载失败")??;
    // Tokens only identify an already authorized archive; every download still
    // passes the administrator session middleware.
    let id = {
        let token = tempfile::Builder::new()
            .prefix("download-")
            .rand_bytes(16)
            .tempfile()
            .context("无法创建下载标识")?;
        blake3::hash(token.path().to_string_lossy().as_bytes())
            .to_hex()
            .to_string()
    };
    let size = archive.size;
    store.downloads.lock().await.insert(id.clone(), archive);
    let weak = Arc::downgrade(&store);
    let expired_id = id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(900)).await;
        if let Some(store) = weak.upgrade() {
            store.downloads.lock().await.remove(&expired_id);
        }
    });
    Ok(private_json(
        serde_json::json!({"url":format!("/api/management/downloads/{id}"), "size":size}),
    ))
}

pub(super) async fn serve(
    State(store): State<Arc<Management>>,
    Path(id): Path<String>,
) -> Result<Response, Failure> {
    let archive = store
        .downloads
        .lock()
        .await
        .remove(&id)
        .context("下载已过期，请重新准备")?;
    if archive.expires <= Instant::now() {
        return Err(anyhow::anyhow!("下载已过期，请重新准备").into());
    }
    let stream = DownloadStream {
        reader: ReaderStream::new(tokio::fs::File::from_std(archive.file)),
        _permit: archive.permit,
    };
    Ok(response(Body::from_stream(stream), archive.size))
}

pub(super) async fn head(
    State(store): State<Arc<Management>>,
    Path(id): Path<String>,
) -> Result<Response, Failure> {
    let downloads = store.downloads.lock().await;
    let archive = downloads
        .get(&id)
        .filter(|archive| archive.expires > Instant::now())
        .context("下载已过期，请重新准备")?;
    Ok(response(Body::empty(), archive.size))
}

fn response(body: Body, size: u64) -> Response {
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"pixhelf-selection.zip\""),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
