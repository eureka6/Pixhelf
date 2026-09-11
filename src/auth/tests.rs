use std::{ffi::OsString, sync::OnceLock};

use argon2::{PasswordHasher, password_hash::SaltString};
use axum::body::{Body, to_bytes};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::RwLock;
use tower::ServiceExt;

use super::*;
use crate::{gallery::scan_gallery, thumbs::ThumbnailManager, web::AppState};

#[path = "setup_tests.rs"]
mod setup_tests;

#[path = "password_tests.rs"]
mod password_tests;

#[path = "guest_tests.rs"]
mod guest_tests;

const ORIGIN: &str = "https://photos.example.test";
const PASSWORD: &str = "test-only-long-password";

fn password_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        Argon2::default()
            .hash_password(PASSWORD.as_bytes(), &SaltString::generate(&mut OsRng))
            .unwrap()
            .to_string()
    })
}

fn config() -> AuthConfig {
    AuthConfig {
        credentials: Some(Credentials {
            username: "admin".into(),
            password_hash: password_hash().into(),
            account_path: None,
            public_origin: None,
            trusted_proxies: Vec::new(),
        }),
        setup: None,
        ..AuthConfig::default()
    }
}

fn parse_config(settings: &[(&str, &str)]) -> anyhow::Result<AuthConfig> {
    let cache = tempfile::tempdir().unwrap();
    AuthConfig::from_sources(std::path::Path::new("/"), cache.path(), &|name| {
        settings
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| OsString::from(value))
    })
}

#[test]
fn configuration_fails_closed_and_never_formats_credentials() {
    let initial = parse_config(&[]).unwrap();
    assert!(initial.enabled() && initial.setup.is_some() && initial.credentials.is_none());
    assert!(parse_config(&[("PIXHELF_AUTH_ENABLED", "typo")]).is_err());
    assert!(
        parse_config(&[("PIXHELF_AUTH_ENABLED", "false")])
            .unwrap()
            .credentials
            .is_none()
    );
    assert!(
        parse_config(&[
            ("PIXHELF_AUTH_ENABLED", "false"),
            ("PIXHELF_AUTH_PASSWORD_HASH", password_hash())
        ])
        .is_err()
    );
    assert!(parse_config(&[("PIXHELF_AUTH_PASSWORD_HASH", password_hash())]).is_ok());
    assert!(
        parse_config(&[
            ("PIXHELF_AUTH_PASSWORD_HASH", password_hash()),
            ("PIXHELF_AUTH_PASSWORD_HASH_FILE", "/missing")
        ])
        .is_err()
    );
    let valid = parse_config(&[
        ("PIXHELF_AUTH_PASSWORD_HASH", password_hash()),
        ("PIXHELF_PUBLIC_URL", ORIGIN),
    ])
    .unwrap();
    assert_eq!(valid.credentials.as_ref().unwrap().username, "admin");
    assert!(!format!("{valid:?}").contains(password_hash()));
}

#[test]
fn configuration_rejects_unsafe_origins_hashes_and_proxy_ranges() {
    for origin in [
        "ftp://photos.example.test",
        "https://admin@photos.example.test",
        "https://photos.example.test/subpath",
        "https://photos.example.test/?a=b",
        "https://photos.example.test/#fragment",
        "invalid",
    ] {
        assert!(
            parse_config(&[
                ("PIXHELF_AUTH_PASSWORD_HASH", password_hash()),
                ("PIXHELF_PUBLIC_URL", origin)
            ])
            .is_err(),
            "{origin}"
        );
    }
    for hash in [
        "plaintext".to_owned(),
        password_hash().replace("argon2id", "argon2i"),
        password_hash().replace("m=19456", "m=1024"),
        password_hash().replace("t=2", "t=1"),
        password_hash().replace("m=19456", "m=1048576"),
    ] {
        assert!(
            parse_config(&[
                ("PIXHELF_AUTH_PASSWORD_HASH", &hash),
                ("PIXHELF_PUBLIC_URL", ORIGIN)
            ])
            .is_err()
        );
    }
    for (key, value) in [
        ("PIXHELF_TRUSTED_PROXIES", "0.0.0.0/0"),
        ("PIXHELF_TRUSTED_PROXIES", "::/0"),
        ("PIXHELF_TRUSTED_PROXIES", "unknown"),
        ("PIXHELF_AUTH_USERNAME", " admin"),
        ("PIXHELF_AUTH_USERNAME", "admin\n"),
        ("PIXHELF_AUTH_USERNAME", ""),
    ] {
        assert!(
            parse_config(&[
                ("PIXHELF_AUTH_PASSWORD_HASH", password_hash()),
                ("PIXHELF_PUBLIC_URL", ORIGIN),
                (key, value)
            ])
            .is_err()
        );
    }
    let valid = parse_config(&[
        ("PIXHELF_AUTH_PASSWORD_HASH", password_hash()),
        ("PIXHELF_PUBLIC_URL", "https://PHOTOS.example.test:443/"),
        ("PIXHELF_TRUSTED_PROXIES", "127.0.0.1/32,::1/128"),
    ])
    .unwrap();
    assert_eq!(
        valid.credentials.unwrap().public_origin.as_deref(),
        Some(ORIGIN)
    );
    let http = parse_config(&[
        ("PIXHELF_AUTH_PASSWORD_HASH", password_hash()),
        ("PIXHELF_PUBLIC_URL", "http://PHOTOS.example.test:80/"),
    ])
    .unwrap();
    assert_eq!(
        http.credentials.unwrap().public_origin.as_deref(),
        Some("http://photos.example.test")
    );
}

#[test]
fn hash_file_accepts_a_trailing_newline_and_rejects_missing_or_oversized_files() {
    let temp = tempfile::tempdir().unwrap();
    let hash_file = temp.path().join("password.hash");
    let settings = [
        (
            "PIXHELF_AUTH_PASSWORD_HASH_FILE",
            hash_file.to_str().unwrap(),
        ),
        ("PIXHELF_PUBLIC_URL", ORIGIN),
    ];
    assert!(parse_config(&settings).is_err());
    std::fs::write(&hash_file, format!("{}\n", password_hash())).unwrap();
    assert_eq!(
        parse_config(&settings)
            .unwrap()
            .credentials
            .unwrap()
            .password_hash,
        password_hash()
    );
    std::fs::write(
        &hash_file,
        format!("{}{}", password_hash(), " ".repeat(1100)),
    )
    .unwrap();
    assert!(parse_config(&settings).is_err());
}

async fn fixture() -> (TempDir, Router, String) {
    fixture_with_config(config()).await
}

async fn fixture_with_config(auth: AuthConfig) -> (TempDir, Router, String) {
    fixture_with_motion(auth, false).await
}

async fn fixture_with_motion(auth: AuthConfig, live: bool) -> (TempDir, Router, String) {
    let temp = tempfile::tempdir().unwrap();
    let gallery = temp.path().join("gallery");
    std::fs::create_dir(&gallery).unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([220, 80, 40]))
        .save(gallery.join("private-photo.png"))
        .unwrap();
    if live {
        std::fs::write(
            gallery.join("private-photo.mp4"),
            crate::motion::tests::video_bytes(),
        )
        .unwrap();
    }
    let index = scan_gallery(&gallery, None).unwrap();
    let id = index.images[0].id.clone();
    let thumbnails = ThumbnailManager::new(temp.path().join("cache")).unwrap();
    thumbnails.reconcile(&index.images);
    thumbnails.start_workers(1);
    thumbnails.ensure_ready(&id).await.unwrap();
    let app = crate::web::router(
        AppState {
            index: Arc::new(RwLock::new(Arc::new(index))),
            thumbnails,
        },
        auth,
    );
    (temp, app, id)
}

fn request(method: Method, uri: &str, cookie: Option<&str>) -> axum::http::request::Builder {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .extension(ConnectInfo(
            "127.0.0.1:12345".parse::<SocketAddr>().unwrap(),
        ));
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    builder
}

async fn call(
    app: &Router,
    builder: axum::http::request::Builder,
    body: impl Into<Body>,
) -> Response {
    app.clone()
        .oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap()
}

async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

fn session_cookie(response: &Response) -> String {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .find_map(|value| {
            let value = value.to_str().unwrap();
            value
                .starts_with(COOKIE_NAME)
                .then(|| value.split(';').next().unwrap().to_owned())
        })
        .expect("session cookie")
}

async fn sign_in(app: &Router, cookie: Option<&str>) -> Response {
    call(
        app,
        request(Method::POST, "/api/auth/login", cookie)
            .header(header::ORIGIN, ORIGIN)
            .header(ORIGIN_HEADER, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json"),
        json!({"username": "admin", "password": PASSWORD}).to_string(),
    )
    .await
}

#[tokio::test]
async fn anonymous_requests_cannot_access_bootstrap_apis_or_conditional_media() {
    let (_temp, app, id) = fixture().await;
    let root = call(&app, request(Method::GET, "/", None), Body::empty()).await;
    assert_eq!(root.status(), StatusCode::SEE_OTHER);
    assert_eq!(root.headers()[header::LOCATION], "/login");
    assert_eq!(root.headers()[header::CACHE_CONTROL], "no-store");
    for path in [
        "/api/gallery".into(),
        "/api/status".into(),
        "/api/images".into(),
        format!("/api/images/{id}/details"),
        format!("/api/images/{id}/similar"),
        format!("/api/images/{id}/thumbnail"),
        format!("/api/images/{id}/original"),
        format!("/api/images/{id}/motion/original/missing"),
        "/not-a-public-route".into(),
    ] {
        for method in [Method::GET, Method::HEAD] {
            let response = call(
                &app,
                request(method, &path, None)
                    .header(header::IF_NONE_MATCH, "*")
                    .header(header::RANGE, "bytes=0-7"),
                Body::empty(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(!response.headers().contains_key(header::SET_COOKIE));
        }
    }
    let response = call(&app, request(Method::GET, "/login", None), Body::empty()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(
        response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    let html = String::from_utf8(
        to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("\"authenticated\":false"));
    assert!(!html.contains("private-photo"));
    assert!(!html.contains("\"total\""));
    assert!(!html.contains("rel=\"preload\" as=\"image\""));
    let assets = html
        .split("/assets/")
        .skip(1)
        .map(|part| format!("/assets/{}", part.split('"').next().unwrap()))
        .collect::<Vec<_>>();
    assert!(!assets.is_empty());
    for asset in assets {
        assert_eq!(
            call(&app, request(Method::GET, &asset, None), Body::empty())
                .await
                .status(),
            StatusCode::OK
        );
    }
    let health = call(
        &app,
        request(Method::GET, "/api/health", None),
        Body::empty(),
    )
    .await;
    assert_eq!(to_bytes(health.into_body(), 32).await.unwrap(), "ok");
    let session = json_body(
        call(
            &app,
            request(Method::GET, "/api/auth/session", None),
            Body::empty(),
        )
        .await,
    )
    .await;
    assert_eq!(session, json!({"enabled": true, "authenticated": false}));
}

#[tokio::test]
async fn login_enforces_origin_json_limits_and_generic_credential_errors() {
    let (_temp, app, _) = fixture().await;
    let body = json!({"username": "admin", "password": PASSWORD}).to_string();
    for origin in [
        None,
        Some("https://evil.example"),
        Some("null"),
        Some("http://photos.example.test"),
    ] {
        let mut builder = request(Method::POST, "/api/auth/login", None)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            builder = builder
                .header(header::ORIGIN, origin)
                .header(ORIGIN_HEADER, ORIGIN);
        }
        let response = call(&app, builder, body.clone()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!response.headers().contains_key(header::SET_COOKIE));
    }
    for builder in [
        request(Method::POST, "/api/auth/login", None)
            .header(header::ORIGIN, ORIGIN)
            .header(ORIGIN_HEADER, ORIGIN)
            .header(header::ORIGIN, ORIGIN)
            .header(ORIGIN_HEADER, ORIGIN),
        request(Method::POST, "/api/auth/login", None)
            .header(header::ORIGIN, ORIGIN)
            .header(ORIGIN_HEADER, ORIGIN)
            .header("sec-fetch-site", "cross-site"),
    ] {
        assert_eq!(
            call(
                &app,
                builder.header(header::CONTENT_TYPE, "application/json"),
                body.clone()
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    let response = call(
        &app,
        request(Method::POST, "/api/auth/login", None)
            .header(header::ORIGIN, ORIGIN)
            .header(ORIGIN_HEADER, ORIGIN)
            .header(header::CONTENT_TYPE, "text/plain"),
        body,
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    for (body, status) in [
        ("{".into(), StatusCode::BAD_REQUEST),
        (
            json!({"username":"admin","password":PASSWORD,"extra":true}).to_string(),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (" ".repeat(4097), StatusCode::PAYLOAD_TOO_LARGE),
        (
            json!({"username":"admin","password":"x".repeat(1025)}).to_string(),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        assert_eq!(
            call(
                &app,
                request(Method::POST, "/api/auth/login", None)
                    .header(header::ORIGIN, ORIGIN)
                    .header(ORIGIN_HEADER, ORIGIN)
                    .header(header::CONTENT_TYPE, "application/json"),
                body
            )
            .await
            .status(),
            status
        );
    }
    let mut errors = Vec::new();
    for (username, password) in [("admin", "wrong-password"), ("unknown", PASSWORD)] {
        let response = call(
            &app,
            request(Method::POST, "/api/auth/login", None)
                .header(header::ORIGIN, ORIGIN)
                .header(ORIGIN_HEADER, ORIGIN)
                .header(header::CONTENT_TYPE, "application/json"),
            json!({"username":username,"password":password}).to_string(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        errors.push(json_body(response).await);
    }
    assert_eq!(errors[0], errors[1]);
}

#[tokio::test]
async fn login_requires_matching_custom_origin_and_does_not_grant_cors_access() {
    let (_temp, app, _) = fixture().await;
    let body = json!({"username": "admin", "password": PASSWORD}).to_string();
    for (origin, page_origin, fetch_site) in [
        (Some(ORIGIN), None, None),
        (None, Some(ORIGIN), None),
        (Some("null"), Some("null"), None),
        (
            Some("ftp://photos.example.test"),
            Some("ftp://photos.example.test"),
            None,
        ),
        (
            Some("https://photos.example.test/path"),
            Some("https://photos.example.test/path"),
            None,
        ),
        (Some("https://evil.example"), Some(ORIGIN), None),
        (Some(ORIGIN), Some(ORIGIN), Some("cross-site")),
        (Some(ORIGIN), Some(ORIGIN), Some("same-site")),
    ] {
        let mut builder = request(Method::POST, "/api/auth/login", None)
            .header(header::CONTENT_TYPE, "application/json");
        for (name, value) in [
            ("origin", origin),
            (ORIGIN_HEADER, page_origin),
            ("sec-fetch-site", fetch_site),
        ] {
            if let Some(value) = value {
                builder = builder.header(name, value);
            }
        }
        let response = call(&app, builder, body.clone()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!response.headers().contains_key(header::SET_COOKIE));
    }
    for duplicate in ["origin", ORIGIN_HEADER, "sec-fetch-site"] {
        let response = call(
            &app,
            request(Method::POST, "/api/auth/login", None)
                .header(header::ORIGIN, ORIGIN)
                .header(ORIGIN_HEADER, ORIGIN)
                .header("sec-fetch-site", "same-origin")
                .header(
                    duplicate,
                    if duplicate == "sec-fetch-site" {
                        "same-origin"
                    } else {
                        ORIGIN
                    },
                )
                .header(header::CONTENT_TYPE, "application/json"),
            body.clone(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    for path in ["/api/auth/login", "/api/auth/setup", "/api/auth/logout"] {
        let response = call(
            &app,
            request(Method::OPTIONS, path, None)
                .header(header::ORIGIN, "https://evil.example")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS,
                    "content-type, x-pixhelf-origin",
                ),
            Body::empty(),
        )
        .await;
        assert!(!response.status().is_success());
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
        assert!(!response.headers().contains_key(header::SET_COOKIE));
    }
}

#[tokio::test]
async fn sessions_at_different_addresses_keep_their_own_cookie_security() {
    let (_temp, app, _) = fixture().await;
    let mut sessions = Vec::new();
    for origin in [
        "https://photos.example.test",
        "http://192.168.1.50:3002",
        "https://gallery.example.test:8443",
        "http://[::1]:3002",
    ] {
        let response = call(
            &app,
            request(Method::POST, "/api/auth/login", None)
                .header(header::ORIGIN, origin)
                .header(ORIGIN_HEADER, origin)
                .header(header::HOST, "pixhelf:3002")
                .header(
                    "x-forwarded-proto",
                    if origin.starts_with("https:") {
                        "http"
                    } else {
                        "https"
                    },
                )
                .header(header::CONTENT_TYPE, "application/json"),
            json!({"username": "admin", "password": PASSWORD}).to_string(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{origin}");
        let secure = origin.starts_with("https:");
        let cookie = session_cookie(&response);
        let parsed =
            Cookie::parse(response.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
        assert_eq!(parsed.secure() == Some(true), secure);
        let account = json_body(response).await;
        assert!(account.get("secureCookie").is_none());
        sessions.push((
            origin,
            secure,
            cookie,
            account["csrfToken"].as_str().unwrap().to_owned(),
        ));
    }
    // Interleave refreshes after all logins: no global setting may change another session's flag.
    for (origin, secure, cookie, csrf) in sessions {
        for path in ["/", "/api/auth/session", "/api/gallery"] {
            let response = call(
                &app,
                request(Method::GET, path, Some(&cookie)),
                Body::empty(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let parsed =
                Cookie::parse(response.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
            assert_eq!(parsed.secure() == Some(true), secure);
        }
        let response = call(
            &app,
            request(Method::POST, "/api/auth/logout", Some(&cookie))
                .header(header::ORIGIN, origin)
                .header(ORIGIN_HEADER, origin)
                .header("x-csrf-token", csrf),
            Body::empty(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let removed =
            Cookie::parse(response.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
        assert_eq!(removed.secure() == Some(true), secure);
        assert_eq!(removed.max_age(), Some(time::Duration::ZERO));
    }
}

#[tokio::test]
async fn an_explicit_public_url_still_restricts_login_addresses() {
    let mut auth = config();
    auth.credentials.as_mut().unwrap().public_origin = Some(ORIGIN.into());
    let (_temp, app, _) = fixture_with_config(auth).await;
    let origin = "http://photos.example.test:3002";
    let response = call(
        &app,
        request(Method::POST, "/api/auth/login", None)
            .header(header::ORIGIN, origin)
            .header(ORIGIN_HEADER, origin)
            .header(header::CONTENT_TYPE, "application/json"),
        json!({"username": "admin", "password": PASSWORD}).to_string(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(sign_in(&app, None).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn valid_session_protects_cached_and_range_responses_until_csrf_checked_logout() {
    let (_temp, app, id) = fixture_with_motion(config(), true).await;
    let login = sign_in(&app, None).await;
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = session_cookie(&login);
    let parsed = Cookie::parse(login.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
    assert_eq!(parsed.name(), COOKIE_NAME);
    assert_eq!(parsed.secure(), Some(true));
    assert_eq!(parsed.http_only(), Some(true));
    assert_eq!(parsed.same_site(), Some(SameSite::Lax));
    assert_eq!(parsed.path(), Some("/"));
    assert_eq!(parsed.domain(), None);
    let account = json_body(login).await;
    let csrf = account["csrfToken"].as_str().unwrap();
    assert_eq!(csrf.len(), 64);
    assert_eq!(account["authenticated"], true);
    let image = json_body(
        call(
            &app,
            request(Method::GET, &format!("/api/images/{id}"), Some(&cookie)),
            Body::empty(),
        )
        .await,
    )
    .await;
    let motion = image["motion"].as_str().unwrap().to_owned();
    let page = call(
        &app,
        request(Method::GET, "/", Some(&cookie)),
        Body::empty(),
    )
    .await;
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
    let page_etag = page.headers()[header::ETAG].clone();
    let html = String::from_utf8(
        to_bytes(page.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(html.contains("private-photo.png"));
    assert!(html.contains(csrf));
    let asset = format!(
        "/assets/{}",
        html.split("/assets/")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
    );
    for path in [asset.as_str(), "/api/health"] {
        let public = call(
            &app,
            request(Method::GET, path, Some(&cookie)),
            Body::empty(),
        )
        .await;
        assert_eq!(public.status(), StatusCode::OK);
        assert!(
            !public.headers().contains_key(header::SET_COOKIE),
            "public responses must not cache a session cookie"
        );
    }
    // A bootstrap with a previous session's CSRF token must never be reused via 304.
    assert_eq!(
        call(
            &app,
            request(Method::GET, "/", Some(&cookie)).header(header::IF_NONE_MATCH, page_etag),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    for path in [
        "/api/gallery".into(),
        "/api/status".into(),
        "/api/images".into(),
        format!("/api/images/{id}/thumbnail"),
        format!("/api/images/{id}/original"),
        motion.clone(),
    ] {
        let response = call(
            &app,
            request(Method::GET, &path, Some(&cookie)),
            Body::empty(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            if path == "/api/status" {
                "no-store"
            } else {
                "private, no-cache"
            }
        );
        assert!(
            response
                .headers()
                .get_all(header::VARY)
                .iter()
                .any(|value| value.to_str().unwrap().contains("Cookie"))
        );
        if let Some(etag) = response.headers().get(header::ETAG) {
            let cached = call(
                &app,
                request(Method::GET, &path, Some(&cookie)).header(header::IF_NONE_MATCH, etag),
                Body::empty(),
            )
            .await;
            assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
            assert_eq!(cached.headers()[header::CACHE_CONTROL], "private, no-cache");
        }
    }
    let original = format!("/api/images/{id}/original");
    for path in [&original, &motion] {
        let range = call(
            &app,
            request(Method::GET, path, Some(&cookie)).header(header::RANGE, "bytes=0-7"),
            Body::empty(),
        )
        .await;
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range.headers()[header::CACHE_CONTROL], "private, no-cache");
        assert_eq!(to_bytes(range.into_body(), 100).await.unwrap().len(), 8);
    }
    for (origin, token) in [
        (ORIGIN, ""),
        (ORIGIN, "forged"),
        ("https://evil.example", csrf),
    ] {
        assert_eq!(
            call(
                &app,
                request(Method::POST, "/api/auth/logout", Some(&cookie))
                    .header(header::ORIGIN, origin)
                    .header(ORIGIN_HEADER, ORIGIN)
                    .header("x-csrf-token", token),
                Body::empty()
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
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
    let logout = call(
        &app,
        request(Method::POST, "/api/auth/logout", Some(&cookie))
            .header(header::ORIGIN, ORIGIN)
            .header(ORIGIN_HEADER, ORIGIN)
            .header("x-csrf-token", csrf),
        Body::empty(),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    let removed = Cookie::parse(logout.headers()[header::SET_COOKIE].to_str().unwrap()).unwrap();
    assert_eq!(removed.secure(), Some(true));
    assert_eq!(removed.max_age(), Some(time::Duration::ZERO));
    for path in [
        "/api/gallery".into(),
        format!("/api/images/{id}/thumbnail"),
        original,
        motion,
    ] {
        assert_eq!(
            call(
                &app,
                request(Method::GET, &path, Some(&cookie))
                    .header(header::IF_NONE_MATCH, "*")
                    .header(header::RANGE, "bytes=0-7"),
                Body::empty()
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn login_rotates_existing_session_and_unknown_cookie_cannot_fixate_it() {
    let (_temp, app, _) = fixture().await;
    let forged = format!("{COOKIE_NAME}={}", tower_sessions::session::Id::default());
    let first = sign_in(&app, Some(&forged)).await;
    assert_eq!(first.status(), StatusCode::OK);
    let old_cookie = session_cookie(&first);
    assert_ne!(old_cookie, forged);
    let first_csrf = json_body(first).await["csrfToken"].clone();
    let second = sign_in(&app, Some(&old_cookie)).await;
    assert_eq!(second.status(), StatusCode::OK);
    let new_cookie = session_cookie(&second);
    assert_ne!(new_cookie, old_cookie);
    assert_ne!(json_body(second).await["csrfToken"], first_csrf);
    assert_eq!(
        call(
            &app,
            request(Method::GET, "/api/gallery", Some(&old_cookie)),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            request(Method::GET, "/api/gallery", Some(&new_cookie)),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    let login_page = call(
        &app,
        request(Method::GET, "/login", Some(&new_cookie)),
        Body::empty(),
    )
    .await;
    assert_eq!(login_page.status(), StatusCode::SEE_OTHER);
    assert_eq!(login_page.headers()[header::LOCATION], "/");
    let (_other_temp, restarted, _) = fixture().await;
    assert_eq!(
        call(
            &restarted,
            request(Method::GET, "/api/gallery", Some(&new_cookie)),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn proxy_headers_are_used_only_from_trusted_peers_and_cannot_spoof_the_leftmost_hop() {
    let mut credentials = config().credentials.unwrap();
    let make = |peer: &str, forwarded: &str| {
        Request::builder()
            .extension(ConnectInfo(peer.parse::<SocketAddr>().unwrap()))
            .header("x-forwarded-for", forwarded)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        client_ip(
            &make("127.0.0.1:1234", "198.51.100.1"),
            &credentials.trusted_proxies
        )
        .to_string(),
        "127.0.0.1"
    );
    credentials.trusted_proxies = vec![
        "127.0.0.1/32".parse().unwrap(),
        "10.0.0.0/24".parse().unwrap(),
    ];
    assert_eq!(
        client_ip(
            &make("127.0.0.1:1234", "198.51.100.1, 203.0.113.10, 10.0.0.2"),
            &credentials.trusted_proxies
        )
        .to_string(),
        "203.0.113.10"
    );
    assert_eq!(
        client_ip(
            &make("203.0.113.20:1234", "198.51.100.1"),
            &credentials.trusted_proxies
        )
        .to_string(),
        "203.0.113.20"
    );
    for forwarded in [
        "garbage",
        "198.51.100.1, unknown",
        "",
        &"10.0.0.2,".repeat(20),
        &"x".repeat(1025),
    ] {
        assert_eq!(
            client_ip(
                &make("127.0.0.1:1234", forwarded),
                &credentials.trusted_proxies
            )
            .to_string(),
            "127.0.0.1"
        );
    }
}

#[test]
fn login_rate_limit_caps_per_ip_global_work_and_memory_then_recovers() {
    let mut attempts = LoginAttempts::default();
    let now = Instant::now();
    let first = "192.0.2.1".parse().unwrap();
    for _ in 0..IP_LOGIN_LIMIT {
        assert!(attempts.allow(first, now));
    }
    assert!(!attempts.allow(first, now));
    for host in 2..=21 {
        assert!(attempts.allow(IpAddr::from([192, 0, 2, host]), now));
    }
    for host in 22..=254 {
        assert!(!attempts.allow(IpAddr::from([192, 0, 2, host]), now));
    }
    assert!(attempts.clients.len() <= GLOBAL_LOGIN_LIMIT);
    assert!(attempts.allow(first, now + RATE_WINDOW));
    assert_eq!(attempts.clients.len(), 1);
}

#[tokio::test]
async fn login_rejects_overload_before_password_work_and_returns_retry_after() {
    let state = AuthState::new(config());
    let session_layer = state.session_layer();
    let held = state
        .password_workers
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let app = router(state.clone()).layer(session_layer);
    let response = sign_in(&app, None).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()[header::RETRY_AFTER], "1");
    drop(held);
    for _ in 1..IP_LOGIN_LIMIT {
        let response = call(
            &app,
            request(Method::POST, "/api/auth/login", None)
                .header(header::ORIGIN, ORIGIN)
                .header(ORIGIN_HEADER, ORIGIN)
                .header(header::CONTENT_TYPE, "application/json"),
            "{",
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let response = sign_in(&app, None).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()[header::RETRY_AFTER], "60");
}
