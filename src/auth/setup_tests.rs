use super::*;

fn fresh_config(cache: &TempDir) -> AuthConfig {
    AuthConfig::from_sources(cache.path(), cache.path(), &|_| None).unwrap()
}

async fn initialize(app: &Router, username: &str) -> Response {
    setup_request(app, json!({ "username": username, "password": PASSWORD })).await
}

async fn setup_request(app: &Router, body: Value) -> Response {
    call(
        app,
        request(Method::POST, "/api/auth/setup", None)
            .header(header::ORIGIN, ORIGIN)
            .header(ORIGIN_HEADER, ORIGIN)
            .header(header::HOST, "pixhelf:3002")
            .header("sec-fetch-site", "same-origin")
            .header(header::CONTENT_TYPE, "application/json"),
        body.to_string(),
    )
    .await
}

#[tokio::test]
async fn unconfigured_instance_keeps_gallery_private_until_the_first_account_is_created() {
    let cache = tempfile::tempdir().unwrap();
    let initial = fresh_config(&cache);
    let setup = initial.setup.clone().unwrap();
    let (_gallery, app, id) = fixture_with_config(initial).await;
    for path in ["/", "/login"] {
        let response = call(&app, request(Method::GET, path, None), Body::empty()).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()[header::LOCATION], "/setup");
    }
    let page = call(&app, request(Method::GET, "/setup", None), Body::empty()).await;
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
    let html = String::from_utf8(
        to_bytes(page.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("\"setupRequired\":true"));
    assert!(!html.contains("private-photo.png"));
    let session = json_body(
        call(
            &app,
            request(Method::GET, "/api/auth/session", None),
            Body::empty(),
        )
        .await,
    )
    .await;
    assert_eq!(
        session,
        json!({ "enabled": true, "authenticated": false, "setupRequired": true, "username": "admin" })
    );
    for path in [
        "/api/gallery".into(),
        "/api/images".into(),
        "/api/status".into(),
        format!("/api/images/{id}/thumbnail"),
        format!("/api/images/{id}/original"),
    ] {
        assert_eq!(
            call(
                &app,
                request(Method::GET, &path, None)
                    .header(header::IF_NONE_MATCH, "*")
                    .header(header::RANGE, "bytes=0-7"),
                Body::empty()
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert!(!setup.path.exists());
    assert_eq!(sign_in(&app, None).await.status(), StatusCode::CONFLICT);
    assert_eq!(initialize(&app, "admin").await.status(), StatusCode::OK);
    assert!(setup.path.exists());
}

#[tokio::test]
async fn setup_validates_origin_json_password_and_request_size() {
    let cache = tempfile::tempdir().unwrap();
    let initial = fresh_config(&cache);
    let setup = initial.setup.clone().unwrap();
    let (_gallery, app, _) = fixture_with_config(initial).await;
    let valid = json!({ "username": "admin", "password": PASSWORD });
    for origin in [
        None,
        Some("ftp://photos.example.test"),
        Some("null"),
        Some("https://photos.example.test/path"),
    ] {
        let mut builder = request(Method::POST, "/api/auth/setup", None)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            builder = builder
                .header(header::ORIGIN, origin)
                .header(ORIGIN_HEADER, ORIGIN);
        }
        assert_eq!(
            call(&app, builder, valid.to_string()).await.status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(
            &app,
            request(Method::POST, "/api/auth/setup", None)
                .header(header::ORIGIN, ORIGIN)
                .header(ORIGIN_HEADER, ORIGIN)
                .header("sec-fetch-site", "cross-site")
                .header(header::CONTENT_TYPE, "application/json"),
            valid.to_string()
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    for (key, value) in [("password", "short"), ("username", "bad\nname")] {
        let mut body = valid.clone();
        body[key] = value.into();
        assert_eq!(
            setup_request(&app, body).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    let mut injected = valid.clone();
    injected["publicOrigin"] = "https://evil.example".into();
    assert_eq!(
        setup_request(&app, injected).await.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &app,
            request(Method::POST, "/api/auth/setup", None)
                .header(header::ORIGIN, ORIGIN)
                .header(ORIGIN_HEADER, ORIGIN)
                .header(header::CONTENT_TYPE, "text/plain"),
            valid.to_string()
        )
        .await
        .status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        call(
            &app,
            request(Method::POST, "/api/auth/setup", None)
                .header(header::ORIGIN, ORIGIN)
                .header(ORIGIN_HEADER, ORIGIN)
                .header(header::CONTENT_TYPE, "application/json"),
            " ".repeat(8193)
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(!setup.path.exists());
}

#[tokio::test]
async fn setup_logs_in_and_survives_restart_without_environment_configuration() {
    let cache = tempfile::tempdir().unwrap();
    let initial = fresh_config(&cache);
    let setup = initial.setup.clone().unwrap();
    let (_gallery, app, _) = fixture_with_config(initial).await;
    let response = initialize(&app, "admin").await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = session_cookie(&response);
    assert_eq!(json_body(response).await["authenticated"], true);
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
    let saved = std::fs::read_to_string(&setup.path).unwrap();
    let account: Value = serde_json::from_str(&saved).unwrap();
    assert!(account.get("publicOrigin").is_none());
    assert!(
        account["passwordHash"]
            .as_str()
            .unwrap()
            .starts_with("$argon2id$")
    );
    assert!(!saved.contains(PASSWORD));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&setup.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(setup.path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    assert_eq!(
        initialize(&app, "replacement").await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(std::fs::read_to_string(&setup.path).unwrap(), saved);
    assert_eq!(
        call(
            &app,
            request(Method::POST, "/api/auth/login", None)
                .header(header::ORIGIN, "https://evil.example")
                .header(header::CONTENT_TYPE, "application/json"),
            json!({"username":"admin","password":PASSWORD}).to_string()
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let restored = fresh_config(&cache);
    assert!(restored.setup.is_none());
    assert!(
        restored
            .credentials
            .as_ref()
            .unwrap()
            .public_origin
            .is_none()
    );
    let (_new_gallery, restarted, _) = fixture_with_config(restored).await;
    assert_eq!(
        call(
            &restarted,
            request(Method::GET, "/api/gallery", Some(&cookie)),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let setup_page = call(
        &restarted,
        request(Method::GET, "/setup", None),
        Body::empty(),
    )
    .await;
    assert_eq!(setup_page.headers()[header::LOCATION], "/login");
    assert_eq!(sign_in(&restarted, None).await.status(), StatusCode::OK);
    assert_eq!(
        initialize(&restarted, "replacement").await.status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn concurrent_setup_cannot_replace_another_process_account() {
    let cache = tempfile::tempdir().unwrap();
    let initial = fresh_config(&cache);
    let setup = initial.setup.clone().unwrap();
    let (_first_gallery, first, _) = fixture_with_config(initial.clone()).await;
    let (_second_gallery, second, _) = fixture_with_config(initial).await;
    let (first, second) = tokio::join!(initialize(&first, "alice"), initialize(&second, "bob"));
    let statuses = [first.status(), second.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CONFLICT)
            .count(),
        1
    );
    let winner = if first.status() == StatusCode::OK {
        json_body(first).await
    } else {
        json_body(second).await
    };
    let account: Value = serde_json::from_slice(&std::fs::read(&setup.path).unwrap()).unwrap();
    assert_eq!(account["username"], winner["username"]);
    assert_eq!(
        std::fs::read_dir(setup.path.parent().unwrap())
            .unwrap()
            .count(),
        1
    );
}

#[tokio::test]
async fn a_failed_save_keeps_gallery_locked_and_can_be_retried() {
    let cache = tempfile::tempdir().unwrap();
    let initial = fresh_config(&cache);
    let setup = initial.setup.clone().unwrap();
    let (_gallery, app, _) = fixture_with_config(initial).await;
    let directory = setup.path.parent().unwrap();
    std::fs::remove_dir(directory).unwrap();
    std::fs::write(directory, "blocked-directory").unwrap();
    assert_eq!(
        initialize(&app, "admin").await.status(),
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
    std::fs::remove_file(directory).unwrap();
    persistence::prepare_directory(directory).unwrap();
    assert_eq!(initialize(&app, "admin").await.status(), StatusCode::OK);
}

#[tokio::test]
async fn http_setup_and_login_survive_restart_with_usable_cookies_and_csrf_protection() {
    const HTTP_ORIGIN: &str = "http://photos.example.test:3002";
    let cache = tempfile::tempdir().unwrap();
    let initial = fresh_config(&cache);
    let (_gallery, app, id) = fixture_with_config(initial).await;
    let response = call(
        &app,
        request(Method::POST, "/api/auth/setup", None)
            .header(header::ORIGIN, HTTP_ORIGIN)
            .header(ORIGIN_HEADER, HTTP_ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            // Forwarding headers must not override the browser origin used for cookies.
            .header("x-forwarded-proto", "https"),
        json!({ "username": "admin", "password": PASSWORD }).to_string(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let parsed = Cookie::parse(response.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
    assert_ne!(parsed.secure(), Some(true));
    assert_eq!(parsed.http_only(), Some(true));
    assert_eq!(parsed.same_site(), Some(SameSite::Lax));
    assert_eq!(parsed.path(), Some("/"));
    assert_eq!(parsed.domain(), None);
    let cookie = session_cookie(&response);
    let original = format!("/api/images/{id}/original");
    let media = call(
        &app,
        request(Method::GET, &original, Some(&cookie)),
        Body::empty(),
    )
    .await;
    assert_eq!(media.status(), StatusCode::OK);
    let refreshed = Cookie::parse(media.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
    assert_ne!(refreshed.secure(), Some(true));

    let restored = fresh_config(&cache);
    assert!(restored.setup.is_none());
    assert!(
        restored
            .credentials
            .as_ref()
            .unwrap()
            .public_origin
            .is_none()
    );
    let (_gallery, restarted, _) = fixture_with_config(restored).await;
    assert_eq!(
        call(
            &restarted,
            request(Method::GET, "/api/gallery", Some(&cookie)),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let login = call(
        &restarted,
        request(Method::POST, "/api/auth/login", None)
            .header(header::ORIGIN, HTTP_ORIGIN)
            .header(ORIGIN_HEADER, HTTP_ORIGIN)
            .header(header::CONTENT_TYPE, "application/json"),
        json!({ "username": "admin", "password": PASSWORD }).to_string(),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = session_cookie(&login);
    let account = json_body(login).await;
    let csrf = account["csrfToken"].as_str().unwrap();
    for (origin, token) in [(HTTP_ORIGIN, "forged"), ("http://evil.example.test", csrf)] {
        assert_eq!(
            call(
                &restarted,
                request(Method::POST, "/api/auth/logout", Some(&cookie))
                    .header(header::ORIGIN, origin)
                    .header(ORIGIN_HEADER, HTTP_ORIGIN)
                    .header("x-csrf-token", token),
                Body::empty()
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    let logout = call(
        &restarted,
        request(Method::POST, "/api/auth/logout", Some(&cookie))
            .header(header::ORIGIN, HTTP_ORIGIN)
            .header(ORIGIN_HEADER, HTTP_ORIGIN)
            .header("x-csrf-token", csrf),
        Body::empty(),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    let removed = Cookie::parse(logout.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
    assert_ne!(removed.secure(), Some(true));
    assert_eq!(removed.max_age(), Some(time::Duration::ZERO));
    assert_eq!(
        call(
            &restarted,
            request(Method::GET, "/api/gallery", Some(&cookie))
                .header(header::IF_NONE_MATCH, "*")
                .header(header::RANGE, "bytes=0-7"),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn saved_origin_is_compatible_but_only_an_explicit_setting_pins_the_address() {
    let cache = tempfile::tempdir().unwrap();
    let path = fresh_config(&cache).setup.unwrap().path;
    let saved = json!({
        "version": 1,
        "username": "admin",
        "passwordHash": password_hash(),
        "publicOrigin": "http://old-address.example.test:3002",
    })
    .to_string();
    std::fs::write(&path, &saved).unwrap();
    let restored = fresh_config(&cache);
    assert!(restored.setup.is_none());
    let credentials = restored.credentials.unwrap();
    assert_eq!(credentials.password_hash, password_hash());
    assert!(credentials.public_origin.is_none());
    let restricted = AuthConfig::from_sources(cache.path(), cache.path(), &|name| {
        (name == "PIXHELF_PUBLIC_URL").then(|| OsString::from(ORIGIN))
    })
    .unwrap();
    assert_eq!(
        restricted.credentials.unwrap().public_origin.as_deref(),
        Some(ORIGIN)
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
}

#[test]
fn corrupt_or_unsupported_saved_accounts_never_reopen_initialization() {
    let cache = tempfile::tempdir().unwrap();
    let path = fresh_config(&cache).setup.unwrap().path;
    for value in ["".to_owned(), "{".into(), json!({"version":99,"username":"admin","passwordHash":password_hash(),"publicOrigin":ORIGIN}).to_string(), json!({"version":1,"username":"admin","passwordHash":"plaintext","publicOrigin":ORIGIN}).to_string(), json!({"version":1,"username":"admin","passwordHash":password_hash(),"publicOrigin":"ftp://photos.example.test"}).to_string()] {
        std::fs::write(&path, &value).unwrap();
        assert!(AuthConfig::from_sources(cache.path(), cache.path(), &|_| None).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), value);
    }
}

#[tokio::test]
async fn user_created_names_cannot_break_the_html_bootstrap() {
    let cache = tempfile::tempdir().unwrap();
    let initial = fresh_config(&cache);
    let (_gallery, app, _) = fixture_with_config(initial).await;
    let username = "</script><script>__PIXHELF_BOOTSTRAP__</script>";
    let response = initialize(&app, username).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = session_cookie(&response);
    let page = call(
        &app,
        request(Method::GET, "/", Some(&cookie)),
        Body::empty(),
    )
    .await;
    let html = String::from_utf8(
        to_bytes(page.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(!html.contains(username));
    let element = html
        .split("id=\"pixhelf-auth\"")
        .nth(1)
        .unwrap()
        .split_once('>')
        .unwrap()
        .1
        .split("</script>")
        .next()
        .unwrap();
    let auth: Value = serde_json::from_str(element).unwrap();
    assert_eq!(auth["username"], username);
}
