use super::*;

async fn finish(manager: &VideoManager) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let status = manager.status();
            if status.playback.background_complete && status.preview.background_complete {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("video jobs timed out");
}

fn ready(manager: &VideoManager, record: &ImageRecord, kind: VideoKind) -> PathBuf {
    let Some(PreparedAsset::Ready(path)) = manager.request(record, kind, false) else {
        panic!("video not ready")
    };
    path
}

#[tokio::test]
async fn background_video_outputs_are_seekable_persistent_and_rebuildable() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    fs::create_dir(&gallery).unwrap();
    let source = gallery.join("long-gop.mkv");
    let mut fixture = Command::new("ffmpeg");
    fixture
        .args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x120:rate=12",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100",
            "-t",
            "7",
            "-c:v",
            "mpeg4",
            "-g",
            "250",
            "-c:a",
            "pcm_s16le",
            "-threads",
            "1",
        ])
        .arg(&source);
    video::run_cancellable(&mut fixture, 1024, Duration::from_secs(10), &|| false).unwrap();
    let original = fs::read(&source).unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let record = &index.images[0];
    let cache = temp.path().join("cache");
    let manager = VideoManager::new(&cache).unwrap();
    manager.reconcile(&index.images);
    assert_eq!(manager.status().playback.queued, 1);
    assert_eq!(manager.status().preview.queued, 1);
    manager.start_worker();
    finish(&manager).await;
    assert_eq!(manager.status().playback.failed, 0);
    assert_eq!(manager.status().preview.failed, 0);
    let playback = ready(&manager, record, VideoKind::Playback);
    let preview = ready(&manager, record, VideoKind::Preview);
    for (path, expected_duration, audio) in [(&playback, 7.0, Some("aac")), (&preview, 6.0, None)] {
        let (width, height, metadata) = video::probe(path).unwrap();
        assert_eq!((width, height), (160, 120));
        assert_eq!(metadata.codec, "h264");
        assert_eq!(metadata.audio_codec.as_deref(), audio);
        assert!((metadata.duration.unwrap() - expected_duration).abs() < 0.15);
        let bytes = fs::read(path).unwrap();
        let atom = |name| bytes.windows(4).position(|bytes| bytes == name).unwrap();
        assert!(
            atom(b"moov") < atom(b"mdat"),
            "index must precede media for immediate playback"
        );
    }
    let mut probe = Command::new("ffprobe");
    probe
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-skip_frame",
            "nokey",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
        ])
        .arg(&playback);
    let frames: serde_json::Value = serde_json::from_slice(
        &video::run_cancellable(&mut probe, 32 * 1024, Duration::from_secs(10), &|| false).unwrap(),
    )
    .unwrap();
    let times = frames["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|frame| {
            frame["best_effort_timestamp_time"]
                .as_str()
                .unwrap()
                .parse::<f64>()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert!(times.len() >= 7, "seeking needs frequent keyframes");
    assert!(times.windows(2).all(|pair| pair[1] - pair[0] <= 1.01));
    assert_eq!(fs::read(&source).unwrap(), original);

    let modified = fs::metadata(&playback).unwrap().modified().unwrap();
    let restarted = VideoManager::new(&cache).unwrap();
    restarted.reconcile(&index.images);
    assert_eq!(restarted.status().playback.ready, 1);
    assert_eq!(
        fs::metadata(&playback).unwrap().modified().unwrap(),
        modified
    );
    fs::remove_file(&preview).unwrap();
    assert!(matches!(
        restarted.request(record, VideoKind::Preview, false),
        Some(PreparedAsset::Pending("queued"))
    ));
    restarted.start_worker();
    finish(&restarted).await;
    assert!(ready(&restarted, record, VideoKind::Preview).is_file());
    restarted.reconcile(&[]);
    restarted.cleanup_stale().await;
    assert!(!playback.exists() && !preview.exists());
    manager.shutdown();
    restarted.shutdown();
}

#[tokio::test]
async fn live_preview_extracts_hevc_and_invalidates_when_paired_video_changes() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    fs::create_dir(&gallery).unwrap();
    let clip = include_bytes!("../../frontend/scripts/fixtures/live-photo-hevc.mov");
    crate::motion::tests::samsung_jpeg(&gallery.join("embedded.jpg"), clip, true);
    image::RgbImage::new(20, 10)
        .save(gallery.join("paired.jpg"))
        .unwrap();
    let paired = gallery.join("paired.mov");
    fs::write(&paired, clip).unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    assert_eq!(index.images.len(), 2);
    let manager = VideoManager::new(&temp.path().join("cache")).unwrap();
    manager.reconcile(&index.images);
    manager.start_worker();
    finish(&manager).await;
    assert_eq!(manager.status().preview.ready, 2);
    assert_eq!(manager.status().playback.total, 0);
    for record in &index.images {
        let path = ready(&manager, record, VideoKind::Preview);
        let (width, height, metadata) = video::probe(&path).unwrap();
        assert_eq!(metadata.codec, "h264");
        assert_eq!(metadata.audio_codec, None);
        assert!(
            width > height,
            "video dimensions must come from the clip, not the still image"
        );
        assert!(
            !record
                .motion
                .as_ref()
                .unwrap()
                .path
                .starts_with(&manager.cache_root)
        );
    }
    let record = index
        .images
        .iter()
        .find(|record| record.name == "paired.jpg")
        .unwrap();
    let old_preview = ready(&manager, record, VideoKind::Preview);
    fs::write(
        &paired,
        include_bytes!("../../frontend/scripts/fixtures/live-photo.mp4"),
    )
    .unwrap();
    let updated = crate::gallery::scan_gallery(&gallery, Some(&index)).unwrap();
    let changed = updated.image(&record.id).unwrap();
    assert_ne!(version(record), version(changed));
    manager.reconcile(&updated.images);
    manager.cleanup_stale().await;
    assert!(!old_preview.exists());
    finish(&manager).await;
    assert_eq!(manager.status().preview.ready, 2);
    manager.shutdown();
}

#[tokio::test]
async fn failed_video_jobs_stop_retrying_until_requested_and_removed_jobs_are_discarded() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    fs::create_dir(&gallery).unwrap();
    let source = gallery.join("broken.mp4");
    fs::write(
        &source,
        include_bytes!("../../frontend/scripts/fixtures/live-photo.mp4"),
    )
    .unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let record = &index.images[0];
    let manager = VideoManager::new(&temp.path().join("cache")).unwrap();
    manager.reconcile(&index.images);
    fs::write(&source, b"replaced before the worker started").unwrap();
    manager.start_worker();
    finish(&manager).await;
    assert_eq!(manager.status().playback.failed, 1);
    assert_eq!(manager.status().preview.failed, 1);
    assert!(matches!(
        manager.request(record, VideoKind::Playback, false),
        Some(PreparedAsset::Failed)
    ));
    assert!(matches!(
        manager.request(record, VideoKind::Playback, true),
        Some(PreparedAsset::Pending("queued"))
    ));
    manager.reconcile(&[]);
    manager.shutdown();
    manager.cleanup_stale().await;
    assert!(fs::read_dir(&manager.cache_root).unwrap().next().is_none());
}

#[tokio::test]
async fn prepared_videos_keep_portrait_rotation() {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    fs::create_dir(&gallery).unwrap();
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-v",
            "error",
            "-nostdin",
            "-display_rotation",
            "90",
            "-i",
            "frontend/scripts/fixtures/live-photo.mp4",
            "-c",
            "copy",
        ])
        .arg(gallery.join("portrait.mp4"));
    video::run_cancellable(&mut command, 1024, Duration::from_secs(10), &|| false).unwrap();
    let index = crate::gallery::scan_gallery(&gallery, None).unwrap();
    let record = &index.images[0];
    assert!(record.height > record.width);
    let manager = VideoManager::new(&temp.path().join("cache")).unwrap();
    manager.reconcile(&index.images);
    manager.start_worker();
    finish(&manager).await;
    for kind in [VideoKind::Playback, VideoKind::Preview] {
        let (width, height, _) = video::probe(&ready(&manager, record, kind)).unwrap();
        assert_eq!((width, height), (record.width, record.height));
    }
    manager.shutdown();
}

#[test]
fn long_running_ffmpeg_can_be_cancelled_and_reaped() {
    let started = std::time::Instant::now();
    let mut command = Command::new("ffmpeg");
    command.args([
        "-v",
        "error",
        "-nostdin",
        "-re",
        "-stream_loop",
        "-1",
        "-i",
        "frontend/scripts/fixtures/live-photo.mp4",
        "-f",
        "null",
        "-",
    ]);
    let error = video::run_cancellable(&mut command, 1024, Duration::from_secs(3600), &|| {
        started.elapsed() > Duration::from_millis(200)
    })
    .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    assert!(started.elapsed() < Duration::from_secs(5));
}
