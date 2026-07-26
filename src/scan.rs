use crate::db::{Database, ImageMetadata};
use anyhow::Context;
use rayon::{ThreadPool, ThreadPoolBuilder, prelude::*};
use std::{
    collections::HashMap,
    fs,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Instant, UNIX_EPOCH},
};

const BATCH_SIZE: usize = 2_000;
const BOOTSTRAP_BATCH_SIZE: usize = 80;
const PARALLEL_CHUNK_SIZE: usize = 64;

#[derive(Clone, Copy)]
pub enum ScanMode {
    Bootstrap,
    Refresh,
}

pub struct ScanSummary {
    pub indexed: u64,
    pub removed: u64,
}

struct ScanSchedule {
    bootstrap_pending: bool,
}

impl ScanSchedule {
    fn new(mode: ScanMode) -> Self {
        Self {
            bootstrap_pending: matches!(mode, ScanMode::Bootstrap),
        }
    }

    fn batch_size(&self) -> usize {
        if self.bootstrap_pending {
            BOOTSTRAP_BATCH_SIZE
        } else {
            BATCH_SIZE
        }
    }

    fn committed(&mut self) {
        self.bootstrap_pending = false;
    }
}

struct ScanProgress {
    started: Instant,
    interactive: bool,
    checked: AtomicU64,
    indexed: AtomicU64,
    unchanged: AtomicU64,
    last_report_ms: AtomicU64,
}

impl ScanProgress {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            interactive: io::stderr().is_terminal(),
            checked: AtomicU64::new(0),
            indexed: AtomicU64::new(0),
            unchanged: AtomicU64::new(0),
            last_report_ms: AtomicU64::new(0),
        }
    }

    fn report(&self) {
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        let interval_ms = if self.interactive { 250 } else { 30_000 };
        let last = self.last_report_ms.load(Ordering::Relaxed);
        if elapsed_ms.saturating_sub(last) < interval_ms
            || self
                .last_report_ms
                .compare_exchange(last, elapsed_ms, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
        {
            return;
        }
        let checked = self.checked.load(Ordering::Relaxed);
        let indexed = self.indexed.load(Ordering::Relaxed);
        let unchanged = self.unchanged.load(Ordering::Relaxed);
        let updated = indexed - unchanged;
        let elapsed = elapsed_ms as f64 / 1_000.0;
        let speed = checked as f64 / elapsed.max(0.001);
        if self.interactive {
            eprint!(
                "\r\x1b[2K扫描 {checked}  收录 {indexed}  更新 {updated}  \
                 {speed:.0} 张/秒  {elapsed:.1} 秒"
            );
            let _ = io::stderr().flush();
        } else {
            tracing::info!(
                checked,
                indexed,
                unchanged,
                updated,
                images_per_second = format_args!("{speed:.1}"),
                elapsed_seconds = format_args!("{elapsed:.1}"),
                "scan progress"
            );
        }
    }

    fn finish(&self) -> u64 {
        let checked = self.checked.load(Ordering::Relaxed);
        let indexed = self.indexed.load(Ordering::Relaxed);
        let unchanged = self.unchanged.load(Ordering::Relaxed);
        let updated = indexed - unchanged;
        let elapsed = self.started.elapsed().as_secs_f64();
        let speed = checked as f64 / elapsed.max(0.001);
        if self.interactive {
            eprintln!(
                "\r\x1b[2K扫描完成  检查 {checked}  收录 {indexed}  更新 {updated}  \
                 {speed:.0} 张/秒  {elapsed:.1} 秒"
            );
        } else {
            tracing::info!(
                checked,
                images = indexed,
                unchanged,
                updated,
                images_per_second = format_args!("{speed:.1}"),
                elapsed_seconds = format_args!("{elapsed:.1}"),
                "scan complete"
            );
        }
        indexed
    }
}

enum ProcessedImage {
    Unchanged(PathBuf),
    Updated(ImageMetadata),
    Invalid,
}

struct ProcessedBatch {
    updates: Vec<ImageMetadata>,
    seen_paths: Vec<PathBuf>,
}

struct ScanContext<'a> {
    root: &'a Path,
    db: &'a Database,
    known_files: &'a HashMap<String, (u64, i64)>,
    progress: &'a ScanProgress,
    cancelled: &'a AtomicBool,
    pool: &'a ThreadPool,
}

fn process_image(
    path: &Path,
    root: &Path,
    known_files: &HashMap<String, (u64, i64)>,
) -> anyhow::Result<ProcessedImage> {
    let meta = path.metadata().context("image metadata")?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    let relative = path.strip_prefix(root).context("relative image path")?;
    if known_files
        .get(relative.to_string_lossy().as_ref())
        .is_some_and(|stored| *stored == (meta.len(), modified))
    {
        return Ok(ProcessedImage::Unchanged(relative.to_path_buf()));
    }
    let Some(mime) = mime_guess::from_path(path).first() else {
        return Ok(ProcessedImage::Invalid);
    };
    let Ok((width, height)) = crate::thumbs::dimensions(path) else {
        return Ok(ProcessedImage::Invalid);
    };
    Ok(ProcessedImage::Updated(ImageMetadata {
        path: relative.to_path_buf(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        mime: mime.to_string(),
        width,
        height,
        bytes: meta.len(),
        modified,
    }))
}

fn process_batch(
    paths: &[PathBuf],
    root: &Path,
    known_files: &HashMap<String, (u64, i64)>,
    progress: &ScanProgress,
    cancelled: &AtomicBool,
    pool: &ThreadPool,
) -> anyhow::Result<ProcessedBatch> {
    if paths.is_empty() {
        return Ok(ProcessedBatch {
            updates: Vec::new(),
            seen_paths: Vec::new(),
        });
    }
    let result_chunks = pool.install(|| {
        paths
            .par_chunks(PARALLEL_CHUNK_SIZE)
            .map(|chunk| {
                let mut results = Vec::with_capacity(chunk.len());
                let mut indexed = 0u64;
                let mut unchanged = 0u64;
                for (offset, path) in chunk.iter().enumerate() {
                    if offset % 16 == 0 && cancelled.load(Ordering::Acquire) {
                        anyhow::bail!("scan cancelled");
                    }
                    let result = process_image(path, root, known_files)?;
                    match &result {
                        ProcessedImage::Unchanged(_) => {
                            unchanged += 1;
                            indexed += 1;
                        }
                        ProcessedImage::Updated(_) => indexed += 1,
                        ProcessedImage::Invalid => {}
                    }
                    results.push(result);
                }
                progress
                    .checked
                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
                progress.indexed.fetch_add(indexed, Ordering::Relaxed);
                progress.unchanged.fetch_add(unchanged, Ordering::Relaxed);
                progress.report();
                Ok(results)
            })
            .collect::<anyhow::Result<Vec<Vec<_>>>>()
    })?;

    let mut updates = Vec::with_capacity(paths.len());
    let mut seen_paths = Vec::with_capacity(paths.len());
    for result in result_chunks.into_iter().flatten() {
        match result {
            ProcessedImage::Unchanged(path) => seen_paths.push(path),
            ProcessedImage::Updated(image) => {
                seen_paths.push(image.path.clone());
                updates.push(image);
            }
            ProcessedImage::Invalid => {}
        }
    }
    Ok(ProcessedBatch {
        updates,
        seen_paths,
    })
}

fn flush_pending(
    pending: &mut Vec<PathBuf>,
    schedule: &mut ScanSchedule,
    context: &ScanContext<'_>,
) -> anyhow::Result<()> {
    let batch = process_batch(
        pending,
        context.root,
        context.known_files,
        context.progress,
        context.cancelled,
        context.pool,
    )?;
    context
        .db
        .commit_scan_batch(&batch.updates, &batch.seen_paths)?;
    pending.clear();
    schedule.committed();
    Ok(())
}

fn scan_directory(
    directory: &Path,
    pending: &mut Vec<PathBuf>,
    schedule: &mut ScanSchedule,
    context: &ScanContext<'_>,
) -> anyhow::Result<()> {
    if context.cancelled.load(Ordering::Acquire) {
        anyhow::bail!("scan cancelled");
    }
    let mut entries = fs::read_dir(directory)
        .with_context(|| format!("cannot read directory {}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut directories = Vec::new();
    for entry in entries {
        if context.cancelled.load(Ordering::Acquire) {
            anyhow::bail!("scan cancelled");
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            directories.push(entry.path());
        } else if file_type.is_file()
            && mime_guess::from_path(entry.path())
                .first()
                .is_some_and(|mime| mime.type_() == mime::IMAGE)
        {
            pending.push(entry.path());
            if pending.len() == schedule.batch_size() {
                flush_pending(pending, schedule, context)?;
            }
        }
    }

    for child in directories {
        scan_directory(&child, pending, schedule, context)?;
    }
    Ok(())
}

#[cfg(test)]
pub fn scan(
    root: &Path,
    db: &Database,
    threads: usize,
    mode: ScanMode,
) -> anyhow::Result<ScanSummary> {
    scan_with_cancel(root, db, threads, mode, &AtomicBool::new(false))
}

pub fn scan_with_cancel(
    root: &Path,
    db: &Database,
    threads: usize,
    mode: ScanMode,
    cancelled: &AtomicBool,
) -> anyhow::Result<ScanSummary> {
    let threads = threads.clamp(1, 32);
    let pool = ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("pixhelf-scan-{index}"))
        .build()
        .context("create scan thread pool")?;
    let known_files = db.file_snapshot()?;
    db.begin_scan()?;
    let progress = ScanProgress::new();
    tracing::info!(
        root = %root.display(),
        threads,
        known = known_files.len(),
        ordering = "directory/name",
        bootstrap = matches!(mode, ScanMode::Bootstrap),
        "scan started"
    );
    let mut pending = Vec::with_capacity(BATCH_SIZE);
    let mut schedule = ScanSchedule::new(mode);
    let context = ScanContext {
        root,
        db,
        known_files: &known_files,
        progress: &progress,
        cancelled,
        pool: &pool,
    };
    let scan_result = scan_directory(root, &mut pending, &mut schedule, &context)
        .and_then(|()| flush_pending(&mut pending, &mut schedule, &context));
    if let Err(error) = scan_result {
        db.abort_scan();
        return Err(error);
    }
    let cleanup = db.finish_scan()?;
    if cleanup.skipped_empty {
        tracing::warn!(
            known = known_files.len(),
            "scan found no images; preserving the existing index"
        );
    } else if cleanup.removed > 0 {
        tracing::info!(removed = cleanup.removed, "stale image records removed");
    }
    Ok(ScanSummary {
        indexed: progress.finish(),
        removed: cleanup.removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    fn temp_gallery(name: &str) -> PathBuf {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("pixhelf-{name}-{}-{id}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_png(path: &Path, color: [u8; 3]) {
        image::save_buffer(path, &color, 1, 1, image::ColorType::Rgb8).unwrap();
    }

    #[test]
    fn bootstrap_uses_a_small_first_batch_only() {
        let mut schedule = ScanSchedule::new(ScanMode::Bootstrap);
        assert_eq!(schedule.batch_size(), BOOTSTRAP_BATCH_SIZE);
        schedule.committed();
        assert_eq!(schedule.batch_size(), BATCH_SIZE);
        assert_eq!(
            ScanSchedule::new(ScanMode::Refresh).batch_size(),
            BATCH_SIZE
        );
    }

    #[test]
    fn successful_scan_prunes_missing_files_but_preserves_an_empty_mount() {
        let workspace = temp_gallery("reconcile");
        let root = workspace.join("pictures");
        fs::create_dir_all(&root).unwrap();
        let first = root.join("01.png");
        let second = root.join("02.png");
        write_png(&first, [255, 0, 0]);
        write_png(&second, [0, 255, 0]);
        let db = Database::open(workspace.join("gallery.sqlite")).unwrap();

        assert_eq!(scan(&root, &db, 2, ScanMode::Bootstrap).unwrap().indexed, 2);
        assert_eq!(db.stats().unwrap().images, 2);
        fs::remove_file(&second).unwrap();
        let summary = scan(&root, &db, 2, ScanMode::Refresh).unwrap();
        assert_eq!(summary.indexed, 1);
        assert_eq!(summary.removed, 1);
        assert_eq!(db.stats().unwrap().images, 1);
        fs::remove_file(&first).unwrap();
        let summary = scan(&root, &db, 2, ScanMode::Refresh).unwrap();
        assert_eq!(summary.indexed, 0);
        assert_eq!(summary.removed, 0);
        assert_eq!(db.stats().unwrap().images, 1);

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn scan_maintains_a_compact_folder_index() {
        let workspace = temp_gallery("folders");
        let root = workspace.join("pictures");
        let first_folder = root.join("albums/first");
        let second_folder = root.join("albums/second");
        fs::create_dir_all(&first_folder).unwrap();
        fs::create_dir_all(&second_folder).unwrap();
        write_png(&first_folder.join("01.png"), [255, 0, 0]);
        write_png(&second_folder.join("02.png"), [0, 255, 0]);
        let db = Database::open(workspace.join("gallery.sqlite")).unwrap();

        scan(&root, &db, 2, ScanMode::Bootstrap).unwrap();
        assert_eq!(
            db.folders().unwrap(),
            ["albums", "albums/first", "albums/second"]
        );

        fs::remove_file(first_folder.join("01.png")).unwrap();
        scan(&root, &db, 2, ScanMode::Refresh).unwrap();
        assert_eq!(db.folders().unwrap(), ["albums", "albums/second"]);

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn failed_walk_does_not_prune_the_existing_index() {
        let workspace = temp_gallery("failed-scan");
        let root = workspace.join("pictures");
        fs::create_dir_all(&root).unwrap();
        write_png(&root.join("kept.png"), [0, 0, 255]);
        let db = Database::open(workspace.join("gallery.sqlite")).unwrap();
        scan(&root, &db, 1, ScanMode::Bootstrap).unwrap();

        let missing_root = workspace.join("not-mounted");
        assert!(scan(&missing_root, &db, 1, ScanMode::Refresh).is_err());
        assert_eq!(db.stats().unwrap().images, 1);
        // The failed scan must also release its temporary reconciliation state.
        assert_eq!(scan(&root, &db, 1, ScanMode::Refresh).unwrap().indexed, 1);

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn cancelled_scan_releases_reconciliation_state() {
        let workspace = temp_gallery("cancelled-scan");
        let root = workspace.join("pictures");
        fs::create_dir_all(&root).unwrap();
        write_png(&root.join("kept.png"), [12, 34, 56]);
        let db = Database::open(workspace.join("gallery.sqlite")).unwrap();
        let cancelled = AtomicBool::new(true);

        assert!(scan_with_cancel(&root, &db, 1, ScanMode::Bootstrap, &cancelled).is_err());
        cancelled.store(false, Ordering::Release);
        assert_eq!(
            scan_with_cancel(&root, &db, 1, ScanMode::Bootstrap, &cancelled)
                .unwrap()
                .indexed,
            1
        );

        fs::remove_dir_all(workspace).unwrap();
    }
}
