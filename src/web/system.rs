//! Admin views combine background kernel samples with current application details.
//! Directory walks are cached and never block CPU or network sampling.
mod storage;

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use serde::Serialize;

use super::AppState;
use crate::monitor::{
    CpuInfo, History, MemoryInfo, Monitor, NATIVE_HISTORY_MS, NativeNetworkSample, NetworkInfo,
    field, field_number, read,
};
use crate::{gallery::GalleryIndex, support::mutex_lock, thumbs::ThumbnailManager};
use storage::{DirectoryInfo, DirectoryUsage};

#[derive(Clone)]
struct SystemState {
    app: AppState,
    sampler: Arc<Mutex<Sampler>>,
    monitor: Arc<Monitor>,
}

pub(super) fn router(app: AppState) -> Router {
    let monitor = Arc::new(Monitor::start(app.thumbnails.cache_directory()));
    Router::new()
        .route("/api/system", get(information))
        .with_state(SystemState {
            app,
            monitor,
            sampler: Arc::new(Mutex::new(Sampler::new())),
        })
}

async fn information(State(state): State<SystemState>) -> Result<impl IntoResponse, StatusCode> {
    let history = state
        .monitor
        .snapshot()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let index = Arc::clone(&*state.app.index.read().await);
    let native_history = state.monitor.native_history();
    let body = tokio::task::spawn_blocking(move || {
        mutex_lock(&state.sampler).sample(&index, &state.app.thumbnails, &history, &native_history)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo<'a> {
    sampled_at_ms: u64,
    host: &'a HostInfo,
    cpu: &'a CpuInfo,
    memory: &'a Option<MemoryInfo>,
    process: ProcessInfo,
    storage: [DirectoryInfo; 2],
    network: &'a Option<Vec<NetworkInfo>>,
    network_history: Vec<NetworkSample<'a>>,
    native_network_history: Vec<&'a NativeNetworkSample>,
    gallery: GalleryInfo,
    jobs: crate::thumbs::ThumbnailStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    hostname: Option<String>,
    operating_system: Option<String>,
    kernel: Option<String>,
    architecture: &'static str,
    cpu_model: Option<String>,
    logical_cpus: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessInfo {
    version: &'static str,
    pid: u32,
    uptime_seconds: u64,
    resident_memory: Option<u64>,
    threads: Option<u64>,
}

#[derive(Serialize)]
struct GalleryInfo {
    total: usize,
    albums: usize,
    initializing: bool,
}

struct Sampler {
    started: Instant,
    host: Option<HostInfo>,
    cached: Option<(Instant, u64, Bytes)>,
    gallery_usage: DirectoryUsage,
    data_usage: DirectoryUsage,
}

impl Sampler {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            host: None,
            cached: None,
            gallery_usage: DirectoryUsage::default(),
            data_usage: DirectoryUsage::default(),
        }
    }

    fn sample(
        &mut self,
        index: &GalleryIndex,
        thumbnails: &ThumbnailManager,
        history: &History,
        native_history: &[NativeNetworkSample],
    ) -> serde_json::Result<Bytes> {
        let current = history.latest();
        if let Some((at, sampled, cached)) = &self.cached
            && at.elapsed() < Duration::from_secs(1)
            && *sampled == current.at
        {
            return Ok(cached.clone());
        }
        let process = read("/proc/self/status").unwrap_or_default();
        let info = SystemInfo {
            sampled_at_ms: current.at,
            host: self.host.get_or_insert_with(host_info),
            cpu: &current.cpu,
            memory: &current.memory,
            process: ProcessInfo {
                version: env!("CARGO_PKG_VERSION"),
                pid: std::process::id(),
                uptime_seconds: self.started.elapsed().as_secs(),
                resident_memory: field_number(&process, "VmRSS")
                    .and_then(|value| value.checked_mul(1024)),
                threads: field_number(&process, "Threads"),
            },
            storage: [
                self.gallery_usage.snapshot("图库大小", &index.root),
                self.data_usage
                    .snapshot("数据大小", thumbnails.cache_directory()),
            ],
            network: &current.network,
            network_history: history
                .samples
                .iter()
                .map(|sample| NetworkSample {
                    at: sample.at,
                    interfaces: sample.network.as_ref().map(|interfaces| {
                        interfaces
                            .iter()
                            .map(|interface| NetworkRate {
                                name: &interface.name,
                                receive_bytes_per_second: interface.receive_bytes_per_second,
                                send_bytes_per_second: interface.send_bytes_per_second,
                            })
                            .collect()
                    }),
                })
                .collect(),
            native_network_history: native_history
                .iter()
                .filter(|sample| {
                    sample.at <= current.at && current.at - sample.at <= NATIVE_HISTORY_MS
                })
                .collect(),
            gallery: GalleryInfo {
                total: index.images.len(),
                albums: index.albums.len(),
                initializing: index.initializing,
            },
            jobs: if index.initializing {
                crate::thumbs::ThumbnailStatus::pending()
            } else {
                thumbnails.status()
            },
        };
        let bytes = Bytes::from(serde_json::to_vec(&info)?);
        self.cached = Some((Instant::now(), current.at, bytes.clone()));
        Ok(bytes)
    }
}

#[derive(Serialize)]
struct NetworkSample<'a> {
    at: u64,
    interfaces: Option<Vec<NetworkRate<'a>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkRate<'a> {
    name: &'a str,
    receive_bytes_per_second: Option<f64>,
    send_bytes_per_second: Option<f64>,
}

fn host_info() -> HostInfo {
    let cpu = read("/proc/cpuinfo").unwrap_or_default();
    HostInfo {
        hostname: read("/proc/sys/kernel/hostname"),
        operating_system: read("/etc/os-release").and_then(|value| {
            value.lines().find_map(|line| {
                line.strip_prefix("PRETTY_NAME=")
                    .map(|name| name.trim_matches(['"', '\'']).to_owned())
            })
        }),
        kernel: read("/proc/sys/kernel/osrelease"),
        architecture: std::env::consts::ARCH,
        cpu_model: ["model name", "Hardware", "Processor"]
            .into_iter()
            .find_map(|key| field(&cpu, key).map(str::to_owned)),
        logical_cpus: read("/proc/stat")
            .map(|value| {
                value
                    .lines()
                    .filter(|line| {
                        line.strip_prefix("cpu").is_some_and(|suffix| {
                            suffix.starts_with(|ch: char| ch.is_ascii_digit())
                        })
                    })
                    .count()
            })
            .filter(|count| *count > 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn application_details_do_not_wait_for_directory_walks() {
        let temp = tempfile::tempdir().unwrap();
        let manager = ThumbnailManager::new(temp.path().join("cache")).unwrap();
        let index = GalleryIndex::pending(temp.path().join("missing"));
        let monitor = Monitor::start(manager.cache_directory());
        let history = monitor.snapshot().await.unwrap();
        let mut sampler = Sampler::new();
        let first = sampler.sample(&index, &manager, &history, &[]).unwrap();
        assert_eq!(
            sampler.sample(&index, &manager, &history, &[]).unwrap(),
            first
        );
        let info: serde_json::Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(info["gallery"]["initializing"], true);
        assert_eq!(info["storage"][0]["sizeBytes"], serde_json::Value::Null);
        assert_eq!(info["storage"][0]["state"], "scanning");
        assert_eq!(info["storage"][1]["name"], "数据大小");
        assert_eq!(info["networkHistory"][0]["at"], info["sampledAtMs"]);
        assert_eq!(info["process"]["pid"], std::process::id());
    }
}
