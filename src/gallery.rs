use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use anyhow::{Context, Result};
use image::{ImageDecoder, ImageReader, metadata::Orientation};
use serde::Serialize;
use tracing::warn;
use walkdir::WalkDir;

#[derive(Clone, Debug)]
pub struct ImageRecord {
    pub id: String,
    pub path: PathBuf,
    pub relative_path: String,
    pub name: String,
    pub album: String,
    pub width: u32,
    pub height: u32,
    pub size: u64,
    pub modified_ms: u64,
    pub(crate) modified_ns: u128,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub path: String,
    pub name: String,
    pub count: usize,
}

#[derive(Clone, Default)]
pub struct GalleryIndex {
    pub images: Vec<Arc<ImageRecord>>,
    pub by_id: HashMap<String, Arc<ImageRecord>>,
    pub albums: Vec<Album>,
}

impl GalleryIndex {
    pub fn get(&self, id: &str) -> Option<Arc<ImageRecord>> {
        self.by_id.get(id).cloned()
    }

    pub fn same_revision(&self, other: &Self) -> bool {
        self.images.len() == other.images.len()
            && self
                .images
                .iter()
                .zip(&other.images)
                .all(|(left, right)| left.id == right.id)
    }
}

pub fn scan_gallery(root: &Path, previous: Option<&GalleryIndex>) -> Result<GalleryIndex> {
    let previous_by_path: HashMap<&str, &Arc<ImageRecord>> = previous
        .into_iter()
        .flat_map(|index| index.images.iter())
        .map(|record| (record.relative_path.as_str(), record))
        .collect();

    let mut images = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(error) => {
                warn!(%error, "cannot inspect gallery entry");
                None
            }
        })
    {
        if !entry.file_type().is_file() || !is_supported_image(entry.path()) {
            continue;
        }

        let path = entry.into_path();
        let relative = path
            .strip_prefix(root)
            .with_context(|| format!("{} is outside the gallery root", path.display()))?;
        let relative_path = path_to_url(relative);
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                warn!(path = %path.display(), %error, "cannot read image metadata");
                continue;
            }
        };
        let modified = metadata
            .modified()
            .unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let modified_ns = modified.as_nanos();
        let size = metadata.len();

        if let Some(existing) = previous_by_path.get(relative_path.as_str())
            && existing.size == size
            && existing.modified_ns == modified_ns
        {
            images.push(Arc::clone(existing));
            continue;
        }

        let (width, height) = match probe_dimensions(&path) {
            Ok(dimensions) => dimensions,
            Err(error) => {
                warn!(path = %path.display(), %error, "cannot decode image header");
                continue;
            }
        };
        let album = relative
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(path_to_url)
            .unwrap_or_default();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&relative_path)
            .to_owned();
        let id = image_id(&relative_path, size, modified_ns);

        images.push(Arc::new(ImageRecord {
            id,
            path,
            relative_path,
            name,
            album,
            width,
            height,
            size,
            modified_ms: modified.as_millis().min(u64::MAX as u128) as u64,
            modified_ns,
        }));
    }

    images.sort_by(|left, right| {
        natord::compare_ignore_case(&left.relative_path, &right.relative_path)
    });

    let mut album_counts = BTreeMap::<String, usize>::new();
    for image in &images {
        *album_counts.entry(image.album.clone()).or_default() += 1;
    }
    let albums = album_counts
        .into_iter()
        .map(|(path, count)| Album {
            name: path
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or("根目录")
                .to_owned(),
            path,
            count,
        })
        .collect();
    let by_id = images
        .iter()
        .map(|record| (record.id.clone(), Arc::clone(record)))
        .collect();

    Ok(GalleryIndex {
        images,
        by_id,
        albums,
    })
}

fn probe_dimensions(path: &Path) -> Result<(u32, u32)> {
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    Ok(oriented_dimensions(width, height, orientation))
}

fn oriented_dimensions(width: u32, height: u32, orientation: Orientation) -> (u32, u32) {
    match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (height, width),
        _ => (width, height),
    }
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp"
            )
        })
        .unwrap_or(false)
}

fn image_id(relative_path: &str, size: u64, modified_ns: u128) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"pixhelf-image-v1\0");
    hasher.update(relative_path.as_bytes());
    hasher.update(&size.to_le_bytes());
    hasher.update(&modified_ns.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

fn path_to_url(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_dimensions_for_quarter_turns() {
        assert_eq!(
            oriented_dimensions(1200, 800, Orientation::Rotate90),
            (800, 1200)
        );
        assert_eq!(
            oriented_dimensions(1200, 800, Orientation::Rotate270FlipH),
            (800, 1200)
        );
        assert_eq!(
            oriented_dimensions(1200, 800, Orientation::Rotate180),
            (1200, 800)
        );
    }

    #[test]
    fn scans_images_and_skips_other_files() {
        let temp = tempfile::tempdir().unwrap();
        let album = temp.path().join("album");
        fs::create_dir(&album).unwrap();
        image::RgbImage::new(20, 10)
            .save(album.join("image.png"))
            .unwrap();
        fs::write(album.join("notes.tsv"), "ignored").unwrap();

        let index = scan_gallery(temp.path(), None).unwrap();
        assert_eq!(index.images.len(), 1);
        assert_eq!(index.images[0].album, "album");
        assert_eq!((index.images[0].width, index.images[0].height), (20, 10));
        assert_eq!(index.albums[0].count, 1);
    }
}
