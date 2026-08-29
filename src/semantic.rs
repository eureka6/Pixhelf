//! Optional DINOv2 semantic embeddings for local image retrieval.
//!
//! Pixhelf never downloads a model at runtime. When the user supplies the
//! official `facebook/dinov2-small` safetensors file, a single background
//! CPU worker builds compact, quantised embeddings beside the thumbnails.
//! The model and every embedding remain local; any load or inference failure
//! leaves the model-free descriptor in `similarity.rs` fully usable.

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
use candle_core::{D, DType, Device, IndexOp, Tensor};
use candle_nn::{
    Conv2d, Conv2dConfig, LayerNorm, Linear, Module, VarBuilder, conv2d, layer_norm, linear,
};
use image::{DynamicImage, GenericImageView, ImageReader, imageops::FilterType};
use serde::Serialize;
use tokio::sync::Notify;
use tracing::{info, warn};

const MODEL_NAME: &str = "DINOv2 ViT-S/14";
const MODEL_EDGE: u32 = 224;
const RESIZE_SHORTEST_EDGE: u32 = 256;
const PATCH_EDGE: usize = 14;
const PATCH_GRID: usize = MODEL_EDGE as usize / PATCH_EDGE;
const PRETRAINED_PATCH_GRID: usize = 37;
const HIDDEN_SIZE: usize = 384;
const INTERMEDIATE_SIZE: usize = 1536;
const ATTENTION_HEADS: usize = 6;
const ATTENTION_HEAD_SIZE: usize = HIDDEN_SIZE / ATTENTION_HEADS;
const ENCODER_LAYERS: usize = 12;
const LAYER_NORM_EPSILON: f64 = 1e-6;
const EMBEDDING_MAGIC: &[u8; 8] = b"PXHFDN2\0";
const EMBEDDING_EXTENSION: &str = "dino2";
const MODEL_FINGERPRINT_BYTES: usize = 16;
const EMBEDDING_CHECKSUM_BYTES: usize = 16;
const EMBEDDING_LENGTH: u64 =
    (EMBEDDING_MAGIC.len() + MODEL_FINGERPRINT_BYTES + HIDDEN_SIZE + EMBEDDING_CHECKSUM_BYTES)
        as u64;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub(crate) struct SemanticEmbedding {
    values: [i8; HIDDEN_SIZE],
    norm: f32,
}

impl SemanticEmbedding {
    fn quantize(values: &[f32]) -> Result<Self> {
        if values.len() != HIDDEN_SIZE || values.iter().any(|value| !value.is_finite()) {
            bail!("semantic model returned an invalid embedding");
        }
        let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm <= f32::EPSILON {
            bail!("semantic model returned an empty embedding");
        }
        let values = std::array::from_fn(|index| {
            (values[index] / norm * 127.0).round().clamp(-127.0, 127.0) as i8
        });
        Self::from_quantized(values)
    }

    fn from_quantized(values: [i8; HIDDEN_SIZE]) -> Result<Self> {
        let norm = values
            .iter()
            .map(|value| f32::from(*value).powi(2))
            .sum::<f32>()
            .sqrt();
        if norm <= f32::EPSILON {
            bail!("semantic embedding is empty");
        }
        Ok(Self { values, norm })
    }

    #[cfg(test)]
    pub(crate) fn for_test(values: impl IntoIterator<Item = (usize, i8)>) -> Self {
        let mut embedding = [0_i8; HIDDEN_SIZE];
        for (index, value) in values {
            embedding[index] = value;
        }
        Self::from_quantized(embedding).expect("test embedding must not be empty")
    }
}

pub(crate) fn semantic_similarity(left: &SemanticEmbedding, right: &SemanticEmbedding) -> f32 {
    let dot = left
        .values
        .iter()
        .zip(&right.values)
        .map(|(left, right)| f32::from(*left) * f32::from(*right))
        .sum::<f32>();
    (dot / (left.norm * right.norm)).clamp(-1.0, 1.0)
}

trait EmbeddingModel: Send {
    fn embed_thumbnail(&mut self, thumbnail: &Path) -> Result<SemanticEmbedding>;
}

pub(crate) struct SemanticIndex {
    model: Arc<Mutex<Box<dyn EmbeddingModel>>>,
    model_fingerprint: [u8; MODEL_FINGERPRINT_BYTES],
    model_token: String,
    entries: RwLock<HashMap<String, Arc<SemanticEntry>>>,
    queue: SemanticQueue,
    worker_started: AtomicBool,
    revision: AtomicU64,
}

struct SemanticEntry {
    thumbnail: PathBuf,
    state: Mutex<SemanticState>,
    notify: Notify,
}

enum SemanticState {
    Pending,
    Processing,
    Ready(Arc<SemanticEmbedding>),
    Failed,
    Removed,
}

#[derive(Default)]
struct SemanticQueue {
    state: Mutex<SemanticQueueState>,
    notify: Notify,
}

#[derive(Default)]
struct SemanticQueueState {
    urgent: VecDeque<String>,
    background: VecDeque<String>,
    queued: HashSet<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticStatus {
    pub enabled: bool,
    pub total: usize,
    pub ready: usize,
    pub queued: usize,
    pub processing: usize,
    pub failed: usize,
    pub background_complete: bool,
}

impl SemanticStatus {
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

impl SemanticIndex {
    pub(crate) fn load(model_path: &Path) -> Result<Arc<Self>> {
        let fingerprint = fingerprint_file(model_path)?;
        let model = DinoV2Small::load(model_path)
            .with_context(|| format!("cannot load semantic model: {}", model_path.display()))?;
        let index = Self::with_model(Box::new(model), fingerprint);
        info!(
            model = MODEL_NAME,
            fingerprint = %index.model_token,
            "local semantic image search enabled"
        );
        Ok(index)
    }

    fn with_model(
        model: Box<dyn EmbeddingModel>,
        model_fingerprint: [u8; MODEL_FINGERPRINT_BYTES],
    ) -> Arc<Self> {
        Arc::new(Self {
            model: Arc::new(Mutex::new(model)),
            model_fingerprint,
            model_token: fingerprint_token(&model_fingerprint),
            entries: RwLock::new(HashMap::new()),
            queue: SemanticQueue::default(),
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
                    *mutex_lock(&entry.state) = SemanticState::Removed;
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
                    let entry = Arc::new(SemanticEntry {
                        thumbnail: thumbnail.to_owned(),
                        state: Mutex::new(SemanticState::Pending),
                        notify: Notify::new(),
                    });
                    entries.insert(id.to_owned(), Arc::clone(&entry));
                    (entry, true)
                }
            }
        };

        let pending = matches!(*mutex_lock(&entry.state), SemanticState::Pending);
        if !inserted && !pending {
            return;
        }
        if urgent {
            self.queue.push_urgent(id.to_owned());
        } else {
            self.queue.push_background(id.to_owned());
        }
    }

    pub(crate) async fn ensure_embedding(
        &self,
        id: &str,
        thumbnail: &Path,
    ) -> Option<Arc<SemanticEmbedding>> {
        self.enqueue(id, thumbnail, true);
        let entry = read_lock(&self.entries).get(id).cloned()?;
        loop {
            let notified = entry.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match &*mutex_lock(&entry.state) {
                SemanticState::Ready(embedding) => return Some(Arc::clone(embedding)),
                SemanticState::Failed | SemanticState::Removed => return None,
                SemanticState::Pending => self.queue.push_urgent(id.to_owned()),
                SemanticState::Processing => {}
            }
            notified.as_mut().await;
        }
    }

    pub(crate) fn embedding(&self, id: &str) -> Option<Arc<SemanticEmbedding>> {
        let entry = read_lock(&self.entries).get(id).cloned()?;
        let state = mutex_lock(&entry.state);
        match &*state {
            SemanticState::Ready(embedding) => Some(Arc::clone(embedding)),
            _ => None,
        }
    }

    pub(crate) fn cache_token(&self) -> String {
        format!(
            "{}-{}",
            self.model_token,
            self.revision.load(Ordering::Acquire)
        )
    }

    pub(crate) fn status(&self) -> SemanticStatus {
        let entries = read_lock(&self.entries);
        let mut ready = 0;
        let mut queued = 0;
        let mut processing = 0;
        let mut failed = 0;
        for entry in entries.values() {
            match &*mutex_lock(&entry.state) {
                SemanticState::Pending => queued += 1,
                SemanticState::Processing => processing += 1,
                SemanticState::Ready(_) => ready += 1,
                SemanticState::Failed => failed += 1,
                SemanticState::Removed => {}
            }
        }
        let total = entries.len();
        SemanticStatus {
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
                if !matches!(*state, SemanticState::Pending) {
                    continue;
                }
                *state = SemanticState::Processing;
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
                    warn!(path = %sidecar.display(), %error, "cannot persist semantic image embedding");
                }
                Ok(embedding)
            })
            .await
            .map_err(|error| anyhow!("semantic worker stopped: {error}"))
            .and_then(|result| result);

            let mut removed = false;
            match result {
                Ok(embedding) => {
                    let mut state = mutex_lock(&entry.state);
                    if matches!(*state, SemanticState::Processing) {
                        *state = SemanticState::Ready(Arc::new(embedding));
                        self.revision.fetch_add(1, Ordering::AcqRel);
                    } else {
                        removed = matches!(*state, SemanticState::Removed);
                    }
                }
                Err(error) => {
                    let mut state = mutex_lock(&entry.state);
                    if matches!(*state, SemanticState::Processing) {
                        *state = SemanticState::Failed;
                        self.revision.fetch_add(1, Ordering::AcqRel);
                        warn!(image = %id, %error, "semantic image embedding failed; using local visual fallback");
                    } else {
                        removed = matches!(*state, SemanticState::Removed);
                    }
                }
            }
            entry.notify.notify_waiters();
            if removed && let Err(error) = remove_embedding_for_thumbnail(&entry.thumbnail) {
                warn!(path = %entry.thumbnail.display(), %error, "cannot remove stale semantic embedding");
            }
        }
    }
}

impl SemanticQueue {
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

pub(crate) fn is_semantic_sidecar(path: &Path) -> bool {
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
) -> Result<SemanticEmbedding> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() != EMBEDDING_LENGTH {
        bail!("semantic embedding cache has an unexpected size");
    }
    let mut file = File::open(path)?;
    let mut magic = [0_u8; EMBEDDING_MAGIC.len()];
    file.read_exact(&mut magic)?;
    if &magic != EMBEDDING_MAGIC {
        bail!("semantic embedding cache has an unknown version");
    }
    let mut fingerprint = [0_u8; MODEL_FINGERPRINT_BYTES];
    file.read_exact(&mut fingerprint)?;
    if &fingerprint != expected_fingerprint {
        bail!("semantic embedding belongs to another model");
    }
    let mut bytes = [0_u8; HIDDEN_SIZE];
    file.read_exact(&mut bytes)?;
    let mut checksum = [0_u8; EMBEDDING_CHECKSUM_BYTES];
    file.read_exact(&mut checksum)?;
    if checksum != embedding_checksum(&fingerprint, &bytes) {
        bail!("semantic embedding cache checksum does not match");
    }
    SemanticEmbedding::from_quantized(bytes.map(|value| value as i8))
}

fn write_embedding(
    path: &Path,
    fingerprint: &[u8; MODEL_FINGERPRINT_BYTES],
    embedding: &SemanticEmbedding,
) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("invalid semantic cache path: {}", path.display()))?;
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
    values: &[u8; HIDDEN_SIZE],
) -> [u8; EMBEDDING_CHECKSUM_BYTES] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(fingerprint);
    hasher.update(values);
    let mut checksum = [0_u8; EMBEDDING_CHECKSUM_BYTES];
    checksum.copy_from_slice(&hasher.finalize().as_bytes()[..EMBEDDING_CHECKSUM_BYTES]);
    checksum
}

fn fingerprint_file(path: &Path) -> Result<[u8; MODEL_FINGERPRINT_BYTES]> {
    let mut file = File::open(path)
        .with_context(|| format!("cannot open semantic model: {}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
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

struct DinoV2Small {
    patch_projection: Conv2d,
    class_token: Tensor,
    position_embeddings: Tensor,
    layers: Vec<DinoLayer>,
    final_norm: LayerNorm,
}

struct DinoLayer {
    norm1: LayerNorm,
    attention: DinoAttention,
    layer_scale1: Tensor,
    norm2: LayerNorm,
    mlp1: Linear,
    mlp2: Linear,
    layer_scale2: Tensor,
}

struct DinoAttention {
    query: Linear,
    key: Linear,
    value: Linear,
    output: Linear,
    scale: f64,
}

impl DinoV2Small {
    fn load(path: &Path) -> Result<Self> {
        let device = Device::Cpu;
        // SAFETY: the mapped model is immutable for the lifetime of this
        // process. Configuration documents that the mounted file must not be
        // replaced in place while Pixhelf is running.
        let variables =
            unsafe { VarBuilder::from_mmaped_safetensors(&[path], DType::F32, &device)? };
        let embeddings = variables.pp("embeddings");
        let patch_projection = conv2d(
            3,
            HIDDEN_SIZE,
            PATCH_EDGE,
            Conv2dConfig {
                stride: PATCH_EDGE,
                ..Default::default()
            },
            embeddings.pp("patch_embeddings").pp("projection"),
        )?;
        let class_token = embeddings.get((1, 1, HIDDEN_SIZE), "cls_token")?;
        let pretrained_positions = embeddings.get(
            (
                1,
                PRETRAINED_PATCH_GRID * PRETRAINED_PATCH_GRID + 1,
                HIDDEN_SIZE,
            ),
            "position_embeddings",
        )?;
        let position_embeddings = resize_position_embeddings(&pretrained_positions)?;

        let encoder = variables.pp("encoder").pp("layer");
        let layers = (0..ENCODER_LAYERS)
            .map(|index| DinoLayer::load(encoder.pp(index.to_string())))
            .collect::<candle_core::Result<Vec<_>>>()?;
        let final_norm = layer_norm(HIDDEN_SIZE, LAYER_NORM_EPSILON, variables.pp("layernorm"))?;
        Ok(Self {
            patch_projection,
            class_token,
            position_embeddings,
            layers,
            final_norm,
        })
    }

    fn forward(&self, input: &Tensor) -> candle_core::Result<Tensor> {
        let (batch, _, _, _) = input.dims4()?;
        let patches = self
            .patch_projection
            .forward(input)?
            .reshape((batch, HIDDEN_SIZE, PATCH_GRID * PATCH_GRID))?
            .transpose(1, 2)?;
        let class_token = self.class_token.expand((batch, 1, HIDDEN_SIZE))?;
        let mut hidden =
            Tensor::cat(&[&class_token, &patches], 1)?.broadcast_add(&self.position_embeddings)?;
        for layer in &self.layers {
            hidden = layer.forward(&hidden)?;
        }
        self.final_norm.forward(&hidden)?.i((.., 0, ..))
    }
}

impl EmbeddingModel for DinoV2Small {
    fn embed_thumbnail(&mut self, thumbnail: &Path) -> Result<SemanticEmbedding> {
        let input = preprocess_thumbnail(thumbnail)?;
        let values = self.forward(&input)?.i(0)?.to_vec1::<f32>()?;
        SemanticEmbedding::quantize(&values)
    }
}

impl DinoLayer {
    fn load(variables: VarBuilder<'_>) -> candle_core::Result<Self> {
        let attention = DinoAttention::load(variables.pp("attention"))?;
        let layer_scale1 = variables.pp("layer_scale1").get(HIDDEN_SIZE, "lambda1")?;
        let layer_scale2 = variables.pp("layer_scale2").get(HIDDEN_SIZE, "lambda1")?;
        let mlp = variables.pp("mlp");
        Ok(Self {
            norm1: layer_norm(HIDDEN_SIZE, LAYER_NORM_EPSILON, variables.pp("norm1"))?,
            attention,
            layer_scale1,
            norm2: layer_norm(HIDDEN_SIZE, LAYER_NORM_EPSILON, variables.pp("norm2"))?,
            mlp1: linear(HIDDEN_SIZE, INTERMEDIATE_SIZE, mlp.pp("fc1"))?,
            mlp2: linear(INTERMEDIATE_SIZE, HIDDEN_SIZE, mlp.pp("fc2"))?,
            layer_scale2,
        })
    }

    fn forward(&self, input: &Tensor) -> candle_core::Result<Tensor> {
        let attention = self
            .attention
            .forward(&self.norm1.forward(input)?)?
            .broadcast_mul(&self.layer_scale1)?;
        let hidden = (input + attention)?;
        let mlp = self
            .mlp2
            .forward(
                &self
                    .mlp1
                    .forward(&self.norm2.forward(&hidden)?)?
                    .gelu_erf()?,
            )?
            .broadcast_mul(&self.layer_scale2)?;
        hidden + mlp
    }
}

impl DinoAttention {
    fn load(variables: VarBuilder<'_>) -> candle_core::Result<Self> {
        let attention = variables.pp("attention");
        Ok(Self {
            query: linear(HIDDEN_SIZE, HIDDEN_SIZE, attention.pp("query"))?,
            key: linear(HIDDEN_SIZE, HIDDEN_SIZE, attention.pp("key"))?,
            value: linear(HIDDEN_SIZE, HIDDEN_SIZE, attention.pp("value"))?,
            output: linear(HIDDEN_SIZE, HIDDEN_SIZE, variables.pp("output").pp("dense"))?,
            scale: 1.0 / (ATTENTION_HEAD_SIZE as f64).sqrt(),
        })
    }

    fn forward(&self, input: &Tensor) -> candle_core::Result<Tensor> {
        let (batch, tokens, _) = input.dims3()?;
        let split_heads = |projection: &Linear| {
            projection
                .forward(input)?
                .reshape((batch, tokens, ATTENTION_HEADS, ATTENTION_HEAD_SIZE))?
                .transpose(1, 2)?
                .contiguous()
        };
        let query = (split_heads(&self.query)? * self.scale)?;
        let key = split_heads(&self.key)?;
        let value = split_heads(&self.value)?;
        let attention = candle_nn::ops::softmax(&query.matmul(&key.transpose(2, 3)?)?, D::Minus1)?;
        let context =
            attention
                .matmul(&value)?
                .transpose(1, 2)?
                .reshape((batch, tokens, HIDDEN_SIZE))?;
        self.output.forward(&context)
    }
}

fn resize_position_embeddings(positions: &Tensor) -> candle_core::Result<Tensor> {
    // Match PyTorch's `interpolate(..., mode="bicubic",
    // align_corners=false)`. Candle currently offers bilinear interpolation,
    // but this tensor is resized only once at model load, so the small CPU
    // implementation keeps the official positional encoding behavior without
    // adding another native dependency.
    let source = positions.to_vec3::<f32>()?;
    let source = &source[0];
    let mut resized = Vec::with_capacity((PATCH_GRID * PATCH_GRID + 1) * HIDDEN_SIZE);
    resized.extend_from_slice(&source[0]);
    let scale = PRETRAINED_PATCH_GRID as f32 / PATCH_GRID as f32;
    for target_y in 0..PATCH_GRID {
        let source_y = (target_y as f32 + 0.5) * scale - 0.5;
        let base_y = source_y.floor() as isize;
        for target_x in 0..PATCH_GRID {
            let source_x = (target_x as f32 + 0.5) * scale - 0.5;
            let base_x = source_x.floor() as isize;
            let mut patch_position = [0.0_f32; HIDDEN_SIZE];
            for offset_y in -1..=2 {
                let sample_y =
                    (base_y + offset_y).clamp(0, PRETRAINED_PATCH_GRID as isize - 1) as usize;
                let weight_y = cubic_weight(source_y - (base_y + offset_y) as f32);
                for offset_x in -1..=2 {
                    let sample_x =
                        (base_x + offset_x).clamp(0, PRETRAINED_PATCH_GRID as isize - 1) as usize;
                    let weight_x = cubic_weight(source_x - (base_x + offset_x) as f32);
                    let source_index = 1 + sample_y * PRETRAINED_PATCH_GRID + sample_x;
                    let weight = weight_y * weight_x;
                    for (target, source) in patch_position.iter_mut().zip(&source[source_index]) {
                        *target += source * weight;
                    }
                }
            }
            resized.extend_from_slice(&patch_position);
        }
    }
    Tensor::from_vec(
        resized,
        (1, PATCH_GRID * PATCH_GRID + 1, HIDDEN_SIZE),
        positions.device(),
    )
}

fn cubic_weight(distance: f32) -> f32 {
    const COEFFICIENT: f32 = -0.75;
    let distance = distance.abs();
    if distance <= 1.0 {
        (COEFFICIENT + 2.0) * distance.powi(3) - (COEFFICIENT + 3.0) * distance.powi(2) + 1.0
    } else if distance < 2.0 {
        COEFFICIENT * distance.powi(3) - 5.0 * COEFFICIENT * distance.powi(2)
            + 8.0 * COEFFICIENT * distance
            - 4.0 * COEFFICIENT
    } else {
        0.0
    }
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
    let (resized_width, resized_height) = if width <= height {
        (
            RESIZE_SHORTEST_EDGE,
            (u64::from(height) * u64::from(RESIZE_SHORTEST_EDGE) / u64::from(width)) as u32,
        )
    } else {
        (
            (u64::from(width) * u64::from(RESIZE_SHORTEST_EDGE) / u64::from(height)) as u32,
            RESIZE_SHORTEST_EDGE,
        )
    };
    let resized = image.resize_exact(resized_width, resized_height, FilterType::CatmullRom);
    let left = (resized_width - MODEL_EDGE) / 2;
    let top = (resized_height - MODEL_EDGE) / 2;
    let pixels = resized
        .crop_imm(left, top, MODEL_EDGE, MODEL_EDGE)
        .to_rgb8();
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STANDARD_DEVIATION: [f32; 3] = [0.229, 0.224, 0.225];
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

    struct ColourModel {
        calls: Arc<AtomicUsize>,
    }

    struct FailingModel;

    impl EmbeddingModel for ColourModel {
        fn embed_thumbnail(&mut self, thumbnail: &Path) -> Result<SemanticEmbedding> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let image = image::open(thumbnail)?.to_rgb8();
            let pixel = image.get_pixel(0, 0).0;
            SemanticEmbedding::quantize(
                &[
                    vec![f32::from(pixel[0]); 128],
                    vec![f32::from(pixel[1]); 128],
                    vec![f32::from(pixel[2]); 128],
                ]
                .concat(),
            )
        }
    }

    impl EmbeddingModel for FailingModel {
        fn embed_thumbnail(&mut self, _thumbnail: &Path) -> Result<SemanticEmbedding> {
            bail!("intentional inference failure")
        }
    }

    #[test]
    fn quantised_cosine_is_stable() {
        let x = SemanticEmbedding::for_test([(0, 100), (1, 50)]);
        let same = SemanticEmbedding::for_test([(0, 100), (1, 50)]);
        let orthogonal = SemanticEmbedding::for_test([(2, 100)]);

        assert!((semantic_similarity(&x, &same) - 1.0).abs() < 1e-5);
        assert!(semantic_similarity(&x, &orthogonal).abs() < 1e-5);
    }

    #[test]
    fn embedding_sidecar_round_trips_and_rejects_other_models() {
        let temp = tempfile::tempdir().unwrap();
        let thumbnail = temp.path().join("image.webp");
        let path = embedding_path(&thumbnail);
        let embedding = SemanticEmbedding::for_test([(0, 100), (42, -70)]);
        let fingerprint = [7_u8; MODEL_FINGERPRINT_BYTES];

        write_embedding(&path, &fingerprint, &embedding).unwrap();
        let loaded = read_embedding(&path, &fingerprint).unwrap();
        assert!((semantic_similarity(&embedding, &loaded) - 1.0).abs() < 1e-5);
        assert!(read_embedding(&path, &[8; MODEL_FINGERPRINT_BYTES]).is_err());

        let mut corrupted = fs::read(&path).unwrap();
        corrupted[EMBEDDING_MAGIC.len() + MODEL_FINGERPRINT_BYTES + 42] ^= 0x40;
        fs::write(&path, corrupted).unwrap();
        assert!(read_embedding(&path, &fingerprint).is_err());
    }

    #[test]
    fn corrupt_embedding_sidecars_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("image.dino2");
        fs::write(&path, [0_u8; EMBEDDING_LENGTH as usize]).unwrap();
        assert!(read_embedding(&path, &[0; MODEL_FINGERPRINT_BYTES]).is_err());
    }

    #[tokio::test]
    async fn worker_persists_embeddings_and_reuses_them() {
        let temp = tempfile::tempdir().unwrap();
        let thumbnail = temp.path().join("image.png");
        image::RgbImage::from_pixel(8, 8, image::Rgb([240, 20, 10]))
            .save(&thumbnail)
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let index = SemanticIndex::with_model(
            Box::new(ColourModel {
                calls: Arc::clone(&calls),
            }),
            [9; 16],
        );
        index.reconcile(&HashSet::from(["image"]));
        index.start_worker();

        let embedding = index
            .ensure_embedding("image", &thumbnail)
            .await
            .expect("embedding should be generated");
        assert!(embedding_path(&thumbnail).is_file());
        assert_eq!(index.status().ready, 1);
        assert!(semantic_similarity(&embedding, &embedding) > 0.999);
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        let restarted = SemanticIndex::with_model(
            Box::new(ColourModel {
                calls: Arc::clone(&calls),
            }),
            [9; 16],
        );
        restarted.reconcile(&HashSet::from(["image"]));
        restarted.start_worker();
        assert!(
            restarted
                .ensure_embedding("image", &thumbnail)
                .await
                .is_some()
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        let changed_model = SemanticIndex::with_model(
            Box::new(ColourModel {
                calls: Arc::clone(&calls),
            }),
            [10; 16],
        );
        changed_model.reconcile(&HashSet::from(["image"]));
        changed_model.start_worker();
        assert!(
            changed_model
                .ensure_embedding("image", &thumbnail)
                .await
                .is_some()
        );
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn inference_failure_finishes_with_visual_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let thumbnail = temp.path().join("broken.png");
        fs::write(&thumbnail, b"the fake model does not inspect this file").unwrap();
        let index = SemanticIndex::with_model(Box::new(FailingModel), [3; 16]);
        index.reconcile(&HashSet::from(["broken"]));
        index.start_worker();

        assert!(index.ensure_embedding("broken", &thumbnail).await.is_none());
        let status = index.status();
        assert_eq!(status.failed, 1);
        assert!(status.background_complete);
    }

    #[test]
    fn preprocessing_has_the_official_dinov2_shape() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_fn(400, 200, |x, y| {
            image::Rgb([(x % 255) as u8, (y % 255) as u8, 128])
        }));
        let tensor = preprocess_image(&image).unwrap();
        assert_eq!(tensor.dims(), &[1, 3, 224, 224]);
        assert!(tensor.flatten_all().unwrap().to_vec1::<f32>().unwrap()[0].is_finite());
    }

    #[test]
    fn official_model_runs_when_supplied_by_the_test_environment() {
        let Some(model_path) = std::env::var_os("PIXHELF_DINOV2_MODEL") else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.png");
        let different = temp.path().join("different.png");
        image::RgbImage::from_fn(256, 256, |x, y| {
            let checker = if (x / 32 + y / 32) % 2 == 0 { 210 } else { 35 };
            image::Rgb([checker, (x % 256) as u8, (y % 256) as u8])
        })
        .save(&source)
        .unwrap();
        image::RgbImage::from_fn(256, 256, |x, y| image::Rgb([20, ((x + y) % 80) as u8, 220]))
            .save(&different)
            .unwrap();

        let mut model = DinoV2Small::load(Path::new(&model_path)).unwrap();
        let first = model.embed_thumbnail(&source).unwrap();
        let repeated = model.embed_thumbnail(&source).unwrap();
        let other = model.embed_thumbnail(&different).unwrap();
        let repeated_score = semantic_similarity(&first, &repeated);
        let other_score = semantic_similarity(&first, &other);
        eprintln!(
            "official DINOv2 smoke scores: repeated={repeated_score:.4}, other={other_score:.4}"
        );
        assert!(repeated_score > 0.999);
        assert!(repeated_score > other_score);
    }
}
