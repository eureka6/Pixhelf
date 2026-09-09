use super::*;

const NEW_PASSWORD: &str = "a-new-private-gallery-password";

async fn saved_account() -> (TempDir, TempDir, Router, String, String) {
    let cache = tempfile::tempdir().unwrap();
    let config = AuthConfig::from_sources(cache.path(), cache.path(), &|_| None).unwrap();
    let (gallery, app, _) = fixture_with_config(config).await;
    let response = call(
        &app,
        auth_request("/api/auth/setup", None, None),
        json!({ "username": "admin", "password": PASSWORD }).to_string(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = session_cookie(&response);
    let view = json_body(response).await;
    assert_eq!(view["canChangePassword"], true);
    (
        cache,
        gallery,
        app,
        cookie,
        view["csrfToken"].as_str().unwrap().to_owned(),
    )
}

fn auth_request(
    path: &str,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> axum::http::request::Builder {
    let mut builder = request(Method::POST, path, cookie)
        .header(header::ORIGIN, ORIGIN)
        .header(ORIGIN_HEADER, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(csrf) = csrf {
        builder = builder.header("x-csrf-token", csrf);
    }
    builder
}

async fn change(app: &Router, cookie: &str, csrf: &str, current: &str, next: &str) -> Response {
    call(
        app,
        auth_request("/api/auth/password", Some(cookie), Some(csrf)),
        json!({ "currentPassword": current, "newPassword": next }).to_string(),
    )
    .await
}

async fn login_with(app: &Router, password: &str) -> Response {
    call(
        app,
        auth_request("/api/auth/login", None, None),
        json!({ "username": "admin", "password": password }).to_string(),
    )
    .await
}

#[tokio::test]
async fn changing_password_persists_and_revokes_every_session() {
    let (cache, _gallery, app, cookie, csrf) = saved_account().await;
    let other = session_cookie(&sign_in(&app, None).await);
    let path = cache.path().join("auth/account.json");
    let before = std::fs::read(&path).unwrap();
    let bad = change(
        &app,
        &cookie,
        &csrf,
        "incorrect-current-password",
        NEW_PASSWORD,
    )
    .await;
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        call(
            &app,
            request(Method::GET, "/api/gallery", Some(&other)),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );

    let response = change(&app, &cookie, &csrf, PASSWORD, NEW_PASSWORD).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    for cookie in [&cookie, &other] {
        assert_eq!(
            call(
                &app,
                request(Method::GET, "/api/gallery", Some(cookie)),
                Body::empty()
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let saved = std::fs::read_to_string(&path).unwrap();
    assert!(!saved.contains(PASSWORD) && !saved.contains(NEW_PASSWORD));
    assert_ne!(saved.as_bytes(), before);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        login_with(&app, PASSWORD).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login_with(&app, NEW_PASSWORD).await.status(),
        StatusCode::OK
    );
    let restarted = AuthConfig::from_sources(cache.path(), cache.path(), &|_| None).unwrap();
    let (_gallery2, app2, _) = fixture_with_config(restarted).await;
    let response = login_with(&app2, NEW_PASSWORD).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["canChangePassword"], true);
    assert_eq!(
        login_with(&app2, PASSWORD).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn password_change_checks_session_csrf_origin_and_input() {
    let (cache, _gallery, app, cookie, csrf) = saved_account().await;
    let path = cache.path().join("auth/account.json");
    let before = std::fs::read(&path).unwrap();
    let body = json!({ "currentPassword": PASSWORD, "newPassword": NEW_PASSWORD });
    assert_eq!(
        call(
            &app,
            auth_request("/api/auth/password", None, Some(&csrf)),
            body.to_string()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        change(&app, &cookie, "forged", PASSWORD, NEW_PASSWORD)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            auth_request("/api/auth/password", Some(&cookie), Some(&csrf))
                .header(header::ORIGIN, "https://evil.example"),
            body.to_string()
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    for next in ["short", "a-long-password-with\n-control", PASSWORD] {
        assert_eq!(
            change(&app, &cookie, &csrf, PASSWORD, next).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        change(&app, &cookie, &csrf, PASSWORD, &"图".repeat(342))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let mut extra = body.clone();
    extra["unexpectedField"] = "other".into();
    assert_eq!(
        call(
            &app,
            auth_request("/api/auth/password", Some(&cookie), Some(&csrf)),
            extra.to_string()
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &app,
            auth_request("/api/auth/password", Some(&cookie), Some(&csrf)),
            " ".repeat(8193)
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn deployment_managed_passwords_cannot_be_silently_overridden() {
    let (_gallery, app, _) = fixture().await;
    let response = sign_in(&app, None).await;
    let cookie = session_cookie(&response);
    let view = json_body(response).await;
    assert_ne!(view["canChangePassword"], true);
    assert_eq!(
        change(
            &app,
            &cookie,
            view["csrfToken"].as_str().unwrap(),
            PASSWORD,
            NEW_PASSWORD
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(sign_in(&app, None).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn concurrent_password_changes_commit_once() {
    let (_cache, _gallery, app, cookie, csrf) = saved_account().await;
    let alternative = "another-new-private-gallery-password";
    let (first, second) = tokio::join!(
        change(&app, &cookie, &csrf, PASSWORD, NEW_PASSWORD),
        change(&app, &cookie, &csrf, PASSWORD, alternative),
    );
    let statuses = [first.status(), second.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::NO_CONTENT)
            .count(),
        1
    );
    assert!(statuses.iter().all(|status| matches!(
        *status,
        StatusCode::NO_CONTENT | StatusCode::CONFLICT | StatusCode::UNAUTHORIZED
    )));
    let (winner, loser) = if first.status() == StatusCode::NO_CONTENT {
        (NEW_PASSWORD, alternative)
    } else {
        (alternative, NEW_PASSWORD)
    };
    assert_eq!(login_with(&app, winner).await.status(), StatusCode::OK);
    assert_eq!(
        login_with(&app, loser).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn failed_password_writes_keep_credentials_and_sessions() {
    let (cache, _gallery, app, cookie, csrf) = saved_account().await;
    let path = cache.path().join("auth/account.json");
    let backup = cache.path().join("auth/account.backup");
    std::fs::rename(&path, &backup).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        change(&app, &cookie, &csrf, PASSWORD, NEW_PASSWORD)
            .await
            .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        call(
            &app,
            request(Method::GET, "/api/gallery", Some(&cookie)),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&backup, &path).unwrap();
    assert_eq!(login_with(&app, PASSWORD).await.status(), StatusCode::OK);
    assert_eq!(
        login_with(&app, NEW_PASSWORD).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn late_login_and_cached_sessions_cannot_bypass_password_revocation() {
    let auth = AuthState::new(config());
    let previous = auth.credentials().unwrap();
    let active = Session::new(None, Arc::new(auth.store.clone()), None);
    assert_eq!(
        start_session(&active, &previous, true).await.status(),
        StatusCode::OK
    );
    assert!(auth.account(&active).await.unwrap().is_some());
    *write_lock(&auth.credentials) = Some(Arc::new(Credentials {
        password_hash: password::hash_password(NEW_PASSWORD).unwrap(),
        ..(*previous).clone()
    }));
    auth.store.revoke_all();
    assert!(auth.account(&active).await.unwrap().is_none());
    let late = Session::new(None, Arc::new(auth.store.clone()), None);
    start_session(&late, &previous, true).await;
    late.save().await.unwrap();
    assert!(auth.account(&late).await.unwrap().is_none());
}

#[tokio::test]
async fn password_changes_share_authentication_rate_limits() {
    let (_cache, _gallery, app, cookie, _) = saved_account().await;
    for _ in 1..IP_LOGIN_LIMIT {
        assert_eq!(
            change(&app, &cookie, "forged", PASSWORD, NEW_PASSWORD)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let response = change(&app, &cookie, "forged", PASSWORD, NEW_PASSWORD).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().contains_key(header::RETRY_AFTER));
}

#[tokio::test]
async fn account_updates_allow_renaming_with_or_without_a_new_password() {
    for next in ["", NEW_PASSWORD] {
        let (cache, _gallery, app, cookie, csrf) = saved_account().await;
        let before = std::fs::read_to_string(cache.path().join("auth/account.json")).unwrap();
        let payload =
            json!({ "username": "新管理员", "currentPassword": PASSWORD, "newPassword": next });
        let response = call(
            &app,
            auth_request("/api/auth/password", Some(&cookie), Some(&csrf)),
            payload.to_string(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            call(
                &app,
                request(Method::GET, "/api/storage/config", Some(&cookie)),
                Body::empty()
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        let persisted: Value = serde_json::from_str(
            &std::fs::read_to_string(cache.path().join("auth/account.json")).unwrap(),
        )
        .unwrap();
        let previous: Value = serde_json::from_str(&before).unwrap();
        assert_eq!(persisted["username"], "新管理员");
        assert_ne!(
            persisted["passwordHash"], previous["passwordHash"],
            "renaming must retire the old credential revision"
        );
        assert_eq!(
            login_with(&app, PASSWORD).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let restarted = AuthConfig::from_sources(cache.path(), cache.path(), &|_| None).unwrap();
        let (_gallery2, app2, _) = fixture_with_config(restarted).await;
        let response = call(&app2, auth_request("/api/auth/login", None, None), json!({ "username": "新管理员", "password": if next.is_empty() { PASSWORD } else { next } }).to_string()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["username"], "新管理员");
    }
}

#[tokio::test]
async fn external_storage_requires_a_session_and_writes_require_csrf_and_origin() {
    let (_cache, _gallery, app, cookie, csrf) = saved_account().await;
    for path in [
        "/api/storage/config",
        "/api/storage/list",
        "/api/storage/file?path=%2Fimage.png",
    ] {
        assert_eq!(
            call(&app, request(Method::GET, path, None), Body::empty())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    for path in [
        "/api/storage/config",
        "/api/storage/test",
        "/api/storage/disconnect",
    ] {
        assert_eq!(
            call(
                &app,
                auth_request(path, Some(&cookie), Some("forged")),
                "{}"
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                request(Method::POST, path, Some(&cookie)).header("x-csrf-token", &csrf),
                "{}"
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(
            &app,
            auth_request("/api/storage/disconnect", Some(&cookie), Some(&csrf)),
            "{}"
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
}
