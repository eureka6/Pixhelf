use super::*;
use axum::http::{Method, Request};
use tower::ServiceExt;

fn input(changes: Value) -> ConfigInput {
    let mut value = json!({
        "name": "家庭文件", "url": "http://openlist:5244/files", "rootPath": "/照片",
        "authMode": "password", "username": "reader", "secret": "openlist-test-password",
        "directoryPassword": "directory-only-secret"
    });
    for (key, changed) in changes.as_object().unwrap() {
        value[key] = changed.clone();
    }
    serde_json::from_value(value).unwrap()
}

#[test]
fn credentials_are_masked_and_only_reused_for_the_same_account_and_server() {
    let saved = input(json!({})).resolve(None).unwrap();
    assert_eq!(saved.url, "http://openlist:5244/files/");
    assert_ne!(saved.secret, "openlist-test-password");
    assert_eq!(saved.secret.len(), 64);
    let view = serde_json::to_value(ConfigView::from_config(Some(&saved))).unwrap();
    assert_eq!(view["hasSecret"], true);
    assert_eq!(view["hasDirectoryPassword"], true);
    assert!(view.get("secret").is_none() && view.get("directoryPassword").is_none());
    assert!(!view.to_string().contains(&saved.secret));
    let mut keep = json!({ "secret": "", "directoryPassword": null, "name": "新名称", "rootPath": "/照片/旅行" });
    let updated = input(keep.clone()).resolve(Some(&saved)).unwrap();
    assert_eq!(updated.secret, saved.secret);
    assert_eq!(updated.directory_password, saved.directory_password);
    for (field, value) in [
        ("url", "http://different-host:5244"),
        ("username", "another-user"),
        ("authMode", "token"),
    ] {
        let mut changed = keep.clone();
        changed[field] = value.into();
        assert!(input(changed).resolve(Some(&saved)).is_err());
    }
    keep["directoryPassword"] = "".into();
    assert!(
        input(keep)
            .resolve(Some(&saved))
            .unwrap()
            .directory_password
            .is_empty()
    );
}

#[test]
fn paths_stay_under_the_configured_root_and_urls_reject_embedded_credentials() {
    let config = input(json!({})).resolve(None).unwrap();
    assert_eq!(config.remote_path("/").unwrap(), "/照片");
    assert_eq!(
        config.remote_path("//项目 & 2026/山 + 海.jpg/").unwrap(),
        "/照片/项目 & 2026/山 + 海.jpg"
    );
    for path in [
        "../",
        "/../private",
        "/a/../../private",
        "/a/./b",
        "/%2e%2e/private",
        "/a%2Fb",
        "/a\\b",
        "/a\nb",
    ] {
        assert!(config.remote_path(path).is_err(), "accepted {path:?}");
    }
    for url in [
        "file:///etc/passwd",
        "ftp://host",
        "http://user:password@host",
        "https://host?token=secret",
        "https://host/#fragment",
    ] {
        assert!(input(json!({ "url": url })).resolve(None).is_err());
    }
}

#[test]
fn configuration_persists_privately_and_corruption_does_not_become_an_empty_connection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings/openlist.json");
    assert!(config::read(&path).unwrap().is_none());
    let saved = input(json!({})).resolve(None).unwrap();
    config::write(&path, &saved).unwrap();
    let restored = config::read(&path).unwrap().unwrap();
    assert_eq!(restored.key(), saved.key());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    std::fs::write(&path, b"{invalid configuration").unwrap();
    assert!(config::read(&path).is_err());
    std::fs::write(&path, vec![b' '; 16_385]).unwrap();
    assert!(config::read(&path).is_err());
}

#[tokio::test]
async fn disconnected_storage_has_a_clear_empty_state_and_private_responses() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(directory.path().to_owned());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/storage/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["configured"],
        false
    );
    for path in ["/api/storage/list", "/api/storage/file?path=%2Fphoto.jpg"] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/storage/disconnect")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}
