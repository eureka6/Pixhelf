//! Duplicate detection verifies original bytes or complete, oriented pixels.
//! Thumbnail similarity is intentionally not sufficient for selecting copies.
use super::{
    AppState,
    models::{ImageView, MAX_QUERY_VALUE_BYTES},
};
use crate::{
    gallery::{GalleryIndex, ImageRecord},
    management::sharing::ReadState,
    support::{BoundedCache, mutex_lock},
};
use axum::{
    Json,
    extract::Query,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use image::{
    DynamicImage, EncodableLayout, ImageDecoder, ImageReader, Limits, metadata::Orientation,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};
use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::{BufReader, Read},
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

#[derive(Clone, Serialize, Deserialize)]
struct Fingerprint {
    bytes: String,
    pixels: Option<String>,
    pixel_checked: bool,
}
#[derive(Clone)]
struct Group {
    id: String,
    images: Vec<Arc<ImageRecord>>,
}
#[derive(Default)]
struct ScanResult {
    groups: Vec<Group>,
    skipped: usize,
    finished: bool,
    failed: bool,
}
struct Scan {
    progress: AtomicUsize,
    total: usize,
    result: Mutex<ScanResult>,
}
static SCANS: OnceLock<Mutex<BoundedCache<Arc<Scan>>>> = OnceLock::new();
static FINGERPRINTS: OnceLock<Mutex<BoundedCache<Fingerprint>>> = OnceLock::new();
static SCAN_LIMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Default, Deserialize)]
pub(super) struct DuplicateQuery {
    offset: Option<usize>,
    limit: Option<usize>,
    search: Option<String>,
    #[serde(default)]
    refresh: bool,
    #[serde(default)]
    plan: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateImage {
    #[serde(flatten)]
    image: ImageView,
    path: String,
    size: u64,
    modified_ms: u64,
}
#[derive(Serialize)]
struct DuplicateGroup {
    id: String,
    images: Vec<DuplicateImage>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicatePage {
    groups: Vec<DuplicateGroup>,
    total: usize,
    scanned: usize,
    image_total: usize,
    skipped: usize,
    scanning: bool,
    revision: String,
    offset: usize,
    next_offset: Option<usize>,
    plan: Option<Vec<SelectionGroup>>,
}

#[derive(Serialize)]
struct SelectionGroup {
    id: String,
    images: Vec<SelectionImage>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionImage {
    id: String,
    size: u64,
    modified_ms: u64,
}

fn file_size(image: &ImageRecord) -> u64 {
    image.size.saturating_add(
        image
            .motion
            .as_ref()
            .filter(|motion| motion.path != image.path)
            .map_or(0, |motion| motion.length),
    )
}

pub(crate) async fn warm(state: &AppState) {
    let index = Arc::clone(&*state.index.read().await);
    if !index.initializing {
        start_scan(index, state.thumbnails.settings_directory(), false);
    }
}

fn start_scan(index: Arc<GalleryIndex>, directory: std::path::PathBuf, refresh: bool) -> Arc<Scan> {
    let key = format!("{}:{}", index.root.display(), index.revision);
    let mut scans = mutex_lock(SCANS.get_or_init(|| Mutex::new(BoundedCache::new(4))));
    if let Some(scan) = scans.get_cloned(&key)
        && (!refresh || !mutex_lock(&scan.result).finished)
    {
        return scan;
    }
    let scan = Arc::new(Scan {
        progress: AtomicUsize::new(0),
        total: index
            .images
            .iter()
            .filter(|image| image.video.is_none())
            .count(),
        result: Mutex::new(ScanResult::default()),
    });
    scans.insert(key, Arc::clone(&scan));
    let job = Arc::clone(&scan);
    tokio::spawn(async move {
        let limit = Arc::clone(SCAN_LIMIT.get_or_init(|| Arc::new(Semaphore::new(1))));
        let Ok(permit) = limit.acquire_owned().await else {
            return;
        };
        let worker = Arc::clone(&job);
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let root_key = blake3::hash(index.root.as_os_str().as_encoded_bytes()).to_hex();
            let cache_file = directory.join(format!("duplicates-v2-{root_key}.json"));
            scan_records(
                &index.images,
                &worker.progress,
                Some(&cache_file),
                Some(&worker.result),
            )
        })
        .await;
        *mutex_lock(&job.result) = match result {
            Ok((groups, skipped)) => ScanResult {
                groups,
                skipped,
                finished: true,
                failed: false,
            },
            Err(_) => ScanResult {
                finished: true,
                failed: true,
                ..Default::default()
            },
        };
    });
    scan
}

pub(super) async fn images(
    axum::extract::State(original): axum::extract::State<AppState>,
    ReadState(state): ReadState,
    Query(query): Query<DuplicateQuery>,
) -> Response {
    if query
        .search
        .as_ref()
        .is_some_and(|s| s.len() > MAX_QUERY_VALUE_BYTES)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "搜索内容过长"})),
        )
            .into_response();
    }
    let index = Arc::clone(&*state.index.read().await);
    let original_index = Arc::clone(&*original.index.read().await);
    let shared = index.revision != original_index.revision;
    let visible_total = index
        .images
        .iter()
        .filter(|image| image.video.is_none())
        .count();
    let scan = start_scan(
        original_index,
        state.thumbnails.settings_directory(),
        query.refresh,
    );
    let result = mutex_lock(&scan.result);
    if result.failed {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "重复图片检查失败，请稍后重试"})),
        )
            .into_response();
    }
    let search = query.search.unwrap_or_default().trim().to_lowercase();
    let groups: Vec<_> = result
        .groups
        .iter()
        // Reuse the startup scan, but expose only the requesting user's files.
        .filter_map(|group| {
            let images: Vec<_> = group
                .images
                .iter()
                .filter(|image| index.image(&image.id).is_some())
                .cloned()
                .collect();
            (images.len() > 1).then(|| Group {
                id: group.id.clone(),
                images,
            })
        })
        .filter(|group| {
            search.is_empty()
                || group
                    .images
                    .iter()
                    .any(|image| image.relative_path.to_lowercase().contains(&search))
        })
        .collect();
    let total = groups.len();
    let offset = query.offset.unwrap_or(0).min(total);
    let limit = query.limit.unwrap_or(12).clamp(1, 40);
    let end = offset.saturating_add(limit).min(total);
    let response = DuplicatePage {
        groups: groups[offset..end]
            .iter()
            .map(|group| DuplicateGroup {
                id: group.id.clone(),
                images: group
                    .images
                    .iter()
                    .map(|image| DuplicateImage {
                        image: ImageView::from(image.as_ref()),
                        path: image.relative_path.clone(),
                        size: file_size(image),
                        modified_ms: image.modified_ms,
                    })
                    .collect(),
            })
            .collect(),
        total,
        scanned: scan
            .progress
            .load(Ordering::Relaxed)
            .saturating_mul(visible_total)
            / scan.total.max(1),
        image_total: visible_total,
        skipped: if shared { 0 } else { result.skipped },
        scanning: !result.finished || index.initializing,
        revision: index.revision.clone(),
        offset,
        next_offset: (end < total).then_some(end),
        plan: (query.plan && result.finished).then(|| {
            groups
                .iter()
                .map(|group| SelectionGroup {
                    id: group.id.clone(),
                    images: group
                        .images
                        .iter()
                        .map(|image| SelectionImage {
                            id: image.id.clone(),
                            size: file_size(image),
                            modified_ms: image.modified_ms,
                        })
                        .collect(),
                })
                .collect()
        }),
    };
    let mut response = Json(response).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn hash_file(path: &std::path::Path) -> anyhow::Result<blake3::Hash> {
    let mut file = BufReader::new(File::open(path)?);
    let mut hash = blake3::Hasher::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(hash.finalize())
}

fn pixel_hash(record: &ImageRecord) -> anyhow::Result<Option<String>> {
    // Preserve every animation frame and Live Photo movie by comparing full files.
    if record.is_live() || u64::from(record.width) * u64::from(record.height) > 25_000_000 {
        return Ok(None);
    }
    let extension = record
        .path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
        return Ok(None);
    }
    let mut reader = ImageReader::open(&record.path)?.with_guessed_format()?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Jpeg | image::ImageFormat::Png)
    ) {
        return Ok(None);
    }
    let gamma = if reader.format() == Some(image::ImageFormat::Png) {
        let decoder =
            image::codecs::png::PngDecoder::new(BufReader::new(File::open(&record.path)?))?;
        if decoder.is_apng()? {
            return Ok(None);
        }
        decoder.gamma_value()?
    } else {
        None
    };
    let mut limits = Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let profile = decoder.icc_profile()?.unwrap_or_default();
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let mut hash = blake3::Hasher::new();
    hash.update(b"pixhelf-full-pixels-v1");
    hash.update(&image.width().to_le_bytes());
    hash.update(&image.height().to_le_bytes());
    hash.update(&(profile.len() as u64).to_le_bytes());
    hash.update(&profile);
    if let Some(gamma) = gamma {
        hash.update(b"gamma");
        hash.update(&gamma.to_le_bytes());
    }
    let pixels = image.into_rgba16();
    hash.update(pixels.as_raw().as_bytes());
    Ok(Some(hash.finalize().to_hex().to_string()))
}

#[derive(Default)]
struct FingerprintCache {
    stored: HashMap<String, Fingerprint>,
    pixels: Mutex<HashMap<String, Arc<OnceLock<Option<String>>>>>,
    hashed: AtomicUsize,
    decoded: AtomicUsize,
    reused: AtomicUsize,
}

fn fingerprint_key(record: &ImageRecord) -> String {
    format!(
        "{}:{}:{}",
        record.path.display(),
        record.id,
        record.motion.as_ref().map_or("", |motion| &motion.id)
    )
}

fn current(record: &ImageRecord) -> anyhow::Result<()> {
    record.ensure_source_is_current()?;
    if let Some(motion) = &record.motion {
        anyhow::ensure!(
            motion.matches_metadata(&std::fs::metadata(&motion.path)?),
            "motion changed"
        );
    }
    Ok(())
}

fn fingerprint(
    record: &ImageRecord,
    pixels: bool,
    saved: &FingerprintCache,
) -> anyhow::Result<Fingerprint> {
    current(record)?;
    let key = fingerprint_key(record);
    let cache = FINGERPRINTS.get_or_init(|| Mutex::new(BoundedCache::new(32_768)));
    let memory = mutex_lock(cache).peek_cloned(&key);
    let from_disk = memory.is_none();
    let cached = memory.or_else(|| saved.stored.get(&key).cloned());
    if let Some(value) = &cached
        && (!pixels || value.pixel_checked)
    {
        saved.reused.fetch_add(1, Ordering::Relaxed);
        if from_disk {
            mutex_lock(cache).insert(key, value.clone());
        }
        return Ok(value.clone());
    }
    let mut result = if let Some(value) = cached {
        value
    } else {
        saved.hashed.fetch_add(1, Ordering::Relaxed);
        let mut bytes = blake3::Hasher::new();
        bytes.update(hash_file(&record.path)?.as_bytes());
        if let Some(motion) = &record.motion {
            bytes.update(b"live");
            if motion.path != record.path {
                bytes.update(hash_file(&motion.path)?.as_bytes());
            }
        }
        Fingerprint {
            bytes: bytes.finalize().to_hex().to_string(),
            pixels: None,
            pixel_checked: false,
        }
    };
    if pixels {
        // Copies with identical original bytes share one decode, including when
        // two workers reach the same original at the same time.
        let decoded = mutex_lock(&saved.pixels)
            .entry(result.bytes.clone())
            .or_default()
            .clone();
        result.pixels = decoded
            .get_or_init(|| {
                saved.decoded.fetch_add(1, Ordering::Relaxed);
                pixel_hash(record).unwrap_or(None)
            })
            .clone();
        result.pixel_checked = true;
    }
    current(record)?;
    mutex_lock(cache).insert(key, result.clone());
    Ok(result)
}

// Revalidate the retained original immediately before recycling a duplicate.
// A changed/missing keeper must never turn an automatic cleanup into data loss.
pub(crate) fn verify_pair(copy: &ImageRecord, keeper: &ImageRecord) -> anyhow::Result<()> {
    anyhow::ensure!(copy.id != keeper.id, "必须保留一张原图");
    let cache = FingerprintCache::default();
    let left = fingerprint(copy, true, &cache)?;
    let right = fingerprint(keeper, true, &cache)?;
    anyhow::ensure!(
        left.bytes == right.bytes || left.pixels.is_some() && left.pixels == right.pixels,
        "保留图片已变化，已跳过这张副本，请重新检查"
    );
    Ok(())
}

fn grouped(records: &BTreeMap<String, Vec<Arc<ImageRecord>>>) -> Vec<Group> {
    let mut groups: Vec<_> = records
        .iter()
        .filter(|(_, images)| images.len() > 1)
        .map(|(id, images)| {
            let mut images = images.clone();
            images.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
            Group {
                id: id.clone(),
                images,
            }
        })
        .collect();
    groups.sort_by_key(|group| {
        (
            std::cmp::Reverse(
                group
                    .images
                    .iter()
                    .skip(1)
                    .map(|image| file_size(image))
                    .sum::<u64>(),
            ),
            group.id.clone(),
        )
    });
    groups
}

fn scan_records(
    records: &[Arc<ImageRecord>],
    progress: &AtomicUsize,
    file: Option<&std::path::Path>,
    partial: Option<&Mutex<ScanResult>>,
) -> (Vec<Group>, usize) {
    let started = std::time::Instant::now();
    let saved = FingerprintCache {
        stored: file
            .and_then(|path| File::open(path).ok())
            .and_then(|file| serde_json::from_reader(BufReader::new(file)).ok())
            .unwrap_or_default(),
        ..Default::default()
    };
    for value in saved.stored.values().filter(|value| value.pixel_checked) {
        mutex_lock(&saved.pixels)
            .entry(value.bytes.clone())
            .or_insert_with(|| Arc::new(OnceLock::from(value.pixels.clone())));
    }
    let records: Vec<_> = records
        .iter()
        .filter(|image| image.video.is_none())
        .collect();
    let mut sizes = HashMap::<_, usize>::new();
    let mut dimensions = HashMap::<_, usize>::new();
    for record in &records {
        *sizes
            .entry((
                record.size,
                record.motion.as_ref().map(|motion| motion.length),
            ))
            .or_default() += 1;
        if !record.is_live() {
            *dimensions
                .entry((
                    record.width.min(record.height),
                    record.width.max(record.height),
                ))
                .or_default() += 1;
        }
    }
    let mut by_key = BTreeMap::<String, Vec<Arc<ImageRecord>>>::new();
    let mut persisted = HashMap::new();
    let mut skipped = 0;
    let cursor = AtomicUsize::new(0);
    let (send, receive) = std::sync::mpsc::sync_channel(4);
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get().min(2));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let send = send.clone();
            let (records, sizes, dimensions, saved, cursor) =
                (&records, &sizes, &dimensions, &saved, &cursor);
            scope.spawn(move || {
                loop {
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some(record) = records.get(index) else {
                        break;
                    };
                    let pixels = !record.is_live()
                        && dimensions
                            .get(&(
                                record.width.min(record.height),
                                record.width.max(record.height),
                            ))
                            .copied()
                            .unwrap_or(0)
                            > 1;
                    let bytes = sizes[&(
                        record.size,
                        record.motion.as_ref().map(|motion| motion.length),
                    )] > 1;
                    let result = if pixels || bytes {
                        fingerprint(record, pixels, saved).map(Some)
                    } else {
                        Ok(None)
                    };
                    if send.send((Arc::clone(record), result)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(send);
        let mut published = std::time::Instant::now();
        for (record, result) in receive {
            match result {
                Ok(Some(value)) => {
                    let key = value.pixels.as_ref().map_or_else(
                        || format!("bytes-{}", value.bytes),
                        |pixels| format!("pixels-{pixels}"),
                    );
                    persisted.insert(fingerprint_key(&record), value);
                    by_key.entry(key).or_default().push(record);
                }
                Ok(None) => {}
                Err(_) => skipped += 1,
            }
            progress.fetch_add(1, Ordering::Relaxed);
            if published.elapsed() >= std::time::Duration::from_millis(500) {
                if let Some(partial) = partial {
                    mutex_lock(partial).groups = grouped(&by_key);
                }
                published = std::time::Instant::now();
            }
        }
    });
    if let Some(path) = file {
        let save = || -> anyhow::Result<()> {
            let parent = path.parent().unwrap();
            std::fs::create_dir_all(parent)?;
            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            let mut writer = std::io::BufWriter::new(temporary.as_file_mut());
            serde_json::to_writer(&mut writer, &persisted)?;
            std::io::Write::flush(&mut writer)?;
            drop(writer);
            temporary.persist(path)?;
            Ok(())
        };
        if let Err(error) = save() {
            tracing::warn!(%error, "无法保存重复图片缓存");
        }
    }
    let groups = grouped(&by_key);
    tracing::info!(
        images = records.len(),
        groups = groups.len(),
        skipped,
        hashed = saved.hashed.load(Ordering::Relaxed),
        decoded = saved.decoded.load(Ordering::Relaxed),
        reused = saved.reused.load(Ordering::Relaxed),
        elapsed_ms = started.elapsed().as_millis(),
        "重复图片后台检查完成"
    );
    (groups, skipped)
}

#[cfg(test)]
fn find_groups(records: &[Arc<ImageRecord>], progress: &AtomicUsize) -> (Vec<Group>, usize) {
    scan_records(records, progress, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::AuthConfig, thumbs::ThumbnailManager};
    use axum::{Router, body::Body, extract::Request};
    use tokio::sync::RwLock;
    use tower::ServiceExt;

    #[test]
    fn duplicate_copies_share_one_decode_and_persist_fingerprints() {
        let folder = tempfile::tempdir().unwrap();
        for name in ["a.png", "b.png", "c.png"] {
            image::RgbImage::from_pixel(300, 200, image::Rgb([42, 55, 71]))
                .save(folder.path().join(name))
                .unwrap();
        }
        let index = crate::gallery::scan_gallery(folder.path(), None).unwrap();
        let cache = FingerprintCache::default();
        for image in &index.images {
            fingerprint(image, true, &cache).unwrap();
        }
        assert_eq!(cache.hashed.load(Ordering::Relaxed), 3);
        assert_eq!(cache.decoded.load(Ordering::Relaxed), 1);
        let file = folder.path().join("fingerprints.json");
        assert_eq!(
            scan_records(&index.images, &AtomicUsize::new(0), Some(&file), None)
                .0
                .len(),
            1
        );
        let stored: HashMap<String, Fingerprint> =
            serde_json::from_reader(File::open(file).unwrap()).unwrap();
        assert_eq!(stored.len(), 3);
        assert!(
            stored
                .values()
                .all(|value| value.pixel_checked && value.pixels.is_some())
        );
        let restored = FingerprintCache {
            stored,
            ..Default::default()
        };
        for image in &index.images {
            fingerprint(image, true, &restored).unwrap();
        }
        assert_eq!(restored.hashed.load(Ordering::Relaxed), 0);
        assert_eq!(restored.decoded.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn duplicates_verify_full_pixels_and_keep_different_photos_separate() {
        let folder = tempfile::tempdir().unwrap();
        let image = image::RgbImage::from_fn(40, 30, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 5) as u8, 90])
        });
        image.save(folder.path().join("original.png")).unwrap();
        std::fs::copy(
            folder.path().join("original.png"),
            folder.path().join("copy.png"),
        )
        .unwrap();
        // Distinct PNG encodings of the same complete image belong together.
        let file = File::create(folder.path().join("encoded.png")).unwrap();
        image::ImageEncoder::write_image(
            image::codecs::png::PngEncoder::new_with_quality(
                file,
                image::codecs::png::CompressionType::Fast,
                image::codecs::png::FilterType::NoFilter,
            ),
            image.as_raw(),
            40,
            30,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
        let mut different = image.clone();
        different.put_pixel(20, 15, image::Rgb([0, 0, 0]));
        different.save(folder.path().join("different.png")).unwrap();
        let index = crate::gallery::scan_gallery(folder.path(), None).unwrap();
        let (groups, skipped) = find_groups(&index.images, &AtomicUsize::new(0));
        assert_eq!(skipped, 0);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].images.len(), 3);
        assert!(
            !groups[0]
                .images
                .iter()
                .any(|image| image.name == "different.png")
        );
        let shared = index.shared_view(&[String::new()].into_iter().collect());
        assert!(
            find_groups(&shared.images, &AtomicUsize::new(0))
                .0
                .is_empty()
        );
        std::fs::write(folder.path().join("copy.png"), b"changed").unwrap();
        let (groups, skipped) = find_groups(&index.images, &AtomicUsize::new(0));
        assert_eq!(skipped, 1);
        assert_eq!(groups[0].images.len(), 2);
    }
    #[test]
    fn duplicate_live_photos_require_the_same_motion_companion() {
        let folder = tempfile::tempdir().unwrap();
        let photo = image::RgbImage::from_pixel(16, 16, image::Rgb([80, 30, 120]));
        let movie = include_bytes!("../../frontend/scripts/fixtures/live-photo.mp4");
        for name in ["original", "copy", "different"] {
            photo
                .save(folder.path().join(format!("{name}.jpg")))
                .unwrap();
            let mut bytes = movie.to_vec();
            if name == "different" {
                bytes.extend_from_slice(&[0, 0, 0, 8, b'f', b'r', b'e', b'e']);
            }
            std::fs::write(folder.path().join(format!("{name}.mp4")), bytes).unwrap();
        }
        let index = crate::gallery::scan_gallery(folder.path(), None).unwrap();
        assert!(index.images.iter().all(|image| image.motion.is_some()));
        let (groups, skipped) = find_groups(&index.images, &AtomicUsize::new(0));
        assert_eq!(skipped, 0);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].images.len(), 2);
        assert!(
            !groups[0]
                .images
                .iter()
                .any(|image| image.name == "different.jpg")
        );
    }

    #[test]
    fn duplicate_animations_compare_all_frames() {
        let folder = tempfile::tempdir().unwrap();
        for name in ["original", "copy", "different"] {
            let mut encoder = image::codecs::gif::GifEncoder::new(
                File::create(folder.path().join(format!("{name}.gif"))).unwrap(),
            );
            for colour in [20, if name == "different" { 180 } else { 90 }] {
                encoder
                    .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                        10,
                        10,
                        image::Rgba([colour, 30, 90, 255]),
                    )))
                    .unwrap();
            }
        }
        let index = crate::gallery::scan_gallery(folder.path(), None).unwrap();
        let (groups, skipped) = find_groups(&index.images, &AtomicUsize::new(0));
        assert_eq!(skipped, 0);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].images.len(), 2);
        assert!(
            !groups[0]
                .images
                .iter()
                .any(|image| image.name == "different.gif")
        );
    }

    #[tokio::test]
    async fn duplicate_endpoint_pages_complete_groups_and_filters_paths() {
        let folder = tempfile::tempdir().unwrap();
        for (name, colour) in [("a.png", 20), ("b.png", 20), ("c.png", 90), ("d.png", 90)] {
            image::RgbImage::from_pixel(10, 10, image::Rgb([colour, 30, 40]))
                .save(folder.path().join(name))
                .unwrap();
        }
        let index = crate::gallery::scan_gallery(folder.path(), None).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let state = AppState {
            index: Arc::new(RwLock::new(Arc::new(index))),
            thumbnails: ThumbnailManager::new(cache.path().to_owned()).unwrap(),
        };
        warm(&state).await;
        // Startup warmup completes without the duplicate page making a request.
        let snapshot = Arc::clone(&*state.index.read().await);
        let scan = start_scan(
            snapshot.clone(),
            state.thumbnails.settings_directory(),
            false,
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !mutex_lock(&scan.result).finished {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(mutex_lock(&scan.result).groups.len(), 2);
        let app = super::super::router(state.clone(), AuthConfig::default());
        async fn request(app: &Router, query: &str) -> serde_json::Value {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/images/duplicates?{query}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap()
        }
        let page = loop {
            let page = request(&app, "limit=1").await;
            if page["scanning"] == false {
                break page;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        assert_eq!(page["total"], 2);
        assert_eq!(page["groups"].as_array().unwrap().len(), 1);
        assert_eq!(page["nextOffset"], 1);
        let plan = request(&app, "limit=1&plan=true").await;
        assert_eq!(plan["groups"].as_array().unwrap().len(), 1);
        assert_eq!(plan["plan"].as_array().unwrap().len(), 2);
        let private = snapshot.shared_view(&[String::new()].into_iter().collect());
        let hidden = images(
            axum::extract::State(state.clone()),
            ReadState(AppState {
                index: Arc::new(RwLock::new(Arc::new(private))),
                thumbnails: state.thumbnails.clone(),
            }),
            Query(DuplicateQuery {
                plan: true,
                ..Default::default()
            }),
        )
        .await;
        let hidden: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(hidden.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(hidden["total"], 0);
        assert_eq!(hidden["imageTotal"], 0);
        assert_eq!(hidden["plan"], serde_json::json!([]));
        let next = request(&app, "limit=1&offset=1").await;
        assert_ne!(page["groups"][0]["id"], next["groups"][0]["id"]);
        assert!(next["nextOffset"].is_null());
        let filtered = request(&app, "search=a.png").await;
        assert_eq!(filtered["total"], 1);
        assert_eq!(filtered["groups"][0]["images"].as_array().unwrap().len(), 2);
        assert!(
            request(&app, "offset=99999").await["groups"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        std::fs::write(folder.path().join("a.png"), b"temporarily unavailable").unwrap();
        // An explicit retry must recheck unreadable/changed files even when the
        // library watcher has not published a new revision yet.
        request(&app, "refresh=true").await;
        let refreshed = loop {
            let page = request(&app, "").await;
            if page["scanning"] == false {
                break page;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        assert_eq!(refreshed["total"], 1);
        assert_eq!(refreshed["skipped"], 1);
    }
}
