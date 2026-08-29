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
};

#[cfg(test)]
use std::fs;

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

use crate::support::{
    BoundedCache, PriorityQueue,
    embedding::{
        FINGERPRINT_BYTES, Fingerprint, QuantizedEmbedding, fingerprint_files, fingerprint_token,
        is_sidecar, read_sidecar, remove_sidecar, sidecar_path, write_sidecar,
    },
    mutex_lock, read_lock, write_lock,
};

const MODEL_NAME: &str = "Chinese-CLIP ViT-B/16";
const MODEL_EDGE: u32 = 224;
const TEXT_CONTEXT_LENGTH: usize = 52;
const EMBEDDING_SIZE: usize = 512;
const EMBEDDING_MAGIC: &[u8; 8] = b"PXHFCN1\0";
const EMBEDDING_EXTENSION: &str = "cnclip";
const MODEL_FINGERPRINT_BYTES: usize = FINGERPRINT_BYTES;
const QUERY_CACHE_LIMIT: usize = 16;

pub(crate) type TextSearchEmbedding = QuantizedEmbedding<EMBEDDING_SIZE>;

pub(crate) fn text_image_similarity(
    query: &TextSearchEmbedding,
    image: &TextSearchEmbedding,
) -> f32 {
    query.cosine_similarity(image)
}

pub(crate) trait TextImageModel: Send {
    fn embed_thumbnail(&mut self, thumbnail: &Path) -> Result<TextSearchEmbedding>;
    fn embed_text(&mut self, text: &str) -> Result<TextSearchEmbedding>;
}

pub(crate) struct TextSearchIndex {
    model: Arc<Mutex<Box<dyn TextImageModel>>>,
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
        TextSearchEmbedding::quantize(&values, "text-search image model")
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
        TextSearchEmbedding::quantize(&values, "text-search text model")
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
