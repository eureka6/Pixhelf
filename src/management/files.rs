use std::{
    collections::BTreeSet,
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

use crate::gallery::ImageRecord;

pub(super) const TRASH: &str = ".pixhelf-trash";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Favorites {
    pub paths: BTreeSet<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TrashEntry {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub deleted_at: u64,
    pub favorite: bool,
    #[serde(default)]
    pub album: bool,
    #[serde(default)]
    pub favorite_paths: BTreeSet<String>,
    pub files: Vec<TrashedFile>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TrashedFile {
    pub original: String,
    pub stored: String,
    pub size: u64,
    pub modified_ns: u128,
}

pub(super) fn read_favorites(directory: &Path) -> Result<Favorites> {
    match fs::read(directory.join("favorites.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("收藏记录损坏，请恢复数据文件后重试"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Favorites::default()),
        Err(error) => Err(error).context("无法读取收藏记录"),
    }
}

pub(super) fn save_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("无效的数据目录")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, value)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub(super) fn save_favorites(directory: &Path, favorites: &Favorites) -> Result<()> {
    save_json(&directory.join("favorites.json"), favorites).context("无法保存收藏记录")
}

// Reject symlinks at every level, including the final file. API inputs are always
// relative to the configured gallery, never arbitrary filesystem paths.
pub(super) fn checked_path(root: &Path, relative: &str, allow_missing: bool) -> Result<PathBuf> {
    ensure!(
        !root.as_os_str().is_empty() && root.is_absolute(),
        "图库目录不可用"
    );
    ensure!(
        !relative.contains('\\') && !relative.contains('\0'),
        "无效的相对路径"
    );
    let mut path = root.to_owned();
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            bail!("路径必须位于图库中");
        };
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => ensure!(!metadata.file_type().is_symlink(), "不能操作符号链接"),
            Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("文件或相册已变化，请刷新后重试"),
        }
    }
    Ok(path)
}

pub(super) fn gallery_path(root: &Path, relative: &str, allow_missing: bool) -> Result<PathBuf> {
    ensure!(
        relative.split('/').next() != Some(TRASH),
        "不能选择回收站目录"
    );
    checked_path(root, relative, allow_missing)
}

pub(super) fn source_files(root: &Path, record: &ImageRecord) -> Result<Vec<(String, PathBuf)>> {
    let path = gallery_path(root, &record.relative_path, false)?;
    ensure!(path == record.path, "文件不在当前图库中");
    record
        .ensure_source_is_current()
        .context("文件已变化，请刷新后重试")?;
    let mut files = vec![(record.relative_path.clone(), path)];
    if let Some(motion) = &record.motion {
        ensure!(
            motion.matches_metadata(&fs::metadata(&motion.path)?),
            "Live Photo 视频已变化，请刷新后重试"
        );
        if motion.path != record.path {
            let relative = motion
                .path
                .strip_prefix(root)?
                .to_str()
                .context("无效的视频路径")?
                .replace('\\', "/");
            files.push((relative.clone(), gallery_path(root, &relative, false)?));
        }
    }
    Ok(files)
}

pub(super) fn move_file(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    let result: io::Result<()> = rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        destination,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(Into::into);
    #[cfg(not(target_os = "linux"))]
    let result = fs::hard_link(source, destination).and_then(|()| fs::remove_file(source));
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
            copy_file(source, destination)?;
            if let Err(error) = fs::remove_file(source) {
                let _ = fs::remove_file(destination);
                return Err(error).context("无法移除源文件，已保留原件");
            }
            Ok(())
        }
        Err(error) => Err(error).context("无法移动文件；请检查目录写入权限及是否存在同名文件"),
    }
}

pub(super) fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    let mut input = File::open(source)?;
    let before = input.metadata()?;
    ensure!(before.is_file(), "只能复制普通文件");
    let mut temporary =
        tempfile::NamedTempFile::new_in(destination.parent().context("无效的目标相册")?)?;
    let size = io::copy(&mut input, &mut temporary)?;
    let after = input.metadata()?;
    ensure!(
        size == before.len()
            && after.len() == before.len()
            && after.modified()? == before.modified()?,
        "复制期间源文件发生变化"
    );
    temporary.as_file().set_permissions(before.permissions())?;
    temporary
        .as_file()
        .set_times(fs::FileTimes::new().set_modified(before.modified()?))?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(destination)
        .map_err(|error| error.error)?;
    Ok(())
}

pub(super) fn copy_image(root: &Path, record: &ImageRecord, destination: &str) -> Result<()> {
    let folder = gallery_path(root, destination, false)?;
    ensure!(folder.is_dir(), "目标不是相册目录");
    let sources = source_files(root, record)?;
    // Give a Live Photo pair the same suffix so it is still recognized as a pair.
    for number in 0..10_000 {
        let suffix = match number {
            0 => String::new(),
            1 => " - 副本".into(),
            _ => format!(" - 副本 ({number})"),
        };
        let targets = sources
            .iter()
            .map(|(_, source)| {
                let stem = source
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .context("无效文件名")?;
                let extension = source
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| format!(".{value}"))
                    .unwrap_or_default();
                Ok(folder.join(format!("{stem}{suffix}{extension}")))
            })
            .collect::<Result<Vec<_>>>()?;
        if targets
            .iter()
            .any(|target| fs::symlink_metadata(target).is_ok())
        {
            continue;
        }
        for (index, ((_, source), target)) in sources.iter().zip(&targets).enumerate() {
            if let Err(error) = copy_file(source, target) {
                for previous in &targets[..index] {
                    fs::remove_file(previous)
                        .context("复制未完成，部分副本未能清理，请刷新查看")?;
                }
                return Err(error);
            }
        }
        return Ok(());
    }
    bail!("同名副本过多，请选择其他相册")
}

pub(super) fn transfer(files: &[(PathBuf, PathBuf)]) -> Result<()> {
    let mut destinations = BTreeSet::new();
    for (source, destination) in files {
        ensure!(source != destination, "文件已在此相册中");
        ensure!(destinations.insert(destination), "所选文件在目标相册中重名");
        ensure!(
            !destination.try_exists()?,
            "目标位置存在同名文件，请先处理冲突"
        );
    }
    for (index, (source, destination)) in files.iter().enumerate() {
        if let Err(error) = move_file(source, destination) {
            for (previous, moved) in files[..index].iter().rev() {
                if move_file(moved, previous).is_err() {
                    bail!("操作未完成，部分文件已移动；请刷新查看当前位置，原文件未被覆盖");
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn trash_directory(root: &Path, create: bool) -> Result<PathBuf> {
    let path = checked_path(root, TRASH, create)?;
    if create {
        fs::create_dir_all(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(path)
}

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn modified_ns(metadata: &fs::Metadata) -> Result<u128> {
    Ok(metadata.modified()?.duration_since(UNIX_EPOCH)?.as_nanos())
}

pub(super) fn read_trash(root: &Path) -> Result<Vec<TrashEntry>> {
    if !root.join(TRASH).try_exists()? {
        return Ok(Vec::new());
    }
    let directory = trash_directory(root, false)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(directory)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !valid_id(&name) {
            continue;
        }
        let path = checked_path(root, &format!("{TRASH}/{name}/entry.json"), false)?;
        let entry: TrashEntry =
            serde_json::from_slice(&fs::read(path)?).context("回收站记录损坏，请检查数据文件")?;
        ensure!(
            entry.id == name && (entry.album || !entry.files.is_empty()),
            "回收站记录无效"
        );
        if entry.album {
            super::validate_selection(
                std::slice::from_ref(&entry.original_path),
                super::SelectionKind::Albums,
            )?;
            for path in &entry.favorite_paths {
                gallery_path(root, path, true)?;
                ensure!(
                    path == &entry.original_path
                        || path.starts_with(&format!("{}/", entry.original_path)),
                    "回收站收藏路径无效"
                );
            }
        }
        for file in &entry.files {
            gallery_path(root, &file.original, true)?;
            if entry.album {
                ensure!(
                    file.original
                        .starts_with(&format!("{}/", entry.original_path))
                        && file.stored
                            == format!(
                                "content/{}",
                                &file.original[entry.original_path.len() + 1..]
                            ),
                    "回收站相册路径无效"
                );
                checked_path(root, &format!("{TRASH}/{name}/{}", file.stored), true)?;
                continue;
            }
            ensure!(
                Path::new(&file.stored).components().count() == 1
                    && matches!(
                        Path::new(&file.stored).components().next(),
                        Some(Component::Normal(_))
                    ),
                "回收站文件名无效"
            );
        }
        if (entry.album && checked_path(root, &format!("{TRASH}/{name}/content"), true)?.is_dir())
            || entry
                .files
                .iter()
                .any(|file| root.join(TRASH).join(&name).join(&file.stored).is_file())
        {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.deleted_at));
    Ok(entries)
}

pub(super) fn new_trash_entry(
    root: &Path,
    record: &ImageRecord,
    favorite: bool,
) -> Result<(TrashEntry, PathBuf)> {
    let sources = source_files(root, record)?;
    let directory = trash_directory(root, true)?;
    let temporary = tempfile::Builder::new()
        .prefix("entry-")
        .rand_bytes(16)
        .tempdir_in(&directory)?;
    let id = blake3::hash(temporary.path().to_string_lossy().as_bytes()).to_hex()[..32].to_string();
    let destination = directory.join(&id);
    let entry = TrashEntry {
        id,
        name: record.name.clone(),
        original_path: record.relative_path.clone(),
        favorite,
        album: false,
        favorite_paths: BTreeSet::new(),
        deleted_at: std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis() as u64,
        files: sources
            .iter()
            .enumerate()
            .map(|(index, (original, path))| {
                Ok(TrashedFile {
                    original: original.clone(),
                    stored: format!("{index}.bin"),
                    size: fs::metadata(path)?.len(),
                    modified_ns: modified_ns(&fs::metadata(path)?)?,
                })
            })
            .collect::<Result<_>>()?,
    };
    // Publish recovery metadata before moving any original bytes. A restart
    // during a Live Photo operation still leaves the moved files recoverable.
    save_json(&temporary.path().join("entry.json"), &entry)?;
    fs::rename(temporary.path(), &destination)?;
    let moves = sources
        .iter()
        .zip(&entry.files)
        .map(|((_, source), file)| (source.clone(), destination.join(&file.stored)))
        .collect::<Vec<_>>();
    transfer(&moves)?;
    Ok((entry, destination))
}

pub(super) fn restore(root: &Path, entry: &TrashEntry) -> Result<()> {
    if entry.album {
        return super::albums::restore(root, entry);
    }
    let mut moves = Vec::new();
    for file in &entry.files {
        let source = checked_path(root, &format!("{TRASH}/{}/{}", entry.id, file.stored), true)?;
        let destination = gallery_path(root, &file.original, true)?;
        if !source.try_exists()? {
            let metadata = fs::metadata(&destination).context("回收站文件缺失，无法恢复")?;
            ensure!(
                metadata.is_file()
                    && metadata.len() == file.size
                    && modified_ns(&metadata)? == file.modified_ns,
                "原位置文件已变化，无法完成恢复"
            );
            continue;
        }
        ensure!(
            fs::metadata(&source)?.len() == file.size
                && modified_ns(&fs::metadata(&source)?)? == file.modified_ns,
            "回收站文件发生变化，无法恢复"
        );
        fs::create_dir_all(destination.parent().context("无效的恢复位置")?)?;
        moves.push((source, destination));
    }
    transfer(&moves)?;
    // Only remove known metadata and an empty directory, never user contents.
    fs::remove_file(root.join(TRASH).join(&entry.id).join("entry.json"))?;
    fs::remove_dir(root.join(TRASH).join(&entry.id))?;
    Ok(())
}
