//! Query normalization and serialized gallery responses.
use crate::gallery::{Album, ImageRecord};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

pub(super) const DEFAULT_PAGE_SIZE: usize = 60;
pub(super) const MAX_PAGE_SIZE: usize = 200;
pub(super) const MAX_QUERY_VALUE_BYTES: usize = 4096;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagesQuery {
    pub(super) album: Option<String>,
    pub(super) search: Option<String>,
    #[serde(default)]
    pub(super) kind: ImageKind,
    #[serde(default)]
    pub(super) orientation: ImageOrientation,
    #[serde(default)]
    pub(super) sort: ImageSort,
    pub(super) seed: Option<String>,
    pub(super) offset: Option<usize>,
    pub(super) limit: Option<usize>,
}

#[derive(Debug)]
pub(crate) struct ImageRequest {
    pub(super) album: Option<String>,
    pub(super) search: Option<String>,
    pub(super) kind: ImageKind,
    pub(super) orientation: ImageOrientation,
    pub(super) sort: ImageSort,
    pub(super) seed: String,
    pub(super) offset: usize,
    pub(super) limit: usize,
}

impl ImagesQuery {
    pub(crate) fn normalize(self) -> Result<ImageRequest, StatusCode> {
        if [&self.album, &self.search, &self.seed]
            .into_iter()
            .flatten()
            .any(|value| value.len() > MAX_QUERY_VALUE_BYTES)
        {
            return Err(StatusCode::BAD_REQUEST);
        }

        Ok(ImageRequest {
            album: self.album.filter(|album| !album.is_empty()),
            search: self
                .search
                .as_deref()
                .map(str::trim)
                .filter(|search| !search.is_empty())
                .map(str::to_lowercase),
            kind: self.kind,
            orientation: self.orientation,
            sort: self.sort,
            seed: self.seed.unwrap_or_default(),
            offset: self.offset.unwrap_or(0),
            limit: self
                .limit
                .unwrap_or(DEFAULT_PAGE_SIZE)
                .clamp(1, MAX_PAGE_SIZE),
        })
    }
}

impl Default for ImageRequest {
    fn default() -> Self {
        Self {
            album: None,
            search: None,
            kind: ImageKind::default(),
            orientation: ImageOrientation::default(),
            sort: ImageSort::default(),
            seed: String::new(),
            offset: 0,
            limit: DEFAULT_PAGE_SIZE,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[repr(u8)]
#[serde(rename_all = "kebab-case")]
pub(super) enum ImageSort {
    #[default]
    Default,
    NameAsc,
    NameDesc,
    Newest,
    Oldest,
    Explore,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[repr(u8)]
#[serde(rename_all = "kebab-case")]
pub(super) enum ImageKind {
    #[default]
    All,
    Photo,
    Live,
    Video,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[repr(u8)]
#[serde(rename_all = "kebab-case")]
pub(super) enum ImageOrientation {
    #[default]
    All,
    Landscape,
    Portrait,
    Square,
}

impl ImageRequest {
    pub(super) fn matches_filters(&self, record: &ImageRecord) -> bool {
        let kind = match self.kind {
            ImageKind::All => true,
            ImageKind::Photo => record.video.is_none() && !record.is_live(),
            ImageKind::Live => record.is_live(),
            ImageKind::Video => record.video.is_some(),
        };
        let orientation = match self.orientation {
            ImageOrientation::All => true,
            ImageOrientation::Landscape => record.width > record.height,
            ImageOrientation::Portrait => record.width < record.height,
            ImageOrientation::Square => record.width == record.height,
        };
        kind && orientation
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GallerySummary {
    pub(super) total: usize,
    pub(super) albums: Vec<Album>,
    pub(super) revision: String,
    pub(super) initializing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImagesResponse {
    pub(super) items: Vec<ImageView>,
    pub(super) total: usize,
    pub(super) offset: usize,
    pub(super) limit: usize,
    pub(super) next_offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageView {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) width: u32,
    pub(super) height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) motion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) video: Option<crate::video::VideoMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) playback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) display: Option<String>,
}

impl From<&ImageRecord> for ImageView {
    fn from(record: &ImageRecord) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            width: record.width,
            height: record.height,
            display: crate::heif::is_image(&record.path)
                .then(|| format!("/api/images/{}/display", record.id)),
            video: record.video.clone(),
            playback: crate::video_jobs::url(record, crate::video_jobs::VideoKind::Playback),
            preview: crate::video_jobs::url(record, crate::video_jobs::VideoKind::Preview),
            motion: record
                .motion
                .as_ref()
                .map(|motion| format!("/api/images/{}/motion/original/{}", record.id, motion.id)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_image_queries_once() {
        let query = ImagesQuery {
            album: Some("album".into()),
            search: Some("  PHOTO  ".into()),
            offset: Some(usize::MAX),
            limit: Some(usize::MAX),
            ..ImagesQuery::default()
        }
        .normalize()
        .unwrap();

        assert_eq!(query.album.as_deref(), Some("album"));
        assert_eq!(query.search.as_deref(), Some("photo"));
        assert_eq!(query.offset, usize::MAX);
        assert_eq!(query.limit, MAX_PAGE_SIZE);

        let oversized = ImagesQuery {
            search: Some("x".repeat(MAX_QUERY_VALUE_BYTES + 1)),
            ..ImagesQuery::default()
        };
        assert_eq!(oversized.normalize().unwrap_err(), StatusCode::BAD_REQUEST);
    }
}
