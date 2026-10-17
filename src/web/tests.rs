use super::pagination::exploration_rank;
use super::{
    AppState, frontend::ASSET_VERSION, models::ImageView, similarity::MAX_SEARCH_UPLOAD_BYTES,
};
use crate::{
    auth::AuthConfig,
    gallery::{GalleryIndex, ImageRecord},
    text_search::TextSearchEmbedding,
    thumbs::ThumbnailManager,
};
use axum::{
    Router,
    body::Body,
    extract::Request,
    http::{Method, StatusCode, header},
    response::Response,
};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower::ServiceExt;

fn router(state: AppState) -> Router {
    super::router(state, AuthConfig::default())
}

struct ColourTextSearchModel;

impl crate::text_search::TextImageModel for ColourTextSearchModel {
    fn embed_thumbnail(
        &mut self,
        thumbnail: &std::path::Path,
    ) -> anyhow::Result<TextSearchEmbedding> {
        let pixel = image::open(thumbnail)?.to_rgb8().get_pixel(0, 0).0;
        let axis = if pixel[0] >= pixel[2] { 0 } else { 1 };
        Ok(TextSearchEmbedding::for_test([(axis, 100)]))
    }

    fn embed_text(&mut self, text: &str) -> anyhow::Result<TextSearchEmbedding> {
        let axis = if text.contains('红') { 0 } else { 1 };
        Ok(TextSearchEmbedding::for_test([(axis, 100)]))
    }
}

fn empty_router() -> Router {
    let temp = tempfile::tempdir().unwrap();
    let thumbnails = ThumbnailManager::new(temp.path().to_owned()).unwrap();
    router(AppState {
        index: Arc::new(RwLock::new(Arc::new(GalleryIndex::default()))),
        thumbnails,
    })
}

async fn request(path: &str) -> Response {
    empty_router()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn embedded_assets_serve_precompressed_bytes_with_variant_validators() {
    use std::io::Read;
    let path = format!("/assets/{ASSET_VERSION}/GalleryApp.js");
    let compressed = empty_router()
        .oneshot(
            Request::builder()
                .uri(&path)
                .header(header::ACCEPT_ENCODING, "br")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(compressed.status(), StatusCode::OK);
    assert_eq!(compressed.headers()[header::CONTENT_ENCODING], "br");
    assert!(
        compressed
            .headers()
            .get_all(header::VARY)
            .iter()
            .any(|value| value.to_str().unwrap().contains("Accept-Encoding"))
    );
    let etag = compressed.headers()[header::ETAG].clone();
    let length = compressed.headers()[header::CONTENT_LENGTH].clone();
    let bytes = axum::body::to_bytes(compressed.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        length.to_str().unwrap().parse::<usize>().unwrap(),
        bytes.len()
    );
    let mut decoded = Vec::new();
    brotli::Decompressor::new(bytes.as_ref(), 8192)
        .read_to_end(&mut decoded)
        .unwrap();
    let plain = request(&path).await;
    assert_ne!(plain.headers()[header::ETAG], etag);
    assert_eq!(
        axum::body::to_bytes(plain.into_body(), usize::MAX)
            .await
            .unwrap()
            .as_ref(),
        decoded
    );
    assert!(bytes.len() < decoded.len() / 2);
    let cached = empty_router()
        .oneshot(
            Request::builder()
                .uri(&path)
                .header(header::ACCEPT_ENCODING, "br")
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(cached.headers()[header::ETAG], etag);
    let head = empty_router()
        .oneshot(
            Request::builder()
                .method(Method::HEAD)
                .uri(&path)
                .header(header::ACCEPT_ENCODING, "br")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(head.headers()[header::CONTENT_LENGTH], length);
    assert!(
        axum::body::to_bytes(head.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );
}

#[test]
fn image_view_keeps_the_payload_compact() {
    let record = ImageRecord {
        id: "abc".into(),
        path: "photo.jpg".into(),
        relative_path: "album/photo.jpg".into(),
        search_key: "album/photo.jpg".into(),
        name: "photo.jpg".into(),
        album: "album".into(),
        width: 10,
        height: 20,
        size: 30,
        modified_ms: 40,
        modified_ns: 40,
        motion: None,
        video: None,
    };
    let view = ImageView::from(&record);
    let json = serde_json::to_string(&view).unwrap();
    assert_eq!(
        json,
        r#"{"id":"abc","name":"photo.jpg","width":10,"height":20}"#
    );
}

#[tokio::test]
async fn animated_gifs_scan_generate_thumbnails_and_serve_original_frames() {
    use image::AnimationDecoder;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("gallery");
    std::fs::create_dir_all(root.join("Live")).unwrap();
    let gif = include_bytes!("../../frontend/scripts/fixtures/animated.gif");
    std::fs::write(root.join("Live/animated.GIF"), gif).unwrap();
    std::fs::write(root.join("broken.gif"), b"not an image").unwrap();
    let index = crate::gallery::scan_gallery(&root, None).unwrap();
    assert_eq!(index.images.len(), 1);
    let record = Arc::clone(&index.images[0]);
    assert_eq!((record.width, record.height), (960, 720));
    assert_eq!(record.album, "Live");
    assert!(record.video.is_none());
    let rescanned = crate::gallery::scan_gallery(&root, Some(&index)).unwrap();
    assert!(Arc::ptr_eq(&record, &rescanned.images[0]));

    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails: Arc::clone(&thumbnails),
    });
    for (kind, count) in [("all", 1), ("live", 1), ("photo", 0), ("video", 0)] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images?kind={kind}&album=Live"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page["total"], count, "{kind}");
        assert_eq!(page["items"].as_array().unwrap().len(), count as usize);
    }
    for path in [
        format!("/api/images/{}.gif", record.id),
        format!("/api/images/{}/original", record.id),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/gif");
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(bytes.as_ref(), gif);
        let decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)).unwrap();
        let frames = decoder.into_frames().collect_frames().unwrap();
        assert_eq!(frames.len(), 2);
        assert_ne!(
            frames[0].buffer().get_pixel(0, 0),
            frames[1].buffer().get_pixel(0, 0)
        );
    }
    let thumbnail = thumbnails.ensure_ready(&record.id).await.unwrap();
    let decoded = image::open(thumbnail).unwrap().to_rgb8();
    assert!(decoded.width() <= 960 && decoded.height() <= 720);
    assert!(
        decoded.get_pixel(0, 0)[0] > 180,
        "thumbnail uses the red first frame"
    );
    assert!(crate::similarity::signature_for_upload(gif).is_ok());
}

#[tokio::test]
async fn heif_live_photos_serve_full_images_and_preserve_both_originals() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("gallery");
    std::fs::create_dir(&root).unwrap();
    let photo = include_bytes!("../../frontend/scripts/fixtures/live-photo.heic");
    let clip = include_bytes!("../../frontend/scripts/fixtures/live-photo.mp4");
    std::fs::write(root.join("IMG_0011.heic"), photo).unwrap();
    std::fs::write(root.join("IMG_0011.mov"), clip).unwrap();
    let index = crate::gallery::scan_gallery(&root, None).unwrap();
    assert_eq!(index.images.len(), 1);
    let record = Arc::clone(&index.images[0]);
    let view = ImageView::from(record.as_ref());
    assert!(view.video.is_none());
    assert!(view.playback.is_none());
    let display = view.display.unwrap();
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails: Arc::clone(&thumbnails),
    });
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&display)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/jpeg");
    let etag = response.headers()[header::ETAG].clone();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap().to_rgb8();
    assert_eq!(decoded.dimensions(), (120, 90));
    assert!(decoded.get_pixel(10, 10)[0] > 180, "top-left tile is red");
    assert!(
        decoded.get_pixel(100, 10)[1] > 150,
        "top-right tile is green"
    );
    assert!(
        decoded.get_pixel(10, 80)[2] > 180,
        "bottom-left tile is blue"
    );
    let cached = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&display)
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    for (url, expected) in [
        (
            format!("/api/images/{}/original", record.id),
            photo.as_slice(),
        ),
        (view.motion.unwrap(), clip.as_slice()),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .as_ref(),
            expected
        );
    }
    let thumbnail = thumbnails.ensure_ready(&record.id).await.unwrap();
    std::fs::remove_file(thumbnail.with_extension("jpg")).unwrap();
    let rebuilt = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&display)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rebuilt.status(), StatusCode::OK);
    assert!(thumbnail.with_extension("jpg").is_file());
    std::fs::write(&record.path, b"replaced").unwrap();
    let stale = app
        .oneshot(
            Request::builder()
                .uri(&display)
                .header(header::IF_NONE_MATCH, etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn live_photo_video_streams_only_the_clip_and_supports_browser_ranges() {
    const CACHE_CONTROL: &str = "private, max-age=31536000, immutable";
    for format in [
        "paired",
        "paired-hevc",
        "xmp",
        "samsung",
        "samsung-reference",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let gallery = temp.path().join("gallery");
        std::fs::create_dir(&gallery).unwrap();
        let photo = gallery.join("photo.jpg");
        let video = if format == "paired-hevc" {
            include_bytes!("../../frontend/scripts/fixtures/live-photo-hevc.mov").to_vec()
        } else {
            crate::motion::tests::video_bytes()
        };
        if format.starts_with("samsung") {
            crate::motion::tests::samsung_jpeg(&photo, &video, format == "samsung-reference");
        } else if format == "xmp" {
            let xmp = format!(
                r#"<x xmlns:c="http://ns.google.com/photos/1.0/camera/" c:MicroVideoOffset="{}"/>"#,
                video.len()
            );
            crate::motion::tests::motion_jpeg(&photo, &xmp, &video);
        } else {
            image::RgbImage::new(20, 10).save(&photo).unwrap();
            std::fs::write(gallery.join("photo.mp4"), &video).unwrap();
        }
        let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
        let record = Arc::clone(&index.images[0]);
        let url = format!(
            "/api/images/{}/motion/original/{}",
            record.id,
            record.motion.as_ref().unwrap().id
        );
        let view = ImageView::from(record.as_ref());
        assert_eq!(view.motion.as_ref(), Some(&url));
        assert!(view.video.is_none() && view.preview.is_none() && view.playback.is_none());
        let app = router(AppState {
            index: Arc::new(RwLock::new(Arc::new(index))),
            thumbnails: ThumbnailManager::new(temp.path().join("cache")).unwrap(),
        });
        let response = app
            .clone()
            .oneshot(Request::builder().uri(&url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            record.motion.as_ref().unwrap().mime
        );
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            video.len().to_string()
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], CACHE_CONTROL);
        let etag = response.headers()[header::ETAG].clone();
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap(),
            video
        );
        for (range, start, end) in [
            ("bytes=0-7", 0, 7),
            ("bytes=8-", 8, video.len() - 1),
            ("bytes=-8", video.len() - 8, video.len() - 1),
            ("bytes=8-9999", 8, video.len() - 1),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(&url)
                        .header(header::RANGE, range)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], CACHE_CONTROL);
            assert_eq!(response.headers()[header::ETAG], etag);
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                format!("bytes {start}-{end}/{}", video.len())
            );
            assert_eq!(
                axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap(),
                video[start..=end]
            );
        }
        let head = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::HEAD)
                    .uri(&url)
                    .header(header::RANGE, "bytes=0-7")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(
            head.headers()[header::CONTENT_LENGTH],
            video.len().to_string()
        );
        assert!(
            axum::body::to_bytes(head.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .is_empty()
        );
        let cached = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(cached.headers()[header::CACHE_CONTROL], CACHE_CONTROL);
        assert_eq!(cached.headers()[header::ETAG], etag);
        assert!(
            axum::body::to_bytes(cached.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .is_empty()
        );
        let continuing = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::RANGE, "bytes=0-7")
                    .header(header::IF_RANGE, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(continuing.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            axum::body::to_bytes(continuing.into_body(), 8)
                .await
                .unwrap(),
            video[..8]
        );
        let outdated = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::RANGE, "bytes=0-7")
                    .header(header::IF_RANGE, "\"old\"")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(outdated.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(outdated.into_body(), 1024 * 1024)
                .await
                .unwrap(),
            video
        );
        let invalid = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::RANGE, "bytes=9999-")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            invalid.headers()[header::CONTENT_RANGE],
            format!("bytes */{}", video.len())
        );
        let wrong = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images/{}/motion/original/wrong", record.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong.status(), StatusCode::NOT_FOUND);
        std::fs::write(&record.motion.as_ref().unwrap().path, b"replaced").unwrap();
        let stale = app
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::IF_NONE_MATCH, etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
#[ignore = "requires PIXHELF_LIVE_SAMPLES with the original Apple and Samsung files"]
async fn original_live_samples_bypass_old_cache_and_match_source_bytes() {
    let samples = std::path::PathBuf::from(
        std::env::var("PIXHELF_LIVE_SAMPLES").expect("set PIXHELF_LIVE_SAMPLES"),
    );
    let index = crate::gallery::scan_gallery(&samples, None).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let cases: Vec<_> = [
        (
            "2023-12-27_12-30-56.jpg",
            "Apple/2023-12-27_12-30-56.mov",
            0,
            5_276_784,
        ),
        (
            "samsung-one-ui-6.jpg",
            "motionphoto/samsung-one-ui-6.jpg",
            4_938_111,
            3_274_599,
        ),
    ]
    .into_iter()
    .map(|(name, source, offset, length)| {
        let record = index
            .images
            .iter()
            .find(|record| record.name == name)
            .unwrap();
        let motion = record
            .motion
            .as_ref()
            .expect("sample must have a live clip");
        assert_eq!(motion.offset, offset as u64);
        assert_eq!(motion.length, length as u64);
        let file = std::fs::read(samples.join(source)).unwrap();
        let expected = file[offset..offset + length].to_vec();
        assert!(expected.windows(4).any(|bytes| bytes == b"hvc1"));
        (Arc::clone(record), expected)
    })
    .collect();
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails: ThumbnailManager::new(temp.path().join("cache")).unwrap(),
    });
    for (record, expected) in cases {
        let motion = record.motion.as_ref().unwrap();
        let url = ImageView::from(record.as_ref()).motion.unwrap();
        assert!(url.contains("/motion/original/"));
        // Both validators can be left behind by an old video response. The
        // new endpoint must send original bytes, never a 304 for that cache.
        for validator in [
            format!("\"motion-{}\"", motion.id),
            format!("\"original-motion-{}\"", motion.id),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(&url)
                        .header(header::IF_NONE_MATCH, validator)
                        .header(header::IF_MODIFIED_SINCE, "Wed, 31 Dec 2098 23:59:59 GMT")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "private, max-age=31536000, immutable"
            );
            assert_eq!(
                axum::body::to_bytes(response.into_body(), 10 * 1024 * 1024)
                    .await
                    .unwrap(),
                expected
            );
        }
        let range = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::RANGE, "bytes=1024-2047")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            range.headers()[header::CACHE_CONTROL],
            "private, max-age=31536000, immutable"
        );
        let original_etag = range.headers()[header::ETAG].clone();
        assert_eq!(
            axum::body::to_bytes(range.into_body(), 1024).await.unwrap(),
            expected[1024..2048]
        );
        let replay = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::IF_NONE_MATCH, original_etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::NOT_MODIFIED);
        assert!(
            axum::body::to_bytes(replay.into_body(), 1)
                .await
                .unwrap()
                .is_empty()
        );
        for suffix in ["", "/preview-v1.mp4"] {
            let legacy = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/api/images/{}/motion/{}{suffix}",
                            record.id, motion.id
                        ))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(legacy.status(), StatusCode::NOT_FOUND);
        }
        println!(
            "{}: {} original HEVC bytes, blake3={}; replay validates without a body, legacy preview unavailable",
            record.name,
            expected.len(),
            blake3::hash(&expected).to_hex()
        );
    }
}

#[test]
fn exploration_rank_is_stable_and_seeded() {
    let first_seed = *blake3::hash(b"first-queue").as_bytes();
    let second_seed = *blake3::hash(b"second-queue").as_bytes();

    assert_eq!(
        exploration_rank(&first_seed, "image-1"),
        exploration_rank(&first_seed, "image-1")
    );
    assert_ne!(
        exploration_rank(&first_seed, "image-1"),
        exploration_rank(&second_seed, "image-1")
    );
    assert_ne!(
        exploration_rank(&first_seed, "image-1"),
        exploration_rank(&first_seed, "image-2")
    );
}

#[tokio::test]
async fn rejects_unknown_sort_modes() {
    assert_eq!(
        request("/api/images?sort=name-asc").await.status(),
        StatusCode::OK
    );
    assert_eq!(
        request("/api/images?sort=explore&seed=test").await.status(),
        StatusCode::OK
    );
    assert_eq!(
        request("/api/images?sort=unexpected").await.status(),
        StatusCode::BAD_REQUEST
    );
    for query in ["kind=unknown", "orientation=unknown"] {
        assert_eq!(
            request(&format!("/api/images?{query}")).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn image_filters_apply_before_pagination_and_have_distinct_etags() {
    let temp = tempfile::tempdir().unwrap();
    let motion_path = temp.path().join("live.mp4");
    std::fs::write(
        &motion_path,
        include_bytes!("../../frontend/scripts/fixtures/live-photo.mp4"),
    )
    .unwrap();
    let motion = crate::motion::paired_video(&motion_path).unwrap();
    let mut index = GalleryIndex::default();
    index.images = (0..9)
        .map(|i| {
            Arc::new(ImageRecord {
                id: format!("{i:032x}"),
                path: format!("photo-{i}.jpg").into(),
                relative_path: format!("album/photo-{i}.jpg"),
                search_key: format!("album/photo-{i}.jpg"),
                name: format!("photo-{i}.jpg"),
                album: "album".into(),
                width: [40, 30, 30][i / 3],
                height: [30, 40, 30][i / 3],
                size: 1,
                modified_ms: (9 - i) as u64,
                modified_ns: 0,
                motion: (i % 3 == 1).then(|| motion.clone()),
                video: (i % 3 == 2).then(|| crate::video::VideoMetadata {
                    duration: Some(1.0),
                    codec: "h264".into(),
                    audio_codec: None,
                    frame_rate: Some(30.0),
                    container: "mp4".into(),
                    stream_index: 0,
                }),
            })
        })
        .collect();
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails: ThumbnailManager::new(temp.path().join("cache")).unwrap(),
    });
    let mut etags = std::collections::HashSet::new();
    for (query, names, total, next) in [
        (
            "kind=photo&limit=2",
            vec!["photo-0.jpg", "photo-3.jpg"],
            3,
            Some(2),
        ),
        ("kind=photo&offset=2&limit=2", vec!["photo-6.jpg"], 3, None),
        (
            "kind=live&orientation=portrait",
            vec!["photo-4.jpg"],
            1,
            None,
        ),
        (
            "kind=video&orientation=square",
            vec!["photo-8.jpg"],
            1,
            None,
        ),
        (
            "orientation=landscape&sort=oldest",
            vec!["photo-2.jpg", "photo-1.jpg", "photo-0.jpg"],
            3,
            None,
        ),
        (
            "kind=live&sort=name-desc",
            vec!["photo-7.jpg", "photo-4.jpg", "photo-1.jpg"],
            3,
            None,
        ),
        (
            "kind=photo&album=album&search=photo-3",
            vec!["photo-3.jpg"],
            1,
            None,
        ),
        ("kind=photo&album=missing", vec![], 0, None),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{query}");
        assert!(
            etags.insert(
                response.headers()[header::ETAG]
                    .to_str()
                    .unwrap()
                    .to_owned()
            )
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            names,
            "{query}"
        );
        assert_eq!(page["total"], total, "{query}");
        assert_eq!(page["nextOffset"], serde_json::json!(next), "{query}");
    }
}

#[tokio::test]
async fn status_exposes_optional_text_search_index_progress() {
    let response = request("/api/status").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(status.get("semantic").is_none());
    assert_eq!(status["textSearch"]["enabled"], false);
    assert_eq!(status["textSearch"]["backgroundComplete"], true);
}

#[tokio::test]
async fn unknown_api_and_image_routes_return_not_found() {
    assert_eq!(
        request("/api/does-not-exist").await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request("/api/images/missing/thumbnail").await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request("/api/images/missing/original").await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request("/api/images/missing/details").await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request("/api/images/missing/similar").await.status(),
        StatusCode::NOT_FOUND
    );
    let response = request("/missing").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
    assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
}

#[tokio::test]
async fn albums_exclude_descendants_from_image_search_and_pagination() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    for folder in ["trip/child", "trip-other", "empty"] {
        std::fs::create_dir_all(gallery.join(folder)).unwrap();
    }
    for path in [
        "root.png",
        "trip/direct.png",
        "trip/second.png",
        "trip/child/child.png",
        "trip-other/other.png",
    ] {
        image::RgbImage::new(20, 10)
            .save(gallery.join(path))
            .unwrap();
    }
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails: ThumbnailManager::new(temp.path().join("cache")).unwrap(),
    });
    for (query, expected_total, expected_items) in [
        ("album=trip&limit=1&offset=0", 2, 1),
        ("album=trip&limit=1&offset=1", 2, 1),
        ("album=trip&limit=1&offset=2", 2, 0),
        ("album=trip&search=child", 0, 0),
        ("album=trip&search=direct", 1, 1),
        ("album=trip&sort=name-desc", 2, 2),
        ("album=trip&sort=explore&seed=test", 2, 2),
        ("album=trip%2Fchild", 1, 1),
        ("album=trip-other", 1, 1),
        ("album=empty", 0, 0),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["total"], expected_total, "{query}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), expected_items, "{query}");
        assert!(items.iter().all(|item| item["name"] != "root.png"));
        if query.starts_with("album=trip&") {
            assert!(
                items
                    .iter()
                    .all(|item| matches!(item["name"].as_str(), Some("direct.png" | "second.png"))),
                "{query}"
            );
        } else if query == "album=trip%2Fchild" {
            assert!(items.iter().all(|item| item["name"] == "child.png"));
        }
    }
}

#[tokio::test]
async fn similar_images_are_ranked_exclude_the_source_and_paginate() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([220, 80, 40]))
        .save(gallery.join("source.png"))
        .unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([216, 82, 43]))
        .save(gallery.join("closest.png"))
        .unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([205, 88, 48]))
        .save(gallery.join("nearby.png"))
        .unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([20, 50, 220]))
        .save(gallery.join("blue.png"))
        .unwrap();

    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let source_id = index
        .images
        .iter()
        .find(|image| image.name == "source.png")
        .unwrap()
        .id
        .clone();
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    for image in &index.images {
        thumbnails.ensure_ready(&image.id).await.unwrap();
    }
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails,
    });

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{source_id}/similar?offset=0&limit=1"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(page["total"], 2);
    assert_eq!(page["nextOffset"], 1);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["name"], "closest.png");
    assert_ne!(page["items"][0]["id"], source_id);

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{source_id}/similar?offset=1&limit=1"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(page["total"], 2);
    assert_eq!(page["nextOffset"], serde_json::Value::Null);
    assert_eq!(page["items"][0]["name"], "nearby.png");
}

#[tokio::test]
async fn uploaded_images_search_without_importing_and_validate_requests() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    let source = image::RgbImage::from_pixel(40, 30, image::Rgb([220, 80, 40]));
    source.save(gallery.join("source.png")).unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([216, 82, 43]))
        .save(gallery.join("nearby.png"))
        .unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([20, 50, 220]))
        .save(gallery.join("unrelated.png"))
        .unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let source_id = index
        .images
        .iter()
        .find(|image| image.name == "source.png")
        .unwrap()
        .id
        .clone();
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    for image in &index.images {
        thumbnails.ensure_ready(&image.id).await.unwrap();
    }
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails,
    });
    let upload = |bytes: Vec<u8>, offset: usize| {
        Request::builder()
            .method("POST")
            .uri(format!("/api/images/similar?offset={offset}&limit=1"))
            .header(header::ORIGIN, "http://localhost")
            .header("x-pixhelf-origin", "http://localhost")
            .body(Body::from(bytes))
            .unwrap()
    };
    for format in [
        image::ImageFormat::Png,
        image::ImageFormat::Jpeg,
        image::ImageFormat::WebP,
    ] {
        let mut encoded = std::io::Cursor::new(Vec::new());
        source.write_to(&mut encoded, format).unwrap();
        for offset in 0..2 {
            let response = app
                .clone()
                .oneshot(upload(encoded.get_ref().clone(), offset))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{format:?}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let body = axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap();
            let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(page["total"], 2, "{format:?}");
            assert_eq!(
                page["items"][0]["name"],
                if offset == 0 {
                    "source.png"
                } else {
                    "nearby.png"
                }
            );
            assert_eq!(
                page["nextOffset"],
                if offset == 0 {
                    serde_json::json!(1)
                } else {
                    serde_json::Value::Null
                }
            );
        }
    }
    // A video-frame upload can omit its source video without changing the
    // shared cached ranking used by the same image's ordinary uploads.
    let mut encoded = std::io::Cursor::new(Vec::new());
    source
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    for exclude in [true, false] {
        let mut request = upload(encoded.get_ref().clone(), 0);
        if exclude {
            *request.uri_mut() =
                format!("/api/images/similar?offset=0&limit=1&exclude={source_id}")
                    .parse()
                    .unwrap();
        }
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(page["total"], if exclude { 1 } else { 2 });
        assert_eq!(
            page["items"][0]["name"],
            if exclude { "nearby.png" } else { "source.png" }
        );
        assert_eq!(
            page["nextOffset"],
            if exclude {
                serde_json::Value::Null
            } else {
                serde_json::json!(1)
            }
        );
    }
    let response = app
        .clone()
        .oneshot(upload(b"invalid image".to_vec(), 0))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = app
        .clone()
        .oneshot(upload(vec![0; MAX_SEARCH_UPLOAD_BYTES + 1], 0))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/images/similar")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{source_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 10_000)
        .await
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(metadata["name"], "source.png");
    assert_eq!(metadata["width"], 40);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/images/missing")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(std::fs::read_dir(&gallery).unwrap().count(), 3);
}

#[tokio::test]
async fn similar_images_omit_unrelated_candidates() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([220, 80, 40]))
        .save(gallery.join("source.png"))
        .unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([20, 50, 220]))
        .save(gallery.join("unrelated.png"))
        .unwrap();

    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let source_id = index
        .images
        .iter()
        .find(|image| image.name == "source.png")
        .unwrap()
        .id
        .clone();
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    for image in &index.images {
        thumbnails.ensure_ready(&image.id).await.unwrap();
    }
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails,
    });

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{source_id}/similar"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(page["total"], 0);
    assert_eq!(page["nextOffset"], serde_json::Value::Null);
    assert!(page["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn natural_language_api_searches_image_content_not_only_filenames() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([230, 25, 20]))
        .save(gallery.join("first.png"))
        .unwrap();
    image::RgbImage::from_pixel(30, 40, image::Rgb([20, 30, 230]))
        .save(gallery.join("second.png"))
        .unwrap();

    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let text_search = crate::text_search::TextSearchIndex::with_test_model(
        Box::new(ColourTextSearchModel),
        [44; 16],
    );
    let thumbnails = ThumbnailManager::new_with_text_search(
        temp.path().join("cache"),
        Some(Arc::clone(&text_search)),
    )
    .unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    text_search.start_worker();
    for image in &index.images {
        thumbnails.ensure_ready(&image.id).await.unwrap();
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let status = thumbnails.status();
            if status.background_complete && status.text_search.background_complete {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("text-search index timed out");
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails,
    });

    for (filters, names) in [
        ("", vec!["first.png", "second.png"]),
        ("&orientation=portrait", vec!["second.png"]),
        ("&orientation=landscape", vec!["first.png"]),
        ("&kind=video", vec![]),
        ("&sort=name-desc", vec!["second.png", "first.png"]),
        ("&orientation=portrait&sort=name-asc", vec!["second.png"]),
        ("", vec!["first.png", "second.png"]),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/images?search=%E7%BA%A2%E8%89%B2%E5%9B%BE%E7%89%87&limit=2{filters}"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            names,
            "{filters}"
        );
        assert_eq!(page["total"], names.len());
    }
}

#[tokio::test]
async fn prepared_video_api_reports_jobs_and_serves_seekable_cached_mp4s() {
    use crate::video_jobs::{self, VideoKind};
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    let path = gallery.join("clip.mov");
    let original = include_bytes!("../../frontend/scripts/fixtures/live-photo-hevc.mov");
    std::fs::write(&path, original).unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let record = Arc::clone(&index.images[0]);
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails: Arc::clone(&thumbnails),
    });
    let url = video_jobs::url(&record, VideoKind::Playback).unwrap();
    let get = |uri: String| {
        app.clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
    };
    let pending = get(format!("{url}?status=true")).await.unwrap();
    assert_eq!(pending.status(), StatusCode::ACCEPTED);
    assert_eq!(pending.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(pending.headers()[header::RETRY_AFTER], "2");
    assert_eq!(
        get(url.clone()).await.unwrap().status(),
        StatusCode::ACCEPTED
    );
    thumbnails.videos.start_worker();
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while !thumbnails.videos.status().playback.background_complete
            || !thumbnails.videos.status().preview.background_complete
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let ready = get(format!("{url}?status=true")).await.unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    assert_eq!(ready.headers()[header::CACHE_CONTROL], "no-store");
    let response = get(url.clone()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
    assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
    let etag = response.headers()[header::ETAG].clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_ne!(bytes.as_ref(), original);
    for (method, range, status) in [
        (Method::HEAD, "bytes=10-29", StatusCode::OK),
        (Method::GET, "bytes=10-29", StatusCode::PARTIAL_CONTENT),
        (
            Method::GET,
            "bytes=999999999-",
            StatusCode::RANGE_NOT_SATISFIABLE,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method.clone())
                    .uri(&url)
                    .header(header::RANGE, range)
                    .header(header::IF_RANGE, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        if method == Method::HEAD {
            assert_eq!(
                response.headers()[header::CONTENT_LENGTH],
                bytes.len().to_string()
            );
            assert!(
                axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .is_empty()
            );
        } else if status == StatusCode::PARTIAL_CONTENT {
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                format!("bytes 10-29/{}", bytes.len())
            );
            assert_eq!(
                axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap(),
                &bytes[10..30]
            );
        }
    }
    let cached = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&url)
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    let metadata = get(format!("/api/images/{}", record.id)).await.unwrap();
    let metadata: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(metadata.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(metadata["playback"], url);
    assert_eq!(
        metadata["preview"],
        video_jobs::url(&record, VideoKind::Preview).unwrap()
    );
    let wrong_version = url.replace(&video_jobs::version(&record).unwrap(), "old-version");
    assert_eq!(
        get(wrong_version).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    std::fs::write(&path, b"replaced").unwrap();
    let stale = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&url)
                .header(header::IF_NONE_MATCH, etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::NOT_FOUND);
    thumbnails.videos.shutdown();
}

#[tokio::test]
async fn standalone_video_metadata_posters_and_original_ranges() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    let source = include_bytes!("../../frontend/scripts/fixtures/live-photo.mp4");
    let path = gallery.join("video.MP4");
    std::fs::write(&path, source).unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let id = index.images[0].id.clone();
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    let poster = thumbnails.ensure_ready(&id).await.unwrap();
    let poster = image::open(poster).unwrap();
    assert!(poster.width() > 0 && poster.width().max(poster.height()) <= 720);
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails,
    });
    let url = format!("/api/images/{id}/original");
    let etag = format!("\"original-{id}\"");
    for (range, validator, expected_status, expected) in [
        (None, None, StatusCode::OK, source.as_slice()),
        (
            Some("bytes=8-31"),
            None,
            StatusCode::PARTIAL_CONTENT,
            &source[8..32],
        ),
        (
            Some("bytes=-16"),
            None,
            StatusCode::PARTIAL_CONTENT,
            &source[source.len() - 16..],
        ),
        (
            Some("bytes=0-15"),
            Some(etag.as_str()),
            StatusCode::PARTIAL_CONTENT,
            &source[..16],
        ),
        (
            Some("bytes=0-15"),
            Some("\"old\""),
            StatusCode::OK,
            source.as_slice(),
        ),
    ] {
        let mut request = Request::builder().uri(&url);
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        if let Some(validator) = validator {
            request = request.header(header::IF_RANGE, validator);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected_status);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            axum::body::to_bytes(response.into_body(), source.len())
                .await
                .unwrap(),
            expected
        );
    }
    let head = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::HEAD)
                .uri(&url)
                .header(header::RANGE, "bytes=0-15")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(
        head.headers()[header::CONTENT_LENGTH],
        source.len().to_string()
    );
    assert!(
        axum::body::to_bytes(head.into_body(), 1)
            .await
            .unwrap()
            .is_empty()
    );
    let invalid = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&url)
                .header(header::RANGE, "bytes=999999999-")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    for route in [
        format!("/api/images/{id}"),
        format!("/api/images/{id}/details"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(route).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 65536)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["video"]["codec"], "h264");
        assert!(value["histogram"].is_null());
    }
    std::fs::write(path, b"replaced").unwrap();
    let stale = app
        .oneshot(
            Request::builder()
                .uri(url)
                .header(header::IF_NONE_MATCH, etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
#[ignore = "requires pic/pixhelf-video-testset (or PIXHELF_VIDEO_TESTSET), ffmpeg and ffprobe"]
async fn video_compatibility_testset() {
    let root = std::path::PathBuf::from(
        std::env::var("PIXHELF_VIDEO_TESTSET")
            .unwrap_or_else(|_| "pic/pixhelf-video-testset".into()),
    );
    let manifest = std::fs::read_to_string(root.join("manifest.csv")).unwrap();
    let rows: Vec<_> = manifest
        .lines()
        .skip(1)
        .filter(|line| !line.is_empty())
        .map(|line| line.split('|').collect::<Vec<_>>())
        .collect();
    let index = crate::gallery::scan_gallery(&root, None).unwrap();
    assert_eq!(index.images.len(), rows.len());
    let temp = tempfile::tempdir().unwrap();
    let thumbnails = ThumbnailManager::new(temp.path().to_owned()).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(2);
    let records = index.images.clone();
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails: Arc::clone(&thumbnails),
    });
    for row in rows {
        let record = records
            .iter()
            .find(|record| record.name == row[0])
            .expect("test video is indexed");
        let video = record.video.as_ref().unwrap();
        assert!(record.motion.is_none());
        assert_eq!(video.codec, row[2], "{} codec", row[0]);
        assert_eq!(video.audio_codec.as_deref().unwrap_or(""), row[3]);
        assert_eq!(record.width, row[4].parse::<u32>().unwrap());
        assert_eq!(record.height, row[5].parse::<u32>().unwrap());
        if row[6] == "N/A" {
            assert!(video.duration.is_none());
        } else {
            assert!((video.duration.unwrap() - row[6].parse::<f64>().unwrap()).abs() < 0.1);
        }
        let poster = thumbnails.ensure_ready(&record.id).await.unwrap();
        let poster = image::open(poster).unwrap();
        assert_eq!(
            (poster.width(), poster.height()),
            (record.width, record.height)
        );
        let bytes = std::fs::read(&record.path).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/images/{}/original", record.id))
                    .header(header::RANGE, "bytes=32-63")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            crate::video::mime_type(&record.path).unwrap()
        );
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 32)
                .await
                .unwrap(),
            &bytes[32..64]
        );
    }
    assert_eq!(thumbnails.status().failed, 0);
}

#[tokio::test]
async fn indexed_images_expose_original_with_immutable_cache() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    image::RgbImage::new(20, 10)
        .save(gallery.join("image.png"))
        .unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let id = index.images[0].id.clone();
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails,
    });

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{id}.png"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(body, std::fs::read(gallery.join("image.png")).unwrap());
    for (path, method, range, expected) in [
        (
            format!("/api/images/{id}.PNG"),
            Method::HEAD,
            false,
            StatusCode::OK,
        ),
        (
            format!("/api/images/{id}.png"),
            Method::GET,
            true,
            StatusCode::PARTIAL_CONTENT,
        ),
        (
            format!("/api/images/{id}/original"),
            Method::GET,
            false,
            StatusCode::OK,
        ),
        (
            format!("/api/images/{id}.jpg"),
            Method::GET,
            false,
            StatusCode::NOT_FOUND,
        ),
        (
            format!("/api/images/{id}.png.exe"),
            Method::GET,
            false,
            StatusCode::NOT_FOUND,
        ),
        (
            "/api/images/missing.png".to_owned(),
            Method::GET,
            false,
            StatusCode::NOT_FOUND,
        ),
    ] {
        let mut request = Request::builder().uri(&path).method(method.clone());
        if range {
            request = request.header(header::RANGE, "bytes=0-7");
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{path}");
        let response_body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        if range {
            assert_eq!(response_body, body[..8]);
        }
        if method == Method::HEAD {
            assert!(response_body.is_empty());
        }
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{id}.png"))
                .header(header::IF_NONE_MATCH, format!("\"original-{id}\""))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    std::fs::write(gallery.join("image.png"), b"changed").unwrap();
    let stale = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{id}.png"))
                .header(header::IF_NONE_MATCH, "*")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn image_details_expose_file_data_and_histogram() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    image::RgbImage::from_pixel(20, 10, image::Rgb([180, 90, 30]))
        .save(gallery.join("image.png"))
        .unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let id = index.images[0].id.clone();
    let expected_size = index.images[0].size;
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails,
    });

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{id}/details"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "private, max-age=31536000, immutable"
    );
    let etag = response.headers()[header::ETAG].clone();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let details: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(details["fileSize"], expected_size);
    assert!(details["modifiedMs"].as_u64().unwrap() > 0);
    assert!(details["exif"].as_array().unwrap().is_empty());
    for channel in ["red", "green", "blue", "luminance"] {
        let bins = details["histogram"][channel].as_array().unwrap();
        assert_eq!(bins.len(), 256);
        assert_eq!(
            bins.iter().map(|bin| bin.as_u64().unwrap()).sum::<u64>(),
            200
        );
    }

    let cached = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{id}/details"))
                .header(header::IF_NONE_MATCH, etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn stale_image_ids_do_not_serve_replaced_files() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    let image_path = gallery.join("image.png");
    image::RgbImage::new(20, 10).save(&image_path).unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let id = index.images[0].id.clone();
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    let app = router(AppState {
        index: Arc::new(RwLock::new(Arc::new(index))),
        thumbnails,
    });
    std::fs::write(&image_path, "replacement with a different size").unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/images/{id}/original"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn versioned_assets_are_immutable() {
    let response = request(&format!("/assets/{ASSET_VERSION}/app.js")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        request("/assets/stale/app.js").await.status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn libmedia_assets_are_embedded_and_versioned() {
    for (path, mime) in [
        ("libmedia/avplayer.js", "text/javascript; charset=utf-8"),
        ("libmedia/wasm/decode/h264-simd.wasm", "application/wasm"),
    ] {
        let uri = format!("/assets/{ASSET_VERSION}/{path}");
        let response = request(&uri).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], mime);
        let etag = response.headers()[header::ETAG].clone();
        let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let original = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("frontend/dist/assets")
                .join(path),
        )
        .unwrap();
        assert_eq!(body.as_ref(), original);
        if path.ends_with(".wasm") {
            assert!(body.starts_with(b"\0asm"));
        }
        let compressed = empty_router()
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .header(header::ACCEPT_ENCODING, "br")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(compressed.headers()[header::CONTENT_ENCODING], "br");
        assert_eq!(compressed.headers()[header::CONTENT_TYPE], mime);
        let encoded = axum::body::to_bytes(compressed.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let mut decoded = Vec::new();
        brotli::BrotliDecompress(&mut encoded.as_ref(), &mut decoded).unwrap();
        assert_eq!(decoded, original);
        let cached = empty_router()
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .header(header::IF_NONE_MATCH, etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            request(&format!("/assets/stale/{path}")).await.status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        request(&format!("/assets/{ASSET_VERSION}/missing.wasm"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn frontend_embeds_bootstrap_and_versioned_assets() {
    let response = request("/").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let html = std::str::from_utf8(&body).unwrap();
    assert!(html.contains(&format!("/assets/{ASSET_VERSION}/app.js")));
    assert!(html.contains("<style>:root"));
    assert!(!html.contains("/assets/app.css"));
    assert!(html.contains(r#""summary":{"total":0"#));
    assert!(!html.contains("__PIXHELF_BOOTSTRAP__"));
}

#[tokio::test]
async fn gallery_etag_supports_conditional_requests() {
    let legacy = empty_router()
        .oneshot(
            Request::builder()
                .uri("/api/gallery")
                .header(header::IF_NONE_MATCH, "\"gallery-\"")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        legacy.status(),
        StatusCode::OK,
        "cached catalogs must acquire album previews"
    );
    let response = empty_router()
        .oneshot(
            Request::builder()
                .uri("/api/gallery")
                .header(header::IF_NONE_MATCH, "\"gallery-previews-v1-\"")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "private, no-cache"
    );

    let weak_response = empty_router()
        .oneshot(
            Request::builder()
                .uri("/api/gallery")
                .header(header::IF_NONE_MATCH, "W/\"gallery-previews-v1-\"")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(weak_response.status(), StatusCode::NOT_MODIFIED);
}
