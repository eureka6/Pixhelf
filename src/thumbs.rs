use std::{
    collections::{HashMap, HashSet, VecDeque},
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use image::{
    DynamicImage, GenericImageView, ImageDecoder, ImageReader, imageops::FilterType,
    metadata::Orientation,
};
use serde::Serialize;
use tokio::sync::Notify;
use tracing::{info, warn};
use walkdir::WalkDir;

use crate::gallery::ImageRecord;

const THUMBNAIL_EDGE: u32 = 720;
const WEBP_QUALITY: f32 = 82.0;
const CACHE_VERSION: &str = "720-webp-q82-v1";
const THUMBNAIL_FILTER: FilterType = FilterType::Triangle;
const LEGACY_VIEWER_CACHE_VERSION: &str = "viewer-3200-webp-q88-fast-v1";
const MAX_ATTEMPTS: u8 = 3;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct ThumbnailManager {
    cache_root: PathBuf,
    entries: RwLock<HashMap<String, Arc<ThumbEntry>>>,
    queue: JobQueue,
    initial_ready: AtomicBool,
}

#[derive(Debug)]
pub enum ThumbnailError {
    NotFound,
    Generation(String),
}

impl fmt::Display for ThumbnailError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => formatter.write_str("unknown image"),
            Self::Generation(message) => formatter.write_str(message),
        }
    }
}

impl Error for ThumbnailError {}

struct ThumbEntry {
    record: Arc<ImageRecord>,
    cache_path: PathBuf,
    state: Mutex<ThumbState>,
    notify: Notify,
}

enum ThumbState {
    Pending { urgent: bool, attempts: u8 },
    Processing { urgent: bool, attempts: u8 },
    Ready,
    Failed(String),
    Removed,
}

#[derive(Default)]
struct JobQueue {
    state: Mutex<QueueState>,
    notify: Notify,
}

#[derive(Default)]
struct QueueState {
    urgent: VecDeque<String>,
    background: VecDeque<String>,
    queued: HashSet<String>,
}

fn mutex_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailStatus {
    pub total: usize,
    pub ready: usize,
    pub queued: usize,
    pub processing: usize,
    pub failed: usize,
    pub initial_batch_ready: bool,
    pub background_complete: bool,
}

impl ThumbnailManager {
    pub fn new(cache_dir: PathBuf) -> Result<Arc<Self>> {
        let cache_root = cache_dir.join(CACHE_VERSION);
        fs::create_dir_all(&cache_root)
            .with_context(|| format!("cannot create thumbnail cache: {}", cache_root.display()))?;
        let legacy_viewer_cache = cache_dir.join(LEGACY_VIEWER_CACHE_VERSION);
        if legacy_viewer_cache.is_dir()
            && let Err(error) = fs::remove_dir_all(&legacy_viewer_cache)
        {
            warn!(
                path = %legacy_viewer_cache.display(),
                %error,
                "cannot remove obsolete viewer cache"
            );
        }
        purge_temporary_files(&cache_root);
        Ok(Arc::new(Self {
            cache_root,
            entries: RwLock::new(HashMap::new()),
            queue: JobQueue::default(),
            initial_ready: AtomicBool::new(false),
        }))
    }

    pub fn reconcile(&self, records: &[Arc<ImageRecord>]) {
        let current_ids: HashSet<&str> = records.iter().map(|record| record.id.as_str()).collect();
        let mut missing = Vec::new();
        {
            let mut entries = write_lock(&self.entries);
            entries.retain(|id, entry| {
                let retained = current_ids.contains(id.as_str());
                if !retained {
                    *mutex_lock(&entry.state) = ThumbState::Removed;
                    entry.notify.notify_waiters();
                }
                retained
            });

            for record in records {
                if entries.contains_key(&record.id) {
                    continue;
                }
                let cache_path = self.cache_path(&record.id);
                let state = if valid_cache_file(&cache_path) {
                    ThumbState::Ready
                } else {
                    missing.push(record.id.clone());
                    ThumbState::Pending {
                        urgent: false,
                        attempts: 0,
                    }
                };
                entries.insert(
                    record.id.clone(),
                    Arc::new(ThumbEntry {
                        record: Arc::clone(record),
                        cache_path,
                        state: Mutex::new(state),
                        notify: Notify::new(),
                    }),
                );
            }
        }

        self.queue.retain(&current_ids);
        for id in missing {
            self.queue.push_background(id);
        }
    }

    pub fn start_workers(self: &Arc<Self>, count: usize) {
        for worker in 0..count {
            let manager = Arc::clone(self);
            tokio::spawn(async move {
                manager.worker_loop(worker).await;
            });
        }
    }

    pub async fn prepare_initial(&self, ids: &[String]) {
        for id in ids {
            self.promote(id);
        }

        let mut failures = 0usize;
        for id in ids {
            if let Err(error) = self.wait_for(id).await {
                failures += 1;
                warn!(%id, %error, "initial thumbnail failed");
            }
        }
        self.initial_ready.store(true, Ordering::Release);
        info!(
            requested = ids.len(),
            failures, "initial thumbnail batch is ready"
        );
    }

    pub async fn ensure_ready(&self, id: &str) -> Result<PathBuf, ThumbnailError> {
        self.promote(id);
        self.wait_for(id).await
    }

    pub fn status(&self) -> ThumbnailStatus {
        let entries = read_lock(&self.entries);
        let mut ready = 0;
        let mut queued = 0;
        let mut processing = 0;
        let mut failed = 0;

        for entry in entries.values() {
            match &*mutex_lock(&entry.state) {
                ThumbState::Ready => ready += 1,
                ThumbState::Processing { .. } => processing += 1,
                ThumbState::Failed(_) => failed += 1,
                ThumbState::Pending { .. } => queued += 1,
                ThumbState::Removed => {}
            }
        }

        let total = entries.len();
        ThumbnailStatus {
            total,
            ready,
            queued,
            processing,
            failed,
            initial_batch_ready: self.initial_ready.load(Ordering::Acquire),
            background_complete: ready + failed == total && processing == 0,
        }
    }

    pub async fn cleanup_stale(&self) {
        let valid_ids: HashSet<String> = read_lock(&self.entries).keys().cloned().collect();
        let root = self.cache_root.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || cleanup_cache(&root, &valid_ids)).await
        {
            warn!(%error, "thumbnail cache cleanup task failed");
        }
    }

    fn promote(&self, id: &str) {
        let entry = read_lock(&self.entries).get(id).cloned();
        let Some(entry) = entry else {
            return;
        };

        let should_queue = {
            let mut state = mutex_lock(&entry.state);
            match &mut *state {
                ThumbState::Pending { urgent, .. } => {
                    *urgent = true;
                    true
                }
                ThumbState::Failed(_) => {
                    *state = ThumbState::Pending {
                        urgent: true,
                        attempts: 0,
                    };
                    true
                }
                _ => false,
            }
        };
        if should_queue {
            self.queue.push_urgent(id.to_owned());
        }
    }

    async fn wait_for(&self, id: &str) -> Result<PathBuf, ThumbnailError> {
        let entry = read_lock(&self.entries)
            .get(id)
            .cloned()
            .ok_or(ThumbnailError::NotFound)?;

        loop {
            let notified = entry.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let should_queue = {
                let mut state = mutex_lock(&entry.state);
                match &*state {
                    ThumbState::Ready if valid_cache_file(&entry.cache_path) => {
                        return Ok(entry.cache_path.clone());
                    }
                    ThumbState::Ready => {
                        *state = ThumbState::Pending {
                            urgent: true,
                            attempts: 0,
                        };
                        true
                    }
                    ThumbState::Failed(message) => {
                        return Err(ThumbnailError::Generation(message.clone()));
                    }
                    ThumbState::Removed => return Err(ThumbnailError::NotFound),
                    ThumbState::Pending { .. } | ThumbState::Processing { .. } => false,
                }
            };
            if should_queue {
                self.queue.push_urgent(id.to_owned());
            } else {
                notified.as_mut().await;
            }
        }
    }

    async fn worker_loop(self: Arc<Self>, worker: usize) {
        loop {
            let id = self.queue.pop().await;
            let entry = read_lock(&self.entries).get(&id).cloned();
            let Some(entry) = entry else {
                continue;
            };
            {
                let mut state = mutex_lock(&entry.state);
                let ThumbState::Pending { urgent, attempts } = &*state else {
                    continue;
                };
                let (urgent, attempts) = (*urgent, *attempts);
                *state = ThumbState::Processing { urgent, attempts };
            }

            let record = Arc::clone(&entry.record);
            let output = entry.cache_path.clone();
            let result = tokio::task::spawn_blocking(move || generate_thumbnail(&record, &output))
                .await
                .map_err(|error| anyhow!("thumbnail worker stopped: {error}"))
                .and_then(|result| result);

            match result {
                Ok(()) => {
                    let (ready, removed) = {
                        let mut state = mutex_lock(&entry.state);
                        if matches!(*state, ThumbState::Processing { .. }) {
                            *state = ThumbState::Ready;
                            (true, false)
                        } else {
                            (false, matches!(*state, ThumbState::Removed))
                        }
                    };
                    if ready {
                        entry.notify.notify_waiters();
                    } else if removed {
                        let entries = read_lock(&self.entries);
                        if !entries.contains_key(&id)
                            && let Err(error) = fs::remove_file(&entry.cache_path)
                            && error.kind() != std::io::ErrorKind::NotFound
                        {
                            warn!(path = %entry.cache_path.display(), %error, "cannot remove stale thumbnail");
                        }
                    }
                }
                Err(error) => {
                    let transition = {
                        let mut state = mutex_lock(&entry.state);
                        let ThumbState::Processing { urgent, attempts } = &*state else {
                            continue;
                        };
                        let (urgent, attempt) = (*urgent, attempts.saturating_add(1));
                        let retry = attempt < MAX_ATTEMPTS;
                        if retry {
                            *state = ThumbState::Pending {
                                urgent,
                                attempts: attempt,
                            };
                        } else {
                            *state = ThumbState::Failed(error.to_string());
                        }
                        (attempt, retry)
                    };
                    let (attempt, retry) = transition;
                    warn!(worker, image = %entry.record.relative_path, attempt, %error, "thumbnail generation failed");
                    entry.notify.notify_waiters();
                    if retry {
                        self.schedule_retry(entry, id, attempt);
                    }
                }
            }
        }
    }

    fn cache_path(&self, id: &str) -> PathBuf {
        shard_path(&self.cache_root, id)
    }

    fn schedule_retry(self: &Arc<Self>, entry: Arc<ThumbEntry>, id: String, attempt: u8) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let delay = Duration::from_millis(200 * (1 << (attempt - 1)));
            tokio::time::sleep(delay).await;
            let urgent = match &*mutex_lock(&entry.state) {
                ThumbState::Pending { urgent, .. } => *urgent,
                _ => return,
            };
            if urgent {
                manager.queue.push_urgent(id);
            } else {
                manager.queue.push_background(id);
            }
        });
    }
}

impl JobQueue {
    fn retain(&self, valid_ids: &HashSet<&str>) {
        let mut state = mutex_lock(&self.state);
        state.urgent.retain(|id| valid_ids.contains(id.as_str()));
        state
            .background
            .retain(|id| valid_ids.contains(id.as_str()));
        state.queued.retain(|id| valid_ids.contains(id.as_str()));
    }

    fn push_urgent(&self, id: String) {
        let should_notify = {
            let mut state = mutex_lock(&self.state);
            if state.queued.contains(&id) {
                if let Some(position) = state.background.iter().position(|queued| queued == &id) {
                    state.background.remove(position);
                    state.urgent.push_back(id);
                    true
                } else {
                    false
                }
            } else {
                state.queued.insert(id.clone());
                state.urgent.push_back(id);
                true
            }
        };
        if !should_notify {
            return;
        }
        self.notify.notify_one();
    }

    fn push_background(&self, id: String) {
        let should_notify = {
            let mut state = mutex_lock(&self.state);
            if state.queued.insert(id.clone()) {
                state.background.push_back(id);
                true
            } else {
                false
            }
        };
        if !should_notify {
            return;
        }
        self.notify.notify_one();
    }

    async fn pop(&self) -> String {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(id) = {
                let mut state = mutex_lock(&self.state);
                let id = state
                    .urgent
                    .pop_front()
                    .or_else(|| state.background.pop_front());
                if let Some(id) = &id {
                    state.queued.remove(id);
                }
                id
            } {
                return id;
            }
            notified.as_mut().await;
        }
    }
}

fn valid_cache_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() > 20)
        .unwrap_or(false)
}

fn shard_path(root: &Path, id: &str) -> PathBuf {
    let shard = id.get(..2).unwrap_or("00");
    root.join(shard).join(format!("{id}.webp"))
}

fn generate_thumbnail(record: &ImageRecord, output: &Path) -> Result<()> {
    generate_image_cache(
        record,
        output,
        THUMBNAIL_EDGE,
        THUMBNAIL_FILTER,
        WEBP_QUALITY,
        "thumbnail",
    )
}

fn generate_image_cache(
    record: &ImageRecord,
    output: &Path,
    max_edge: u32,
    filter: FilterType,
    quality: f32,
    label: &str,
) -> Result<()> {
    let reader = ImageReader::open(&record.path)
        .with_context(|| format!("cannot open {}", record.path.display()))?
        .with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let (width, height) = image.dimensions();
    let image = if width.max(height) > max_edge {
        image.resize(max_edge, max_edge, filter)
    } else {
        image
    };
    write_webp(&image, output, quality)
        .with_context(|| format!("cannot store {label}: {}", output.display()))
}

fn write_webp(image: &DynamicImage, output: &Path, quality: f32) -> Result<()> {
    let encoded = match image {
        DynamicImage::ImageRgb8(rgb) => {
            webp::Encoder::from_rgb(rgb.as_raw(), rgb.width(), rgb.height()).encode(quality)
        }
        DynamicImage::ImageRgba8(rgba) => {
            webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height()).encode(quality)
        }
        _ => {
            let rgba = image.to_rgba8();
            webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height()).encode(quality)
        }
    };
    let parent = output
        .parent()
        .with_context(|| format!("invalid image cache path: {}", output.display()))?;
    fs::create_dir_all(parent)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        output
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("image"),
        std::process::id(),
        sequence
    ));
    let write_result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(encoded.as_ref())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, output)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn cleanup_cache(root: &Path, valid_ids: &HashSet<String>) {
    visit_cache_files(root, |path| {
        if path.extension().and_then(|ext| ext.to_str()) != Some("webp") {
            return;
        }
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        if !valid_ids.contains(stem)
            && let Err(error) = fs::remove_file(path)
        {
            warn!(path = %path.display(), %error, "cannot remove stale thumbnail");
        }
    });
}

fn purge_temporary_files(root: &Path) {
    visit_cache_files(root, |path| {
        if path.extension().and_then(|ext| ext.to_str()) == Some("tmp")
            && let Err(error) = fs::remove_file(path)
        {
            warn!(path = %path.display(), %error, "cannot remove temporary thumbnail");
        }
    });
}

fn visit_cache_files(root: &Path, mut visit: impl FnMut(&Path)) {
    for entry in WalkDir::new(root).min_depth(1) {
        match entry {
            Ok(entry) if entry.file_type().is_file() => visit(entry.path()),
            Ok(_) => {}
            Err(error) => warn!(%error, "cannot inspect thumbnail cache"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gallery::scan_gallery;

    #[test]
    fn generates_one_bounded_webp_thumbnail() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        fs::create_dir(&gallery).unwrap();
        image::RgbImage::new(1200, 600)
            .save(gallery.join("wide.png"))
            .unwrap();
        let index = scan_gallery(&gallery, None).unwrap();
        let output = temp.path().join("thumbnail.webp");

        generate_thumbnail(&index.images[0], &output).unwrap();
        let generated = image::open(output).unwrap();
        assert_eq!(generated.dimensions(), (720, 360));
    }

    #[test]
    fn manager_removes_the_obsolete_second_preview_cache() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join(LEGACY_VIEWER_CACHE_VERSION);
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("preview.webp"), [1; 32]).unwrap();

        let manager = ThumbnailManager::new(temp.path().to_path_buf()).unwrap();

        assert!(manager.cache_root.is_dir());
        assert!(!legacy.exists());
    }

    #[test]
    fn cleanup_keeps_only_the_single_high_quality_variant() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let id = "abcdef";
        let thumbnail = shard_path(root, id);
        let old_compact = thumbnail.with_file_name(format!("{id}-360.webp"));
        let stale = shard_path(root, "stale");
        fs::create_dir_all(thumbnail.parent().unwrap()).unwrap();
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&thumbnail, [1; 32]).unwrap();
        fs::write(&old_compact, [1; 32]).unwrap();
        fs::write(&stale, [1; 32]).unwrap();

        cleanup_cache(root, &HashSet::from([id.to_owned()]));

        assert!(thumbnail.exists());
        assert!(!old_compact.exists());
        assert!(!stale.exists());
    }

    #[test]
    fn queue_promotes_without_duplicate_jobs() {
        let queue = JobQueue::default();
        queue.push_background("image".to_owned());
        queue.push_background("image".to_owned());
        queue.push_urgent("image".to_owned());

        let state = mutex_lock(&queue.state);
        assert_eq!(state.urgent.as_slices().0, ["image"]);
        assert!(state.background.is_empty());
        assert_eq!(state.queued.len(), 1);
    }

    #[tokio::test]
    async fn queue_wakes_all_needed_workers() {
        let queue = Arc::new(JobQueue::default());
        let first_queue = Arc::clone(&queue);
        let second_queue = Arc::clone(&queue);
        let first = tokio::spawn(async move { first_queue.pop().await });
        let second = tokio::spawn(async move { second_queue.pop().await });
        tokio::task::yield_now().await;

        queue.push_background("first".to_owned());
        queue.push_background("second".to_owned());

        let first = tokio::time::timeout(Duration::from_secs(1), first)
            .await
            .expect("first worker timed out")
            .unwrap();
        let second = tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("second worker timed out")
            .unwrap();
        assert_eq!(
            HashSet::from([first, second]),
            HashSet::from(["first".into(), "second".into()])
        );
    }

    #[tokio::test]
    async fn failed_thumbnail_can_be_retried() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        fs::create_dir(&gallery).unwrap();
        let image_path = gallery.join("image.png");
        image::RgbImage::new(20, 10).save(&image_path).unwrap();
        let index = scan_gallery(&gallery, None).unwrap();
        fs::write(&image_path, "invalid image").unwrap();

        let manager = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        manager.reconcile(&index.images);
        manager.start_workers(1);
        let id = &index.images[0].id;
        assert!(matches!(
            manager.ensure_ready(id).await,
            Err(ThumbnailError::Generation(_))
        ));

        image::RgbImage::new(20, 10).save(&image_path).unwrap();
        let thumbnail = manager.ensure_ready(id).await.unwrap();
        assert!(valid_cache_file(&thumbnail));
    }

    #[tokio::test]
    async fn removing_an_entry_releases_waiters() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        fs::create_dir(&gallery).unwrap();
        image::RgbImage::new(20, 10)
            .save(gallery.join("image.png"))
            .unwrap();
        let index = scan_gallery(&gallery, None).unwrap();
        let manager = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        manager.reconcile(&index.images);

        let id = index.images[0].id.clone();
        let waiting_manager = Arc::clone(&manager);
        let waiter = tokio::spawn(async move { waiting_manager.ensure_ready(&id).await });
        tokio::task::yield_now().await;
        manager.reconcile(&[]);

        let result = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("thumbnail waiter timed out")
            .expect("thumbnail waiter stopped");
        assert!(matches!(result, Err(ThumbnailError::NotFound)));
    }
}
