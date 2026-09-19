use std::{
    collections::VecDeque,
    io::Read,
    sync::{Arc, Mutex, OnceLock},
};

use anyhow::{Context, Result, ensure};
use axum::body::Bytes;
use tokio::sync::Semaphore;

use crate::support::mutex_lock;

const CACHE_BYTES: usize = 16 * 1024 * 1024;

pub(crate) struct Asset {
    name: &'static str,
    source: AssetSource,
}

#[derive(Clone, Copy)]
enum AssetSource {
    Plain(&'static [u8]),
    Packed {
        group: usize,
        offset: usize,
        length: usize,
    },
}

struct AssetGroup {
    compressed: &'static [u8],
    length: usize,
}

include!(concat!(env!("OUT_DIR"), "/frontend_assets.rs"));

pub(crate) fn find(name: &str) -> Option<&'static Asset> {
    FRONTEND_ASSETS.iter().find(|asset| asset.name == name)
}

impl Asset {
    pub(crate) async fn read(&self) -> Result<Bytes> {
        match self.source {
            AssetSource::Plain(content) => Ok(Bytes::from_static(content)),
            AssetSource::Packed {
                group,
                offset,
                length,
            } => {
                static STORE: OnceLock<Arc<AssetStore>> = OnceLock::new();
                let store = STORE.get_or_init(|| Arc::new(AssetStore::new(CACHE_BYTES)));
                let content = store.load(group).await?;
                let end = offset.checked_add(length).context("invalid asset range")?;
                ensure!(end <= content.len(), "asset exceeds its decoded group");
                Ok(content.slice(offset..end))
            }
        }
    }
}

struct AssetStore {
    cache: Mutex<DecodedGroups>,
    decoding: Arc<Semaphore>,
}

impl AssetStore {
    fn new(limit: usize) -> Self {
        Self {
            cache: Mutex::new(DecodedGroups::new(limit)),
            decoding: Arc::new(Semaphore::new(1)),
        }
    }

    async fn load(self: &Arc<Self>, index: usize) -> Result<Bytes> {
        if let Some(content) = mutex_lock(&self.cache).get(index) {
            return Ok(content);
        }
        // Only one cold group allocates/decodes at a time; waiting requests
        // recheck the cache so concurrent requests share the same decoded bytes.
        let permit = Arc::clone(&self.decoding).acquire_owned().await?;
        if let Some(content) = mutex_lock(&self.cache).get(index) {
            return Ok(content);
        }
        let store = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            // Keep the permit until this task finishes even if its HTTP request
            // is cancelled. Decoding never blocks the async request executor.
            let _permit = permit;
            let group = ASSET_GROUPS.get(index).context("unknown asset group")?;
            let content = decode(group)?;
            mutex_lock(&store.cache).insert(index, content.clone());
            Ok(content)
        })
        .await
        .context("asset decoding task failed")?
    }
}

fn decode(group: &AssetGroup) -> Result<Bytes> {
    // Exact allocation keeps the cache's byte accounting equal to its storage.
    let mut content = vec![0; group.length];
    let mut decoder = brotli::Decompressor::new(group.compressed, 8192);
    decoder
        .read_exact(&mut content)
        .context("cannot decompress embedded asset group")?;
    ensure!(
        decoder.read(&mut [0])? == 0,
        "decoded asset group has an unexpected size"
    );
    Ok(Bytes::from(content))
}

struct DecodedGroups {
    limit: usize,
    bytes: usize,
    entries: VecDeque<(usize, Bytes)>,
}

impl DecodedGroups {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            bytes: 0,
            entries: VecDeque::new(),
        }
    }

    fn get(&mut self, index: usize) -> Option<Bytes> {
        let position = self.entries.iter().position(|(key, _)| *key == index)?;
        let entry = self.entries.remove(position)?;
        let content = entry.1.clone();
        self.entries.push_back(entry);
        Some(content)
    }

    fn insert(&mut self, index: usize, content: Bytes) {
        if let Some(position) = self.entries.iter().position(|(key, _)| *key == index) {
            self.bytes -= self.entries.remove(position).unwrap().1.len();
        }
        if content.len() > self.limit {
            return;
        }
        while self.bytes + content.len() > self.limit {
            self.bytes -= self.entries.pop_front().unwrap().1.len();
        }
        self.bytes += content.len();
        self.entries.push_back((index, content));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn all_embedded_assets_match_the_original_frontend_files() {
        let directory =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("frontend/dist/assets");
        for asset in FRONTEND_ASSETS {
            let original = std::fs::read(directory.join(asset.name)).unwrap();
            assert_eq!(
                asset.read().await.unwrap().as_ref(),
                original,
                "{}",
                asset.name
            );
        }
    }

    #[tokio::test]
    async fn concurrent_cold_reads_share_one_decoded_group() {
        let store = Arc::new(AssetStore::new(CACHE_BYTES));
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..16 {
            let store = Arc::clone(&store);
            requests.spawn(async move { store.load(0).await.unwrap() });
        }
        let first = requests.join_next().await.unwrap().unwrap();
        while let Some(result) = requests.join_next().await {
            assert_eq!(result.unwrap().as_ptr(), first.as_ptr());
        }
        let cache = mutex_lock(&store.cache);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.bytes, ASSET_GROUPS[0].length);
    }

    #[test]
    fn cache_evicts_by_bytes_and_recency_without_invalidating_active_readers() {
        let mut cache = DecodedGroups::new(8);
        cache.insert(0, Bytes::from_static(b"aaaa"));
        cache.insert(1, Bytes::from_static(b"bbbb"));
        let active = cache.get(0).unwrap();
        cache.insert(2, Bytes::from_static(b"cc"));
        assert!(cache.get(1).is_none());
        assert!(cache.get(0).is_some());
        cache.insert(3, Bytes::from_static(b"ddddddd"));
        assert!(cache.get(0).is_none());
        assert!(cache.get(2).is_none());
        assert_eq!(active, b"aaaa"[..]);
        assert_eq!(cache.bytes, 7);
        cache.insert(4, Bytes::from_static(b"too large"));
        assert!(cache.get(4).is_none());
        assert!(cache.get(3).is_some());
        assert!(cache.bytes <= cache.limit);
    }

    #[test]
    fn corrupt_or_incorrectly_sized_groups_fail_decoding() {
        assert!(
            decode(&AssetGroup {
                compressed: b"invalid",
                length: 10
            })
            .is_err()
        );
        assert!(
            decode(&AssetGroup {
                compressed: ASSET_GROUPS[0].compressed,
                length: ASSET_GROUPS[0].length - 1,
            })
            .is_err()
        );
    }
}
