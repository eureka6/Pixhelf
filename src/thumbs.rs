use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
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
use tracing::{debug, info, warn};
use walkdir::WalkDir;

use crate::{
    gallery::ImageRecord,
    similarity::{
        cache_signature_for_thumbnail, has_signature_sidecar, is_signature_sidecar,
        remove_signature_for_thumbnail, signature_for_thumbnail,
    },
    support::{
        PriorityQueue as JobQueue,
        embedding::{is_sidecar, remove_sidecar},
        mutex_lock, read_lock, write_lock,
    },
    text_search::{
        TextSearchEmbedding, TextSearchIndex, TextSearchStatus, is_text_search_sidecar,
        remove_embedding_for_thumbnail as remove_text_search_embedding,
    },
};

const THUMBNAIL_EDGE: u32 = 720;
const WEBP_QUALITY: f32 = 82.0;
const CACHE_VERSION: &str = "720-webp-q82-v1";
const LEGACY_VIEWER_CACHE_VERSION: &str = "viewer-3200-webp-q88-fast-v1";
const OBSOLETE_DINO_EXTENSION: &str = "dino2";
const MAX_ATTEMPTS: u8 = 3;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct ThumbnailManager {
    cache_root: PathBuf,
    entries: RwLock<HashMap<String, Arc<ThumbEntry>>>,
    queue: JobQueue,
    initial_ready: AtomicBool,
    similarity_warmup_running: AtomicBool,
    text_search: RwLock<Option<Arc<TextSearchIndex>>>,
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
    pub text_search: TextSearchStatus,
}

impl ThumbnailManager {
    pub(crate) fn settings_directory(&self) -> PathBuf {
        self.cache_root
            .parent()
            .expect("thumbnail cache parent")
            .join("settings")
    }

    #[cfg(test)]
    pub fn new(cache_dir: PathBuf) -> Result<Arc<Self>> {
        Self::new_with_text_search(cache_dir, None)
    }

    pub fn new_with_text_search(
        cache_dir: PathBuf,
        text_search: Option<Arc<TextSearchIndex>>,
    ) -> Result<Arc<Self>> {
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
                "无法清理旧版查看器缓存"
            );
        }
        purge_temporary_files(&cache_root);
        Ok(Arc::new(Self {
            cache_root,
            entries: RwLock::new(HashMap::new()),
            queue: JobQueue::default(),
            initial_ready: AtomicBool::new(false),
            similarity_warmup_running: AtomicBool::new(false),
            text_search: RwLock::new(text_search),
        }))
    }

    fn text_search(&self) -> Option<Arc<TextSearchIndex>> {
        read_lock(&self.text_search).clone()
    }

    /// Attach an automatically downloaded search model without restarting the
    /// web service, then backfill every thumbnail that is already available.
    pub fn enable_text_search(&self, text_search: Arc<TextSearchIndex>) -> bool {
        {
            let mut current = write_lock(&self.text_search);
            if current.is_some() {
                return false;
            }
            *current = Some(Arc::clone(&text_search));
        }

        // The model is visible before this snapshot. A thumbnail completed
        // after that point enqueues itself in the regular worker path, while a
        // thumbnail completed before it is included below.
        let (ids, ready) = {
            let entries = read_lock(&self.entries);
            let ids = entries.keys().cloned().collect::<Vec<_>>();
            let ready = entries
                .values()
                .filter(|entry| matches!(*mutex_lock(&entry.state), ThumbState::Ready))
                .filter(|entry| valid_cache_file(&entry.cache_path))
                .map(|entry| (entry.record.id.clone(), entry.cache_path.clone()))
                .collect::<Vec<_>>();
            (ids, ready)
        };
        let current_ids = ids.iter().map(String::as_str).collect::<HashSet<_>>();
        text_search.reconcile(&current_ids);
        for (id, thumbnail) in ready {
            text_search.enqueue(&id, &thumbnail, false);
        }
        text_search.start_worker();
        true
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
        if let Some(text_search) = self.text_search() {
            text_search.reconcile(&current_ids);
            let ready = {
                let entries = read_lock(&self.entries);
                entries
                    .values()
                    .filter(|entry| matches!(*mutex_lock(&entry.state), ThumbState::Ready))
                    .filter(|entry| valid_cache_file(&entry.cache_path))
                    .map(|entry| (entry.record.id.clone(), entry.cache_path.clone()))
                    .collect::<Vec<_>>()
            };
            for (id, thumbnail) in ready {
                text_search.enqueue(&id, &thumbnail, false);
            }
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

    /// Build descriptors for thumbnails created by an older Pixhelf release.
    /// New thumbnails write their descriptor during generation, so this is a
    /// one-time, low-priority migration after an upgrade.
    pub fn start_similarity_warmup(self: &Arc<Self>) {
        if self.similarity_warmup_running.swap(true, Ordering::AcqRel) {
            return;
        }
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let pending = {
                let entries = read_lock(&manager.entries);
                entries
                    .values()
                    .filter(|entry| matches!(*mutex_lock(&entry.state), ThumbState::Ready))
                    .filter(|entry| valid_cache_file(&entry.cache_path))
                    .filter(|entry| !has_signature_sidecar(&entry.cache_path))
                    .map(|entry| (Arc::clone(&entry.record), entry.cache_path.clone()))
                    .collect::<Vec<_>>()
            };
            let total = pending.len();
            let result = tokio::task::spawn_blocking(move || {
                pending
                    .into_iter()
                    .filter(|(record, thumbnail)| {
                        if let Err(error) = signature_for_thumbnail(record, thumbnail) {
                            warn!(image = %record.relative_path, %error, "无法补齐相似图片索引");
                            true
                        } else {
                            false
                        }
                    })
                    .count()
            })
            .await;
            match result {
                Ok(0) if total > 0 => {
                    info!(images = total, "相似图片索引已补齐");
                }
                Ok(failures) if failures > 0 => {
                    warn!(
                        total,
                        failed = failures,
                        "相似图片索引补齐结束，部分图片处理失败"
                    );
                }
                Ok(_) => {}
                Err(error) => warn!(%error, "相似图片索引任务中断"),
            }
            manager
                .similarity_warmup_running
                .store(false, Ordering::Release);
        });
    }

    pub async fn prepare_initial(&self, ids: &[String]) {
        for id in ids {
            self.promote(id);
        }

        let mut failures = 0usize;
        for id in ids {
            if let Err(error) = self.wait_for(id).await {
                failures += 1;
                // The worker reports the final failure; avoid repeating it at normal log levels.
                debug!(%id, %error, "首批缩略图中有图片不可用");
            }
        }
        self.initial_ready.store(true, Ordering::Release);
        if failures > 0 {
            warn!(
                ready = ids.len() - failures,
                failed = failures,
                "首批缩略图处理结束，部分图片未能生成"
            );
        } else if !ids.is_empty() {
            info!(images = ids.len(), "首批缩略图已就绪");
        }
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
            text_search: self
                .text_search()
                .as_deref()
                .map_or_else(TextSearchStatus::disabled, |index| index.status()),
        }
    }

    pub async fn text_query_embedding(
        &self,
        query: &str,
    ) -> Result<Option<Arc<TextSearchEmbedding>>> {
        let Some(index) = self.text_search() else {
            return Ok(None);
        };
        index.embed_query(query).await.map(Some)
    }

    pub fn text_search_embedding(&self, id: &str) -> Option<Arc<TextSearchEmbedding>> {
        self.text_search()?.embedding(id)
    }

    pub fn text_search_cache_token(&self) -> String {
        self.text_search()
            .as_deref()
            .map_or_else(|| "off".to_owned(), |index| index.cache_token())
    }

    pub fn ready_path(&self, id: &str) -> Option<PathBuf> {
        let entry = read_lock(&self.entries).get(id).cloned()?;
        let ready = matches!(*mutex_lock(&entry.state), ThumbState::Ready);
        (ready && valid_cache_file(&entry.cache_path)).then(|| entry.cache_path.clone())
    }

    pub async fn cleanup_stale(&self) {
        let valid_ids: HashSet<String> = read_lock(&self.entries).keys().cloned().collect();
        let root = self.cache_root.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || cleanup_cache(&root, &valid_ids)).await
        {
            warn!(%error, "缩略图缓存清理任务中断");
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
                        if let Some(text_search) = self.text_search() {
                            text_search.enqueue(&id, &entry.cache_path, false);
                        }
                        entry.notify.notify_waiters();
                    } else if removed && !read_lock(&self.entries).contains_key(&id) {
                        remove_cached_artifacts(&entry.cache_path);
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
                    if retry {
                        debug!(worker, image = %entry.record.relative_path, attempt, %error, "缩略图生成失败，自动重试");
                    } else {
                        warn!(image = %entry.record.relative_path, attempts = attempt, %error, "缩略图生成失败，已达到重试上限");
                    }
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
    record.ensure_source_is_current()?;
    let reader = ImageReader::open(&record.path)
        .with_context(|| format!("cannot open {}", record.path.display()))?
        .with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let (width, height) = image.dimensions();
    let image = if width.max(height) > THUMBNAIL_EDGE {
        image.resize(THUMBNAIL_EDGE, THUMBNAIL_EDGE, FilterType::Triangle)
    } else {
        image
    };
    write_webp(&image, output, WEBP_QUALITY)
        .with_context(|| format!("cannot store thumbnail: {}", output.display()))?;
    if let Err(error) = cache_signature_for_thumbnail(record, &image, output) {
        warn!(path = %output.display(), %error, "无法保存相似图片索引");
    }
    if let Err(error) = record.ensure_source_is_current() {
        remove_cached_artifacts(output);
        return Err(error);
    }
    Ok(())
}

fn remove_cached_artifacts(thumbnail: &Path) {
    if let Err(error) = fs::remove_file(thumbnail)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        warn!(path = %thumbnail.display(), %error, "无法清理过期缩略图");
    }
    if let Err(error) = remove_signature_for_thumbnail(thumbnail) {
        warn!(path = %thumbnail.display(), %error, "无法清理过期相似图片索引");
    }
    if let Err(error) = remove_sidecar(thumbnail, OBSOLETE_DINO_EXTENSION) {
        warn!(path = %thumbnail.display(), %error, "无法清理旧版 DINOv2 索引");
    }
    if let Err(error) = remove_text_search_embedding(thumbnail) {
        warn!(path = %thumbnail.display(), %error, "无法清理过期文字搜图索引");
    }
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
        if is_sidecar(path, OBSOLETE_DINO_EXTENSION) {
            if let Err(error) = fs::remove_file(path) {
                warn!(path = %path.display(), %error, "无法清理旧版 DINOv2 索引");
            }
            return;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("webp")
            && !is_signature_sidecar(path)
            && !is_text_search_sidecar(path)
        {
            return;
        }
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        if !valid_ids.contains(stem)
            && let Err(error) = fs::remove_file(path)
        {
            warn!(path = %path.display(), %error, "无法清理过期缩略图");
        }
    });
}

fn purge_temporary_files(root: &Path) {
    visit_cache_files(root, |path| {
        if path.extension().and_then(|ext| ext.to_str()) == Some("tmp")
            && let Err(error) = fs::remove_file(path)
        {
            warn!(path = %path.display(), %error, "无法清理临时缩略图");
        }
    });
}

fn visit_cache_files(root: &Path, mut visit: impl FnMut(&Path)) {
    for entry in WalkDir::new(root).min_depth(1) {
        match entry {
            Ok(entry) if entry.file_type().is_file() => visit(entry.path()),
            Ok(_) => {}
            Err(error) => warn!(%error, "无法读取缩略图缓存目录"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gallery::scan_gallery;

    struct ConstantTextSearchModel;

    impl crate::text_search::TextImageModel for ConstantTextSearchModel {
        fn embed_thumbnail(&mut self, _thumbnail: &Path) -> Result<TextSearchEmbedding> {
            Ok(TextSearchEmbedding::for_test([(0, 100)]))
        }

        fn embed_text(&mut self, _text: &str) -> Result<TextSearchEmbedding> {
            Ok(TextSearchEmbedding::for_test([(0, 100)]))
        }
    }

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
        assert!(temp.path().join("thumbnail.sim2").is_file());
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
        let signature = thumbnail.with_extension("sim2");
        let obsolete_dino = thumbnail.with_extension("dino2");
        let text_search = thumbnail.with_extension("cnclip");
        let old_compact = thumbnail.with_file_name(format!("{id}-360.webp"));
        let stale = shard_path(root, "stale");
        let stale_signature = stale.with_extension("sim2");
        let stale_dino = stale.with_extension("dino2");
        let stale_text_search = stale.with_extension("cnclip");
        fs::create_dir_all(thumbnail.parent().unwrap()).unwrap();
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&thumbnail, [1; 32]).unwrap();
        fs::write(&signature, [1; 32]).unwrap();
        fs::write(&obsolete_dino, [1; 32]).unwrap();
        fs::write(&text_search, [1; 32]).unwrap();
        fs::write(&old_compact, [1; 32]).unwrap();
        fs::write(&stale, [1; 32]).unwrap();
        fs::write(&stale_signature, [1; 32]).unwrap();
        fs::write(&stale_dino, [1; 32]).unwrap();
        fs::write(&stale_text_search, [1; 32]).unwrap();

        cleanup_cache(root, &HashSet::from([id.to_owned()]));

        assert!(thumbnail.exists());
        assert!(signature.exists());
        assert!(!obsolete_dino.exists());
        assert!(text_search.exists());
        assert!(!old_compact.exists());
        assert!(!stale.exists());
        assert!(!stale_signature.exists());
        assert!(!stale_dino.exists());
        assert!(!stale_text_search.exists());
    }

    #[tokio::test]
    async fn warmup_migrates_cached_thumbnails_without_descriptors() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        fs::create_dir(&gallery).unwrap();
        let source = gallery.join("warmup.png");
        image::RgbImage::from_fn(48, 32, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 6) as u8, ((x + y) * 3) as u8])
        })
        .save(&source)
        .unwrap();
        let index = scan_gallery(&gallery, None).unwrap();
        let manager = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        let cached = manager.cache_path(&index.images[0].id);
        fs::create_dir_all(cached.parent().unwrap()).unwrap();
        write_webp(&image::open(&source).unwrap(), &cached, WEBP_QUALITY).unwrap();
        assert!(valid_cache_file(&cached));
        assert!(!has_signature_sidecar(&cached));

        manager.reconcile(&index.images);
        manager.start_similarity_warmup();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if has_signature_sidecar(&cached)
                    && !manager.similarity_warmup_running.load(Ordering::Acquire)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("similarity descriptor warmup timed out");
    }

    #[tokio::test]
    async fn downloaded_text_search_attaches_to_existing_thumbnails() {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        fs::create_dir(&gallery).unwrap();
        image::RgbImage::new(20, 10)
            .save(gallery.join("image.png"))
            .unwrap();
        let gallery = scan_gallery(&gallery, None).unwrap();
        let manager = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        manager.reconcile(&gallery.images);
        manager.start_workers(1);
        let id = gallery.images[0].id.clone();
        manager.ensure_ready(&id).await.unwrap();
        assert!(!manager.status().text_search.enabled);

        let text_search = TextSearchIndex::with_test_model(
            Box::new(ConstantTextSearchModel),
            [17; crate::support::embedding::FINGERPRINT_BYTES],
        );
        assert!(manager.enable_text_search(text_search));

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let status = manager.status().text_search;
                if status.background_complete && status.ready == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dynamically attached text-search index timed out");
        assert!(manager.text_search_embedding(&id).is_some());
    }

    #[tokio::test]
    async fn changed_source_requires_a_fresh_gallery_record() {
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
        let old_id = index.images[0].id.clone();
        assert!(matches!(
            manager.ensure_ready(&old_id).await,
            Err(ThumbnailError::Generation(_))
        ));

        image::RgbImage::new(20, 10).save(&image_path).unwrap();
        let updated = scan_gallery(&gallery, Some(&index)).unwrap();
        let new_id = updated.images[0].id.clone();
        assert_ne!(new_id, old_id);
        manager.reconcile(&updated.images);

        let thumbnail = manager.ensure_ready(&new_id).await.unwrap();
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
