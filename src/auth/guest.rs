use std::{io::Read, path::PathBuf};

use anyhow::{Context, Result, bail};

use super::*;

#[derive(Clone, Default)]
pub(super) struct GuestConfig {
    pub enabled: bool,
    path: Option<PathBuf>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GuestSettings {
    enabled: bool,
}

impl GuestConfig {
    pub(super) fn load(path: PathBuf) -> Result<Self> {
        let settings = match std::fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(1025).read_to_end(&mut bytes)?;
                if bytes.len() > 1024 {
                    bail!("guest settings file is too large");
                }
                serde_json::from_slice::<GuestSettings>(&bytes)
                    .context("saved guest settings are invalid; restore the configuration backup")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                GuestSettings { enabled: false }
            }
            Err(error) => return Err(error).context("cannot read guest settings"),
        };
        Ok(Self {
            enabled: settings.enabled,
            path: Some(path),
        })
    }
}

pub(super) async fn read_settings(State(auth): State<AuthState>, session: Session) -> Response {
    match auth.account(&session).await {
        Ok(Some(_)) => Json(GuestSettings {
            enabled: mutex_lock(&auth.guest).enabled,
        })
        .into_response(),
        Ok(None) => error(StatusCode::UNAUTHORIZED, "请先以管理员身份登录"),
        Err(status) => error(status, "暂时无法验证登录状态"),
    }
}

pub(super) async fn save_settings(
    State(auth): State<AuthState>,
    session: Session,
    headers: HeaderMap,
    payload: std::result::Result<Json<GuestSettings>, JsonRejection>,
) -> Response {
    let account = match auth.account(&session).await {
        Ok(Some(account)) => account,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "请先以管理员身份登录"),
        Err(status) => return error(status, "暂时无法验证登录状态"),
    };
    if !valid_csrf(&headers, &account) {
        return error(StatusCode::FORBIDDEN, "请求已失效，请刷新页面后重试");
    }
    let settings = match payload {
        Ok(Json(settings)) => settings,
        Err(rejection) => return error(rejection.status(), "访客设置格式无效"),
    };
    // Finish the atomic write even when the browser disconnects. The credential read lock
    // also prevents a revoked administrator request from committing after a password change.
    let outcome = tokio::task::spawn_blocking(move || -> Result<StatusCode> {
        let credentials = read_lock(&auth.credentials);
        if credentials.as_ref().is_none_or(|credentials| {
            account.credential_revision != credential_revision(credentials)
        }) {
            return Ok(StatusCode::UNAUTHORIZED);
        }
        let mut guest = mutex_lock(&auth.guest);
        let path = guest
            .path
            .as_ref()
            .context("guest settings path unavailable")?;
        if guest.enabled != settings.enabled {
            if let Err(reason) = persistence::write_json(path, &settings, true) {
                // A directory flush can fail after the rename has already committed.
                if !GuestConfig::load(path.clone())
                    .is_ok_and(|saved| saved.enabled == settings.enabled)
                {
                    return Err(reason);
                }
                tracing::warn!(error = %reason, "访客设置已保存，但目录同步失败");
            }
            guest.enabled = settings.enabled;
        }
        Ok(StatusCode::NO_CONTENT)
    })
    .await;
    match outcome {
        Ok(Ok(StatusCode::NO_CONTENT)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(status)) => error(status, "登录已失效，请重新登录"),
        failure => {
            match failure {
                Ok(Err(reason)) => tracing::error!(error = %reason, "无法保存访客设置"),
                Err(reason) => tracing::error!(error = %reason, "访客设置任务中断"),
                _ => unreachable!(),
            }
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "无法保存访客设置，请稍后重试",
            )
        }
    }
}
