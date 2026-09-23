use std::{fs, path::Path, sync::Arc};

use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Query, State},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{Action, Batch, Failure, Management, SelectionKind, albums, files, private_json};
use crate::gallery::scan_gallery;

#[derive(Default, Deserialize)]
pub(super) struct DirectoryQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    search: String,
    #[serde(default)]
    content: bool,
    #[serde(default)]
    offset: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    name: String,
    directory: bool,
    has_children: bool,
    size: u64,
    image_id: Option<String>,
}

fn validate_path(path: &str, allow_root: bool) -> Result<()> {
    if allow_root && path.is_empty() {
        return Ok(());
    }
    super::validate_selection(&[path.to_owned()], SelectionKind::Albums)
}

fn child_path(parent: &str, name: &str) -> Result<String> {
    ensure!(
        !name.is_empty()
            && name == name.trim()
            && name.len() <= 255
            && name != "."
            && name != ".."
            && !name.contains(['/', '\\'])
            && !name.chars().any(char::is_control),
        "请输入有效的目录名称"
    );
    let path = if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    };
    validate_path(&path, false)?;
    Ok(path)
}

fn has_children(path: &Path) -> bool {
    // If unreadable, keep the disclosure control so opening it reports the error.
    fs::read_dir(path).map_or(true, |mut entries| {
        entries.any(|entry| {
            entry
                .ok()
                .is_some_and(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        })
    })
}

pub(super) async fn list(
    State(store): State<Arc<Management>>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Response, Failure> {
    validate_path(&query.path, true)?;
    let index = Arc::clone(&*store.app.index.read().await);
    let result = tokio::task::spawn_blocking(move || -> Result<_> {
        let folder = files::gallery_path(&index.root, &query.path, false)?;
        ensure!(folder.is_dir(), "目录不存在");
        let search = query.search.trim().to_lowercase();
        let searching_tree = !query.content && !search.is_empty();
        let mut entries = Vec::new();
        let walker = walkdir::WalkDir::new(&folder).min_depth(1)
            .max_depth(if searching_tree { usize::MAX } else { 1 })
            .follow_links(false);
        // Recursive searches stop at 200 matches and need deterministic traversal.
        // Other listings sort once, after filtering.
        let walker = if searching_tree { walker.sort_by_file_name() } else { walker };
        let walker = walker.into_iter()
            .filter_entry(|entry| !(folder == index.root && entry.depth() == 1 && entry.file_name() == files::TRASH));
        for entry in walker {
            let entry = entry.context("无法读取目录")?;
            let directory = entry.file_type().is_dir();
            if !directory && (!query.content || !entry.file_type().is_file()) { continue; }
            let Some(path) = entry.path().strip_prefix(&index.root)?.to_str().map(|path| path.replace('\\', "/")) else { continue; };
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(if searching_tree { &path } else { &name }).to_lowercase().contains(&search) { continue; }
            entries.push((path, name, entry));
            if searching_tree && entries.len() >= 200 { break; }
        }
        entries.sort_by(|left, right| right.2.file_type().is_dir().cmp(&left.2.file_type().is_dir())
            .then_with(|| natord::compare_ignore_case(&left.1, &right.1))
            .then_with(|| left.0.cmp(&right.0)));
        let total = entries.len();
        let paginated = query.content || searching_tree;
        let offset = if paginated { query.offset } else { 0 };
        let limit = if paginated { 200 } else { total };
        let mut items = Vec::with_capacity(limit.min(total.saturating_sub(offset)));
        let mut images = Vec::new();
        // Inspect only the returned page. No directory I/O holds the index lock.
        for (path, name, entry) in entries.into_iter().skip(offset).take(limit) {
            let directory = entry.file_type().is_dir();
            let record = if directory { None } else { index.image_by_path(&path) };
            if let Some(record) = record {
                images.push(crate::web::ImageView::from(record.as_ref()));
            }
            items.push(Entry { name, directory, has_children: directory && has_children(entry.path()),
                size: if directory { 0 } else { entry.metadata()?.len() },
                image_id: record.map(|image| image.id.clone()), path });
        }
        let end = offset.saturating_add(items.len());
        Ok(json!({"path": query.path, "items": items, "images": images, "total": total, "nextOffset": (end < total).then_some(end), "truncated": searching_tree && total == 200}))
    }).await.context("读取目录失败")??;
    Ok(private_json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum DirectoryAction {
    Create,
    Rename,
    Move,
    Trash,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DirectoryInput {
    action: DirectoryAction,
    path: String,
    name: Option<String>,
    destination: Option<String>,
}

pub(super) async fn update(
    State(store): State<Arc<Management>>,
    Json(input): Json<DirectoryInput>,
) -> Result<Response, Failure> {
    validate_path(&input.path, matches!(input.action, DirectoryAction::Create))?;
    let updates = store
        .updates
        .clone()
        .try_lock_owned()
        .map_err(|_| anyhow::anyhow!("请等待当前操作完成"))?;
    let mut index = store.app.index.clone().write_owned().await;
    let directory = store.directory.clone();
    let thumbnails = store.app.thumbnails.clone();
    let path = tokio::task::spawn_blocking(move || -> Result<String> {
        let _updates = updates;
        let root = index.root.clone();
        let source = files::gallery_path(&root, &input.path, false)?;
        ensure!(source.is_dir(), "目录不存在");
        let mut favorites = files::read_favorites(&directory)?;
        let result = (|| -> Result<String> {
            match input.action {
                DirectoryAction::Create => {
                    let path = child_path(
                        &input.path,
                        input.name.as_deref().context("请输入目录名称")?,
                    )?;
                    fs::create_dir(files::gallery_path(&root, &path, true)?)
                        .context("无法新建目录")?;
                    Ok(path)
                }
                DirectoryAction::Rename => {
                    let parent = input.path.rsplit_once('/').map_or("", |(parent, _)| parent);
                    let path =
                        child_path(parent, input.name.as_deref().context("请输入目录名称")?)?;
                    let destination = files::gallery_path(&root, &path, true)?;
                    albums::relocate(&root, &directory, &input.path, &destination, &mut favorites)?;
                    Ok(path)
                }
                DirectoryAction::Move | DirectoryAction::Trash => {
                    let moving = matches!(input.action, DirectoryAction::Move);
                    let path = if moving {
                        let destination = input.destination.as_deref().context("请选择目标目录")?;
                        validate_path(destination, true)?;
                        child_path(
                            destination,
                            input.path.rsplit('/').next().context("无效目录")?,
                        )?
                    } else {
                        input
                            .path
                            .rsplit_once('/')
                            .map_or("", |(parent, _)| parent)
                            .to_owned()
                    };
                    albums::update(
                        &root,
                        &directory,
                        &input.path,
                        &Batch {
                            ids: vec![input.path.clone()],
                            kind: SelectionKind::Albums,
                            action: if moving { Action::Move } else { Action::Trash },
                            destination: input.destination,
                            favorite: None,
                        },
                        &mut favorites,
                    )?;
                    Ok(path)
                }
            }
        })();
        // Rescan even after a partial filesystem failure, as in batch management.
        let updated =
            scan_gallery(&root, Some(&index)).context("目录操作已结束，但图库刷新失败，请重试")?;
        thumbnails.reconcile(&updated.images);
        thumbnails.start_similarity_warmup();
        *index = Arc::new(updated);
        result
    })
    .await
    .context("目录操作中断，请刷新查看")??;
    Ok(private_json(json!({"path": path})))
}
