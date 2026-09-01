//! Chinese-CLIP loading, preprocessing, and idle model lifecycle.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::chinese_clip::{ChineseClipConfig, ChineseClipModel};
use image::{DynamicImage, GenericImageView, ImageReader, imageops::FilterType};
use tokenizers::{
    Tokenizer, TruncationParams, models::wordpiece::WordPiece, normalizers::bert::BertNormalizer,
    pre_tokenizers::bert::BertPreTokenizer, processors::bert::BertProcessing,
};
use tracing::info;

use super::TextSearchEmbedding;

pub(super) const MODEL_NAME: &str = "Chinese-CLIP ViT-B/16";
const MODEL_EDGE: u32 = 224;
const TEXT_CONTEXT_LENGTH: usize = 52;

pub(crate) trait TextImageModel: Send {
    fn embed_thumbnail(&mut self, thumbnail: &Path) -> Result<TextSearchEmbedding>;
    fn embed_text(&mut self, text: &str) -> Result<TextSearchEmbedding>;
}

type ModelLoader = dyn Fn() -> Result<Box<dyn TextImageModel>> + Send + Sync + 'static;

pub(super) struct LazyModel {
    current: Option<Box<dyn TextImageModel>>,
    loader: Option<Arc<ModelLoader>>,
    load_error: Option<String>,
    last_used: Option<Instant>,
}

impl LazyModel {
    pub(super) fn chinese_clip(model_path: PathBuf, vocabulary_path: PathBuf) -> Self {
        Self::reloadable(Arc::new(move || {
            let model = ChineseClip::load(&model_path, &vocabulary_path).with_context(|| {
                format!(
                    "cannot load natural-language search model: {}",
                    model_path.display()
                )
            })?;
            Ok(Box::new(model))
        }))
    }

    #[cfg(test)]
    pub(super) fn preloaded(model: Box<dyn TextImageModel>) -> Self {
        Self {
            current: Some(model),
            loader: None,
            load_error: None,
            last_used: Some(Instant::now()),
        }
    }

    #[cfg(test)]
    pub(super) fn with_loader(
        loader: impl Fn() -> Result<Box<dyn TextImageModel>> + Send + Sync + 'static,
    ) -> Self {
        Self::reloadable(Arc::new(loader))
    }

    fn reloadable(loader: Arc<ModelLoader>) -> Self {
        Self {
            current: None,
            loader: Some(loader),
            load_error: None,
            last_used: None,
        }
    }

    pub(super) fn embed_thumbnail(&mut self, path: &Path) -> Result<TextSearchEmbedding> {
        self.run(|model| model.embed_thumbnail(path))
    }

    pub(super) fn embed_text(&mut self, text: &str) -> Result<TextSearchEmbedding> {
        self.run(|model| model.embed_text(text))
    }

    fn run<T>(
        &mut self,
        operation: impl FnOnce(&mut dyn TextImageModel) -> Result<T>,
    ) -> Result<T> {
        self.ensure_loaded()?;
        let result = operation(self.current.as_deref_mut().expect("model must be loaded"));
        self.last_used = Some(Instant::now());
        result
    }

    fn ensure_loaded(&mut self) -> Result<()> {
        if self.current.is_some() {
            return Ok(());
        }
        if let Some(error) = &self.load_error {
            bail!("natural-language search model is unavailable: {error}");
        }
        let loader = self
            .loader
            .as_ref()
            .context("natural-language search model cannot be reloaded")?
            .clone();
        info!(
            model = MODEL_NAME,
            "loading natural-language search model on demand"
        );
        match loader() {
            Ok(model) => {
                self.current = Some(model);
                self.last_used = Some(Instant::now());
                info!(model = MODEL_NAME, "natural-language search model loaded");
                Ok(())
            }
            Err(error) => {
                let message = format!("{error:#}");
                self.load_error = Some(message.clone());
                Err(anyhow!(message))
            }
        }
    }

    pub(super) fn release_if_idle(&mut self, timeout: Duration) -> bool {
        if self.loader.is_none() || self.current.is_none() {
            return false;
        }
        if !self
            .last_used
            .is_some_and(|last_used| last_used.elapsed() >= timeout)
        {
            return false;
        }
        self.current = None;
        self.last_used = None;
        true
    }
}

struct ChineseClip {
    model: ChineseClipModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl ChineseClip {
    fn load(model_path: &Path, vocabulary_path: &Path) -> Result<Self> {
        let device = Device::Cpu;
        // SAFETY: Pixhelf treats the configured model as immutable while the
        // process is running. Reloads use the same canonical file.
        let variables =
            unsafe { VarBuilder::from_mmaped_safetensors(&[model_path], DType::F32, &device)? };
        let config = ChineseClipConfig::clip_vit_base_patch16();
        Ok(Self {
            model: ChineseClipModel::new(variables, &config)?,
            tokenizer: load_tokenizer(vocabulary_path)?,
            device,
        })
    }
}

#[cfg(test)]
pub(super) fn validate_checkpoint(model_path: &Path, vocabulary_path: &Path) -> Result<()> {
    ChineseClip::load(model_path, vocabulary_path).map(|_| ())
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
    // This checkpoint resizes directly to 224x224 without a centre crop.
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
    use std::fs;

    use super::*;
    use crate::text_search::text_image_similarity;

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

        let encoding = load_tokenizer(&path)
            .unwrap()
            .encode("海边日落", true)
            .unwrap();
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
        assert!(
            text_image_similarity(&query, &red) > text_image_similarity(&query, &blue),
            "red query should rank the red image first"
        );
    }
}
