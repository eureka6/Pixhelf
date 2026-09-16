use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use serde::Serialize;
use tracing::{debug, warn};

use crate::{
    gallery::ImageRecord,
    support::{PriorityQueue, mutex_lock, read_lock, write_lock},
    video,
};

// Included in URLs as well as disk paths: changing encoding settings must also
// invalidate browser caches. Only complete, atomically published MP4s are reused.
const CACHE_VERSION: &str = "video-h264-aac-v1";
const MAX_ATTEMPTS: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoKind {
    Playback,
    Preview,
}

impl VideoKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Playback => "playback",
            Self::Preview => "preview",
        }
    }
}

pub fn version(record: &ImageRecord) -> Option<String> {
    if record.video.is_none() && record.motion.is_none() {
        return None;
    }
    let mut hash = blake3::Hasher::new();
    hash.update(CACHE_VERSION.as_bytes());
    hash.update(record.id.as_bytes());
    if let Some(motion) = &record.motion {
        hash.update(motion.id.as_bytes());
    }
    Some(hash.finalize().to_hex().to_string())
}

pub fn url(record: &ImageRecord, kind: VideoKind) -> Option<String> {
    if kind == VideoKind::Playback && record.video.is_none() {
        return None;
    }
    Some(format!(
        "/api/images/{}/video/{}/{}.mp4",
        record.id,
        version(record)?,
        kind.name(),
    ))
}

pub struct VideoManager {
    cache_root: PathBuf,
    entries: RwLock<HashMap<String, Arc<VideoEntry>>>,
    queue: PriorityQueue,
    started: AtomicBool,
}

struct VideoEntry {
    record: Arc<ImageRecord>,
    kind: VideoKind,
    path: PathBuf,
    state: Mutex<JobState>,
    cancelled: AtomicBool,
}

enum JobState {
    Queued(u8),
    Processing,
    Ready,
    Failed,
}

pub enum PreparedAsset {
    Pending(&'static str),
    Ready(PathBuf),
    Failed,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub total: usize,
    pub ready: usize,
    pub queued: usize,
    pub processing: usize,
    pub failed: usize,
    pub background_complete: bool,
}

#[derive(Default, Debug, Serialize)]
pub struct VideoStatus {
    pub playback: JobStatus,
    pub preview: JobStatus,
}

impl VideoManager {
    pub fn new(cache_dir: &Path) -> Result<Arc<Self>> {
        let cache_root = cache_dir.join(CACHE_VERSION);
        fs::create_dir_all(&cache_root).context("cannot create video cache")?;
        for entry in fs::read_dir(&cache_root)?.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(Arc::new(Self {
            cache_root,
            entries: RwLock::new(HashMap::new()),
            queue: PriorityQueue::default(),
            started: AtomicBool::new(false),
        }))
    }

    pub fn reconcile(&self, records: &[Arc<ImageRecord>]) {
        let mut jobs = Vec::new();
        // Finish inexpensive previews before starting full background encodes.
        // Explicit playback requests can promote their own job at any time.
        for kind in [VideoKind::Preview, VideoKind::Playback] {
            for record in records {
                if kind == VideoKind::Playback && record.video.is_none() {
                    continue;
                }
                if let Some(version) = version(record) {
                    jobs.push((format!("{version}-{}", kind.name()), record, kind));
                }
            }
        }
        let current = jobs
            .iter()
            .map(|(key, _, _)| key.as_str())
            .collect::<HashSet<_>>();
        let mut entries = write_lock(&self.entries);
        entries.retain(|key, entry| {
            let keep = current.contains(key.as_str());
            if !keep {
                entry.cancelled.store(true, Ordering::Release);
            }
            keep
        });
        self.queue.retain(&current);
        for (key, record, kind) in &jobs {
            if entries.contains_key(key) {
                continue;
            }
            let path = self.cache_root.join(format!("{key}.mp4"));
            let ready = valid_cache(&path);
            entries.insert(
                key.clone(),
                Arc::new(VideoEntry {
                    record: Arc::clone(record),
                    kind: *kind,
                    path,
                    state: Mutex::new(if ready {
                        JobState::Ready
                    } else {
                        JobState::Queued(0)
                    }),
                    cancelled: AtomicBool::new(false),
                }),
            );
            if !ready {
                self.queue.push_background(key.clone());
            }
        }
    }

    // Polling does not retry permanent failures; only an explicit retry does.
    pub fn request(
        &self,
        record: &ImageRecord,
        kind: VideoKind,
        retry: bool,
    ) -> Option<PreparedAsset> {
        let key = format!("{}-{}", version(record)?, kind.name());
        let entry = read_lock(&self.entries).get(&key).cloned()?;
        let mut state = mutex_lock(&entry.state);
        if matches!(*state, JobState::Ready) && !valid_cache(&entry.path)
            || retry && matches!(*state, JobState::Failed)
        {
            *state = JobState::Queued(0);
        }
        Some(match *state {
            JobState::Queued(_) => {
                self.queue.push_urgent(key);
                PreparedAsset::Pending("queued")
            }
            JobState::Processing => PreparedAsset::Pending("processing"),
            JobState::Ready => PreparedAsset::Ready(entry.path.clone()),
            JobState::Failed => PreparedAsset::Failed,
        })
    }

    pub fn status(&self) -> VideoStatus {
        let mut status = VideoStatus::default();
        for entry in read_lock(&self.entries).values() {
            let counts = match entry.kind {
                VideoKind::Playback => &mut status.playback,
                VideoKind::Preview => &mut status.preview,
            };
            counts.total += 1;
            match *mutex_lock(&entry.state) {
                JobState::Ready => counts.ready += 1,
                JobState::Queued(_) => counts.queued += 1,
                JobState::Processing => counts.processing += 1,
                JobState::Failed => counts.failed += 1,
            }
        }
        for counts in [&mut status.playback, &mut status.preview] {
            counts.background_complete = counts.ready + counts.failed == counts.total;
        }
        status
    }

    pub fn start_worker(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let manager = Arc::clone(self);
        tokio::spawn(async move { manager.worker().await });
    }

    pub fn shutdown(&self) {
        for entry in read_lock(&self.entries).values() {
            entry.cancelled.store(true, Ordering::Release);
        }
    }

    pub async fn cleanup_stale(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(files) = fs::read_dir(&manager.cache_root) else {
                return;
            };
            for file in files.flatten() {
                let name = file.file_name();
                let Some(key) = name.to_str().and_then(|name| name.strip_suffix(".mp4")) else {
                    continue;
                };
                // Hold the index lock through removal so reconciliation cannot
                // adopt a cached file between this check and its deletion.
                let entries = read_lock(&manager.entries);
                if !entries.contains_key(key) {
                    let _ = fs::remove_file(file.path());
                }
            }
        })
        .await;
    }

    async fn worker(self: Arc<Self>) {
        loop {
            let key = self.queue.pop().await;
            let Some(entry) = read_lock(&self.entries).get(&key).cloned() else {
                continue;
            };
            if entry.cancelled.load(Ordering::Acquire) {
                continue;
            }
            let attempts = {
                let mut state = mutex_lock(&entry.state);
                let JobState::Queued(attempts) = *state else {
                    continue;
                };
                *state = JobState::Processing;
                attempts + 1
            };
            let job = Arc::clone(&entry);
            let result = tokio::task::spawn_blocking(move || generate(&job))
                .await
                .map_err(|error| anyhow!("video worker stopped: {error}"))
                .and_then(|result| result);
            // Publication belongs to the current entry. A removed/readded file
            // must never receive output from an obsolete job with the same key.
            let entries = read_lock(&self.entries);
            if !entries
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &entry))
                || entry.cancelled.load(Ordering::Acquire)
            {
                continue;
            }
            let mut state = mutex_lock(&entry.state);
            match result.and_then(|temp| {
                ensure_current(&entry.record)?;
                temp.persist(&entry.path)
                    .context("cannot publish prepared video")?;
                Ok(())
            }) {
                Ok(()) => *state = JobState::Ready,
                Err(error) if attempts < MAX_ATTEMPTS => {
                    debug!(image = %entry.record.relative_path, kind = entry.kind.name(), attempts, %error, "视频准备失败，重新排队");
                    *state = JobState::Queued(attempts);
                    self.queue.push_background(key);
                }
                Err(error) => {
                    warn!(image = %entry.record.relative_path, kind = entry.kind.name(), error = %format!("{error:#}"), "无法准备视频");
                    *state = JobState::Failed;
                }
            }
        }
    }
}

fn valid_cache(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut header = [0; 12];
    file.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 32)
        && file.read_exact(&mut header).is_ok()
        && &header[4..8] == b"ftyp"
}

pub fn ensure_current(record: &ImageRecord) -> Result<()> {
    record.ensure_source_is_current()?;
    if let Some(motion) = &record.motion {
        ensure!(
            motion.matches_metadata(&fs::metadata(&motion.path)?),
            "live photo video changed since the gallery scan"
        );
    }
    Ok(())
}

fn temporary(directory: &Path) -> Result<tempfile::NamedTempFile> {
    tempfile::Builder::new()
        .prefix("video-")
        .suffix(".tmp")
        .tempfile_in(directory)
        .context("cannot create video temporary file")
}

fn generate(entry: &VideoEntry) -> Result<tempfile::NamedTempFile> {
    ensure_current(&entry.record)?;
    let directory = entry.path.parent().context("video cache has no parent")?;
    // Embedded clips need a seekable input. Copy only their bounded byte range,
    // never the JPEG or Samsung trailer, and remove it on every exit path.
    let mut extracted = None;
    let source = if let Some(motion) = &entry.record.motion {
        if motion.offset > 0 {
            let mut file = File::open(&motion.path)?;
            file.seek(SeekFrom::Start(motion.offset))?;
            let mut temp = temporary(directory)?;
            let copied = std::io::copy(&mut file.take(motion.length), &mut temp)?;
            ensure!(copied == motion.length, "incomplete embedded video");
            extracted = Some(temp);
            extracted.as_ref().unwrap().path()
        } else {
            &motion.path
        }
    } else {
        &entry.record.path
    };
    let (width, height, metadata) = match &entry.record.video {
        Some(metadata) => (entry.record.width, entry.record.height, metadata.clone()),
        None => video::probe(source)?,
    };
    let preview = entry.kind == VideoKind::Preview;
    let scale = if preview {
        480.0 / f64::from(width.max(height))
    } else {
        (1920.0 / f64::from(width.max(height))).min(1080.0 / f64::from(width.min(height)))
    }
    .min(1.0);
    let width = ((f64::from(width) * scale / 2.0).floor() as u32 * 2).max(2);
    let height = ((f64::from(height) * scale / 2.0).floor() as u32 * 2).max(2);
    let fps = if preview { "24" } else { "30" };
    let output = temporary(directory)?;
    let mut command = Command::new("ffmpeg");
    command.args(["-v", "error", "-nostdin", "-y", "-filter_threads", "1"]);
    video::input_options(&mut command, source)?;
    command.args([
        "-map",
        &format!("0:{}", metadata.stream_index),
        "-sn",
        "-dn",
    ]);
    if preview {
        command.args([
            "-an",
            "-t",
            if entry.record.motion.is_some() {
                "30"
            } else {
                "6"
            },
        ]);
    } else {
        command.args([
            "-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
        ]);
    }
    command
        .args([
            "-vf",
            &format!("scale={width}:{height},setsar=1,fps={fps}"),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            if preview { "28" } else { "22" },
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "main",
            "-level:v",
            "4.0",
            "-g",
            fps,
            "-keyint_min",
            fps,
            "-sc_threshold",
            "0",
            "-maxrate",
            if preview { "800k" } else { "8M" },
            "-bufsize",
            if preview { "1600k" } else { "16M" },
            "-threads",
            "2",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ])
        .arg(output.path());
    let timeout = if preview {
        120.0
    } else {
        (metadata.duration.unwrap_or(3600.0) * 12.0 + 300.0).clamp(300.0, 86400.0)
    };
    video::run_cancellable(
        &mut command,
        1024,
        Duration::from_secs_f64(timeout),
        &|| entry.cancelled.load(Ordering::Acquire),
    )?;
    ensure!(
        !entry.cancelled.load(Ordering::Acquire),
        "video job cancelled"
    );
    ensure_current(&entry.record)?;
    ensure!(
        valid_cache(output.path()),
        "encoder produced an invalid MP4"
    );
    // Probe once before publication to reject header-only or incomplete output.
    let (_, _, prepared) = video::probe(output.path())?;
    ensure!(
        prepared.codec == "h264" && prepared.duration.is_some(),
        "encoder produced no playable video"
    );
    output.as_file().sync_all()?;
    drop(extracted);
    Ok(output)
}

#[cfg(test)]
mod tests;
