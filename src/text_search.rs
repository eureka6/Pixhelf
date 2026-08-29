//! Optional Chinese-CLIP embeddings for natural-language image search.
//!
//! The model, vocabulary, image embeddings, and text queries stay local. A
//! single CPU worker builds compact quantised image vectors beside thumbnails;
//! text queries use the same shared embedding space and are cached in memory.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result, anyhow, bail};
use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::chinese_clip::{ChineseClipConfig, ChineseClipModel};
use image::{DynamicImage, GenericImageView, ImageReader, imageops::FilterType};
use serde::Serialize;
use tokenizers::{
    Tokenizer, TruncationParams, models::wordpiece::WordPiece, normalizers::bert::BertNormalizer,
    pre_tokenizers::bert::BertPreTokenizer, processors::bert::BertProcessing,
};
use tokio::sync::Notify;
use tracing::{info, warn};

const MODEL_NAME: &str = "Chinese-CLIP ViT-B/16";
const MODEL_EDGE: u32 = 224;
const TEXT_CONTEXT_LENGTH: usize = 52;
const EMBEDDING_SIZE: usize = 512;
const EMBEDDING_MAGIC: &[u8; 8] = b"PXHFCN1\0";
const EMBEDDING_EXTENSION: &str = "cnclip";
const MODEL_FINGERPRINT_BYTES: usize = 16;
const EMBEDDING_CHECKSUM_BYTES: usize = 16;
const EMBEDDING_LENGTH: u64 =
    (EMBEDDING_MAGIC.len() + MODEL_FINGERPRINT_BYTES + EMBEDDING_SIZE + EMBEDDING_CHECKSUM_BYTES)
        as u64;
const QUERY_CACHE_LIMIT: usize = 16;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub(crate) struct TextSearchEmbedding {
    values: [i8; EMBEDDING_SIZE],
    norm: f32,
}

impl TextSearchEmbedding {
    fn quantize(values: &[f32]) -> Result<Self> {
        if values.len() != EMBEDDING_SIZE || values.iter().any(|value| !value.is_finite()) {
            bail!("text-search model returned an invalid embedding");
        }
        let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm <= f32::EPSILON {
            bail!("text-search model returned an empty embedding");
        }
        let values = std::array::from_fn(|index| {
            (values[index] / norm * 127.0).round().clamp(-127.0, 127.0) as i8
        });
        Self::from_quantized(values)
    }

    fn from_quantized(values: [i8; EMBEDDING_SIZE]) -> Result<Self> {
        let norm = values
            .iter()
            .map(|value| f32::from(*value).powi(2))
            .sum::<f32>()
            .sqrt();
        if norm <= f32::EPSILON {
            bail!("text-search embedding is empty");
        }
        Ok(Self { values, norm })
    }

    #[cfg(test)]
    pub(crate) fn for_test(values: impl IntoIterator<Item = (usize, i8)>) -> Self {
        let mut embedding = [0_i8; EMBEDDING_SIZE];
        for (index, value) in values {
            embedding[index] = value;
        }
        Self::from_quantized(embedding).expect("test embedding must not be empty")
    }
}

pub(crate) fn text_image_similarity(
    query: &TextSearchEmbedding,
    image: &TextSearchEmbedding,
) -> f32 {
    let dot = query
        .values
        .iter()
        .zip(&image.values)
        .map(|(left, right)| f32::from(*left) * f32::from(*right))
        .sum::<f32>();
    (dot / (query.norm * image.norm)).clamp(-1.0, 1.0)
}

pub(crate) trait TextImageModel: Send {
    fn embed_thumbnail(&mut self, thumbnail: &Path) -> Result<TextSearchEmbedding>;
    fn embed_text(&mut self, text: &str) -> Result<TextSearchEmbedding>;
}

pub(crate) struct TextSearchIndex {
    model: Arc<Mutex<Box<dyn TextImageModel>>>,
    model_fingerprint: [u8; MODEL_FINGERPRINT_BYTES],
    model_token: String,
    entries: RwLock<HashMap<String, Arc<TextSearchEntry>>>,
    queue: TextSearchQueue,
    query_cache: Mutex<VecDeque<(String, Arc<TextSearchEmbedding>)>>,
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

#[derive(Default)]
struct TextSearchQueue {
    state: Mutex<TextSearchQueueState>,
    notify: Notify,
}

#[derive(Default)]
struct TextSearchQueueState {
    urgent: VecDeque<String>,
    background: VecDeque<String>,
    queued: HashSet<String>,
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

impl TextSearchIndex {
    pub(crate) fn load(model_path: &Path, vocabulary_path: &Path) -> Result<Arc<Self>> {
        let fingerprint = fingerprint_files(&[model_path, vocabulary_path])?;
        let model = ChineseClip::load(model_path, vocabulary_path).with_context(|| {
            format!(
                "cannot load natural-language search model: {}",
                model_path.display()
            )
        })?;
        let index = Self::with_model(Box::new(model), fingerprint);
        info!(
            model = MODEL_NAME,
            fingerprint = %index.model_token,
            "local natural-language image search enabled"
        );
        Ok(index)
    }

    #[cfg(test)]
    pub(crate) fn with_test_model(
        model: Box<dyn TextImageModel>,
        model_fingerprint: [u8; MODEL_FINGERPRINT_BYTES],
    ) -> Arc<Self> {
        Self::with_model(model, model_fingerprint)
    }

    fn with_model(
        model: Box<dyn TextImageModel>,
        model_fingerprint: [u8; MODEL_FINGERPRINT_BYTES],
    ) -> Arc<Self> {
        Arc::new(Self {
            model: Arc::new(Mutex::new(model)),
            model_fingerprint,
            model_token: fingerprint_token(&model_fingerprint),
            entries: RwLock::new(HashMap::new()),
            queue: TextSearchQueue::default(),
            query_cache: Mutex::new(VecDeque::new()),
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
        let mut cache = mutex_lock(&self.query_cache);
        let position = cache.iter().position(|(cached, _)| cached == query)?;
        let entry = cache.remove(position)?;
        let embedding = Arc::clone(&entry.1);
        cache.push_back(entry);
        Some(embedding)
    }

    fn cache_query(&self, query: String, embedding: Arc<TextSearchEmbedding>) {
        let mut cache = mutex_lock(&self.query_cache);
        if let Some(position) = cache.iter().position(|(cached, _)| cached == &query) {
            cache.remove(position);
        }
        if cache.len() >= QUERY_CACHE_LIMIT {
            cache.pop_front();
        }
        cache.push_back((query, embedding));
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
                    warn!(path = %sidecar.display(), %error, "cannot persist text-search image embedding");
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
                        warn!(image = %id, %error, "text-search image embedding failed");
                    } else {
                        removed = matches!(*state, TextSearchState::Removed);
                    }
                }
            }
            entry.notify.notify_waiters();
            if removed && let Err(error) = remove_embedding_for_thumbnail(&entry.thumbnail) {
                warn!(path = %entry.thumbnail.display(), %error, "cannot remove stale text-search embedding");
            }
        }
    }
}

impl TextSearchQueue {
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
        if should_notify {
            self.notify.notify_one();
        }
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
        if should_notify {
            self.notify.notify_one();
        }
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

pub(crate) fn embedding_path(thumbnail: &Path) -> PathBuf {
    thumbnail.with_extension(EMBEDDING_EXTENSION)
}

pub(crate) fn is_text_search_sidecar(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()) == Some(EMBEDDING_EXTENSION)
}

pub(crate) fn remove_embedding_for_thumbnail(thumbnail: &Path) -> std::io::Result<()> {
    match fs::remove_file(embedding_path(thumbnail)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn read_embedding(
    path: &Path,
    expected_fingerprint: &[u8; MODEL_FINGERPRINT_BYTES],
) -> Result<TextSearchEmbedding> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() != EMBEDDING_LENGTH {
        bail!("text-search embedding cache has an unexpected size");
    }
    let mut file = File::open(path)?;
    let mut magic = [0_u8; EMBEDDING_MAGIC.len()];
    file.read_exact(&mut magic)?;
    if &magic != EMBEDDING_MAGIC {
        bail!("text-search embedding cache has an unknown version");
    }
    let mut fingerprint = [0_u8; MODEL_FINGERPRINT_BYTES];
    file.read_exact(&mut fingerprint)?;
    if &fingerprint != expected_fingerprint {
        bail!("text-search embedding belongs to another model");
    }
    let mut bytes = [0_u8; EMBEDDING_SIZE];
    file.read_exact(&mut bytes)?;
    let mut checksum = [0_u8; EMBEDDING_CHECKSUM_BYTES];
    file.read_exact(&mut checksum)?;
    if checksum != embedding_checksum(&fingerprint, &bytes) {
        bail!("text-search embedding cache checksum does not match");
    }
    TextSearchEmbedding::from_quantized(bytes.map(|value| value as i8))
}

fn write_embedding(
    path: &Path,
    fingerprint: &[u8; MODEL_FINGERPRINT_BYTES],
    embedding: &TextSearchEmbedding,
) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("invalid text-search cache path: {}", path.display()))?;
    fs::create_dir_all(parent)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("embedding"),
        std::process::id(),
        sequence
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(EMBEDDING_MAGIC)?;
        file.write_all(fingerprint)?;
        let values = embedding.values.map(|value| value as u8);
        file.write_all(&values)?;
        file.write_all(&embedding_checksum(fingerprint, &values))?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn embedding_checksum(
    fingerprint: &[u8; MODEL_FINGERPRINT_BYTES],
    values: &[u8; EMBEDDING_SIZE],
) -> [u8; EMBEDDING_CHECKSUM_BYTES] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(fingerprint);
    hasher.update(values);
    let mut checksum = [0_u8; EMBEDDING_CHECKSUM_BYTES];
    checksum.copy_from_slice(&hasher.finalize().as_bytes()[..EMBEDDING_CHECKSUM_BYTES]);
    checksum
}

fn fingerprint_files(paths: &[&Path]) -> Result<[u8; MODEL_FINGERPRINT_BYTES]> {
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 128 * 1024];
    for path in paths {
        let mut file = File::open(path)
            .with_context(|| format!("cannot open text-search model file: {}", path.display()))?;
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        hasher.update(b"\0");
    }
    let mut fingerprint = [0_u8; MODEL_FINGERPRINT_BYTES];
    fingerprint.copy_from_slice(&hasher.finalize().as_bytes()[..MODEL_FINGERPRINT_BYTES]);
    Ok(fingerprint)
}

fn fingerprint_token(fingerprint: &[u8; MODEL_FINGERPRINT_BYTES]) -> String {
    let mut token = String::with_capacity(MODEL_FINGERPRINT_BYTES * 2);
    for byte in fingerprint {
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    token
}

struct ChineseClip {
    model: ChineseClipModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl ChineseClip {
    fn load(model_path: &Path, vocabulary_path: &Path) -> Result<Self> {
        let device = Device::Cpu;
        // SAFETY: the mapped model is immutable for the process lifetime. The
        // documentation requires stopping Pixhelf before replacing it.
        let variables =
            unsafe { VarBuilder::from_mmaped_safetensors(&[model_path], DType::F32, &device)? };
        let config = ChineseClipConfig::clip_vit_base_patch16();
        let model = ChineseClipModel::new(variables, &config)?;
        let tokenizer = load_tokenizer(vocabulary_path)?;
        Ok(Self {
            model,
            tokenizer,
            device,
        })
    }
}

impl TextImageModel for ChineseClip {
    fn embed_thumbnail(&mut self, thumbnail: &Path) -> Result<TextSearchEmbedding> {
        let input = preprocess_thumbnail(thumbnail)?;
        let values = self
            .model
            .get_image_features(&input)?
            .i(0)?
            .to_vec1::<f32>()?;
        TextSearchEmbedding::quantize(&values)
    }

    fn embed_text(&mut self, text: &str) -> Result<TextSearchEmbedding> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|error| anyhow!("cannot tokenize text query: {error}"))?;
        if encoding.is_empty() {
            bail!("text query did not produce any tokens");
        }
        let input_ids = Tensor::new(encoding.get_ids(), &self.device)?.unsqueeze(0)?;
        let token_type_ids = Tensor::new(encoding.get_type_ids(), &self.device)?.unsqueeze(0)?;
        let attention_mask =
            Tensor::new(encoding.get_attention_mask(), &self.device)?.unsqueeze(0)?;
        let values = self
            .model
            .get_text_features(&input_ids, Some(&token_type_ids), Some(&attention_mask))?
            .i(0)?
            .to_vec1::<f32>()?;
        TextSearchEmbedding::quantize(&values)
    }
}

fn load_tokenizer(vocabulary_path: &Path) -> Result<Tokenizer> {
    let vocabulary = vocabulary_path.to_str().with_context(|| {
        format!(
            "vocabulary path is not UTF-8: {}",
            vocabulary_path.display()
        )
    })?;
    let model = WordPiece::from_file(vocabulary)
        .unk_token("[UNK]".to_owned())
        .build()
        .map_err(|error| anyhow!("cannot load Chinese-CLIP vocabulary: {error}"))?;
    let mut tokenizer = Tokenizer::new(model);
    let cls_id = tokenizer
        .token_to_id("[CLS]")
        .context("Chinese-CLIP vocabulary is missing [CLS]")?;
    let sep_id = tokenizer
        .token_to_id("[SEP]")
        .context("Chinese-CLIP vocabulary is missing [SEP]")?;
    tokenizer.with_normalizer(Some(BertNormalizer::default()));
    tokenizer.with_pre_tokenizer(Some(BertPreTokenizer));
    tokenizer.with_post_processor(Some(BertProcessing::new(
        ("[SEP]".to_owned(), sep_id),
        ("[CLS]".to_owned(), cls_id),
    )));
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: TEXT_CONTEXT_LENGTH,
            ..Default::default()
        }))
        .map_err(|error| anyhow!("cannot configure Chinese-CLIP tokenizer: {error}"))?;
    Ok(tokenizer)
}

fn preprocess_thumbnail(path: &Path) -> Result<Tensor> {
    let image = ImageReader::open(path)
        .with_context(|| format!("cannot open thumbnail {}", path.display()))?
        .with_guessed_format()?
        .decode()
        .with_context(|| format!("cannot decode thumbnail {}", path.display()))?;
    preprocess_image(&image)
}

fn preprocess_image(image: &DynamicImage) -> Result<Tensor> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        bail!("cannot embed an empty image");
    }
    // The official ChineseCLIPFeatureExtractor resizes directly to 224x224
    // and does not centre-crop this checkpoint.
    let pixels = image
        .resize_exact(MODEL_EDGE, MODEL_EDGE, FilterType::CatmullRom)
        .to_rgb8();
    const MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
    const STANDARD_DEVIATION: [f32; 3] = [0.268_629_54, 0.261_302_6, 0.275_777_1];
    let mut values = Vec::with_capacity((MODEL_EDGE * MODEL_EDGE * 3) as usize);
    for channel in 0..3 {
        values.extend(pixels.pixels().map(|pixel| {
            (f32::from(pixel.0[channel]) / 255.0 - MEAN[channel]) / STANDARD_DEVIATION[channel]
        }));
    }
    Ok(Tensor::from_vec(
        values,
        (1, 3, MODEL_EDGE as usize, MODEL_EDGE as usize),
        &Device::Cpu,
    )?)
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

    #[test]
    fn tokenizer_uses_chinese_bert_special_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("vocab.txt");
        let mut vocabulary = vec!["[PAD]".to_owned()];
        vocabulary.extend((0..99).map(|index| format!("[unused{index}]")));
        vocabulary.extend(
            ["[UNK]", "[CLS]", "[SEP]", "[MASK]", "海", "边", "日", "落"].map(str::to_owned),
        );
        fs::write(&path, format!("{}\n", vocabulary.join("\n"))).unwrap();
        let tokenizer = load_tokenizer(&path).unwrap();
        let encoding = tokenizer.encode("海边日落", true).unwrap();
        assert_eq!(encoding.get_ids().first(), Some(&101));
        assert_eq!(encoding.get_ids().last(), Some(&102));
        assert!(encoding.len() >= 6);
    }

    #[test]
    fn preprocessing_matches_official_chinese_clip_shape() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_fn(400, 200, |x, y| {
            image::Rgb([(x % 255) as u8, (y % 255) as u8, 128])
        }));
        let tensor = preprocess_image(&image).unwrap();
        assert_eq!(tensor.dims(), &[1, 3, 224, 224]);
        assert!(tensor.flatten_all().unwrap().to_vec1::<f32>().unwrap()[0].is_finite());
    }

    #[test]
    fn official_model_runs_when_supplied_by_the_test_environment() {
        let (Some(model_path), Some(vocabulary_path)) = (
            std::env::var_os("PIXHELF_CHINESE_CLIP_MODEL"),
            std::env::var_os("PIXHELF_CHINESE_CLIP_VOCAB"),
        ) else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let red = temp.path().join("red.png");
        let blue = temp.path().join("blue.png");
        image::RgbImage::from_pixel(224, 224, image::Rgb([235, 30, 25]))
            .save(&red)
            .unwrap();
        image::RgbImage::from_pixel(224, 224, image::Rgb([25, 40, 235]))
            .save(&blue)
            .unwrap();

        let mut model =
            ChineseClip::load(Path::new(&model_path), Path::new(&vocabulary_path)).unwrap();
        let query = model.embed_text("一张红色的图片").unwrap();
        let red = model.embed_thumbnail(&red).unwrap();
        let blue = model.embed_thumbnail(&blue).unwrap();
        let red_score = text_image_similarity(&query, &red);
        let blue_score = text_image_similarity(&query, &blue);
        eprintln!("official Chinese-CLIP scores: red={red_score:.4}, blue={blue_score:.4}");
        assert!(red_score > blue_score);
    }
}
