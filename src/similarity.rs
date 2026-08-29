//! Compact, local image descriptors used by the "find similar" endpoint.
//!
//! The descriptor deliberately stays CPU-only and model-free so it remains a
//! dependable fallback when no semantic vision model is configured. It mixes
//! brightness-invariant structure, a perceptual hash, colour distribution,
//! spatial colour and edge orientation. Descriptor sidecars are persisted
//! beside thumbnails so an application restart does not require decoding the
//! whole gallery again.

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Mutex, OnceLock},
};

use anyhow::{Context, Result, anyhow, bail};
use image::{DynamicImage, ImageReader, imageops::FilterType};
#[cfg(test)]
use image::{ImageDecoder, metadata::Orientation};
use tracing::warn;

use crate::gallery::ImageRecord;

const SAMPLE_EDGE: u32 = 32;
const PIXEL_COUNT: usize = (SAMPLE_EDGE * SAMPLE_EDGE) as usize;
const COLOUR_HUE_BINS: usize = 12;
const COLOUR_SATURATION_BINS: usize = 3;
const COLOUR_VALUE_BINS: usize = 3;
const COLOUR_FEATURES: usize = COLOUR_HUE_BINS * COLOUR_SATURATION_BINS * COLOUR_VALUE_BINS;
const SPATIAL_EDGE: usize = 4;
const SPATIAL_FEATURES: usize = SPATIAL_EDGE * SPATIAL_EDGE * 3;
const EDGE_ORIENTATION_BINS: usize = 8;
const EDGE_FEATURES: usize = SPATIAL_EDGE * SPATIAL_EDGE * EDGE_ORIENTATION_BINS;
const HASH_EDGE: usize = 8;
const HASH_BITS: f32 = (HASH_EDGE * HASH_EDGE - 1) as f32;
const CACHE_LIMIT: usize = 16_384;
const SIGNATURE_MAGIC: &[u8; 8] = b"PXHFSIM2";
const SIGNATURE_EXTENSION: &str = "sim2";
const SIGNATURE_LENGTH: u64 = (SIGNATURE_MAGIC.len()
    + PIXEL_COUNT
    + COLOUR_FEATURES * 2
    + SPATIAL_FEATURES
    + EDGE_FEATURES * 2
    + 8
    + 3
    + 4 * 3) as u64;

/// Scores below this value are generally a coincidental palette/layout match,
/// rather than a useful recommendation. Keep this in one place so a future
/// semantic model can calibrate its score before entering the same pipeline.
pub(crate) const MIN_SIMILARITY_SCORE: f32 = 0.58;

#[derive(Clone)]
pub(crate) struct ImageSignature {
    /// Z-normalised luminance samples. This makes structure largely invariant
    /// to global exposure and contrast changes.
    normalized_luminance: [i8; PIXEL_COUNT],
    /// Joint HSV histogram; sample counts always add up to `PIXEL_COUNT`.
    colour_histogram: [u16; COLOUR_FEATURES],
    /// Mean Y/Cb/Cr values for a 4x4 spatial grid.
    spatial_colour: [u8; SPATIAL_FEATURES],
    /// Per-cell Sobel orientation histograms, each normalised to 0..65535.
    edge_histogram: [u16; EDGE_FEATURES],
    perceptual_hash: u64,
    average_colour: [u8; 3],
    contrast: f32,
    edge_energy: f32,
    aspect_ratio: f32,
}

#[derive(Clone, Copy)]
pub(crate) struct DiversityFingerprint {
    perceptual_hash: u64,
    average_colour: [u8; 3],
    aspect_ratio: f32,
}

impl ImageSignature {
    pub(crate) fn diversity_fingerprint(&self) -> DiversityFingerprint {
        DiversityFingerprint {
            perceptual_hash: self.perceptual_hash,
            average_colour: self.average_colour,
            aspect_ratio: self.aspect_ratio,
        }
    }
}

static SIGNATURE_CACHE: OnceLock<Mutex<HashMap<String, ImageSignature>>> = OnceLock::new();
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static DCT_BASIS: OnceLock<[[f32; SAMPLE_EDGE as usize]; HASH_EDGE]> = OnceLock::new();

fn signature_cache() -> &'static Mutex<HashMap<String, ImageSignature>> {
    SIGNATURE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_cache() -> std::sync::MutexGuard<'static, HashMap<String, ImageSignature>> {
    signature_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cache_signature(id: &str, signature: ImageSignature) {
    let mut cache = lock_cache();
    if cache.len() >= CACHE_LIMIT {
        // IDs include the file fingerprint, so evicting any old entry is safe.
        if let Some(evicted) = cache.keys().next().cloned() {
            cache.remove(&evicted);
        }
    }
    cache.insert(id.to_owned(), signature);
}

/// Return a cached signature, decoding the original only in focused unit tests.
#[cfg(test)]
pub(crate) fn signature_for(record: &ImageRecord) -> Result<ImageSignature> {
    record.ensure_source_is_current()?;
    let reader = ImageReader::open(&record.path)
        .with_context(|| format!("cannot open image {}", record.path.display()))?
        .with_guessed_format()
        .with_context(|| format!("cannot identify image {}", record.path.display()))?;
    let mut decoder = reader
        .into_decoder()
        .with_context(|| format!("cannot decode image {}", record.path.display()))?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .with_context(|| format!("cannot decode image {}", record.path.display()))?;
    image.apply_orientation(orientation);
    let signature = signature_from_image(record, &image);
    record.ensure_source_is_current()?;
    Ok(signature)
}

/// Load a persisted descriptor or derive one from the already-oriented,
/// bounded thumbnail. A broken sidecar is simply regenerated.
pub(crate) fn signature_for_thumbnail(
    record: &ImageRecord,
    thumbnail: &std::path::Path,
) -> Result<ImageSignature> {
    if let Some(signature) = lock_cache().get(&record.id).cloned() {
        return Ok(signature);
    }

    let sidecar = signature_path(thumbnail);
    if let Ok(signature) = read_signature(&sidecar) {
        cache_signature(&record.id, signature.clone());
        return Ok(signature);
    }

    let image = ImageReader::open(thumbnail)
        .with_context(|| format!("cannot open thumbnail {}", thumbnail.display()))?
        .with_guessed_format()
        .with_context(|| format!("cannot identify thumbnail {}", thumbnail.display()))?
        .decode()
        .with_context(|| format!("cannot decode thumbnail {}", thumbnail.display()))?;
    let signature = signature_from_image(record, &image);
    if let Err(error) = write_signature(&sidecar, &signature) {
        warn!(path = %sidecar.display(), %error, "cannot persist image similarity descriptor");
    }
    cache_signature(&record.id, signature.clone());
    Ok(signature)
}

/// Persist the descriptor while a thumbnail is already decoded. This makes
/// similarity search cheap even before the first request after a fresh scan.
pub(crate) fn cache_signature_for_thumbnail(
    record: &ImageRecord,
    image: &DynamicImage,
    thumbnail: &std::path::Path,
) -> Result<()> {
    let signature = signature_from_image(record, image);
    write_signature(&signature_path(thumbnail), &signature)?;
    cache_signature(&record.id, signature);
    Ok(())
}

pub(crate) fn remove_signature_for_thumbnail(thumbnail: &std::path::Path) -> std::io::Result<()> {
    match fs::remove_file(signature_path(thumbnail)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(crate) fn is_signature_sidecar(path: &std::path::Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()) == Some(SIGNATURE_EXTENSION)
}

pub(crate) fn has_signature_sidecar(thumbnail: &std::path::Path) -> bool {
    fs::metadata(signature_path(thumbnail))
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == SIGNATURE_LENGTH)
}

fn signature_from_image(record: &ImageRecord, image: &DynamicImage) -> ImageSignature {
    let sampled = image
        .resize_exact(SAMPLE_EDGE, SAMPLE_EDGE, FilterType::Triangle)
        .to_rgb8();
    let mut luminance = [0_u8; PIXEL_COUNT];
    let mut colour_histogram = [0_u16; COLOUR_FEATURES];
    let mut spatial_sums = [[0_u32; 3]; SPATIAL_EDGE * SPATIAL_EDGE];
    let mut spatial_counts = [0_u32; SPATIAL_EDGE * SPATIAL_EDGE];
    let mut average_sums = [0_u32; 3];

    for (x, y, pixel) in sampled.enumerate_pixels() {
        let [red, green, blue] = pixel.0;
        let index = (y * SAMPLE_EDGE + x) as usize;
        luminance[index] = rgb_luminance(red, green, blue);

        let (hue, saturation, value) = rgb_to_hsv(red, green, blue);
        let hue_bin = ((hue * COLOUR_HUE_BINS as f32) as usize).min(COLOUR_HUE_BINS - 1);
        let saturation_bin =
            ((saturation * COLOUR_SATURATION_BINS as f32) as usize).min(COLOUR_SATURATION_BINS - 1);
        let value_bin = ((value * COLOUR_VALUE_BINS as f32) as usize).min(COLOUR_VALUE_BINS - 1);
        let colour_index =
            (hue_bin * COLOUR_SATURATION_BINS + saturation_bin) * COLOUR_VALUE_BINS + value_bin;
        colour_histogram[colour_index] += 1;

        let cell_x = (x as usize * SPATIAL_EDGE / SAMPLE_EDGE as usize).min(SPATIAL_EDGE - 1);
        let cell_y = (y as usize * SPATIAL_EDGE / SAMPLE_EDGE as usize).min(SPATIAL_EDGE - 1);
        let cell = cell_y * SPATIAL_EDGE + cell_x;
        let [y_colour, cb, cr] = rgb_to_ycbcr(red, green, blue);
        spatial_sums[cell][0] += u32::from(y_colour);
        spatial_sums[cell][1] += u32::from(cb);
        spatial_sums[cell][2] += u32::from(cr);
        spatial_counts[cell] += 1;
        average_sums[0] += u32::from(y_colour);
        average_sums[1] += u32::from(cb);
        average_sums[2] += u32::from(cr);
    }

    let mean = luminance.iter().map(|value| f32::from(*value)).sum::<f32>() / PIXEL_COUNT as f32;
    let variance = luminance
        .iter()
        .map(|value| {
            let difference = f32::from(*value) - mean;
            difference * difference
        })
        .sum::<f32>()
        / PIXEL_COUNT as f32;
    let standard_deviation = variance.sqrt();
    let normalization_scale = standard_deviation.max(8.0);
    let normalized_luminance = std::array::from_fn(|index| {
        (((f32::from(luminance[index]) - mean) / normalization_scale) * 36.0)
            .round()
            .clamp(-127.0, 127.0) as i8
    });

    let mut spatial_colour = [0_u8; SPATIAL_FEATURES];
    for cell in 0..spatial_counts.len() {
        let count = spatial_counts[cell].max(1);
        for channel in 0..3 {
            spatial_colour[cell * 3 + channel] =
                (spatial_sums[cell][channel] / count).min(255) as u8;
        }
    }

    let (edge_histogram, edge_energy) = edge_descriptor(&luminance);
    let average_colour =
        std::array::from_fn(|channel| (average_sums[channel] / PIXEL_COUNT as u32).min(255) as u8);

    ImageSignature {
        normalized_luminance,
        colour_histogram,
        spatial_colour,
        edge_histogram,
        perceptual_hash: perceptual_hash(&luminance),
        average_colour,
        contrast: standard_deviation / 255.0,
        edge_energy,
        aspect_ratio: record.width as f32 / record.height.max(1) as f32,
    }
}

fn rgb_luminance(red: u8, green: u8, blue: u8) -> u8 {
    (f32::from(red) * 0.299 + f32::from(green) * 0.587 + f32::from(blue) * 0.114).round() as u8
}

fn rgb_to_ycbcr(red: u8, green: u8, blue: u8) -> [u8; 3] {
    let red = f32::from(red);
    let green = f32::from(green);
    let blue = f32::from(blue);
    let y = red * 0.299 + green * 0.587 + blue * 0.114;
    let cb = 128.0 - red * 0.168_736 - green * 0.331_264 + blue * 0.5;
    let cr = 128.0 + red * 0.5 - green * 0.418_688 - blue * 0.081_312;
    [y, cb, cr].map(|value| value.round().clamp(0.0, 255.0) as u8)
}

fn rgb_to_hsv(red: u8, green: u8, blue: u8) -> (f32, f32, f32) {
    let red = f32::from(red) / 255.0;
    let green = f32::from(green) / 255.0;
    let blue = f32::from(blue) / 255.0;
    let maximum = red.max(green).max(blue);
    let minimum = red.min(green).min(blue);
    let delta = maximum - minimum;
    let saturation = if maximum <= f32::EPSILON {
        0.0
    } else {
        delta / maximum
    };
    let hue = if delta <= f32::EPSILON {
        0.0
    } else if maximum == red {
        ((green - blue) / delta).rem_euclid(6.0) / 6.0
    } else if maximum == green {
        (((blue - red) / delta) + 2.0) / 6.0
    } else {
        (((red - green) / delta) + 4.0) / 6.0
    };
    (hue, saturation, maximum)
}

fn edge_descriptor(luminance: &[u8; PIXEL_COUNT]) -> ([u16; EDGE_FEATURES], f32) {
    let mut histogram = [0.0_f32; EDGE_FEATURES];
    let mut energy = 0.0_f32;
    for y in 1..SAMPLE_EDGE as usize - 1 {
        for x in 1..SAMPLE_EDGE as usize - 1 {
            let sample = |offset_x: isize, offset_y: isize| -> f32 {
                let x = (x as isize + offset_x) as usize;
                let y = (y as isize + offset_y) as usize;
                f32::from(luminance[y * SAMPLE_EDGE as usize + x])
            };
            let gradient_x = -sample(-1, -1) + sample(1, -1) - 2.0 * sample(-1, 0)
                + 2.0 * sample(1, 0)
                - sample(-1, 1)
                + sample(1, 1);
            let gradient_y = -sample(-1, -1) - 2.0 * sample(0, -1) - sample(1, -1)
                + sample(-1, 1)
                + 2.0 * sample(0, 1)
                + sample(1, 1);
            let magnitude = gradient_x.hypot(gradient_y);
            energy += magnitude;
            if magnitude < 4.0 {
                continue;
            }
            let angle = gradient_y
                .atan2(gradient_x)
                .rem_euclid(std::f32::consts::PI);
            let orientation = ((angle / std::f32::consts::PI * EDGE_ORIENTATION_BINS as f32)
                as usize)
                .min(EDGE_ORIENTATION_BINS - 1);
            let cell_x = (x * SPATIAL_EDGE / SAMPLE_EDGE as usize).min(SPATIAL_EDGE - 1);
            let cell_y = (y * SPATIAL_EDGE / SAMPLE_EDGE as usize).min(SPATIAL_EDGE - 1);
            let cell = cell_y * SPATIAL_EDGE + cell_x;
            histogram[cell * EDGE_ORIENTATION_BINS + orientation] += magnitude;
        }
    }

    let mut normalized = [0_u16; EDGE_FEATURES];
    for cell in 0..SPATIAL_EDGE * SPATIAL_EDGE {
        let start = cell * EDGE_ORIENTATION_BINS;
        let total = histogram[start..start + EDGE_ORIENTATION_BINS]
            .iter()
            .sum::<f32>();
        if total <= f32::EPSILON {
            continue;
        }
        for orientation in 0..EDGE_ORIENTATION_BINS {
            normalized[start + orientation] = (histogram[start + orientation] / total
                * f32::from(u16::MAX))
            .round()
            .clamp(0.0, f32::from(u16::MAX)) as u16;
        }
    }
    let interior_pixels = ((SAMPLE_EDGE - 2) * (SAMPLE_EDGE - 2)) as f32;
    // Sobel magnitude can reach roughly 4 * 255. Normalising keeps the value
    // architecture-independent and easy to persist.
    (
        normalized,
        (energy / interior_pixels / 1020.0).clamp(0.0, 1.0),
    )
}

fn perceptual_hash(luminance: &[u8; PIXEL_COUNT]) -> u64 {
    let basis = DCT_BASIS.get_or_init(|| {
        std::array::from_fn(|frequency| {
            std::array::from_fn(|position| {
                ((std::f32::consts::PI / SAMPLE_EDGE as f32)
                    * (position as f32 + 0.5)
                    * frequency as f32)
                    .cos()
            })
        })
    });
    // DCT is separable. Computing the horizontal low frequencies once cuts
    // descriptor construction from roughly 65k to 10k multiply-adds.
    let mut horizontal = [0.0_f32; SAMPLE_EDGE as usize * HASH_EDGE];
    for y in 0..SAMPLE_EDGE as usize {
        for horizontal_frequency in 0..HASH_EDGE {
            horizontal[y * HASH_EDGE + horizontal_frequency] = (0..SAMPLE_EDGE as usize)
                .map(|x| {
                    f32::from(luminance[y * SAMPLE_EDGE as usize + x])
                        * basis[horizontal_frequency][x]
                })
                .sum();
        }
    }
    let mut coefficients = [0.0_f32; HASH_EDGE * HASH_EDGE];
    for vertical_frequency in 0..HASH_EDGE {
        for horizontal_frequency in 0..HASH_EDGE {
            coefficients[vertical_frequency * HASH_EDGE + horizontal_frequency] = (0..SAMPLE_EDGE
                as usize)
                .map(|y| {
                    horizontal[y * HASH_EDGE + horizontal_frequency] * basis[vertical_frequency][y]
                })
                .sum();
        }
    }
    let mut frequencies = coefficients[1..].to_vec();
    frequencies.sort_unstable_by(f32::total_cmp);
    let median = frequencies[frequencies.len() / 2];
    coefficients[1..]
        .iter()
        .enumerate()
        .fold(0_u64, |hash, (index, coefficient)| {
            hash | (u64::from(*coefficient > median) << index)
        })
}

/// Score two descriptors from 0 (unrelated) to 1 (near-identical).
pub(crate) fn similarity_score(first: &ImageSignature, second: &ImageSignature) -> f32 {
    let colour = colour_similarity(first, second);
    let spatial = spatial_colour_similarity(first, second);
    let structure = structure_similarity(first, second);
    let hash = hash_similarity(first.perceptual_hash, second.perceptual_hash);
    let edges = edge_similarity(first, second);
    let aspect = aspect_similarity(first.aspect_ratio, second.aspect_ratio);

    // Flat graphics and scans have little structural evidence, so dynamically
    // move their weight to colour instead of letting an all-zero edge map look
    // like a perfect match.
    let contrast_reliability = (first.contrast.min(second.contrast) / 0.18).clamp(0.0, 1.0);
    let edge_reliability = (first.edge_energy.min(second.edge_energy) / 0.08).clamp(0.0, 1.0);
    let colour_weight = 0.32;
    let spatial_weight = 0.22;
    let structure_weight = 0.20 * contrast_reliability;
    let hash_weight = 0.16 * contrast_reliability;
    let edge_weight = 0.18 * edge_reliability;
    let aspect_weight = 0.04;
    let weight = colour_weight
        + spatial_weight
        + structure_weight
        + hash_weight
        + edge_weight
        + aspect_weight;

    ((colour * colour_weight
        + spatial * spatial_weight
        + structure * structure_weight
        + hash * hash_weight
        + edges * edge_weight
        + aspect * aspect_weight)
        / weight.max(f32::EPSILON))
    .clamp(0.0, 1.0)
}

fn colour_similarity(first: &ImageSignature, second: &ImageSignature) -> f32 {
    first
        .colour_histogram
        .iter()
        .zip(&second.colour_histogram)
        .map(|(left, right)| f32::from((*left).min(*right)))
        .sum::<f32>()
        / PIXEL_COUNT as f32
}

fn spatial_colour_similarity(first: &ImageSignature, second: &ImageSignature) -> f32 {
    let distance = first
        .spatial_colour
        .chunks_exact(3)
        .zip(second.spatial_colour.chunks_exact(3))
        .map(|(left, right)| {
            let luminance = f32::from(left[0].abs_diff(right[0])) / 255.0;
            let chroma = (f32::from(left[1].abs_diff(right[1]))
                + f32::from(left[2].abs_diff(right[2])))
                / (2.0 * 255.0);
            luminance * 0.45 + chroma * 0.55
        })
        .sum::<f32>()
        / (SPATIAL_EDGE * SPATIAL_EDGE) as f32;
    (-4.0 * distance).exp()
}

fn structure_similarity(first: &ImageSignature, second: &ImageSignature) -> f32 {
    let mut dot = 0.0_f32;
    let mut first_energy = 0.0_f32;
    let mut second_energy = 0.0_f32;
    for (left, right) in first
        .normalized_luminance
        .iter()
        .zip(&second.normalized_luminance)
    {
        let left = f32::from(*left);
        let right = f32::from(*right);
        dot += left * right;
        first_energy += left * left;
        second_energy += right * right;
    }
    if first_energy <= f32::EPSILON || second_energy <= f32::EPSILON {
        return 0.5;
    }
    let correlation = dot / (first_energy * second_energy).sqrt();
    ((correlation.clamp(-1.0, 1.0) + 1.0) * 0.5).clamp(0.0, 1.0)
}

fn hash_similarity(first: u64, second: u64) -> f32 {
    (1.0 - (first ^ second).count_ones() as f32 / HASH_BITS).clamp(0.0, 1.0)
}

fn edge_similarity(first: &ImageSignature, second: &ImageSignature) -> f32 {
    let mut similarity = 0.0_f32;
    let mut compared_cells = 0usize;
    for cell in 0..SPATIAL_EDGE * SPATIAL_EDGE {
        let start = cell * EDGE_ORIENTATION_BINS;
        let first_cell = &first.edge_histogram[start..start + EDGE_ORIENTATION_BINS];
        let second_cell = &second.edge_histogram[start..start + EDGE_ORIENTATION_BINS];
        let first_total = first_cell
            .iter()
            .map(|value| u32::from(*value))
            .sum::<u32>();
        let second_total = second_cell
            .iter()
            .map(|value| u32::from(*value))
            .sum::<u32>();
        if first_total == 0 && second_total == 0 {
            continue;
        }
        compared_cells += 1;
        similarity += first_cell
            .iter()
            .zip(second_cell)
            .map(|(left, right)| f32::from((*left).min(*right)))
            .sum::<f32>()
            / f32::from(u16::MAX);
    }
    if compared_cells == 0 {
        0.5
    } else {
        (similarity / compared_cells as f32).clamp(0.0, 1.0)
    }
}

fn aspect_similarity(first: f32, second: f32) -> f32 {
    (-(first / second.max(0.001)).ln().abs()).exp()
}

/// Cheap near-duplicate estimate used only to diversify the first page. It is
/// intentionally stricter than the main relevance score.
pub(crate) fn redundancy_score(first: DiversityFingerprint, second: DiversityFingerprint) -> f32 {
    let hash = hash_similarity(first.perceptual_hash, second.perceptual_hash);
    let colour_distance = first
        .average_colour
        .iter()
        .zip(second.average_colour)
        .map(|(left, right)| f32::from(left.abs_diff(right)) / 255.0)
        .sum::<f32>()
        / 3.0;
    let colour = (-5.0 * colour_distance).exp();
    let aspect = aspect_similarity(first.aspect_ratio, second.aspect_ratio);
    (hash * 0.78 + colour * 0.17 + aspect * 0.05).clamp(0.0, 1.0)
}

fn signature_path(thumbnail: &std::path::Path) -> std::path::PathBuf {
    thumbnail.with_extension(SIGNATURE_EXTENSION)
}

fn write_signature(path: &std::path::Path, signature: &ImageSignature) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("invalid descriptor cache path: {}", path.display()))?;
    fs::create_dir_all(parent)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("image"),
        std::process::id(),
        sequence
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(SIGNATURE_MAGIC)?;
        file.write_all(&signature.normalized_luminance.map(|value| value as u8))?;
        for value in signature.colour_histogram {
            file.write_all(&value.to_le_bytes())?;
        }
        file.write_all(&signature.spatial_colour)?;
        for value in signature.edge_histogram {
            file.write_all(&value.to_le_bytes())?;
        }
        file.write_all(&signature.perceptual_hash.to_le_bytes())?;
        file.write_all(&signature.average_colour)?;
        file.write_all(&signature.contrast.to_le_bytes())?;
        file.write_all(&signature.edge_energy.to_le_bytes())?;
        file.write_all(&signature.aspect_ratio.to_le_bytes())?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_signature(path: &std::path::Path) -> Result<ImageSignature> {
    let bytes = fs::read(path)?;
    let mut cursor = 0usize;
    let magic = take_bytes::<8>(&bytes, &mut cursor)?;
    if &magic != SIGNATURE_MAGIC {
        bail!("unknown descriptor cache version");
    }
    let normalized_luminance =
        take_bytes::<PIXEL_COUNT>(&bytes, &mut cursor)?.map(|value| value as i8);
    let mut colour_histogram = [0_u16; COLOUR_FEATURES];
    for value in &mut colour_histogram {
        *value = u16::from_le_bytes(take_bytes::<2>(&bytes, &mut cursor)?);
    }
    let spatial_colour = take_bytes::<SPATIAL_FEATURES>(&bytes, &mut cursor)?;
    let mut edge_histogram = [0_u16; EDGE_FEATURES];
    for value in &mut edge_histogram {
        *value = u16::from_le_bytes(take_bytes::<2>(&bytes, &mut cursor)?);
    }
    let perceptual_hash = u64::from_le_bytes(take_bytes::<8>(&bytes, &mut cursor)?);
    let average_colour = take_bytes::<3>(&bytes, &mut cursor)?;
    let contrast = f32::from_le_bytes(take_bytes::<4>(&bytes, &mut cursor)?);
    let edge_energy = f32::from_le_bytes(take_bytes::<4>(&bytes, &mut cursor)?);
    let aspect_ratio = f32::from_le_bytes(take_bytes::<4>(&bytes, &mut cursor)?);
    if cursor != bytes.len()
        || !contrast.is_finite()
        || !edge_energy.is_finite()
        || !aspect_ratio.is_finite()
        || aspect_ratio <= 0.0
    {
        bail!("invalid descriptor cache contents");
    }
    Ok(ImageSignature {
        normalized_luminance,
        colour_histogram,
        spatial_colour,
        edge_histogram,
        perceptual_hash,
        average_colour,
        contrast,
        edge_energy,
        aspect_ratio,
    })
}

fn take_bytes<const LENGTH: usize>(bytes: &[u8], cursor: &mut usize) -> Result<[u8; LENGTH]> {
    let end = cursor
        .checked_add(LENGTH)
        .ok_or_else(|| anyhow!("descriptor cache length overflow"))?;
    let value = bytes
        .get(*cursor..end)
        .ok_or_else(|| anyhow!("truncated descriptor cache"))?
        .try_into()
        .map_err(|_| anyhow!("invalid descriptor cache field"))?;
    *cursor = end;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, time::UNIX_EPOCH};

    use crate::gallery::ImageRecord;

    fn record(path: PathBuf, id: &str, width: u32, height: u32) -> ImageRecord {
        let metadata = fs::metadata(&path).unwrap();
        let modified_ns = metadata
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        ImageRecord {
            id: id.to_owned(),
            path,
            relative_path: id.to_owned(),
            search_key: id.to_owned(),
            name: id.to_owned(),
            album: String::new(),
            width,
            height,
            size: metadata.len(),
            modified_ms: 0,
            modified_ns,
        }
    }

    #[test]
    fn identical_images_score_higher_than_different_images() {
        let temp = tempfile::tempdir().unwrap();
        let first_path = temp.path().join("first.png");
        let same_path = temp.path().join("same.png");
        let different_path = temp.path().join("different.png");
        image::RgbImage::from_pixel(48, 32, image::Rgb([220, 80, 40]))
            .save(&first_path)
            .unwrap();
        fs::copy(&first_path, &same_path).unwrap();
        image::RgbImage::from_pixel(48, 32, image::Rgb([20, 40, 220]))
            .save(&different_path)
            .unwrap();

        let first = record(first_path, "colour-first", 48, 32);
        let same = record(same_path, "colour-same", 48, 32);
        let different = record(different_path, "colour-different", 48, 32);
        let first_signature = signature_for(&first).unwrap();
        let same_signature = signature_for(&same).unwrap();
        let different_signature = signature_for(&different).unwrap();

        assert!(
            similarity_score(&first_signature, &same_signature)
                > similarity_score(&first_signature, &different_signature)
        );
        assert!(similarity_score(&first_signature, &same_signature) > 0.99);
        assert!(similarity_score(&first_signature, &different_signature) < MIN_SIMILARITY_SCORE);
    }

    #[test]
    fn descriptor_sidecars_round_trip_and_reject_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let image_path = temp.path().join("source.png");
        let sidecar = temp.path().join("source.sim2");
        image::RgbImage::from_fn(64, 48, |x, y| {
            image::Rgb([(x * 3) as u8, (y * 5) as u8, ((x + y) * 2) as u8])
        })
        .save(&image_path)
        .unwrap();
        let source = record(image_path, "sidecar-source", 64, 48);
        let signature = signature_for(&source).unwrap();

        write_signature(&sidecar, &signature).unwrap();
        let restored = read_signature(&sidecar).unwrap();
        assert_eq!(similarity_score(&signature, &restored), 1.0);

        fs::write(&sidecar, b"not a signature").unwrap();
        assert!(read_signature(&sidecar).is_err());
    }

    #[test]
    fn exposure_and_small_crops_keep_the_same_scene_ahead() {
        let temp = tempfile::tempdir().unwrap();
        let source_path = temp.path().join("scene-source.png");
        let exposure_path = temp.path().join("scene-exposure.png");
        let crop_path = temp.path().join("scene-crop.png");
        let unrelated_path = temp.path().join("scene-unrelated.png");
        let source_image = image::RgbImage::from_fn(96, 72, |x, y| {
            let circle = (x as i32 - 30).pow(2) + (y as i32 - 36).pow(2) < 18_i32.pow(2);
            if circle {
                image::Rgb([218, 82, 43])
            } else if x > 56 && (16..60).contains(&y) {
                image::Rgb([42, 166, 112])
            } else {
                image::Rgb([
                    28_u8.saturating_add((x / 2) as u8),
                    42_u8.saturating_add((y / 2) as u8),
                    92_u8.saturating_add(((x + y) / 5) as u8),
                ])
            }
        });
        let exposure_image =
            image::RgbImage::from_fn(96, 72, |x, y| {
                image::Rgb(source_image.get_pixel(x, y).0.map(|channel| {
                    (f32::from(channel) * 0.82 + 24.0).round().clamp(0.0, 255.0) as u8
                }))
            });
        let crop_image = image::imageops::crop_imm(&source_image, 4, 3, 88, 66).to_image();
        let unrelated_image = image::RgbImage::from_fn(96, 72, |x, y| {
            let stripe = ((x / 12) + (y / 9)) % 2 == 0;
            if stripe {
                image::Rgb([218, 82, 43])
            } else {
                image::Rgb([42, 166, 112])
            }
        });
        source_image.save(&source_path).unwrap();
        exposure_image.save(&exposure_path).unwrap();
        crop_image.save(&crop_path).unwrap();
        unrelated_image.save(&unrelated_path).unwrap();

        let source = record(source_path, "robust-source", 96, 72);
        let exposure = record(exposure_path, "robust-exposure", 96, 72);
        let crop = record(crop_path, "robust-crop", 88, 66);
        let unrelated = record(unrelated_path, "robust-unrelated", 96, 72);
        let source_signature = signature_for(&source).unwrap();
        let exposure_score =
            similarity_score(&source_signature, &signature_for(&exposure).unwrap());
        let crop_score = similarity_score(&source_signature, &signature_for(&crop).unwrap());
        let unrelated_score =
            similarity_score(&source_signature, &signature_for(&unrelated).unwrap());

        assert!(
            exposure_score >= MIN_SIMILARITY_SCORE,
            "exposure score was {exposure_score}"
        );
        assert!(
            crop_score >= MIN_SIMILARITY_SCORE,
            "crop score was {crop_score}"
        );
        assert!(
            exposure_score > unrelated_score && crop_score > unrelated_score,
            "exposure={exposure_score}, crop={crop_score}, unrelated={unrelated_score}"
        );
    }
}
