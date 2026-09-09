use std::{
    io::{Read, Write},
    path::Path,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::{StorageError, StorageResult};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Config {
    pub version: u8,
    pub name: String,
    pub url: String,
    pub root_path: String,
    pub auth_mode: AuthMode,
    pub username: String,
    pub secret: String,
    pub directory_password: String,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum AuthMode {
    Password,
    Token,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConfigInput {
    name: String,
    url: String,
    root_path: String,
    auth_mode: AuthMode,
    #[serde(default)]
    username: String,
    #[serde(default)]
    secret: String,
    // Omission keeps an existing directory password; an empty value clears it.
    directory_password: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConfigView {
    pub configured: bool,
    pub name: String,
    pub url: String,
    pub root_path: String,
    pub auth_mode: AuthMode,
    pub username: String,
    pub has_secret: bool,
    pub has_directory_password: bool,
}

impl ConfigView {
    pub fn from_config(config: Option<&Config>) -> Self {
        Self {
            configured: config.is_some(),
            name: config.map_or("OpenList", |value| &value.name).into(),
            url: config.map_or("", |value| &value.url).into(),
            root_path: config.map_or("/", |value| &value.root_path).into(),
            auth_mode: config.map_or(AuthMode::Password, |value| value.auth_mode),
            username: config.map_or("", |value| &value.username).into(),
            has_secret: config.is_some_and(|value| !value.secret.is_empty()),
            has_directory_password: config
                .is_some_and(|value| !value.directory_password.is_empty()),
        }
    }
}

impl ConfigInput {
    pub fn resolve(self, previous: Option<&Config>) -> StorageResult<Config> {
        let name = self.name.trim().to_owned();
        if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
            return Err(StorageError::input("连接名称需为 1–128 字节"));
        }
        let mut url = http_url(self.url.trim())?;
        if url.query().is_some() || url.fragment().is_some() {
            return Err(StorageError::input("OpenList 地址不能包含查询参数或片段"));
        }
        let path = format!("{}/", url.path().trim_end_matches('/'));
        url.set_path(&path);
        let url = url.to_string();
        let root_path = normalize_path(&self.root_path)?;
        let username = self.username.trim().to_owned();
        if self.auth_mode == AuthMode::Password
            && (username.is_empty()
                || username.len() > 128
                || username.chars().any(char::is_control))
        {
            return Err(StorageError::input("请填写有效的 OpenList 用户名"));
        }
        let previous = previous.filter(|value| {
            value.url == url && value.auth_mode == self.auth_mode && value.username == username
        });
        let supplied = Zeroizing::new(self.secret);
        if supplied.len() > 4096 || supplied.chars().any(char::is_control) {
            return Err(StorageError::input("认证信息过长或包含无效字符"));
        }
        let secret = if supplied.is_empty() {
            previous
                .map(|value| value.secret.clone())
                .ok_or_else(|| StorageError::input("请填写 OpenList 密码或认证令牌"))?
        } else if self.auth_mode == AuthMode::Password {
            // OpenList's /api/auth/login/hash uses its documented static SHA-256 hash.
            let mut hash = Sha256::new();
            hash.update(supplied.as_bytes());
            hash.update(b"-https://github.com/alist-org/alist");
            format!("{:x}", hash.finalize())
        } else {
            supplied.trim().to_owned()
        };
        if secret.is_empty() {
            return Err(StorageError::input("认证令牌不能为空"));
        }
        let directory_password = self.directory_password.unwrap_or_else(|| {
            previous.map_or(String::new(), |value| value.directory_password.clone())
        });
        if directory_password.len() > 1024 || directory_password.chars().any(char::is_control) {
            return Err(StorageError::input("目录密码长度无效"));
        }
        Ok(Config {
            version: 1,
            name,
            url,
            root_path,
            auth_mode: self.auth_mode,
            username,
            secret,
            directory_password,
        })
    }
}

impl Config {
    pub fn key(&self) -> String {
        blake3::hash(&serde_json::to_vec(self).expect("configuration serialization"))
            .to_hex()
            .to_string()
    }

    pub fn remote_path(&self, path: &str) -> StorageResult<String> {
        let path = normalize_path(path)?;
        Ok(if self.root_path == "/" {
            path
        } else if path == "/" {
            self.root_path.clone()
        } else {
            format!("{}{}", self.root_path, path)
        })
    }
}

pub(super) fn http_url(value: &str) -> StorageResult<reqwest::Url> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| StorageError::input("请输入完整的 HTTP 或 HTTPS 地址"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || value.len() > 4096
    {
        return Err(StorageError::input(
            "地址仅支持 HTTP/HTTPS，认证信息请填在单独的字段中",
        ));
    }
    Ok(url)
}

pub(super) fn normalize_path(value: &str) -> StorageResult<String> {
    if !value.starts_with('/')
        || value.len() > 4096
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(StorageError::input("目录路径无效，请使用以 / 开头的路径"));
    }
    let mut parts = Vec::new();
    for part in value.split('/').filter(|part| !part.is_empty()) {
        if part == "."
            || part == ".."
            || part.to_ascii_lowercase().contains("%2e")
            || part.to_ascii_lowercase().contains("%2f")
            || part.to_ascii_lowercase().contains("%5c")
        {
            return Err(StorageError::input("目录路径不能包含跳转片段"));
        }
        parts.push(part);
    }
    Ok(format!("/{}", parts.join("/")))
}

pub(super) fn read(path: &Path) -> StorageResult<Option<Config>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(StorageError::internal("无法读取外部存储配置")),
    };
    let mut bytes = Vec::new();
    file.take(16_385)
        .read_to_end(&mut bytes)
        .map_err(|_| StorageError::internal("无法读取外部存储配置"))?;
    if bytes.len() > 16_384 {
        return Err(StorageError::internal("外部存储配置过大"));
    }
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|_| StorageError::internal("外部存储配置损坏，请恢复备份"))?;
    if config.version != 1 {
        return Err(StorageError::internal("外部存储配置版本不受支持"));
    }
    http_url(&config.url)?;
    normalize_path(&config.root_path)?;
    Ok(Some(config))
}

pub(super) fn write(path: &Path, config: &Config) -> StorageResult<()> {
    let commit = || -> anyhow::Result<()> {
        let directory = path.parent().expect("settings directory");
        std::fs::create_dir_all(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut temporary, config)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary.persist(path)?;
        #[cfg(unix)]
        std::fs::File::open(directory)?.sync_all()?;
        Ok(())
    };
    commit().map_err(|_| StorageError::internal("无法保存外部存储配置，请确认数据目录可写"))
}
