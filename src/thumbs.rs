use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use image::{
    DynamicImage, GenericImageView, ImageDecoder, ImageReader, imageops::FilterType,
    metadata::Orientation,
};
use serde::Serialize;
use tokio::sync::{Notify, Semaphore};
use tracing::{info, warn};
use walkdir::WalkDir;

use crate::gallery::ImageRecord;

const THUMBNAIL_EDGE: u32 = 720;
const WEBP_QUALITY: f32 = 82.0;
const CACHE_VERSION: &str = "720-webp-q82-v1";
const THUMBNAIL_FILTER: FilterType = FilterType::Triangle;
const MAX_ATTEMPTS: u8 = 3;

const PENDING: u8 = 0;
const PROCESSING: u8 = 1;
const READY: u8 = 2;
const FAILED: u8 = 3;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct ThumbnailManager {
    cache_root: PathBuf,
    entries: RwLock<HashMap<String, Arc<ThumbEntry>>>,
    queue: JobQueue,
    initial_ready: AtomicBool,
}

const PREVIEW_CACHE_VERSION: &str = "2560-webp-q88-v2";
const PREVIEW_EDGE: u32 = 2560;
const PREVIEW_QUALITY: f32 = 88.0;
const PREVIEW_FILTER: FilterType = FilterType::CatmullRom;
const PREVIEW_PENDING: u8 = 0;
const PREVIEW_PROCESSING: u8 = 1;
const PREVIEW_READY: u8 = 2;
const PREVIEW_FAILED: u8 = 3;

/// Viewer previews are intentionally independent from the eager thumbnail queue.
/// They are generated only when a user opens an image, then retained immutably.
pub struct ViewerPreviewManager {
    cache_root: PathBuf,
    entries: RwLock<HashMap<String, Arc<PreviewEntry>>>,
    slots: Arc<Semaphore>,
}

struct PreviewEntry {
    record: Arc<ImageRecord>,
    cache_path: PathBuf,
    state: AtomicU8,
    last_error: Mutex<Option<String>>,
    notify: Notify,
}

impl ViewerPreviewManager {
    pub fn new(cache_dir: PathBuf) -> Result<Arc<Self>> {
        let cache_root = cache_dir.join(PREVIEW_CACHE_VERSION);
        fs::create_dir_all(&cache_root).with_context(|| {
            format!(
                "cannot create viewer preview cache: {}",
                cache_root.display()
            )
        })?;
        purge_temporary_files(&cache_root);
        Ok(Arc::new(Self {
            cache_root,
            entries: RwLock::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(2)),
        }))
    }

    pub fn reconcile(&self, records: &[Arc<ImageRecord>]) {
        let current_ids: HashSet<&str> = records.iter().map(|record| record.id.as_str()).collect();
        let mut entries = self.entries.write().expect("viewer preview entries lock");
        entries.retain(|id, _| current_ids.contains(id.as_str()));
        for record in records {
            if entries.contains_key(&record.id) {
                continue;
            }
            let cache_path = shard_path(&self.cache_root, &record.id);
            let state = if valid_cache_file(&cache_path) {
                PREVIEW_READY
            } else {
                PREVIEW_PENDING
            };
            entries.insert(
                record.id.clone(),
                Arc::new(PreviewEntry {
                    record: Arc::clone(record),
                    cache_path,
                    state: AtomicU8::new(state),
                    last_error: Mutex::new(None),
                    notify: Notify::new(),
                }),
            );
        }
    }

    pub async fn ensure_ready(&self, id: &str) -> Result<PathBuf> {
        let entry = self
            .entries
            .read()
            .expect("viewer preview entries lock")
            .get(id)
            .cloned()
            .with_context(|| format!("unknown image: {id}"))?;

        loop {
            let notified = entry.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match entry.state.load(Ordering::Acquire) {
                PREVIEW_READY if valid_cache_file(&entry.cache_path) => {
                    return Ok(entry.cache_path.clone());
                }
                PREVIEW_READY => {
                    let _ = entry.state.compare_exchange(
                        PREVIEW_READY,
                        PREVIEW_PENDING,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                }
                PREVIEW_PENDING => {
                    if entry
                        .state
                        .compare_exchange(
                            PREVIEW_PENDING,
                            PREVIEW_PROCESSING,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        self.start_generation(Arc::clone(&entry));
                    }
                }
                PREVIEW_PROCESSING => notified.as_mut().await,
                PREVIEW_FAILED => {
                    let message = entry
                        .last_error
                        .lock()
                        .expect("viewer preview error lock")
                        .clone()
                        .unwrap_or_else(|| "viewer preview generation failed".to_owned());
                    bail!(message);
                }
                _ => unreachable!(),
            }
        }
    }

    fn start_generation(&self, entry: Arc<PreviewEntry>) {
        let slots = Arc::clone(&self.slots);
        tokio::spawn(async move {
            let record = Arc::clone(&entry.record);
            let output = entry.cache_path.clone();
            let result = async move {
                let _permit = slots
                    .acquire_owned()
                    .await
                    .map_err(|_| anyhow!("viewer preview worker stopped"))?;
                tokio::task::spawn_blocking(move || generate_preview(&record, &output))
                    .await
                    .map_err(|error| anyhow!("viewer preview worker stopped: {error}"))?
            }
            .await;

            match result {
                Ok(()) => {
                    entry.state.store(PREVIEW_READY, Ordering::Release);
                    entry.notify.notify_waiters();
                }
                Err(error) => {
                    *entry.last_error.lock().expect("viewer preview error lock") =
                        Some(error.to_string());
                    entry.state.store(PREVIEW_FAILED, Ordering::Release);
                    entry.notify.notify_waiters();
                    warn!(image = %entry.record.relative_path, %error, "viewer preview generation failed");
                }
            }
        });
    }

    pub async fn cleanup_stale(&self) {
        let valid_ids: HashSet<String> = self
            .entries
            .read()
            .expect("viewer preview entries lock")
            .keys()
            .cloned()
            .collect();
        let root = self.cache_root.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || cleanup_cache(&root, &valid_ids)).await
        {
            warn!(%error, "viewer preview cache cleanup task failed");
        }
    }
}

struct ThumbEntry {
    record: Arc<ImageRecord>,
    cache_path: PathBuf,
    state: AtomicU8,
    urgent: AtomicBool,
    attempts: AtomicU8,
    last_error: Mutex<Option<String>>,
    notify: Notify,
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
            let mut entries = self.entries.write().expect("thumbnail entries lock");
            entries.retain(|id, _| current_ids.contains(id.as_str()));

            for record in records {
                if entries.contains_key(&record.id) {
                    continue;
                }
                let cache_path = self.cache_path(&record.id);
                let state = if valid_cache_file(&cache_path) {
                    READY
                } else {
                    missing.push(record.id.clone());
                    PENDING
                };
                entries.insert(
                    record.id.clone(),
                    Arc::new(ThumbEntry {
                        record: Arc::clone(record),
                        cache_path,
                        state: AtomicU8::new(state),
                        urgent: AtomicBool::new(false),
                        attempts: AtomicU8::new(0),
                        last_error: Mutex::new(None),
                        notify: Notify::new(),
                    }),
                );
            }
        }

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

    pub async fn ensure_ready(&self, id: &str) -> Result<PathBuf> {
        self.promote(id);
        self.wait_for(id).await
    }

    pub fn status(&self) -> ThumbnailStatus {
        let entries = self.entries.read().expect("thumbnail entries lock");
        let mut ready = 0;
        let mut queued = 0;
        let mut processing = 0;
        let mut failed = 0;

        for entry in entries.values() {
            match entry.state.load(Ordering::Acquire) {
                READY => ready += 1,
                PROCESSING => processing += 1,
                FAILED => failed += 1,
                _ => queued += 1,
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
        let valid_ids: HashSet<String> = self
            .entries
            .read()
            .expect("thumbnail entries lock")
            .keys()
            .cloned()
            .collect();
        let root = self.cache_root.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || cleanup_cache(&root, &valid_ids)).await
        {
            warn!(%error, "thumbnail cache cleanup task failed");
        }
    }

    fn promote(&self, id: &str) {
        let entry = self
            .entries
            .read()
            .expect("thumbnail entries lock")
            .get(id)
            .cloned();
        if let Some(entry) = entry
            && entry.state.load(Ordering::Acquire) == PENDING
        {
            entry.urgent.store(true, Ordering::Release);
            self.queue.push_urgent(id.to_owned());
        }
    }

    async fn wait_for(&self, id: &str) -> Result<PathBuf> {
        let entry = self
            .entries
            .read()
            .expect("thumbnail entries lock")
            .get(id)
            .cloned()
            .with_context(|| format!("unknown image: {id}"))?;

        loop {
            let notified = entry.notify.notified();
            match entry.state.load(Ordering::Acquire) {
                READY if valid_cache_file(&entry.cache_path) => {
                    return Ok(entry.cache_path.clone());
                }
                READY => {
                    if entry
                        .state
                        .compare_exchange(READY, PENDING, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                    {
                        self.queue.push_urgent(id.to_owned());
                    }
                }
                FAILED => {
                    let message = entry
                        .last_error
                        .lock()
                        .expect("thumbnail error lock")
                        .clone()
                        .unwrap_or_else(|| "thumbnail generation failed".to_owned());
                    bail!(message);
                }
                _ => notified.await,
            }
        }
    }

    async fn worker_loop(self: Arc<Self>, worker: usize) {
        loop {
            let id = self.queue.pop().await;
            let entry = self
                .entries
                .read()
                .expect("thumbnail entries lock")
                .get(&id)
                .cloned();
            let Some(entry) = entry else {
                continue;
            };
            if entry
                .state
                .compare_exchange(PENDING, PROCESSING, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                continue;
            }

            let record = Arc::clone(&entry.record);
            let output = entry.cache_path.clone();
            let result = tokio::task::spawn_blocking(move || generate_thumbnail(&record, &output))
                .await
                .map_err(|error| anyhow!("thumbnail worker stopped: {error}"))
                .and_then(|result| result);

            match result {
                Ok(()) => {
                    entry.state.store(READY, Ordering::Release);
                    entry.notify.notify_waiters();
                }
                Err(error) => {
                    let attempt = entry.attempts.fetch_add(1, Ordering::AcqRel) + 1;
                    *entry.last_error.lock().expect("thumbnail error lock") =
                        Some(error.to_string());
                    warn!(worker, image = %entry.record.relative_path, attempt, %error, "thumbnail generation failed");

                    if attempt < MAX_ATTEMPTS {
                        entry.state.store(PENDING, Ordering::Release);
                        entry.notify.notify_waiters();
                        self.schedule_retry(entry, id, attempt);
                    } else {
                        entry.state.store(FAILED, Ordering::Release);
                        entry.notify.notify_waiters();
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
            if entry.state.load(Ordering::Acquire) != PENDING {
                return;
            }
            if entry.urgent.load(Ordering::Acquire) {
                manager.queue.push_urgent(id);
            } else {
                manager.queue.push_background(id);
            }
        });
    }
}

impl JobQueue {
    fn push_urgent(&self, id: String) {
        let should_notify = {
            let mut state = self.state.lock().expect("thumbnail queue lock");
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
            let mut state = self.state.lock().expect("thumbnail queue lock");
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
            if let Some(id) = {
                let mut state = self.state.lock().expect("thumbnail queue lock");
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
            notified.await;
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

fn generate_preview(record: &ImageRecord, output: &Path) -> Result<()> {
    generate_image_cache(
        record,
        output,
        PREVIEW_EDGE,
        PREVIEW_FILTER,
        PREVIEW_QUALITY,
        "viewer preview",
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
        let mut file = File::create(&temporary)?;
        file.write_all(encoded.as_ref())?;
        file.flush()?;
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
    for entry in WalkDir::new(root).min_depth(1).into_iter().flatten() {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|ext| ext.to_str()) != Some("webp")
        {
            continue;
        }
        let id = entry
            .path()
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        if !valid_ids.contains(id)
            && let Err(error) = fs::remove_file(entry.path())
        {
            warn!(path = %entry.path().display(), %error, "cannot remove stale thumbnail");
        }
    }
}

fn purge_temporary_files(root: &Path) {
    for entry in WalkDir::new(root).min_depth(1).into_iter().flatten() {
        if entry.file_type().is_file()
            && entry.path().extension().and_then(|ext| ext.to_str()) == Some("tmp")
            && let Err(error) = fs::remove_file(entry.path())
        {
            warn!(path = %entry.path().display(), %error, "cannot remove temporary thumbnail");
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
    fn generates_bounded_viewer_preview_without_upscaling() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        fs::create_dir(&gallery).unwrap();
        image::RgbImage::new(5000, 2500)
            .save(gallery.join("wide.png"))
            .unwrap();
        let index = scan_gallery(&gallery, None).unwrap();
        let output = temp.path().join("preview.webp");
        generate_preview(&index.images[0], &output).unwrap();
        assert_eq!(image::open(output).unwrap().dimensions(), (2560, 1280));

        image::RgbImage::new(400, 200)
            .save(gallery.join("small.png"))
            .unwrap();
        let index = scan_gallery(&gallery, None).unwrap();
        let small = index
            .images
            .iter()
            .find(|image| image.name == "small.png")
            .unwrap();
        let output = temp.path().join("small.webp");
        generate_preview(small, &output).unwrap();
        assert_eq!(image::open(output).unwrap().dimensions(), (400, 200));
    }

    #[test]
    fn queue_promotes_without_duplicate_jobs() {
        let queue = JobQueue::default();
        queue.push_background("image".to_owned());
        queue.push_background("image".to_owned());
        queue.push_urgent("image".to_owned());

        let state = queue.state.lock().unwrap();
        assert_eq!(state.urgent.as_slices().0, ["image"]);
        assert!(state.background.is_empty());
        assert_eq!(state.queued.len(), 1);
    }
}
