//! Read existing sysstat archives. Never install or start a system collector.
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime},
};

use serde::Serialize;
use tokio::{io::AsyncReadExt, process::Command, sync::watch, task::JoinHandle};

use super::metrics::{read, timestamp};

pub(crate) const NATIVE_HISTORY_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_SAMPLES: usize = 1441;
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeNetworkSample {
    pub at: u64,
    pub interval_seconds: f64,
    pub interfaces: Option<Vec<NativeNetworkRate>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeNetworkRate {
    pub name: String,
    pub receive_bytes_per_second: Option<f64>,
    pub send_bytes_per_second: Option<f64>,
}

pub(super) struct NativeHistory {
    receiver: watch::Receiver<Arc<Vec<NativeNetworkSample>>>,
    task: JoinHandle<()>,
}

impl NativeHistory {
    pub(super) fn start() -> Self {
        let (sender, receiver) = watch::channel(Arc::new(Vec::new()));
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let files = tokio::task::spawn_blocking(|| {
                    discover(&[Path::new("/var/log/sysstat"), Path::new("/var/log/sa")])
                })
                .await
                .unwrap_or_default();
                let hostname = read("/proc/sys/kernel/hostname").unwrap_or_default();
                let mut samples = BTreeMap::new();
                for file in files {
                    let mut command = sadf_command(&file);
                    let Ok(output) = read_output(&mut command, MAX_OUTPUT, READ_TIMEOUT).await
                    else {
                        continue;
                    };
                    let Ok(text) = std::str::from_utf8(&output) else {
                        continue;
                    };
                    for sample in parse(text, &hostname, timestamp()) {
                        samples.insert(sample.at, sample);
                    }
                    trim(&mut samples);
                }
                if sender
                    .send(Arc::new(samples.into_values().collect()))
                    .is_err()
                {
                    break;
                }
            }
        });
        Self { receiver, task }
    }

    pub(super) fn snapshot(&self) -> Arc<Vec<NativeNetworkSample>> {
        Arc::clone(&self.receiver.borrow())
    }
}

impl Drop for NativeHistory {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn sadf_command(file: &Path) -> Command {
    let mut command = Command::new("sadf");
    // Epoch timestamps avoid local time, DST and locale-dependent parsing.
    command
        .args(["-d", "-U", "-s", "00:00:00", "-e", "23:59:59"])
        .arg(file)
        .args(["--", "-n", "DEV"])
        .env("LC_ALL", "C")
        .env("S_COLORS", "never");
    command
}

async fn read_output(
    command: &mut Command,
    limit: usize,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let output = child.stdout.take().expect("piped stdout");
    let result = tokio::time::timeout(timeout, async {
        let mut bytes = Vec::new();
        output
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > limit {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if !child.wait().await?.success() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(bytes)
    })
    .await
    .unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into()));
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

fn discover(directories: &[&Path]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for directory in directories {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(suffix) = name.to_str().and_then(|name| name.strip_prefix("sa")) else {
                continue;
            };
            if ![2, 8].contains(&suffix.len()) || !suffix.bytes().all(|byte| byte.is_ascii_digit())
            {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Ok(modified) = metadata.modified() else {
                continue;
            };
            if metadata.is_file()
                && metadata.len() > 0
                && SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default()
                    <= Duration::from_secs(48 * 3600)
            {
                files.push((modified, entry.path()));
            }
        }
    }
    files.sort_by(|a, b| b.cmp(a));
    files.truncate(4);
    files.into_iter().map(|(_, path)| path).collect()
}

fn trim(samples: &mut BTreeMap<u64, NativeNetworkSample>) {
    while samples.len() > MAX_SAMPLES {
        samples.pop_first();
    }
}

fn parse(text: &str, hostname: &str, now: u64) -> Vec<NativeNetworkSample> {
    let mut columns = None;
    let mut samples = BTreeMap::<u64, NativeNetworkSample>::new();
    if hostname.is_empty() {
        return Vec::new();
    }
    for line in text.lines() {
        if let Some(header) = line.strip_prefix('#') {
            let fields: Vec<_> = header.split(';').map(str::trim).collect();
            columns = fields
                .iter()
                .position(|field| *field == "IFACE")
                .zip(fields.iter().position(|field| *field == "rxkB/s"))
                .zip(fields.iter().position(|field| *field == "txkB/s"))
                .map(|((name, receive), send)| (name, receive, send));
            continue;
        }
        let fields: Vec<_> = line.split(';').map(str::trim).collect();
        if fields.len() < 4 || fields[0] != hostname {
            continue;
        }
        let Some(at) = fields[2]
            .parse::<u64>()
            .ok()
            .and_then(|seconds| seconds.checked_mul(1000))
        else {
            continue;
        };
        if at > now || now - at > NATIVE_HISTORY_MS {
            continue;
        }
        if fields[1] == "-1" && fields[3].starts_with("LINUX-RESTART") {
            samples.insert(
                at,
                NativeNetworkSample {
                    at,
                    interval_seconds: 0.0,
                    interfaces: None,
                },
            );
            trim(&mut samples);
            continue;
        }
        let Some((name, receive, send)) = columns else {
            continue;
        };
        let Some(name) = fields
            .get(name)
            .filter(|name| !name.is_empty() && **name != "lo")
        else {
            continue;
        };
        let Some(interval) = fields[1]
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value > 0.0 && *value <= 86400.0)
        else {
            continue;
        };
        let rate = |index: usize| {
            fields
                .get(index)?
                .parse::<f64>()
                .ok()
                .map(|value| value * 1024.0)
                .filter(|value| value.is_finite() && *value >= 0.0)
        };
        let (Some(receive), Some(send)) = (rate(receive), rate(send)) else {
            continue;
        };
        let sample = samples.entry(at).or_insert_with(|| NativeNetworkSample {
            at,
            interval_seconds: interval,
            interfaces: Some(Vec::new()),
        });
        if let Some(interfaces) = &mut sample.interfaces
            && !interfaces.iter().any(|interface| interface.name == *name)
        {
            interfaces.push(NativeNetworkRate {
                name: (*name).to_owned(),
                receive_bytes_per_second: Some(receive),
                send_bytes_per_second: Some(send),
            });
        }
        trim(&mut samples);
    }
    samples.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "# hostname;interval;timestamp;IFACE;rxpck/s;txpck/s;rxkB/s;txkB/s;rxcmp/s;txcmp/s;rxmcst/s;%ifutil\n";

    #[test]
    fn reads_native_rates_intervals_and_reboot_gaps() {
        let text = format!(
            "{HEADER}server;600;1700000000;eth0;1;2;4.5;1.25;0;0;0;0\nserver;600;1700000000;ens6;1;2;0;0;0;0;0;0\nserver;-1;1700000060;LINUX-RESTART\nserver;60;1700000120;eth0;1;2;2;3;0;0;0;0\n"
        );
        let samples = parse(&text, "server", 1700000120000);
        assert_eq!(samples.len(), 3);
        let interfaces = samples[0].interfaces.as_ref().unwrap();
        assert_eq!(interfaces.len(), 2);
        assert_eq!(interfaces[0].receive_bytes_per_second, Some(4608.0));
        assert_eq!(interfaces[0].send_bytes_per_second, Some(1280.0));
        assert_eq!(samples[0].interval_seconds, 600.0);
        assert!(samples[1].interfaces.is_none());
        assert_eq!(samples[2].interval_seconds, 60.0);
    }

    #[test]
    fn rejects_wrong_host_expired_future_and_invalid_records() {
        let now = 1700000000000;
        let rows = [
            "other;600;1700000000;eth0;1;2;4;1;0;0;0;0",
            "server;600;1600000000;eth0;1;2;4;1;0;0;0;0",
            "server;600;1800000000;eth0;1;2;4;1;0;0;0;0",
            "server;600;1700000000;lo;1;2;4;1;0;0;0;0",
            "server;0;1700000000;eth0;1;2;4;1;0;0;0;0",
            "server;600;1700000000;eth0;1;2;-1;1;0;0;0;0",
            "server;600;1700000000;eth0;1;2;NaN;1;0;0;0;0",
            "server;600;1700000000;eth0;1;2;inf;1;0;0;0;0",
        ];
        assert!(parse(&format!("{HEADER}{}", rows.join("\n")), "server", now).is_empty());
        assert!(parse("not a sysstat archive", "server", now).is_empty());
    }

    #[test]
    fn finds_only_daily_archives_and_limits_work() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            "sa01",
            "sa02",
            "sa03",
            "sa04",
            "sa20261017",
            "sar17",
            "sa17.txt",
            "sa",
            "config",
        ] {
            fs::write(temp.path().join(name), "data").unwrap();
        }
        let files = discover(&[temp.path(), &temp.path().join("missing")]);
        assert_eq!(files.len(), 4);
        assert!(files.iter().all(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("sa")
        }));
    }

    #[tokio::test]
    async fn unavailable_slow_or_oversized_readers_do_not_block_sampling() {
        assert!(
            read_output(&mut Command::new("/missing/pixhelf-sadf"), 64, READ_TIMEOUT)
                .await
                .is_err()
        );
        let mut slow = Command::new("sleep");
        slow.arg("2");
        assert_eq!(
            read_output(&mut slow, 64, Duration::from_millis(30))
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        let mut large = Command::new("printf");
        large.arg("more than four bytes");
        assert_eq!(
            read_output(&mut large, 4, READ_TIMEOUT)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}
