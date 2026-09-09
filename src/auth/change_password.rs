use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PasswordInput {
    current_password: String,
    #[serde(default)]
    new_password: String,
    username: Option<String>,
}

pub(super) async fn change_password(
    State(auth): State<AuthState>,
    session: Session,
    headers: HeaderMap,
    payload: Result<Json<PasswordInput>, JsonRejection>,
) -> Response {
    let account = match auth.account(&session).await {
        Ok(Some(account)) => account,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "登录已失效，请重新登录"),
        Err(status) => return error(status, "暂时无法验证登录状态"),
    };
    if !valid_csrf(&headers, &account) {
        return error(StatusCode::FORBIDDEN, "请求已失效，请刷新页面后重试");
    }
    let Some(credentials) = auth.credentials() else {
        return error(StatusCode::UNAUTHORIZED, "登录已失效，请重新登录");
    };
    if account.credential_revision != credential_revision(&credentials) {
        return error(StatusCode::UNAUTHORIZED, "登录已失效，请重新登录");
    }
    let Some(path) = credentials.account_path.clone() else {
        return error(
            StatusCode::CONFLICT,
            "此账号由部署配置管理，请在部署配置中修改",
        );
    };
    let input = match payload {
        Ok(Json(input)) => input,
        Err(rejection) => return error(rejection.status(), "修改账号请求格式无效"),
    };
    let current_password = Zeroizing::new(input.current_password);
    let new_password = Zeroizing::new(input.new_password);
    let username = input
        .username
        .unwrap_or_else(|| credentials.username.clone());
    if let Err(reason) = config::validate_username(&username) {
        return error(StatusCode::BAD_REQUEST, &reason.to_string());
    }
    if current_password.is_empty() || current_password.len() > 1024 {
        return error(StatusCode::BAD_REQUEST, "当前密码长度无效");
    }
    if !new_password.is_empty() {
        if let Err(reason) = password::validate_password(&new_password) {
            return error(StatusCode::BAD_REQUEST, &reason.to_string());
        }
    } else if username == credentials.username {
        return error(StatusCode::BAD_REQUEST, "请修改用户名或填写新密码");
    }
    if current_password == new_password {
        return error(StatusCode::BAD_REQUEST, "新密码不能与当前密码相同");
    }
    let Ok(permit) = auth.password_workers.clone().try_acquire_owned() else {
        return throttled(1);
    };
    let updating = auth.clone();
    let outcome = tokio::task::spawn_blocking(move || -> anyhow::Result<StatusCode> {
        let _permit = permit;
        let hash = PasswordHash::new(&credentials.password_hash)
            .map_err(|_| anyhow::anyhow!("invalid current password hash"))?;
        if Argon2::default()
            .verify_password(current_password.as_bytes(), &hash)
            .is_err()
        {
            return Ok(StatusCode::BAD_REQUEST);
        }
        let updated = Arc::new(Credentials {
            username,
            // Rehash even on a rename so old in-flight logins cannot become valid again.
            password_hash: password::hash_password(if new_password.is_empty() {
                &current_password
            } else {
                &new_password
            })?,
            ..(*credentials).clone()
        });
        let mut current = write_lock(&updating.credentials);
        if current
            .as_ref()
            .is_none_or(|current| !Arc::ptr_eq(current, &credentials))
        {
            return Ok(StatusCode::CONFLICT);
        }
        // Complete persistence and revocation even if the HTTP request is cancelled.
        if let Err(reason) = persistence::replace(&path, &updated) {
            // Rename may have completed before a directory flush failed. Keep memory and
            // sessions consistent with the committed password in that case.
            if persistence::load(&path)
                .ok()
                .flatten()
                .is_some_and(|saved| {
                    saved.username == updated.username
                        && saved.password_hash == updated.password_hash
                })
            {
                *current = Some(updated);
                updating.store.revoke_all();
                tracing::error!(error = %reason, "密码文件已更新，但目录同步失败");
                return Ok(StatusCode::NO_CONTENT);
            }
            return Err(reason);
        }
        *current = Some(updated);
        updating.store.revoke_all();
        tracing::info!("管理员账号已更新，所有登录会话已退出");
        Ok(StatusCode::NO_CONTENT)
    })
    .await;
    match outcome {
        Ok(Ok(StatusCode::NO_CONTENT)) => {
            // All server sessions are already revoked; flushing also removes this browser's cookie.
            if session.flush().await.is_err() {
                tracing::warn!("密码已更新，未能清除当前浏览器的会话 Cookie");
            }
            let mut response = StatusCode::NO_CONTENT.into_response();
            response
                .headers_mut()
                .insert("clear-site-data", HeaderValue::from_static("\"cache\""));
            response
        }
        Ok(Ok(StatusCode::BAD_REQUEST)) => error(StatusCode::BAD_REQUEST, "当前密码不正确"),
        Ok(Ok(_)) => error(StatusCode::CONFLICT, "密码已被更新，请重新登录后再试"),
        failure => {
            match failure {
                Ok(Err(reason)) => tracing::error!(error = %reason, "无法保存管理员密码"),
                Err(reason) => tracing::error!(error = %reason, "修改账号任务中断"),
                _ => unreachable!(),
            }
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "无法保存密码，请确认应用数据卷可写后重试",
            )
        }
    }
}
