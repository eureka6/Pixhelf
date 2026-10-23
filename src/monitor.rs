//! Background sampling within the gallery process, plus existing system archives.
mod history;
mod metrics;
mod native;

use std::{path::Path, sync::Arc, time::Duration};

use tokio::{sync::watch, task::JoinHandle};

pub(crate) use history::History;
use history::Journal;
pub(crate) use metrics::{CpuInfo, MemoryInfo, NetworkInfo, field, field_number, read};
use metrics::{MAX_GAP, Sampler, timestamp};
use native::NativeHistory;
pub(crate) use native::{NATIVE_HISTORY_MS, NativeNetworkSample};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

pub(crate) struct Monitor {
    receiver: watch::Receiver<Option<Arc<History>>>,
    task: JoinHandle<()>,
    native: NativeHistory,
}

impl Monitor {
    pub(crate) fn start(cache: &Path) -> Self {
        let (sender, receiver) = watch::channel(None);
        let cache = cache.to_owned();
        let task = tokio::spawn(async move {
            let mut recorder = Recorder::new(&cache);
            let mut interval = tokio::time::interval(SAMPLE_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let result = tokio::task::spawn_blocking(move || {
                    let snapshot = Arc::new(recorder.tick());
                    (recorder, snapshot)
                })
                .await;
                let Ok((next, snapshot)) = result else { break };
                recorder = next;
                if sender.send(Some(snapshot)).is_err() {
                    break;
                }
            }
        });
        Self {
            receiver,
            task,
            native: NativeHistory::start(),
        }
    }

    pub(crate) fn native_history(&self) -> Arc<Vec<NativeNetworkSample>> {
        self.native.snapshot()
    }

    pub(crate) async fn snapshot(&self) -> std::io::Result<Arc<History>> {
        let mut receiver = self.receiver.clone();
        loop {
            receiver
                .has_changed()
                .map_err(|_| std::io::ErrorKind::BrokenPipe)?;
            if let Some(snapshot) = receiver.borrow_and_update().as_ref() {
                if timestamp().abs_diff(snapshot.latest().at) > MAX_GAP.as_millis() as u64 {
                    return Err(std::io::ErrorKind::TimedOut.into());
                }
                return Ok(Arc::clone(snapshot));
            }
            tokio::time::timeout(MAX_GAP, receiver.changed())
                .await
                .map_err(|_| std::io::ErrorKind::TimedOut)?
                .map_err(|_| std::io::ErrorKind::BrokenPipe)?;
        }
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Recorder {
    journal: Journal,
    sampler: Sampler,
    history: History,
    warned: bool,
}

impl Recorder {
    fn new(cache: &Path) -> Self {
        Self {
            journal: Journal::new(cache),
            sampler: Sampler::default(),
            history: History::default(),
            warned: false,
        }
    }

    fn tick(&mut self) -> History {
        let now = timestamp();
        let owns_lock = match self.journal.acquire() {
            Ok(acquired) => {
                if acquired {
                    // A new collector never joins rates across a restart or takeover.
                    self.sampler = Sampler::default();
                    if let Ok(history) = self.journal.read(now) {
                        self.history = history;
                    }
                }
                self.journal.owns_lock()
            }
            Err(error) => {
                self.warn(error);
                false
            }
        };
        if !owns_lock {
            // Concurrent gallery instances can share a cache without duplicate writes.
            if let Ok(history) = self.journal.read(now)
                && history
                    .samples
                    .back()
                    .is_some_and(|last| now.saturating_sub(last.at) <= MAX_GAP.as_millis() as u64)
            {
                self.history = history;
                return self.history.clone();
            }
        }
        self.history.push(self.sampler.sample());
        if owns_lock {
            match self.journal.write(&self.history) {
                Ok(()) => self.warned = false,
                Err(error) => self.warn(error),
            }
        }
        self.history.clone()
    }

    fn warn(&mut self, error: std::io::Error) {
        if !self.warned {
            tracing::warn!(%error, "无法保存系统监控记录，继续使用内存采样");
            self.warned = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn records_without_requests_and_restores_history_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let monitor = Monitor::start(temp.path());
        // No HTTP request or snapshot read drives the collector.
        tokio::time::sleep(Duration::from_millis(2300)).await;
        let history = monitor.snapshot().await.unwrap();
        assert!(history.samples.len() >= 2);
        let first_at = history.samples.front().unwrap().at;
        assert!(history.latest().cpu.usage_percent.is_some());
        let follower = Monitor::start(temp.path());
        let shared = follower.snapshot().await.unwrap();
        assert_eq!(shared.latest().at, history.latest().at);
        drop(follower);
        drop(monitor);
        tokio::task::yield_now().await;
        let reopened = Monitor::start(temp.path());
        let restored = reopened.snapshot().await.unwrap();
        assert_eq!(restored.samples.front().unwrap().at, first_at);
        assert!(restored.samples.len() >= 2);
    }

    #[test]
    fn recorder_takes_over_when_writer_stops() {
        let temp = tempfile::tempdir().unwrap();
        let mut writer = Recorder::new(temp.path());
        let first = writer.tick();
        let mut follower = Recorder::new(temp.path());
        assert_eq!(follower.tick().latest().at, first.latest().at);
        assert!(!follower.journal.owns_lock());
        drop(writer);
        // Other tests may be between fork and exec, briefly inheriting the lock
        // descriptor before CLOEXEC closes it. The normal sampling loop retries.
        let started = std::time::Instant::now();
        while !follower.journal.owns_lock() && started.elapsed() < Duration::from_secs(1) {
            follower.tick();
            if !follower.journal.owns_lock() {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        assert!(follower.journal.owns_lock());
        assert!(follower.history.latest().cpu.usage_percent.is_none());
    }
}
