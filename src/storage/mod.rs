mod client;
mod config;

use std::{path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Semaphore};

use config::{Config, ConfigInput, ConfigView};

type StorageResult<T> = Result<T, StorageError>;

#[derive(Debug)]
struct StorageError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl StorageError {
    fn new(status: StatusCode, code: &'static str, message: &str) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    fn input(message: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_config", message)
    }
    fn internal(message: &str) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "storage_config", message)
    }
    fn upstream(message: &str) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "remote_error", message)
    }
    fn remote_auth() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "remote_auth",
            "OpenList 认证已失效，请在外部存储设置中更新密码或令牌",
        )
    }
}

impl IntoResponse for StorageError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(json!({ "error": self.message, "code": self.code })),
        )
            .into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

struct Storage {
    path: PathBuf,
    api_client: reqwest::Client,
    media_client: reqwest::Client,
    token: Mutex<Option<client::CachedToken>>,
    updates: Arc<Mutex<()>>,
    requests: Arc<Semaphore>,
}

impl Storage {
    fn new(directory: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            path: directory.join("openlist.json"),
            // Authentication is sent only to the configured API, with redirects disabled.
            api_client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("OpenList API client"),
            media_client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .read_timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()
                .expect("OpenList media client"),
            token: Mutex::new(None),
            updates: Arc::new(Mutex::new(())),
            requests: Arc::new(Semaphore::new(8)),
        })
    }

    async fn read(&self) -> StorageResult<Option<Config>> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || config::read(&path))
            .await
            .map_err(|_| StorageError::internal("无法读取外部存储配置"))?
    }

    async fn configured(&self) -> StorageResult<Config> {
        self.read().await?.ok_or_else(|| {
            StorageError::new(
                StatusCode::CONFLICT,
                "not_configured",
                "请先连接 OpenList 外部存储",
            )
        })
    }
}

pub(crate) fn router(directory: PathBuf) -> Router {
    Router::new()
        .route("/api/storage/config", get(read_config).post(save_config))
        .route("/api/storage/test", post(test_config))
        .route("/api/storage/disconnect", post(disconnect))
        .route("/api/storage/list", get(list))
        .route("/api/storage/file", get(file))
        .layer(DefaultBodyLimit::max(16_384))
        .with_state(Storage::new(directory))
}

async fn read_config(State(storage): State<Arc<Storage>>) -> StorageResult<Response> {
    let config = storage.read().await?;
    Ok(private_json(ConfigView::from_config(config.as_ref())))
}

async fn test_config(
    State(storage): State<Arc<Storage>>,
    Json(input): Json<ConfigInput>,
) -> StorageResult<Response> {
    let _permit = storage.requests.clone().try_acquire_owned().map_err(|_| {
        StorageError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "busy",
            "连接请求较多，请稍后重试",
        )
    })?;
    let previous = storage.read().await?;
    let config = input.resolve(previous.as_ref())?;
    storage.verify(&config).await?;
    Ok(private_json(json!({ "connected": true })))
}

async fn save_config(
    State(storage): State<Arc<Storage>>,
    Json(input): Json<ConfigInput>,
) -> StorageResult<Response> {
    let guard = storage.updates.clone().try_lock_owned().map_err(|_| {
        StorageError::new(
            StatusCode::CONFLICT,
            "busy",
            "另一项设置正在保存，请稍后重试",
        )
    })?;
    let previous = storage.read().await?;
    let config = input.resolve(previous.as_ref())?;
    storage.verify(&config).await?;
    let view = ConfigView::from_config(Some(&config));
    let path = storage.path.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        config::write(&path, &config)
    })
    .await
    .map_err(|_| StorageError::internal("保存外部存储设置失败"))??;
    Ok(private_json(view))
}

async fn disconnect(State(storage): State<Arc<Storage>>) -> StorageResult<StatusCode> {
    let _guard = storage.updates.lock().await;
    match tokio::fs::remove_file(&storage.path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(StorageError::internal("无法清除外部存储配置")),
    }
    *storage.token.lock().await = None;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    #[serde(default = "root")]
    path: String,
    #[serde(default = "first_page")]
    page: u32,
}
fn root() -> String {
    "/".into()
}
fn first_page() -> u32 {
    1
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: String,
    kind: &'static str,
}

async fn list(
    State(storage): State<Arc<Storage>>,
    Query(query): Query<ListQuery>,
) -> StorageResult<Response> {
    if query.page == 0 || query.page > 1_000_000 {
        return Err(StorageError::input("页码无效"));
    }
    let _permit = storage
        .requests
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| StorageError::upstream("连接已关闭"))?;
    let config = storage.configured().await?;
    let path = config::normalize_path(&query.path)?;
    let data = storage.api(&config, "fs/list", Some(json!({ "path": config.remote_path(&path)?, "password": config.directory_password, "page": query.page, "per_page": 60, "refresh": false }))).await?;
    let total = data
        .get("total")
        .and_then(Value::as_u64)
        .ok_or_else(|| StorageError::upstream("OpenList 目录信息无效"))?;
    let values = data.get("content").and_then(Value::as_array);
    if values.is_none() && !data.get("content").is_some_and(Value::is_null) {
        return Err(StorageError::upstream("OpenList 文件列表无效"));
    }
    let mut items = Vec::new();
    for value in values.into_iter().flatten().take(60) {
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| StorageError::upstream("OpenList 文件名无效"))?;
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name == "."
            || name == ".."
            || name.chars().any(char::is_control)
            || path.len() + name.len() + 1 > 4096
        {
            continue;
        }
        let is_dir = value
            .get("is_dir")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        items.push(Entry {
            name: name.into(),
            path: format!("{}/{name}", path.trim_end_matches('/')),
            is_dir,
            size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
            modified: value
                .get("modified")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            kind: file_kind(name, is_dir),
        });
    }
    Ok(private_json(
        json!({ "items": items, "path": path, "total": total, "page": query.page, "nextPage": (u64::from(query.page) * 60 < total).then_some(query.page + 1) }),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileQuery {
    path: String,
    #[serde(default)]
    thumbnail: bool,
    #[serde(default)]
    download: bool,
}

async fn file(
    State(storage): State<Arc<Storage>>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
) -> StorageResult<Response> {
    let _permit = storage
        .requests
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| StorageError::upstream("连接已关闭"))?;
    let config = storage.configured().await?;
    let path = config.remote_path(&query.path)?;
    let data = storage
        .api(
            &config,
            "fs/get",
            Some(json!({ "path": path, "password": config.directory_password })),
        )
        .await?;
    if data.get("is_dir").and_then(Value::as_bool) != Some(false) {
        return Err(StorageError::input("请选择要打开的文件"));
    }
    let name = data
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| StorageError::upstream("OpenList 文件信息无效"))?;
    let raw_url = data.get("raw_url").and_then(Value::as_str).unwrap_or("");
    let thumb = data
        .get("thumb")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty());
    let source = if query.thumbnail {
        thumb.unwrap_or(raw_url)
    } else {
        raw_url
    };
    let url = reqwest::Url::parse(&config.url)
        .expect("validated URL")
        .join(source)
        .map_err(|_| StorageError::upstream("OpenList 文件地址无效"))?;
    config::http_url(url.as_str()).map_err(|_| StorageError::upstream("OpenList 文件地址无效"))?;
    if source.is_empty() {
        return Err(StorageError::upstream("OpenList 未提供文件地址"));
    }
    // File hosts receive no OpenList token, browser cookies, or user-supplied target URL.
    let mut request = storage.media_client.get(url);
    for key in [
        header::RANGE,
        header::IF_RANGE,
        header::IF_NONE_MATCH,
        header::IF_MODIFIED_SINCE,
    ] {
        if let Some(value) = headers.get(&key) {
            request = request.header(key, value);
        }
    }
    let upstream = request
        .send()
        .await
        .map_err(|_| StorageError::upstream("无法读取外部文件"))?;
    let status = upstream.status();
    if !status.is_success()
        && status != StatusCode::NOT_MODIFIED
        && status != StatusCode::RANGE_NOT_SATISFIABLE
    {
        return Err(StorageError::upstream(
            "外部文件暂时无法访问，请刷新目录后重试",
        ));
    }
    let mut response_headers = HeaderMap::new();
    for key in [
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(value) = upstream.headers().get(&key) {
            response_headers.insert(key, value.clone());
        }
    }
    let media_type = if query.thumbnail {
        upstream
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .filter(|value| {
                matches!(
                    *value,
                    "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif"
                )
            })
            .unwrap_or(mime_type(name))
    } else {
        mime_type(name)
    };
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(media_type).expect("static media type"),
    );
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    let disposition = if query.download || media_type == "application/octet-stream" {
        "attachment"
    } else {
        "inline"
    };
    let encoded = name
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    response_headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("{disposition}; filename*=UTF-8''{encoded}"))
            .map_err(|_| StorageError::upstream("外部文件名无效"))?,
    );
    Ok((
        status,
        response_headers,
        Body::from_stream(upstream.bytes_stream()),
    )
        .into_response())
}

fn file_kind(name: &str, directory: bool) -> &'static str {
    if directory {
        "folder"
    } else {
        let mime = mime_type(name);
        if mime.starts_with("image/") {
            "image"
        } else if mime.starts_with("video/") {
            "video"
        } else if mime.starts_with("audio/") {
            "audio"
        } else {
            "file"
        }
    }
}

fn mime_type(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn private_json(value: impl Serialize) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

#[cfg(test)]
mod tests;
