//! Optional Chinese-CLIP embeddings for natural-language image search.
//!
//! The model, vocabulary, image embeddings, and text queries stay local. A
//! single CPU worker builds compact quantised image vectors beside thumbnails;
//! text queries use the same shared embedding space and are cached in memory.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Result, anyhow};
use serde::Serialize;
use tokio::sync::Notify;
use tracing::{debug, warn};

use crate::support::{
    BoundedCache, PriorityQueue,
    embedding::{
        FINGERPRINT_BYTES, Fingerprint, QuantizedEmbedding, fingerprint_files, fingerprint_token,
        is_sidecar, read_sidecar, remove_sidecar, sidecar_path, write_sidecar,
    },
    mutex_lock, read_lock, write_lock,
};

mod download;
mod model;

pub(crate) use download::ensure_automatic_model;

#[cfg(test)]
pub(crate) use model::TextImageModel;
use model::{LazyModel, MODEL_NAME};

const EMBEDDING_SIZE: usize = 512;
const EMBEDDING_MAGIC: &[u8; 8] = b"PXHFCN1\0";
const EMBEDDING_EXTENSION: &str = "cnclip";
const MODEL_FINGERPRINT_BYTES: usize = FINGERPRINT_BYTES;
const QUERY_CACHE_LIMIT: usize = 16;
const MODEL_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MODEL_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(10);

pub(crate) type TextSearchEmbedding = QuantizedEmbedding<EMBEDDING_SIZE>;

pub(crate) fn text_image_similarity(
    query: &TextSearchEmbedding,
    image: &TextSearchEmbedding,
) -> f32 {
    query.cosine_similarity(image)
}

pub(crate) struct TextSearchIndex {
    model: Arc<Mutex<LazyModel>>,
    model_fingerprint: Fingerprint,
    model_token: String,
    entries: RwLock<HashMap<String, Arc<TextSearchEntry>>>,
    queue: PriorityQueue,
    query_cache: Mutex<BoundedCache<Arc<TextSearchEmbedding>>>,
    worker_started: AtomicBool,
    revision: AtomicU64,
}

struct TextSearchEntry {
    thumbnail: PathBuf,
    state: Mutex<TextSearchState>,
    notify: Notify,
}

enum TextSearchState {
    Pending,
    Processing,
    Ready(Arc<TextSearchEmbedding>),
    Failed,
    Removed,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextSearchStatus {
    pub enabled: bool,
    pub total: usize,
    pub ready: usize,
    pub queued: usize,
    pub processing: usize,
    pub failed: usize,
    pub background_complete: bool,
}

impl TextSearchStatus {
    pub(crate) fn disabled() -> Self {
        Self {
            enabled: false,
            total: 0,
            ready: 0,
            queued: 0,
            processing: 0,
            failed: 0,
            background_complete: true,
        }
    }
}

impl TextSearchIndex {
    pub(crate) fn load(model_path: &Path, vocabulary_path: &Path) -> Result<Arc<Self>> {
        let fingerprint =
            fingerprint_files(&[model_path, vocabulary_path], "text-search model file")?;
        let model = LazyModel::chinese_clip(model_path.to_owned(), vocabulary_path.to_owned());
        let index = Self::with_model(model, fingerprint);
        debug!(
            model = MODEL_NAME,
            path = %model_path.display(),
            fingerprint = %index.model_token,
            "文字搜图模型文件已就绪"
        );
        Ok(index)
    }

    #[cfg(test)]
    pub(crate) fn with_test_model(
        model: Box<dyn TextImageModel>,
        model_fingerprint: [u8; MODEL_FINGERPRINT_BYTES],
    ) -> Arc<Self> {
        Self::with_model(LazyModel::preloaded(model), model_fingerprint)
    }

    #[cfg(test)]
    fn with_test_loader(
        loader: impl Fn() -> Result<Box<dyn TextImageModel>> + Send + Sync + 'static,
        model_fingerprint: [u8; MODEL_FINGERPRINT_BYTES],
    ) -> Arc<Self> {
        Self::with_model(LazyModel::with_loader(loader), model_fingerprint)
    }

    fn with_model(model: LazyModel, model_fingerprint: [u8; MODEL_FINGERPRINT_BYTES]) -> Arc<Self> {
        Arc::new(Self {
            model: Arc::new(Mutex::new(model)),
            model_fingerprint,
            model_token: fingerprint_token(&model_fingerprint),
            entries: RwLock::new(HashMap::new()),
            queue: PriorityQueue::default(),
            query_cache: Mutex::new(BoundedCache::new(QUERY_CACHE_LIMIT)),
            worker_started: AtomicBool::new(false),
            revision: AtomicU64::new(0),
        })
    }

    pub(crate) fn start_worker(self: &Arc<Self>) {
        if self.worker_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let index = Arc::clone(self);
        tokio::spawn(async move {
            index.worker_loop().await;
        });
        let index = Arc::clone(self);
        tokio::spawn(async move {
            index.model_reaper_loop().await;
        });
    }

    pub(crate) fn reconcile(&self, valid_ids: &HashSet<&str>) {
        {
            let mut entries = write_lock(&self.entries);
            entries.retain(|id, entry| {
                let retained = valid_ids.contains(id.as_str());
                if !retained {
                    *mutex_lock(&entry.state) = TextSearchState::Removed;
                    entry.notify.notify_waiters();
                }
                retained
            });
        }
        self.queue.retain(valid_ids);
    }

    pub(crate) fn enqueue(&self, id: &str, thumbnail: &Path, urgent: bool) {
        let (entry, inserted) = {
            let mut entries = write_lock(&self.entries);
            match entries.get(id) {
                Some(entry) => (Arc::clone(entry), false),
                None => {
                    let entry = Arc::new(TextSearchEntry {
                        thumbnail: thumbnail.to_owned(),
                        state: Mutex::new(TextSearchState::Pending),
                        notify: Notify::new(),
                    });
                    entries.insert(id.to_owned(), Arc::clone(&entry));
                    (entry, true)
                }
            }
        };

        let pending = matches!(*mutex_lock(&entry.state), TextSearchState::Pending);
        if !inserted && !pending {
            return;
        }
        if urgent {
            self.queue.push_urgent(id.to_owned());
        } else {
            self.queue.push_background(id.to_owned());
        }
    }

    pub(crate) fn embedding(&self, id: &str) -> Option<Arc<TextSearchEmbedding>> {
        let entry = read_lock(&self.entries).get(id).cloned()?;
        let state = mutex_lock(&entry.state);
        match &*state {
            TextSearchState::Ready(embedding) => Some(Arc::clone(embedding)),
            _ => None,
        }
    }

    pub(crate) async fn embed_query(&self, query: &str) -> Result<Arc<TextSearchEmbedding>> {
        if let Some(embedding) = self.cached_query(query) {
            return Ok(embedding);
        }
        let model = Arc::clone(&self.model);
        let owned_query = query.to_owned();
        let embedding =
            tokio::task::spawn_blocking(move || mutex_lock(&model).embed_text(&owned_query))
                .await
                .map_err(|error| anyhow!("text-search query worker stopped: {error}"))??;
        let embedding = Arc::new(embedding);
        self.cache_query(query.to_owned(), Arc::clone(&embedding));
        Ok(embedding)
    }

    fn cached_query(&self, query: &str) -> Option<Arc<TextSearchEmbedding>> {
        mutex_lock(&self.query_cache).get_cloned(query)
    }

    fn cache_query(&self, query: String, embedding: Arc<TextSearchEmbedding>) {
        mutex_lock(&self.query_cache).insert(query, embedding);
    }

    pub(crate) fn cache_token(&self) -> String {
        format!(
            "{}-{}",
            self.model_token,
            self.revision.load(Ordering::Acquire)
        )
    }

    pub(crate) fn status(&self) -> TextSearchStatus {
        let entries = read_lock(&self.entries);
        let mut ready = 0;
        let mut queued = 0;
        let mut processing = 0;
        let mut failed = 0;
        for entry in entries.values() {
            match &*mutex_lock(&entry.state) {
                TextSearchState::Pending => queued += 1,
                TextSearchState::Processing => processing += 1,
                TextSearchState::Ready(_) => ready += 1,
                TextSearchState::Failed => failed += 1,
                TextSearchState::Removed => {}
            }
        }
        let total = entries.len();
        TextSearchStatus {
            enabled: true,
            total,
            ready,
            queued,
            processing,
            failed,
            background_complete: ready + failed == total && processing == 0,
        }
    }

    async fn model_reaper_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(MODEL_IDLE_CHECK_INTERVAL).await;
            if mutex_lock(&self.model).release_if_idle(MODEL_IDLE_TIMEOUT) {
                debug!(
                    model = MODEL_NAME,
                    idle_seconds = MODEL_IDLE_TIMEOUT.as_secs(),
                    "已释放空闲的文字搜图模型"
                );
            }
        }
    }

    #[cfg(test)]
    fn release_model_for_test(&self) -> bool {
        mutex_lock(&self.model).release_if_idle(Duration::ZERO)
    }

    async fn worker_loop(self: Arc<Self>) {
        loop {
            let id = self.queue.pop().await;
            let entry = read_lock(&self.entries).get(&id).cloned();
            let Some(entry) = entry else {
                continue;
            };
            {
                let mut state = mutex_lock(&entry.state);
                if !matches!(*state, TextSearchState::Pending) {
                    continue;
                }
                *state = TextSearchState::Processing;
            }

            let thumbnail = entry.thumbnail.clone();
            let sidecar = embedding_path(&thumbnail);
            let model = Arc::clone(&self.model);
            let fingerprint = self.model_fingerprint;
            let result = tokio::task::spawn_blocking(move || {
                if let Ok(embedding) = read_embedding(&sidecar, &fingerprint) {
                    return Ok(embedding);
                }
                let embedding = mutex_lock(&model).embed_thumbnail(&thumbnail)?;
                if let Err(error) = write_embedding(&sidecar, &fingerprint, &embedding) {
                    warn!(path = %sidecar.display(), %error, "无法保存文字搜图索引");
                }
                Ok(embedding)
            })
            .await
            .map_err(|error| anyhow!("text-search index worker stopped: {error}"))
            .and_then(|result| result);

            let mut removed = false;
            match result {
                Ok(embedding) => {
                    let mut state = mutex_lock(&entry.state);
                    if matches!(*state, TextSearchState::Processing) {
                        *state = TextSearchState::Ready(Arc::new(embedding));
                        self.revision.fetch_add(1, Ordering::AcqRel);
                    } else {
                        removed = matches!(*state, TextSearchState::Removed);
                    }
                }
                Err(error) => {
                    let mut state = mutex_lock(&entry.state);
                    if matches!(*state, TextSearchState::Processing) {
                        *state = TextSearchState::Failed;
                        self.revision.fetch_add(1, Ordering::AcqRel);
                        warn!(image = %id, %error, "文字搜图索引生成失败");
                    } else {
                        removed = matches!(*state, TextSearchState::Removed);
                    }
                }
            }
            entry.notify.notify_waiters();
            if removed && let Err(error) = remove_embedding_for_thumbnail(&entry.thumbnail) {
                warn!(path = %entry.thumbnail.display(), %error, "无法清理过期文字搜图索引");
            }
        }
    }
}

pub(crate) fn embedding_path(thumbnail: &Path) -> PathBuf {
    sidecar_path(thumbnail, EMBEDDING_EXTENSION)
}

pub(crate) fn is_text_search_sidecar(path: &Path) -> bool {
    is_sidecar(path, EMBEDDING_EXTENSION)
}

pub(crate) fn remove_embedding_for_thumbnail(thumbnail: &Path) -> std::io::Result<()> {
    remove_sidecar(thumbnail, EMBEDDING_EXTENSION)
}

fn read_embedding(
    path: &Path,
    expected_fingerprint: &[u8; MODEL_FINGERPRINT_BYTES],
) -> Result<TextSearchEmbedding> {
    read_sidecar(
        path,
        expected_fingerprint,
        EMBEDDING_MAGIC,
        "text-search embedding",
    )
}

fn write_embedding(
    path: &Path,
    fingerprint: &[u8; MODEL_FINGERPRINT_BYTES],
    embedding: &TextSearchEmbedding,
) -> Result<()> {
    write_sidecar(
        path,
        fingerprint,
        EMBEDDING_MAGIC,
        embedding,
        "text-search embedding",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct ColourAndWordModel {
        image_calls: Arc<AtomicUsize>,
        text_calls: Arc<AtomicUsize>,
    }

    impl TextImageModel for ColourAndWordModel {
        fn embed_thumbnail(&mut self, thumbnail: &Path) -> Result<TextSearchEmbedding> {
            self.image_calls.fetch_add(1, Ordering::Relaxed);
            let pixel = image::open(thumbnail)?.to_rgb8().get_pixel(0, 0).0;
            let axis = if pixel[0] >= pixel[2] { 0 } else { 1 };
            Ok(TextSearchEmbedding::for_test([(axis, 100)]))
        }

        fn embed_text(&mut self, text: &str) -> Result<TextSearchEmbedding> {
            self.text_calls.fetch_add(1, Ordering::Relaxed);
            let axis = if text.contains('红') || text.contains("red") {
                0
            } else {
                1
            };
            Ok(TextSearchEmbedding::for_test([(axis, 100)]))
        }
    }

    #[test]
    fn quantised_cross_modal_cosine_is_stable() {
        let query = TextSearchEmbedding::for_test([(0, 100), (1, 50)]);
        let same = TextSearchEmbedding::for_test([(0, 100), (1, 50)]);
        let other = TextSearchEmbedding::for_test([(2, 100)]);
        assert!((text_image_similarity(&query, &same) - 1.0).abs() < 1e-5);
        assert!(text_image_similarity(&query, &other).abs() < 1e-5);
    }

    #[test]
    fn sidecar_round_trips_and_rejects_other_models() {
        let temp = tempfile::tempdir().unwrap();
        let path = embedding_path(&temp.path().join("image.webp"));
        let embedding = TextSearchEmbedding::for_test([(0, 100), (42, -70)]);
        let fingerprint = [7_u8; MODEL_FINGERPRINT_BYTES];
        write_embedding(&path, &fingerprint, &embedding).unwrap();
        let loaded = read_embedding(&path, &fingerprint).unwrap();
        assert!((text_image_similarity(&embedding, &loaded) - 1.0).abs() < 1e-5);
        assert!(read_embedding(&path, &[8; MODEL_FINGERPRINT_BYTES]).is_err());
    }

    #[tokio::test]
    async fn worker_persists_images_and_caches_text_queries() {
        let temp = tempfile::tempdir().unwrap();
        let thumbnail = temp.path().join("image.png");
        image::RgbImage::from_pixel(8, 8, image::Rgb([240, 20, 10]))
            .save(&thumbnail)
            .unwrap();
        let image_calls = Arc::new(AtomicUsize::new(0));
        let text_calls = Arc::new(AtomicUsize::new(0));
        let index = TextSearchIndex::with_test_model(
            Box::new(ColourAndWordModel {
                image_calls: Arc::clone(&image_calls),
                text_calls: Arc::clone(&text_calls),
            }),
            [9; MODEL_FINGERPRINT_BYTES],
        );
        index.reconcile(&HashSet::from(["image"]));
        index.enqueue("image", &thumbnail, false);
        index.start_worker();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if index.status().background_complete {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("text-search worker timed out");

        let image = index.embedding("image").unwrap();
        let first = index.embed_query("红色图片").await.unwrap();
        let repeated = index.embed_query("红色图片").await.unwrap();
        assert!(text_image_similarity(&first, &image) > 0.999);
        assert!(text_image_similarity(&repeated, &image) > 0.999);
        assert_eq!(image_calls.load(Ordering::Relaxed), 1);
        assert_eq!(text_calls.load(Ordering::Relaxed), 1);
        assert!(embedding_path(&thumbnail).is_file());
    }

    #[tokio::test]
    async fn reloadable_model_loads_on_demand_and_can_be_released() {
        let loads = Arc::new(AtomicUsize::new(0));
        let image_calls = Arc::new(AtomicUsize::new(0));
        let text_calls = Arc::new(AtomicUsize::new(0));
        let index = TextSearchIndex::with_test_loader(
            {
                let loads = Arc::clone(&loads);
                let image_calls = Arc::clone(&image_calls);
                let text_calls = Arc::clone(&text_calls);
                move || {
                    loads.fetch_add(1, Ordering::Relaxed);
                    Ok(Box::new(ColourAndWordModel {
                        image_calls: Arc::clone(&image_calls),
                        text_calls: Arc::clone(&text_calls),
                    }))
                }
            },
            [10; MODEL_FINGERPRINT_BYTES],
        );

        assert_eq!(loads.load(Ordering::Relaxed), 0);
        index.embed_query("红色图片").await.unwrap();
        assert_eq!(loads.load(Ordering::Relaxed), 1);
        assert!(index.release_model_for_test());

        index.embed_query("blue image").await.unwrap();
        assert_eq!(loads.load(Ordering::Relaxed), 2);
        assert_eq!(text_calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn cached_image_embedding_does_not_load_model() {
        let temp = tempfile::tempdir().unwrap();
        let thumbnail = temp.path().join("cached.webp");
        let fingerprint = [11; MODEL_FINGERPRINT_BYTES];
        write_embedding(
            &embedding_path(&thumbnail),
            &fingerprint,
            &TextSearchEmbedding::for_test([(0, 100)]),
        )
        .unwrap();
        let loads = Arc::new(AtomicUsize::new(0));
        let index = TextSearchIndex::with_test_loader(
            {
                let loads = Arc::clone(&loads);
                move || {
                    loads.fetch_add(1, Ordering::Relaxed);
                    Ok(Box::new(ColourAndWordModel {
                        image_calls: Arc::new(AtomicUsize::new(0)),
                        text_calls: Arc::new(AtomicUsize::new(0)),
                    }))
                }
            },
            fingerprint,
        );
        index.reconcile(&HashSet::from(["cached"]));
        index.enqueue("cached", &thumbnail, false);
        index.start_worker();

        tokio::time::timeout(Duration::from_secs(2), async {
            while !index.status().background_complete {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cached text-search index timed out");

        assert!(index.embedding("cached").is_some());
        assert_eq!(loads.load(Ordering::Relaxed), 0);
    }
}
