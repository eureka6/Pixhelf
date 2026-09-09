use std::time::{Duration, Instant};

use axum::http::{StatusCode, header};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{
    Storage, StorageError, StorageResult,
    config::{AuthMode, Config},
};

pub(super) struct CachedToken {
    pub key: String,
    pub token: String,
    pub retry_at: Option<Instant>,
}

impl Storage {
    async fn token(&self, config: &Config, rejected: Option<&str>) -> StorageResult<String> {
        if config.auth_mode == AuthMode::Token {
            return Ok(config.secret.clone());
        }
        let key = config.key();
        let mut cache = self.token.lock().await;
        if let Some(cached) = cache.as_ref().filter(|cached| cached.key == key) {
            if cached.retry_at.is_some_and(|at| at > Instant::now()) {
                return Err(StorageError::remote_auth());
            }
            if !cached.token.is_empty() && rejected != Some(cached.token.as_str()) {
                return Ok(cached.token.clone());
            }
        }
        let result = self
            .send(
                config,
                "auth/login/hash",
                None,
                Some(json!({
                    "username": config.username, "password": config.secret,
                })),
            )
            .await;
        match result {
            Ok(data) => {
                let token = data
                    .get("token")
                    .and_then(Value::as_str)
                    .filter(|token| !token.is_empty() && token.len() <= 4096)
                    .ok_or_else(|| StorageError::upstream("OpenList 返回了无效的认证结果"))?
                    .to_owned();
                *cache = Some(CachedToken {
                    key,
                    token: token.clone(),
                    retry_at: None,
                });
                Ok(token)
            }
            Err(error) => {
                *cache = Some(CachedToken {
                    key,
                    token: String::new(),
                    retry_at: Some(Instant::now() + Duration::from_secs(30)),
                });
                Err(error)
            }
        }
    }

    pub async fn api(
        &self,
        config: &Config,
        endpoint: &str,
        body: Option<Value>,
    ) -> StorageResult<Value> {
        let token = self.token(config, None).await?;
        let result = self
            .send(config, endpoint, Some(&token), body.clone())
            .await;
        if result
            .as_ref()
            .is_err_and(|error| error.code == "remote_auth")
            && config.auth_mode == AuthMode::Password
        {
            let token = self.token(config, Some(&token)).await?;
            return self.send(config, endpoint, Some(&token), body).await;
        }
        result
    }

    async fn send(
        &self,
        config: &Config,
        endpoint: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> StorageResult<Value> {
        let url = format!("{}api/{endpoint}", config.url);
        let mut request = if let Some(body) = body {
            self.api_client
                .post(url)
                .header(header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(&body).expect("API JSON"))
        } else {
            self.api_client.get(url)
        };
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, token);
        }
        let response = request
            .send()
            .await
            .map_err(|_| StorageError::upstream("无法连接 OpenList，请检查地址及网络"))?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(StorageError::remote_auth());
        }
        if !status.is_success() {
            return Err(remote_error(status.as_u16() as i64));
        }
        let envelope: Value = read_json(response).await?;
        match envelope.get("code").and_then(Value::as_i64) {
            Some(200) => Ok(envelope.get("data").cloned().unwrap_or(Value::Null)),
            Some(code) => Err(remote_error(code)),
            None => Err(StorageError::upstream(
                "OpenList 返回格式无效，请检查服务地址",
            )),
        }
    }

    pub async fn verify(&self, config: &Config) -> StorageResult<()> {
        let user = self.api(config, "me", None).await?;
        if user.get("role").and_then(Value::as_i64) == Some(1)
            || user.get("disabled").and_then(Value::as_bool) == Some(true)
        {
            return Err(StorageError::remote_auth());
        }
        if !matches!(user.get("role").and_then(Value::as_i64), Some(0 | 2)) {
            return Err(StorageError::upstream("OpenList 账号信息无效"));
        }
        let directory = self
            .api(
                config,
                "fs/list",
                Some(json!({
                    "path": config.root_path, "password": config.directory_password,
                    "page": 1, "per_page": 1, "refresh": false,
                })),
            )
            .await?;
        if directory.get("total").and_then(Value::as_u64).is_none()
            || !directory
                .get("content")
                .is_some_and(|content| content.is_array() || content.is_null())
        {
            return Err(StorageError::upstream("OpenList 目录信息无效"));
        }
        Ok(())
    }
}

fn remote_error(code: i64) -> StorageError {
    match code {
        401 => StorageError::remote_auth(),
        402 => StorageError::input("OpenList 账号启用了两步验证，请改用令牌认证"),
        403 => StorageError::new(
            StatusCode::FORBIDDEN,
            "remote_permission",
            "OpenList 无权访问此目录，请检查账号权限或目录密码",
        ),
        404 => StorageError::new(
            StatusCode::NOT_FOUND,
            "remote_missing",
            "外部文件或目录不存在",
        ),
        429 => StorageError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "remote_busy",
            "OpenList 请求过于频繁，请稍后重试",
        ),
        _ => StorageError::upstream("OpenList 暂时无法读取文件，请稍后重试"),
    }
}

async fn read_json<T: DeserializeOwned>(mut response: reqwest::Response) -> StorageResult<T> {
    const LIMIT: usize = 4 * 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|length| length > LIMIT as u64)
    {
        return Err(StorageError::upstream("OpenList 返回的数据过大"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| StorageError::upstream("OpenList 响应中断，请重试"))?
    {
        if bytes.len() + chunk.len() > LIMIT {
            return Err(StorageError::upstream("OpenList 返回的数据过大"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| StorageError::upstream("OpenList 返回格式无效，请检查服务地址"))
}
