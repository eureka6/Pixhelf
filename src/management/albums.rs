use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use walkdir::WalkDir;

use super::{
    Action, Batch,
    files::{self, Favorites, TrashEntry, TrashedFile},
};

// Include empty directories and non-media files. Never follow a link outside an album.
pub(super) fn contents(folder: &Path) -> Result<Vec<PathBuf>> {
    ensure!(fs::symlink_metadata(folder)?.is_dir(), "目标不是相册目录");
    let mut paths = Vec::new();
    for entry in WalkDir::new(folder).follow_links(false).sort_by_file_name() {
        let entry = entry.context("无法读取相册内容")?;
        ensure!(
            entry.file_type().is_dir() || entry.file_type().is_file(),
            "相册包含符号链接或特殊文件，无法操作"
        );
        paths.push(entry.into_path());
    }
    Ok(paths)
}

fn move_directory(source: &Path, destination: &Path) -> Result<()> {
    let paths = contents(source)?;
    ensure!(
        !destination.starts_with(source),
        "不能将相册移入自身或子相册"
    );
    ensure!(
        fs::symlink_metadata(destination)
            .is_err_and(|error| error.kind() == io::ErrorKind::NotFound),
        "目标位置存在同名相册或文件，请先处理冲突"
    );
    #[cfg(target_os = "linux")]
    match rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        destination,
        rustix::fs::RenameFlags::NOREPLACE,
    ) {
        Ok(()) => return Ok(()),
        Err(error) if io::Error::from(error).kind() == io::ErrorKind::CrossesDevices => {}
        Err(error) => return Err(io::Error::from(error)).context("无法移动相册"),
    }
    // Cross-filesystem moves use the existing per-file rollback. Only empty
    // source directories are removed, so concurrently added files are retained.
    let mut directories = Vec::new();
    let result = (|| -> Result<()> {
        let mut moves = Vec::new();
        for path in &paths {
            let target = destination.join(path.strip_prefix(source)?);
            if path.is_dir() {
                fs::create_dir(&target)?;
                directories.push(target);
            } else {
                moves.push((path.clone(), target));
            }
        }
        files::transfer(&moves)?;
        Ok(())
    })();
    if let Err(error) = result {
        for directory in directories.iter().rev() {
            let _ = fs::remove_dir(directory);
        }
        return Err(error);
    }
    for path in paths.iter().rev().filter(|path| path.is_dir()) {
        fs::remove_dir(path).context("相册内容发生变化，已移动的文件保留在目标相册，请刷新查看")?;
    }
    Ok(())
}

fn within(path: &str, album: &str) -> bool {
    path == album || path.starts_with(&format!("{album}/"))
}

pub(super) fn update(
    root: &Path,
    directory: &Path,
    album: &str,
    input: &Batch,
    favorites: &mut Favorites,
) -> Result<()> {
    let source = files::gallery_path(root, album, false)?;
    let paths = contents(&source)?;
    let mut updated = favorites.clone();
    match input.action {
        Action::Favorite => {
            if input.favorite.context("请选择收藏或取消收藏")? {
                updated.paths.insert(album.to_owned());
            } else {
                updated.paths.remove(album);
            }
            files::save_favorites(directory, &updated)?;
        }
        Action::Move => {
            let folder = files::gallery_path(
                root,
                input.destination.as_deref().context("请选择目标相册")?,
                false,
            )?;
            ensure!(folder.is_dir(), "目标不是相册目录");
            let destination = folder.join(source.file_name().context("相册名称无效")?);
            relocate(root, directory, album, &destination, favorites)?;
            updated = favorites.clone();
        }
        Action::Trash => {
            let favorite_paths: BTreeSet<_> = updated
                .paths
                .iter()
                .filter(|path| within(path, album))
                .cloned()
                .collect();
            updated.paths.retain(|path| !within(path, album));
            files::save_favorites(directory, favorites)?;
            let trash = files::trash_directory(root, true)?;
            let temporary = tempfile::Builder::new()
                .prefix("entry-")
                .rand_bytes(16)
                .tempdir_in(&trash)?;
            let id = blake3::hash(temporary.path().to_string_lossy().as_bytes()).to_hex()[..32]
                .to_owned();
            let entry = TrashEntry {
                id: id.clone(),
                name: source
                    .file_name()
                    .context("相册名称无效")?
                    .to_string_lossy()
                    .into(),
                original_path: album.to_owned(),
                favorite: favorite_paths.contains(album),
                favorite_paths,
                album: true,
                deleted_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64,
                files: paths
                    .iter()
                    .filter(|path| path.is_file())
                    .map(|path| {
                        let metadata = fs::metadata(path)?;
                        Ok(TrashedFile {
                            original: path
                                .strip_prefix(root)?
                                .to_str()
                                .context("相册路径无效")?
                                .replace('\\', "/"),
                            stored: format!(
                                "content/{}",
                                path.strip_prefix(&source)?
                                    .to_str()
                                    .context("相册路径无效")?
                                    .replace('\\', "/")
                            ),
                            size: metadata.len(),
                            modified_ns: files::modified_ns(&metadata)?,
                        })
                    })
                    .collect::<Result<_>>()?,
            };
            files::save_json(&temporary.path().join("entry.json"), &entry)?;
            let destination = trash.join(id);
            fs::rename(temporary.path(), &destination)?;
            if let Err(error) = move_directory(&source, &destination.join("content")) {
                // Recovery metadata is retained if a cross-filesystem move was interrupted.
                if !destination.join("content").exists() {
                    fs::remove_file(destination.join("entry.json"))?;
                    fs::remove_dir(destination)?;
                }
                return Err(error);
            }
            if let Err(error) = files::save_favorites(directory, &updated) {
                restore(root, &entry)?;
                return Err(error);
            }
        }
        _ => bail!("相册操作无效"),
    }
    *favorites = updated;
    Ok(())
}

// Preserve directory metadata when a directory is renamed or moved. Keep both
// old and new private paths until the filesystem operation has succeeded.
pub(super) fn relocate(
    root: &Path,
    directory: &Path,
    album: &str,
    destination: &Path,
    favorites: &mut Favorites,
) -> Result<()> {
    let source = files::gallery_path(root, album, false)?;
    ensure!(
        !destination.starts_with(&source),
        "不能将目录移入自身或下级目录"
    );
    ensure!(
        fs::symlink_metadata(destination)
            .is_err_and(|error| error.kind() == io::ErrorKind::NotFound),
        "目标位置存在同名目录或文件"
    );
    let relative = destination
        .strip_prefix(root)?
        .to_str()
        .context("目录路径无效")?
        .replace('\\', "/");
    let mut updated = favorites.clone();
    updated.paths = updated
        .paths
        .iter()
        .map(|path| {
            if within(path, album) {
                format!("{relative}{}", &path[album.len()..])
            } else {
                path.clone()
            }
        })
        .collect();
    let sharing = super::sharing::read(directory)?;
    let relocated = sharing.relocated(album, &relative);
    let mut pending = sharing.clone();
    pending
        .private_albums
        .extend(relocated.private_albums.iter().cloned());
    files::save_favorites(directory, favorites)?;
    super::sharing::save(directory, &pending)?;
    move_directory(&source, destination)?;
    let persisted = files::save_favorites(directory, &updated)
        .and_then(|()| super::sharing::save(directory, &relocated));
    if let Err(error) = persisted {
        move_directory(destination, &source)?;
        files::save_favorites(directory, favorites)?;
        super::sharing::save(directory, &sharing)?;
        return Err(error);
    }
    *favorites = updated;
    Ok(())
}

pub(super) fn restore(root: &Path, entry: &TrashEntry) -> Result<()> {
    let source = files::checked_path(
        root,
        &format!("{}/{}/content", files::TRASH, entry.id),
        false,
    )?;
    let destination = files::gallery_path(root, &entry.original_path, true)?;
    for file in &entry.files {
        let path = files::checked_path(
            root,
            &format!("{}/{}/{}", files::TRASH, entry.id, file.stored),
            false,
        )?;
        let metadata = fs::metadata(path)?;
        ensure!(
            metadata.is_file()
                && metadata.len() == file.size
                && files::modified_ns(&metadata)? == file.modified_ns,
            "回收站相册内容发生变化，无法恢复"
        );
    }
    fs::create_dir_all(destination.parent().context("无效的恢复位置")?)?;
    move_directory(&source, &destination)?;
    fs::remove_file(root.join(files::TRASH).join(&entry.id).join("entry.json"))?;
    fs::remove_dir(root.join(files::TRASH).join(&entry.id))?;
    Ok(())
}
