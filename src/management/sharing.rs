use std::{
    collections::BTreeSet,
    io,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};

use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{StatusCode, request::Parts},
    response::Response,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use super::{Failure, Management, files, private_json};
use crate::{
    auth::AuthView,
    gallery::GalleryIndex,
    support::{BoundedCache, mutex_lock},
    web::AppState,
};

static SHARED_INDEXES: OnceLock<Mutex<BoundedCache<Arc<GalleryIndex>>>> = OnceLock::new();

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Sharing {
    pub private_albums: BTreeSet<String>,
}

pub(super) fn read(directory: &Path) -> Result<Sharing> {
    match std::fs::read(directory.join("sharing.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("分享设置损坏，请恢复后重试"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Sharing::default()),
        Err(error) => Err(error).context("无法读取分享设置"),
    }
}

pub(super) fn save(directory: &Path, sharing: &Sharing) -> Result<()> {
    files::save_json(&directory.join("sharing.json"), sharing).context("无法保存分享设置")
}

impl Sharing {
    pub fn relocated(&self, from: &str, to: &str) -> Self {
        Self {
            private_albums: self
                .private_albums
                .iter()
                .map(|path| {
                    if path == from || path.starts_with(&format!("{from}/")) {
                        format!("{to}{}", &path[from.len()..])
                    } else {
                        path.clone()
                    }
                })
                .collect(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ShareInput {
    path: String,
    shared: bool,
}

pub(super) async fn update(
    State(store): State<Arc<Management>>,
    Json(input): Json<ShareInput>,
) -> Result<Response, Failure> {
    super::validate_selection(
        std::slice::from_ref(&input.path),
        super::SelectionKind::Albums,
    )?;
    let _updates = store.updates.lock().await;
    let index = store.app.index.write().await;
    if !index.albums.iter().any(|album| album.path == input.path) {
        return Err(anyhow::anyhow!("相册已变化，请刷新").into());
    }
    let directory = store.directory.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut sharing = read(&directory)?;
        if input.shared {
            sharing.private_albums.remove(&input.path);
        } else {
            sharing.private_albums.insert(input.path);
        }
        save(&directory, &sharing)
    })
    .await
    .context("保存分享设置失败")??;
    Ok(private_json(serde_json::json!({"ok": true})))
}

// Every gallery read, including bootstrap, similarity and conditional media
// requests, resolves against the same visibility-filtered index. Administrative
// routes continue to use the original index and their existing auth middleware.
pub(crate) struct ReadState(pub AppState);

impl FromRequestParts<AppState> for ReadState {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if !parts
            .extensions
            .get::<AuthView>()
            .is_some_and(|auth| auth.guest && !auth.authenticated)
        {
            return Ok(Self(state.clone()));
        }
        let index = state.index.read().await;
        let sharing = match tokio::fs::read(
            state
                .thumbnails
                .settings_directory()
                .join("management/sharing.json"),
        )
        .await
        {
            Ok(bytes) => serde_json::from_slice::<Sharing>(&bytes)
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Sharing::default(),
            Err(_) => return Err(StatusCode::SERVICE_UNAVAILABLE),
        };
        let mut hasher = blake3::Hasher::new();
        hasher.update(index.root.as_os_str().as_encoded_bytes());
        hasher.update(index.revision.as_bytes());
        for path in &sharing.private_albums {
            hasher.update(path.as_bytes());
            hasher.update(b"\0");
        }
        let key = hasher.finalize().to_hex().to_string();
        let cache = SHARED_INDEXES.get_or_init(|| Mutex::new(BoundedCache::new(4)));
        let cached = { mutex_lock(cache).get_cloned(&key) };
        let visible = cached.unwrap_or_else(|| {
            let visible = Arc::new(index.shared_view(&sharing.private_albums));
            mutex_lock(cache).insert(key, visible.clone());
            visible
        });
        Ok(Self(AppState {
            index: Arc::new(RwLock::new(visible)),
            thumbnails: state.thumbnails.clone(),
        }))
    }
}
