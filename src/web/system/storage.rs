use std::{
    collections::HashSet,
    fs, io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use walkdir::WalkDir;

use crate::support::mutex_lock;

const REFRESH_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectoryInfo {
    name: &'static str,
    path: String,
    size_bytes: Option<u64>,
    state: ScanStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ScanStatus {
    Scanning,
    Ready,
    Error,
}

#[derive(Default)]
struct ScanState {
    size_bytes: Option<u64>,
    completed: Option<Instant>,
    scanning: bool,
    failed: bool,
}

#[derive(Default)]
pub(super) struct DirectoryUsage {
    path: PathBuf,
    state: Arc<Mutex<ScanState>>,
}

impl DirectoryUsage {
    pub(super) fn snapshot(&mut self, name: &'static str, path: &Path) -> DirectoryInfo {
        if self.path != path {
            self.path = path.to_owned();
            // An old scan may still finish; keep its result attached to its own path.
            self.state = Arc::default();
        }
        let mut state = mutex_lock(&self.state);
        if !state.scanning
            && state
                .completed
                .is_none_or(|at| at.elapsed() >= REFRESH_INTERVAL)
        {
            state.scanning = true;
            let shared = Arc::clone(&self.state);
            let path = self.path.clone();
            // Only an active system page schedules scans. Concurrent requests share
            // one scan and keep reading the last complete result until it finishes.
            tokio::task::spawn_blocking(move || {
                let result = directory_size(&path);
                let mut state = mutex_lock(&shared);
                match result {
                    Ok(size) => {
                        state.size_bytes = Some(size);
                        state.failed = false;
                    }
                    Err(_) => state.failed = true,
                }
                state.completed = Some(Instant::now());
                state.scanning = false;
            });
        }
        DirectoryInfo {
            name,
            path: path.to_string_lossy().into_owned(),
            size_bytes: state.size_bytes,
            state: if state.failed {
                ScanStatus::Error
            } else if state.scanning {
                ScanStatus::Scanning
            } else {
                ScanStatus::Ready
            },
        }
    }
}

fn directory_size(path: &Path) -> io::Result<u64> {
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a directory",
        ));
    }
    let mut bytes = 0_u64;
    let mut hard_links = HashSet::new();
    for entry in WalkDir::new(path)
        .follow_links(false)
        .follow_root_links(false)
    {
        let entry = match entry {
            Ok(entry) => entry,
            // Files can be removed while uploads, cache cleanup or management run.
            Err(error)
                if error.depth() > 0
                    && error
                        .io_error()
                        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error)
                if error
                    .io_error()
                    .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file()
            || (metadata.nlink() > 1 && !hard_links.insert((metadata.dev(), metadata.ino())))
        {
            continue;
        }
        bytes = bytes
            .checked_add(metadata.len())
            .ok_or_else(|| io::Error::other("directory size overflow"))?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn counts_nested_hidden_and_companion_files_without_following_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("gallery");
        fs::create_dir_all(root.join("album")).unwrap();
        fs::write(root.join("photo.jpg"), [1; 100]).unwrap();
        fs::write(root.join("album/photo.mov"), [2; 200]).unwrap();
        fs::write(root.join(".hidden"), [3; 30]).unwrap();
        fs::write(temp.path().join("unrelated"), [4; 1000]).unwrap();
        fs::hard_link(root.join("photo.jpg"), root.join("copy.jpg")).unwrap();
        symlink(temp.path(), root.join("outside")).unwrap();
        symlink(temp.path().join("unrelated"), root.join("linked.jpg")).unwrap();
        symlink(&root, root.join("cycle")).unwrap();
        assert_eq!(directory_size(&root).unwrap(), 330);
        assert!(directory_size(&root.join("outside")).is_err());
        assert!(directory_size(&root.join("missing")).is_err());
        assert!(directory_size(&root.join("photo.jpg")).is_err());
    }

    #[test]
    fn distinguishes_empty_directories_and_independent_roots_on_the_same_disk() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        let data = temp.path().join("data");
        fs::create_dir(&gallery).unwrap();
        fs::create_dir_all(data.join("cache")).unwrap();
        assert_eq!(directory_size(&gallery).unwrap(), 0);
        fs::write(gallery.join("photo.jpg"), [0; 123]).unwrap();
        fs::write(data.join("cache/thumb.webp"), [0; 45]).unwrap();
        assert_eq!(directory_size(&gallery).unwrap(), 123);
        assert_eq!(directory_size(&data).unwrap(), 45);
    }

    async fn finished(usage: &mut DirectoryUsage, path: &Path) -> DirectoryInfo {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                usage.snapshot("测试", path);
                let scanning = mutex_lock(&usage.state).scanning;
                if !scanning {
                    return usage.snapshot("测试", path);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }

    fn expire(usage: &DirectoryUsage) {
        mutex_lock(&usage.state).completed = Some(Instant::now() - REFRESH_INTERVAL);
    }

    #[tokio::test]
    async fn shares_cached_sizes_refreshes_changes_and_preserves_results_on_failure() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("index"), [0; 10]).unwrap();
        let mut usage = DirectoryUsage::default();
        assert_eq!(
            usage.snapshot("数据大小", &root).state,
            ScanStatus::Scanning
        );
        let first = finished(&mut usage, &root).await;
        assert_eq!(first.size_bytes, Some(10));
        assert_eq!(first.state, ScanStatus::Ready);

        fs::write(root.join("index"), [0; 20]).unwrap();
        assert_eq!(usage.snapshot("数据大小", &root).size_bytes, Some(10));
        expire(&usage);
        assert_eq!(usage.snapshot("数据大小", &root).size_bytes, Some(10));
        assert_eq!(finished(&mut usage, &root).await.size_bytes, Some(20));

        fs::remove_dir_all(&root).unwrap();
        expire(&usage);
        let failed = finished(&mut usage, &root).await;
        assert_eq!(failed.size_bytes, Some(20));
        assert_eq!(failed.state, ScanStatus::Error);

        fs::create_dir(&root).unwrap();
        expire(&usage);
        let recovered = finished(&mut usage, &root).await;
        assert_eq!(recovered.size_bytes, Some(0));
        assert_eq!(recovered.state, ScanStatus::Ready);

        let missing = finished(&mut usage, &root.join("missing")).await;
        assert_eq!(missing.size_bytes, None);
        assert_eq!(missing.state, ScanStatus::Error);
    }
}
