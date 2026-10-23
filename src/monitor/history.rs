use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

use rustix::fs::{FlockOperation, flock};
use serde::{Deserialize, Serialize};

use super::metrics::{Sample, read};

const HISTORY_MS: u64 = 5 * 60 * 1000;
const MAX_SAMPLES: usize = 151;
const MAX_JOURNAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct History {
    pub samples: VecDeque<Sample>,
}

impl History {
    pub(crate) fn latest(&self) -> &Sample {
        self.samples
            .back()
            .expect("published history has a current sample")
    }

    pub(super) fn push(&mut self, sample: Sample) {
        if self.samples.back().is_some_and(|last| last.at > sample.at) {
            self.samples.clear();
        }
        if self.samples.back().is_some_and(|last| last.at == sample.at) {
            self.samples.pop_back();
        }
        let cutoff = sample.at.saturating_sub(HISTORY_MS);
        self.samples.push_back(sample);
        while self.samples.len() > MAX_SAMPLES
            || self.samples.front().is_some_and(|first| first.at < cutoff)
        {
            self.samples.pop_front();
        }
    }
}

#[derive(Deserialize, Serialize)]
struct Header {
    version: u32,
    scope: String,
}

pub(super) struct Journal {
    directory: PathBuf,
    scope: String,
    lock: Option<File>,
    appended: usize,
}

impl Journal {
    pub(super) fn new(cache: &Path) -> Self {
        // Never combine counters from different boots or network namespaces.
        let boot = read("/proc/sys/kernel/random/boot_id").unwrap_or_default();
        let network = fs::read_link("/proc/self/ns/net").unwrap_or_default();
        Self {
            directory: cache.join("system"),
            scope: format!("{boot}:{}", network.display()),
            lock: None,
            appended: MAX_SAMPLES,
        }
    }

    pub(super) fn owns_lock(&self) -> bool {
        self.lock.is_some()
    }

    pub(super) fn acquire(&mut self) -> io::Result<bool> {
        if self.owns_lock() {
            return Ok(false);
        }
        fs::create_dir_all(&self.directory)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.directory.join("collector.lock"))?;
        match flock(&file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => {
                self.lock = Some(file);
                Ok(true)
            }
            Err(rustix::io::Errno::WOULDBLOCK) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn read(&self, now: u64) -> io::Result<History> {
        let file = File::open(self.directory.join("history.jsonl"))?;
        if file.metadata()?.len() > MAX_JOURNAL_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let header: Header = serde_json::from_str(&line)?;
        if header.version != 1 || header.scope != self.scope {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut history = History::default();
        loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            // A concurrently appended or interrupted final line is not committed yet.
            if !line.ends_with('\n') {
                break;
            }
            if let Ok(sample) = serde_json::from_str::<Sample>(&line)
                && sample.at <= now
                && now - sample.at <= HISTORY_MS
            {
                history.push(sample);
            }
        }
        Ok(history)
    }

    pub(super) fn write(&mut self, history: &History) -> io::Result<()> {
        debug_assert!(self.owns_lock());
        let result = self.write_inner(history);
        if result.is_err() {
            self.appended = MAX_SAMPLES;
        }
        result
    }

    fn write_inner(&mut self, history: &History) -> io::Result<()> {
        let path = self.directory.join("history.jsonl");
        if self.appended >= MAX_SAMPLES {
            // Compact on takeover and every five minutes. The usual tick appends
            // one record rather than rewriting all five minutes every two seconds.
            let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
            serde_json::to_writer(
                &mut temporary,
                &Header {
                    version: 1,
                    scope: self.scope.clone(),
                },
            )?;
            temporary.write_all(b"\n")?;
            for sample in &history.samples {
                serde_json::to_writer(&mut temporary, sample)?;
                temporary.write_all(b"\n")?;
            }
            temporary.flush()?;
            temporary.persist(path).map_err(|error| error.error)?;
            self.appended = 0;
        } else {
            let mut bytes = serde_json::to_vec(history.latest())?;
            bytes.push(b'\n');
            OpenOptions::new()
                .append(true)
                .open(path)?
                .write_all(&bytes)?;
            self.appended += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::metrics::Sampler;

    #[test]
    fn history_expires_bounds_and_resets_on_clock_reversal() {
        let mut history = History::default();
        let mut sample = Sampler::default().sample();
        for at in 0..500 {
            sample.at = at * 2000;
            history.push(sample.clone());
        }
        assert_eq!(history.samples.len(), MAX_SAMPLES);
        assert_eq!(
            history.latest().at - history.samples.front().unwrap().at,
            HISTORY_MS
        );
        sample.at += HISTORY_MS + 1;
        history.push(sample.clone());
        assert_eq!(history.samples.len(), 1);
        sample.at = 100;
        history.push(sample);
        assert_eq!(history.samples.len(), 1);
    }

    #[test]
    fn journal_handles_partial_writes_reboot_and_restart() {
        let temp = tempfile::tempdir().unwrap();
        let mut journal = Journal::new(temp.path());
        assert!(journal.acquire().unwrap());
        let mut history = History::default();
        let mut sample = Sampler::default().sample();
        sample.at = HISTORY_MS * 2;
        history.push(sample.clone());
        journal.write(&history).unwrap();
        sample.at += 2000;
        history.push(sample.clone());
        journal.write(&history).unwrap();
        let path = temp.path().join("system/history.jsonl");
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"at\":")
            .unwrap();
        assert_eq!(journal.read(sample.at).unwrap().samples.len(), 2);
        assert_eq!(
            journal
                .read(sample.at + HISTORY_MS + 1)
                .unwrap()
                .samples
                .len(),
            0
        );
        drop(journal);
        let mut reopened = Journal::new(temp.path());
        assert!(reopened.acquire().unwrap());
        let restored = reopened.read(sample.at).unwrap();
        reopened.write(&restored).unwrap();
        assert!(fs::read_to_string(path).unwrap().ends_with('\n'));
        reopened.scope = "different-boot-or-network".into();
        assert!(reopened.read(sample.at).is_err());
    }
}
