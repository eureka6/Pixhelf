//! Kernel counters are system-wide; rates use elapsed monotonic time.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(super) const MAX_GAP: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sample {
    pub at: u64,
    pub cpu: CpuInfo,
    pub memory: Option<MemoryInfo>,
    pub network: Option<Vec<NetworkInfo>>,
}

#[derive(Default)]
pub(super) struct Sampler {
    previous: Option<(Instant, Option<CpuCounters>, Option<Vec<NetworkCounters>>)>,
}

impl Sampler {
    pub(super) fn sample(&mut self) -> Sample {
        let now = Instant::now();
        let cpu = read("/proc/stat").and_then(|value| cpu_counters(&value));
        let network = read("/proc/net/dev").map(|value| network_counters(&value));
        let previous = self
            .previous
            .as_ref()
            .filter(|(at, _, _)| now.duration_since(*at) <= MAX_GAP);
        let sample = Sample {
            at: timestamp(),
            cpu: CpuInfo {
                usage_percent: cpu
                    .as_ref()
                    .zip(previous.and_then(|(_, cpu, _)| cpu.as_ref()))
                    .and_then(|(current, previous)| cpu_usage(previous, current)),
                load_average: read("/proc/loadavg").and_then(|value| load_average(&value)),
                uptime_seconds: read("/proc/uptime")
                    .and_then(|value| value.split_whitespace().next()?.parse::<f64>().ok())
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .map(|value| value as u64),
            },
            memory: read("/proc/meminfo").and_then(|value| memory_info(&value)),
            network: network.as_ref().map(|interfaces| {
                interfaces
                    .iter()
                    .map(|interface| {
                        let old = previous.and_then(|(at, _, interfaces)| {
                            interfaces
                                .as_ref()?
                                .iter()
                                .find(|old| old.name == interface.name)
                                .map(|old| (*at, old))
                        });
                        NetworkInfo {
                            name: interface.name.clone(),
                            received_bytes: interface.received,
                            sent_bytes: interface.sent,
                            receive_bytes_per_second: old.and_then(|(at, old)| {
                                byte_rate(old.received, interface.received, now.duration_since(at))
                            }),
                            send_bytes_per_second: old.and_then(|(at, old)| {
                                byte_rate(old.sent, interface.sent, now.duration_since(at))
                            }),
                        }
                    })
                    .collect()
            }),
        };
        self.previous = Some((now, cpu, network));
        sample
    }
}

pub(super) fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CpuInfo {
    pub usage_percent: Option<f64>,
    pub load_average: Option<[f64; 3]>,
    pub uptime_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryInfo {
    pub total: u64,
    pub available: u64,
    pub used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkInfo {
    pub name: String,
    pub received_bytes: u64,
    pub sent_bytes: u64,
    pub receive_bytes_per_second: Option<f64>,
    pub send_bytes_per_second: Option<f64>,
}

pub(crate) fn read(path: &str) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) fn field<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == name).then(|| value.trim())
    })
}

pub(crate) fn field_number(text: &str, name: &str) -> Option<u64> {
    field(text, name)?.split_whitespace().next()?.parse().ok()
}

#[derive(Debug)]
struct CpuCounters {
    total: u64,
    idle: u64,
}

fn cpu_counters(text: &str) -> Option<CpuCounters> {
    let line = text.lines().find(|line| line.starts_with("cpu "))?;
    // Guest time is already included in user/nice; count only the first 8 fields.
    let values = line
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if values.len() < 4 {
        return None;
    }
    Some(CpuCounters {
        total: values
            .iter()
            .try_fold(0_u64, |total, value| total.checked_add(*value))?,
        idle: values[3].checked_add(values.get(4).copied().unwrap_or(0))?,
    })
}

fn cpu_usage(previous: &CpuCounters, current: &CpuCounters) -> Option<f64> {
    let total = current.total.checked_sub(previous.total)?;
    let idle = current.idle.checked_sub(previous.idle)?;
    (total > 0 && idle <= total).then(|| (total - idle) as f64 * 100.0 / total as f64)
}

fn memory_info(text: &str) -> Option<MemoryInfo> {
    let bytes = |key| field_number(text, key)?.checked_mul(1024);
    let total = bytes("MemTotal")?;
    if total == 0 {
        return None;
    }
    let available = bytes("MemAvailable")
        .or_else(|| {
            Some(
                bytes("MemFree")?
                    .saturating_add(bytes("Buffers").unwrap_or(0))
                    .saturating_add(bytes("Cached").unwrap_or(0))
                    .saturating_add(bytes("SReclaimable").unwrap_or(0))
                    .saturating_sub(bytes("Shmem").unwrap_or(0)),
            )
        })?
        .min(total);
    let swap_total = bytes("SwapTotal")?;
    Some(MemoryInfo {
        total,
        available,
        used: total - available,
        swap_total,
        swap_used: swap_total.saturating_sub(bytes("SwapFree")?),
    })
}

fn load_average(text: &str) -> Option<[f64; 3]> {
    let mut fields = text.split_whitespace();
    let values = [
        fields.next()?.parse::<f64>().ok()?,
        fields.next()?.parse::<f64>().ok()?,
        fields.next()?.parse::<f64>().ok()?,
    ];
    values
        .iter()
        .all(|value| value.is_finite() && *value >= 0.0)
        .then_some(values)
}

#[derive(Debug)]
struct NetworkCounters {
    name: String,
    received: u64,
    sent: u64,
}

fn network_counters(text: &str) -> Vec<NetworkCounters> {
    text.lines()
        .filter_map(|line| {
            let (name, values) = line.split_once(':')?;
            if name.trim() == "lo" {
                return None;
            }
            let mut values = values.split_whitespace();
            let received = values.next()?.parse().ok()?;
            let sent = values.nth(7)?.parse().ok()?;
            Some(NetworkCounters {
                name: name.trim().to_owned(),
                received,
                sent,
            })
        })
        .collect()
}

fn byte_rate(previous: u64, current: u64, elapsed: Duration) -> Option<f64> {
    if elapsed.is_zero() {
        return None;
    }
    Some(current.checked_sub(previous)? as f64 / elapsed.as_secs_f64())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_excludes_guest_ticks_and_handles_reset_counters() {
        let old = cpu_counters("cpu 100 10 20 200 50 5 5 10 40 10\ncpu0 1 2 3 4").unwrap();
        let new = cpu_counters("cpu 140 10 30 230 60 5 5 10 60 10").unwrap();
        assert_eq!(old.total, 400);
        assert_eq!(old.idle, 250);
        assert!((cpu_usage(&old, &new).unwrap() - 50.0 / 90.0 * 100.0).abs() < 0.001);
        assert_eq!(cpu_usage(&new, &old), None);
        assert_eq!(cpu_usage(&old, &old), None);
        assert!(cpu_counters("cpu 1 2 bad 4").is_none());
    }

    #[test]
    fn memory_uses_available_instead_of_only_free() {
        let info = memory_info("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB").unwrap();
        assert_eq!(
            (info.total, info.used, info.available, info.swap_used),
            (1024000, 409600, 614400, 51200)
        );
        let legacy = memory_info("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 20 kB\nCached: 200 kB\nSReclaimable: 50 kB\nShmem: 10 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB").unwrap();
        assert_eq!(legacy.available, 360 * 1024);
        assert!(memory_info("MemFree: 100 kB").is_none());
    }

    #[test]
    fn network_rates_exclude_loopback_and_handle_counter_resets() {
        let interfaces = network_counters(
            "Inter-| Receive | Transmit\n lo: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\n eth0: 1024 1 0 0 0 0 0 0 2048 2 0 0 0 0 0 0\n invalid: no data",
        );
        assert_eq!(interfaces.len(), 1);
        assert_eq!(
            (
                interfaces[0].name.as_str(),
                interfaces[0].received,
                interfaces[0].sent
            ),
            ("eth0", 1024, 2048)
        );
        assert_eq!(byte_rate(1024, 2048, Duration::from_secs(2)), Some(512.0));
        assert_eq!(byte_rate(2048, 0, Duration::from_secs(2)), None);
        assert_eq!(byte_rate(0, 1, Duration::ZERO), None);
    }
}
