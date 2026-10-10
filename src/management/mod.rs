mod albums;
pub(crate) mod categories;
mod directories;
mod download;
mod files;
pub(crate) mod sharing;
mod upload;

use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::Arc,
};

use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{Mutex, Semaphore};

use crate::{
    gallery::{GalleryIndex, ImageRecord, scan_gallery},
    web::{AppState, ImagesQuery, pagination::image_page_from_records},
};
use files::{Favorites, gallery_path, read_favorites, read_trash, save_favorites, source_files};

const MAX_BATCH: usize = 500;

struct Management {
    app: AppState,
    directory: PathBuf,
    updates: Arc<Mutex<()>>,
    downloads: Mutex<HashMap<String, download::Archive>>,
    download_limit: Arc<Semaphore>,
}

pub(crate) fn router(app: AppState) -> Router {
    let directory = app.thumbnails.settings_directory().join("management");
    Router::new()
        .route("/api/management", get(state))
        .route("/api/management/favorites", get(favorites))
        .route("/api/management/trash", get(trash))
        .route("/api/management/batch", post(batch))
        .route("/api/management/categories", post(categories::save))
        .route(
            "/api/management/directories",
            get(directories::list).post(directories::update),
        )
        .route("/api/management/sharing", post(sharing::update))
        .route("/api/management/downloads", post(download::prepare))
        .route(
            "/api/management/downloads/{id}",
            get(download::serve).head(download::head),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .route(
            "/api/management/upload",
            post(upload::save).layer(DefaultBodyLimit::max(upload::MAX_UPLOAD_BYTES)),
        )
        .with_state(Arc::new(Management {
            app,
            directory,
            updates: Arc::new(Mutex::new(())),
            downloads: Mutex::new(HashMap::new()),
            download_limit: Arc::new(Semaphore::new(2)),
        }))
}

pub(crate) struct Failure(anyhow::Error);
impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        tracing::warn!(error = %self.0, "图库管理操作失败");
        let mut response = private_json(json!({"error": message(&self.0)}));
        *response.status_mut() = StatusCode::CONFLICT;
        response
    }
}

fn message(error: &anyhow::Error) -> String {
    for cause in error.chain() {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem => {
                    return "目录不可写，请检查图库挂载方式及写入权限".into();
                }
                std::io::ErrorKind::AlreadyExists => {
                    return "目标位置存在同名文件，原文件已保留".into();
                }
                _ => {}
            }
        }
    }
    error.to_string()
}

fn private_json(value: impl Serialize) -> Response {
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    ids: Vec<String>,
    #[serde(default)]
    kind: SelectionKind,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SelectionKind {
    #[default]
    Images,
    Albums,
}

fn validate_selection(ids: &[String], kind: SelectionKind) -> Result<()> {
    if kind == SelectionKind::Images {
        return validate_ids(ids);
    }
    ensure!(
        !ids.is_empty() && ids.len() <= MAX_BATCH,
        "每次请选择 1 至 500 个相册"
    );
    ensure!(
        ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
        "相册选择重复"
    );
    for path in ids {
        ensure!(
            !path.is_empty()
                && path.len() <= 4096
                && !path.contains('\\')
                && !path.contains('\0')
                && path
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
                && path.split('/').next() != Some(files::TRASH),
            "相册路径无效"
        );
    }
    Ok(())
}

// Albums remain independently selectable. Recursive filesystem operations run
// once per selected tree; each selected album still gets its own result.
fn selected_tree<'a>(id: &'a str, ids: &'a [String]) -> &'a str {
    id.match_indices('/')
        .find_map(|(end, _)| {
            ids.iter()
                .find(|candidate| candidate.as_str() == &id[..end])
                .map(String::as_str)
        })
        .unwrap_or(id)
}

fn validate_ids(ids: &[String]) -> Result<()> {
    ensure!(
        !ids.is_empty() && ids.len() <= MAX_BATCH,
        "每次请选择 1 至 500 项"
    );
    ensure!(
        ids.iter()
            .all(|id| (id.len() == 32 || id.len() == 64)
                && id.bytes().all(|c| c.is_ascii_hexdigit())),
        "选择记录无效，请刷新后重试"
    );
    ensure!(
        ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
        "选择记录重复"
    );
    Ok(())
}

async fn state(State(store): State<Arc<Management>>) -> Result<Response, Failure> {
    let guard = store.updates.clone().lock_owned().await;
    let index = Arc::clone(&*store.app.index.read().await);
    let directory = store.directory.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<_> {
        let _guard = guard;
        let favorites = read_favorites(&directory)?;
        let ids: Vec<_> = index
            .images
            .iter()
            .filter(|image| favorites.paths.contains(&image.relative_path))
            .map(|image| image.id.clone())
            .collect();
        let count = if index.root.as_os_str().is_empty() {
            0
        } else {
            read_trash(&index.root)?.len()
        };
        let albums: Vec<_> = index
            .albums
            .iter()
            .filter(|album| favorites.paths.contains(&album.path))
            .map(|album| &album.path)
            .collect();
        Ok(json!({"favoriteIds": ids, "favoriteAlbums": albums, "privateAlbums": sharing::read(&directory)?.private_albums, "trashCount": count}))
    })
    .await
    .context("读取管理记录失败")??;
    Ok(private_json(result))
}

async fn favorites(
    State(store): State<Arc<Management>>,
    Query(query): Query<ImagesQuery>,
) -> Result<Response, Failure> {
    let query = match query.normalize() {
        Ok(query) => query,
        Err(status) => return Ok(status.into_response()),
    };
    let guard = store.updates.clone().lock_owned().await;
    let index = Arc::clone(&*store.app.index.read().await);
    let directory = store.directory.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<_> {
        let _guard = guard;
        let favorites = read_favorites(&directory)?;
        Ok(image_page_from_records(
            index
                .images
                .iter()
                .map(Arc::as_ref)
                .filter(|image| favorites.paths.contains(&image.relative_path)),
            &query,
        ))
    })
    .await
    .context("读取收藏失败")??;
    Ok(private_json(result))
}

async fn trash(State(store): State<Arc<Management>>) -> Result<Response, Failure> {
    let guard = store.updates.clone().lock_owned().await;
    let root = store.app.index.read().await.root.clone();
    let entries = tokio::task::spawn_blocking(move || -> Result<_> {
        let _guard = guard;
        let entries = if root.as_os_str().is_empty() { Vec::new() } else { read_trash(&root)? };
        Ok(entries.into_iter().map(|entry| json!({"id":entry.id, "name":entry.name, "originalPath":entry.original_path, "deletedAt":entry.deleted_at, "album":entry.album, "fileCount":entry.files.len(), "size":entry.files.iter().map(|file| file.size).sum::<u64>()})).collect::<Vec<_>>())
    }).await.context("读取回收站失败")??;
    Ok(private_json(json!({"items": entries})))
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Action {
    Favorite,
    Move,
    Copy,
    Trash,
    Restore,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    ids: Vec<String>,
    #[serde(default)]
    kind: SelectionKind,
    action: Action,
    destination: Option<String>,
    favorite: Option<bool>,
}

#[derive(Serialize)]
struct ItemResult {
    id: String,
    ok: bool,
    error: Option<String>,
}

fn update_record(
    root: &std::path::Path,
    directory: &std::path::Path,
    record: &ImageRecord,
    input: &Batch,
    favorites: &mut Favorites,
) -> Result<()> {
    let mut updated = favorites.clone();
    match input.action {
        Action::Copy => files::copy_image(
            root,
            record,
            input.destination.as_deref().context("请选择目标相册")?,
        )?,
        Action::Favorite => {
            source_files(root, record)?;
            if input.favorite.context("请选择收藏或取消收藏")? {
                updated.paths.insert(record.relative_path.clone());
            } else {
                updated.paths.remove(&record.relative_path);
            }
            save_favorites(directory, &updated)?;
        }
        Action::Move => {
            let destination = input.destination.as_deref().context("请选择目标相册")?;
            let folder = gallery_path(root, destination, false)?;
            ensure!(folder.is_dir(), "目标不是相册目录");
            let sources = source_files(root, record)?;
            let moves = sources
                .iter()
                .map(|(_, source)| {
                    Ok((
                        source.clone(),
                        folder.join(source.file_name().context("无效文件名")?),
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            let new_path = moves[0]
                .1
                .strip_prefix(root)?
                .to_str()
                .context("无效的目标路径")?
                .replace('\\', "/");
            if updated.paths.remove(&record.relative_path) {
                updated.paths.insert(new_path);
            }
            // Verify metadata can be persisted before changing any media files.
            save_favorites(directory, favorites)?;
            files::transfer(&moves)?;
            if let Err(error) = save_favorites(directory, &updated) {
                files::transfer(
                    &moves
                        .iter()
                        .map(|(from, to)| (to.clone(), from.clone()))
                        .collect::<Vec<_>>(),
                )?;
                return Err(error);
            }
        }
        Action::Trash => {
            save_favorites(directory, favorites)?;
            let (entry, _) =
                files::new_trash_entry(root, record, updated.paths.remove(&record.relative_path))?;
            if let Err(error) = save_favorites(directory, &updated) {
                files::restore(root, &entry)?;
                return Err(error);
            }
        }
        Action::Restore => bail!("无效操作"),
    }
    *favorites = updated;
    Ok(())
}

async fn batch(
    State(store): State<Arc<Management>>,
    Json(input): Json<Batch>,
) -> Result<Response, Failure> {
    validate_selection(&input.ids, input.kind)?;
    if input.kind == SelectionKind::Albums && matches!(input.action, Action::Restore | Action::Copy)
    {
        return Err(anyhow::anyhow!("相册操作无效").into());
    }
    let updates = store
        .updates
        .clone()
        .try_lock_owned()
        .map_err(|_| anyhow::anyhow!("另一项管理操作正在进行，请稍后重试"))?;
    let mut index = store.app.index.clone().write_owned().await;
    let directory = store.directory.clone();
    let thumbnails = store.app.thumbnails.clone();
    let results = tokio::task::spawn_blocking(move || -> Result<_> {
        let _updates = updates;
        let root = index.root.clone();
        ensure!(!root.as_os_str().is_empty(), "图库目录不可用");
        let mut favorites = read_favorites(&directory)?;
        let trash = if input.action == Action::Restore {
            read_trash(&root)?
        } else {
            Vec::new()
        };
        let recursive = input.kind == SelectionKind::Albums
            && matches!(input.action, Action::Move | Action::Trash);
        let mut visited = BTreeSet::new();
        let targets: Vec<_> = input
            .ids
            .iter()
            .map(|id| {
                if recursive {
                    selected_tree(id, &input.ids)
                } else {
                    id.as_str()
                }
            })
            .filter(|id| visited.insert(*id))
            .collect();
        let mut outcomes = HashMap::new();
        for id in targets {
            let result = if input.action == Action::Restore {
                (|| -> Result<()> {
                    let entry = trash
                        .iter()
                        .find(|entry| entry.id == id)
                        .context("回收站项目已变化，请刷新")?;
                    let mut updated = favorites.clone();
                    if entry.favorite {
                        updated.paths.insert(entry.original_path.clone());
                    }
                    updated.paths.extend(entry.favorite_paths.iter().cloned());
                    save_favorites(&directory, &updated)?;
                    if let Err(error) = files::restore(&root, entry) {
                        save_favorites(&directory, &favorites)?;
                        return Err(error);
                    }
                    favorites = updated;
                    Ok(())
                })()
            } else if input.kind == SelectionKind::Albums {
                (|| -> Result<()> {
                    ensure!(
                        index.albums.iter().any(|album| album.path == id),
                        "相册已变化，请刷新后重试"
                    );
                    albums::update(&root, &directory, id, &input, &mut favorites)
                })()
            } else {
                index
                    .image(id)
                    .context("文件已变化，请刷新后重试")
                    .and_then(|record| {
                        update_record(&root, &directory, record, &input, &mut favorites)
                    })
            };
            outcomes.insert(id, result.err().map(|error| message(&error)));
        }
        let results: Vec<_> = input
            .ids
            .iter()
            .map(|id| {
                let target = if recursive {
                    selected_tree(id, &input.ids)
                } else {
                    id.as_str()
                };
                let error = if input.kind == SelectionKind::Albums
                    && !index.albums.iter().any(|album| album.path == *id)
                {
                    Some("相册已变化，请刷新后重试".to_owned())
                } else {
                    outcomes[target].clone()
                };
                ItemResult {
                    id: id.clone(),
                    ok: error.is_none(),
                    error,
                }
            })
            .collect();
        if input.action != Action::Favorite {
            // Also refresh after partial failures, including interrupted Live Photo moves.
            let updated: GalleryIndex = scan_gallery(&root, Some(&index))
                .context("文件操作已完成，但图库刷新失败，请稍后刷新")?;
            thumbnails.reconcile(&updated.images);
            thumbnails.start_similarity_warmup();
            *index = Arc::new(updated);
        }
        Ok(results)
    })
    .await
    .context("管理操作中断，请刷新查看结果")??;
    Ok(private_json(json!({"results":results})))
}

#[cfg(test)]
mod tests;
