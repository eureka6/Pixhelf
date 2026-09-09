use super::*;

async fn guest_fixture() -> (TempDir, TempDir, Router, String, String, String) {
    let cache = tempfile::tempdir().unwrap();
    let config = AuthConfig::from_sources(cache.path(), cache.path(), &|_| None).unwrap();
    let (gallery, app, id) = fixture_with_config(config).await;
    let response = call(
        &app,
        write_request("/api/auth/setup", None, None),
        json!({"username": "admin", "password": PASSWORD}).to_string(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = session_cookie(&response);
    let csrf = json_body(response).await["csrfToken"]
        .as_str()
        .unwrap()
        .to_owned();
    (cache, gallery, app, id, cookie, csrf)
}

fn write_request(
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

async fn set_guest(app: &Router, cookie: &str, csrf: &str, enabled: bool) -> Response {
    call(
        app,
        write_request("/api/auth/guest", Some(cookie), Some(csrf)),
        json!({"enabled": enabled}).to_string(),
    )
    .await
}

#[tokio::test]
async fn guest_mode_is_opt_in_read_only_and_revocable_before_conditional_media() {
    let (_cache, gallery, app, id, cookie, csrf) = guest_fixture().await;
    let setting = call(
        &app,
        request(Method::GET, "/api/auth/guest", Some(&cookie)),
        Body::empty(),
    )
    .await;
    assert_eq!(json_body(setting).await, json!({"enabled": false}));
    assert_eq!(
        call(
            &app,
            request(Method::GET, "/api/gallery", None),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        set_guest(&app, &cookie, &csrf, true).await.status(),
        StatusCode::NO_CONTENT
    );

    let session = call(
        &app,
        request(Method::GET, "/api/auth/session", None),
        Body::empty(),
    )
    .await;
    assert!(!session.headers().contains_key(header::SET_COOKIE));
    assert_eq!(
        json_body(session).await,
        json!({"enabled": true, "authenticated": false, "guest": true})
    );
    for path in [
        "/".into(),
        "/api/gallery".into(),
        "/api/images".into(),
        "/api/status".into(),
        format!("/api/images/{id}"),
        format!("/api/images/{id}/thumbnail"),
        format!("/api/images/{id}/details"),
        format!("/api/images/{id}/similar"),
    ] {
        let response = call(&app, request(Method::GET, &path, None), Body::empty()).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        assert!(
            response.headers()[header::VARY]
                .to_str()
                .unwrap()
                .contains("Cookie")
        );
    }
    let original = format!("/api/images/{id}/original");
    let response = call(
        &app,
        request(Method::GET, &original, None).header(header::RANGE, "bytes=0-7"),
        Body::empty(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    let etag = response.headers()[header::ETAG].clone();
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "private, no-cache"
    );
    let image = std::fs::read(gallery.path().join("gallery/private-photo.png")).unwrap();
    let upload = call(
        &app,
        write_request("/api/images/similar", None, None),
        image.clone(),
    )
    .await;
    assert_eq!(upload.status(), StatusCode::OK);
    assert_eq!(json_body(upload).await["items"][0]["id"], id);
    let cross_site = call(
        &app,
        request(Method::POST, "/api/images/similar", None)
            .header(header::ORIGIN, "https://elsewhere.test"),
        image,
    )
    .await;
    assert_eq!(cross_site.status(), StatusCode::FORBIDDEN);

    for path in [
        "/api/auth/guest",
        "/api/storage/config",
        "/api/storage/list",
        "/api/storage/file",
    ] {
        for method in [Method::GET, Method::HEAD] {
            assert_eq!(
                call(&app, request(method, path, None), Body::empty())
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
    }
    for path in [
        "/api/auth/guest",
        "/api/auth/password",
        "/api/auth/logout",
        "/api/storage/config",
        "/api/storage/test",
        "/api/storage/disconnect",
    ] {
        assert_eq!(
            call(&app, write_request(path, None, Some(&csrf)), "{}")
                .await
                .status(),
            StatusCode::UNAUTHORIZED,
            "{path}"
        );
    }
    let admin = json_body(
        call(
            &app,
            request(Method::GET, "/api/auth/session", Some(&cookie)),
            Body::empty(),
        )
        .await,
    )
    .await;
    assert_eq!(admin["authenticated"], true);
    assert_eq!(admin["canChangePassword"], true);
    assert!(admin.get("guest").is_none());

    assert_eq!(
        set_guest(&app, &cookie, &csrf, false).await.status(),
        StatusCode::NO_CONTENT
    );
    for method in [Method::GET, Method::HEAD] {
        let response = call(
            &app,
            request(method, &original, None)
                .header(header::IF_NONE_MATCH, &etag)
                .header(header::RANGE, "bytes=0-7"),
            Body::empty(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
    let response = call(&app, request(Method::GET, "/", None), Body::empty()).await;
    assert_eq!(response.headers()[header::LOCATION], "/login");
    assert_eq!(
        call(
            &app,
            request(Method::GET, &original, Some(&cookie)),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn guest_settings_validate_admin_origin_csrf_payload_and_revoked_sessions() {
    let (cache, _gallery, app, _id, cookie, csrf) = guest_fixture().await;
    for (request_cookie, token, status) in [
        (None, None, StatusCode::UNAUTHORIZED),
        (Some(cookie.as_str()), None, StatusCode::FORBIDDEN),
        (Some(cookie.as_str()), Some("forged"), StatusCode::FORBIDDEN),
    ] {
        assert_eq!(
            call(
                &app,
                write_request("/api/auth/guest", request_cookie, token),
                "{\"enabled\":true}"
            )
            .await
            .status(),
            status
        );
    }
    let response = call(
        &app,
        request(Method::POST, "/api/auth/guest", Some(&cookie))
            .header("x-csrf-token", &csrf)
            .header(header::CONTENT_TYPE, "application/json"),
        "{\"enabled\":true}",
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    for invalid in [
        "{}",
        "{\"enabled\":\"true\"}",
        "{\"enabled\":true,\"admin\":true}",
    ] {
        assert_eq!(
            call(
                &app,
                write_request("/api/auth/guest", Some(&cookie), Some(&csrf)),
                invalid
            )
            .await
            .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(
        call(
            &app,
            write_request("/api/auth/guest", Some(&cookie), Some(&csrf)),
            " ".repeat(1025)
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(!cache.path().join("auth/guest.json").exists());
    assert_eq!(
        set_guest(&app, &cookie, &csrf, true).await.status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            write_request("/api/auth/logout", Some(&cookie), Some(&csrf)),
            "{}"
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        set_guest(&app, &cookie, &csrf, false).await.status(),
        StatusCode::UNAUTHORIZED
    );
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
    assert_eq!(
        json_body(
            call(
                &app,
                request(Method::GET, "/api/auth/session", Some(&cookie)),
                Body::empty()
            )
            .await
        )
        .await["guest"],
        true
    );
}

#[tokio::test]
async fn guest_mode_survives_restart_and_supports_deployment_managed_accounts() {
    let (cache, _gallery, app, _id, cookie, csrf) = guest_fixture().await;
    assert_eq!(
        set_guest(&app, &cookie, &csrf, true).await.status(),
        StatusCode::NO_CONTENT
    );
    let path = cache.path().join("auth/guest.json");
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(),
        json!({"enabled": true})
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    for managed in [false, true] {
        let config = AuthConfig::from_sources(cache.path(), cache.path(), &|key| {
            (managed && key == "PIXHELF_AUTH_PASSWORD_HASH")
                .then(|| OsString::from(password_hash()))
        })
        .unwrap();
        let (_gallery, restarted, _) = fixture_with_config(config).await;
        assert_eq!(
            call(&restarted, request(Method::GET, "/", None), Body::empty())
                .await
                .status(),
            StatusCode::OK
        );
        let response = sign_in(&restarted, None).await;
        let cookie = session_cookie(&response);
        let csrf = json_body(response).await["csrfToken"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            set_guest(&restarted, &cookie, &csrf, false).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            set_guest(&restarted, &cookie, &csrf, true).await.status(),
            StatusCode::NO_CONTENT
        );
    }
}

#[tokio::test]
async fn failed_guest_saves_keep_access_closed_and_uninitialized_sites_stay_private() {
    let (cache, _gallery, app, _id, cookie, csrf) = guest_fixture().await;
    let path = cache.path().join("auth/guest.json");
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        set_guest(&app, &cookie, &csrf, true).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        call(
            &app,
            request(Method::GET, "/api/gallery", None),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    std::fs::remove_dir(&path).unwrap();
    assert_eq!(
        set_guest(&app, &cookie, &csrf, true).await.status(),
        StatusCode::NO_CONTENT
    );
    std::fs::remove_file(cache.path().join("auth/account.json")).unwrap();
    let config = AuthConfig::from_sources(cache.path(), cache.path(), &|_| None).unwrap();
    let (_gallery, uninitialized, _) = fixture_with_config(config).await;
    let response = call(
        &uninitialized,
        request(Method::GET, "/", None),
        Body::empty(),
    )
    .await;
    assert_eq!(response.headers()[header::LOCATION], "/setup");
    assert_eq!(
        call(
            &uninitialized,
            request(Method::GET, "/api/gallery", None),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    for invalid in [
        "{",
        "{\"enabled\":\"true\"}",
        "{\"enabled\":true,\"unknown\":1}",
    ] {
        std::fs::write(&path, invalid).unwrap();
        assert!(AuthConfig::from_sources(cache.path(), cache.path(), &|_| None).is_err());
    }
}
