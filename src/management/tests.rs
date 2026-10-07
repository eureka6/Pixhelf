use super::*;
use axum::{body::Body, http::Request};
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, AppState) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("gallery");
    std::fs::create_dir_all(root.join("目标")).unwrap();
    for name in ["one.png", "two.png"] {
        image::RgbImage::from_pixel(4, 3, image::Rgb([50, 120, 180]))
            .save(root.join(name))
            .unwrap();
    }
    let index = scan_gallery(&root, None).unwrap();
    let thumbnails = crate::thumbs::ThumbnailManager::new(temporary.path().join("cache")).unwrap();
    let state = AppState {
        index: Arc::new(tokio::sync::RwLock::new(Arc::new(index))),
        thumbnails,
    };
    (temporary, state)
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    payload: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn category_settings_are_validated_saved_and_reloaded() {
    let (_temporary, state) = fixture();
    let make_app = || {
        router(state.clone()).merge(
            Router::new()
                .route("/api/categories", get(categories::read))
                .with_state(state.clone()),
        )
    };
    let app = make_app();
    let saved = json!({"categories":[{"name":"旅行", "query":"海边的日落"}]});
    let (status, result) = call(&app, "POST", "/api/management/categories", saved.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result, saved);
    let (status, result) = call(&make_app(), "GET", "/api/categories", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result, saved);
    for input in [
        json!({"categories":[{"name":"", "query":"海边"}]}),
        json!({"categories":[{"name":"一", "query":"海边"}, {"name":"二", "query":"海边"}]}),
        json!({"categories":[{"name":"一", "query":"a".repeat(201)}]}),
    ] {
        let (status, _) = call(&app, "POST", "/api/management/categories", input).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            call(&app, "GET", "/api/categories", json!(null)).await.1,
            saved
        );
    }
    let cleared = json!({"categories":[]});
    assert_eq!(
        call(&app, "POST", "/api/management/categories", cleared.clone())
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&make_app(), "GET", "/api/categories", json!(null))
            .await
            .1,
        cleared
    );
}

#[tokio::test]
async fn favorites_apply_sorting_search_and_pagination_consistently() {
    let (_temporary, state) = fixture();
    let root = state.index.read().await.root.clone();
    for (name, seconds) in [("one.png", 1), ("two.png", 2)] {
        std::fs::File::open(root.join(name))
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds)),
            )
            .unwrap();
    }
    *state.index.write().await = Arc::new(scan_gallery(&root, None).unwrap());
    let ids: Vec<_> = state
        .index
        .read()
        .await
        .images
        .iter()
        .map(|image| image.id.clone())
        .collect();
    let app = router(state.clone());
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({
            "ids": ids, "action": "favorite", "favorite": true,
        }),
    )
    .await;
    assert!(
        result["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["ok"] == true)
    );

    // Non-favorites must remain excluded even when their sort keys match.
    std::fs::copy(root.join("two.png"), root.join("three.png")).unwrap();
    *state.index.write().await = Arc::new(scan_gallery(&root, None).unwrap());
    for sort in ["name-desc", "newest"] {
        let (_, first) = call(
            &app,
            "GET",
            &format!("/api/management/favorites?sort={sort}&limit=1"),
            json!(null),
        )
        .await;
        assert_eq!(first["items"][0]["name"], "two.png", "{sort}");
        assert_eq!(first["total"], 2);
        assert_eq!(first["nextOffset"], 1);
        let (_, second) = call(
            &app,
            "GET",
            &format!("/api/management/favorites?sort={sort}&limit=1&offset=1"),
            json!(null),
        )
        .await;
        assert_eq!(second["items"][0]["name"], "one.png", "{sort}");
        assert_eq!(second["nextOffset"], json!(null));
    }
    let (_, search) = call(
        &app,
        "GET",
        "/api/management/favorites?search=%20ONE%20",
        json!(null),
    )
    .await;
    assert_eq!(search["total"], 1);
    assert_eq!(search["items"][0]["name"], "one.png");
    let (_, past_end) = call(
        &app,
        "GET",
        &format!("/api/management/favorites?offset={}&limit=0", usize::MAX),
        json!(null),
    )
    .await;
    assert_eq!(past_end["offset"], 2);
    assert_eq!(past_end["limit"], 1);
    assert_eq!(past_end["items"], json!([]));
    assert_eq!(past_end["nextOffset"], json!(null));
    for query in [
        "sort=invalid".to_owned(),
        format!("search={}", "x".repeat(4097)),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/management/favorites?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn favorites_move_trash_and_restore_survive_reopening() {
    let (_temporary, state) = fixture();
    let app = router(state.clone());
    let id = state.index.read().await.images[0].id.clone();
    for body in [
        json!({"ids":[id], "action":"favorite", "favorite":true}),
        json!({"ids":[id], "action":"move", "destination":"目标"}),
    ] {
        let (_, result) = call(&app, "POST", "/api/management/batch", body).await;
        assert_eq!(result["results"][0]["ok"], true, "{result}");
    }
    let reopened = router(state.clone());
    let (_, favorites) = call(&reopened, "GET", "/api/management/favorites", json!(null)).await;
    assert_eq!(favorites["total"], 1);
    let moved_id = favorites["items"][0]["id"].as_str().unwrap();
    assert_ne!(moved_id, id);
    let (_, result) = call(
        &reopened,
        "POST",
        "/api/management/batch",
        json!({"ids":[moved_id], "action":"trash"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    assert_eq!(state.index.read().await.images.len(), 1);
    let (_, entries) = call(&reopened, "GET", "/api/management/trash", json!(null)).await;
    let trash_id = entries["items"][0]["id"].as_str().unwrap();
    assert_eq!(entries["items"][0]["originalPath"], "目标/one.png");
    let (_, result) = call(
        &reopened,
        "POST",
        "/api/management/batch",
        json!({"ids":[trash_id], "action":"restore"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    let (_, favorites) = call(
        &router(state.clone()),
        "GET",
        "/api/management/favorites",
        json!(null),
    )
    .await;
    assert_eq!(favorites["total"], 1);
    assert_eq!(state.index.read().await.images.len(), 2);
}

#[tokio::test]
async fn conflicts_stale_files_and_unsafe_paths_preserve_originals() {
    let (_temporary, state) = fixture();
    let app = router(state.clone());
    let index = Arc::clone(&*state.index.read().await);
    let record = &index.images[0];
    let conflicting = index.root.join("目标/one.png");
    std::fs::write(&conflicting, b"keep me").unwrap();
    for destination in ["目标", "../outside", "/tmp", ".pixhelf-trash"] {
        let (_, result) = call(
            &app,
            "POST",
            "/api/management/batch",
            json!({"ids":[record.id], "action":"move", "destination":destination}),
        )
        .await;
        assert_eq!(result["results"][0]["ok"], false, "{result}");
        assert!(record.path.is_file());
    }
    assert_eq!(std::fs::read(conflicting).unwrap(), b"keep me");
    std::fs::write(&record.path, b"changed after scan").unwrap();
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":[record.id], "action":"trash"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], false);
    assert_eq!(std::fs::read(&record.path).unwrap(), b"changed after scan");
}

#[tokio::test]
async fn copying_preserves_originals_favorites_and_existing_files() {
    let (_temporary, state) = fixture();
    let app = router(state.clone());
    let record = state.index.read().await.images[0].clone();
    let original = std::fs::read(&record.path).unwrap();
    let root = state.index.read().await.root.clone();
    call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":[record.id], "action":"favorite", "favorite":true}),
    )
    .await;
    std::fs::write(root.join("目标/one.png"), b"existing").unwrap();
    for destination in ["目标", "", ""] {
        let (_, result) = call(
            &app,
            "POST",
            "/api/management/batch",
            json!({"ids":[record.id], "action":"copy", "destination":destination}),
        )
        .await;
        assert_eq!(result["results"][0]["ok"], true, "{result}");
    }
    for name in [
        "one.png",
        "目标/one - 副本.png",
        "one - 副本.png",
        "one - 副本 (2).png",
    ] {
        assert_eq!(std::fs::read(root.join(name)).unwrap(), original);
    }
    assert_eq!(
        std::fs::read(root.join("目标/one.png")).unwrap(),
        b"existing"
    );
    let (_, favorites) = call(&app, "GET", "/api/management/favorites", json!(null)).await;
    assert_eq!(favorites["total"], 1);
    assert_eq!(favorites["items"][0]["id"], record.id);
    for destination in ["../outside", "/tmp", ".pixhelf-trash", "missing"] {
        let (_, result) = call(
            &app,
            "POST",
            "/api/management/batch",
            json!({"ids":[record.id], "action":"copy", "destination":destination}),
        )
        .await;
        assert_eq!(result["results"][0]["ok"], false, "{result}");
    }
    std::fs::write(&record.path, b"modified").unwrap();
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":[record.id], "action":"copy", "destination":"目标"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], false, "{result}");
}

#[tokio::test]
async fn copying_live_photos_keeps_pairs_and_uses_one_shared_suffix() {
    let (_temporary, state) = fixture();
    let root = state.index.read().await.root.clone();
    for extension in ["jpg", "mp4"] {
        std::fs::copy(
            format!("frontend/scripts/fixtures/live-photo.{extension}"),
            root.join(format!("live.{extension}")),
        )
        .unwrap();
    }
    *state.index.write().await = Arc::new(scan_gallery(&root, None).unwrap());
    let record = state
        .index
        .read()
        .await
        .images
        .iter()
        .find(|image| image.name == "live.jpg")
        .unwrap()
        .clone();
    let app = router(state.clone());
    std::fs::write(root.join("目标/live.mp4"), b"existing video").unwrap();
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":[record.id], "action":"copy", "destination":"目标"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    for extension in ["jpg", "mp4"] {
        assert_eq!(
            std::fs::read(root.join(format!("live.{extension}"))).unwrap(),
            std::fs::read(root.join(format!("目标/live - 副本.{extension}"))).unwrap()
        );
    }
    assert!(!root.join("目标/live.jpg").exists());
    assert_eq!(
        std::fs::read(root.join("目标/live.mp4")).unwrap(),
        b"existing video"
    );
    assert!(
        state
            .index
            .read()
            .await
            .images
            .iter()
            .find(|image| image.name == "live - 副本.jpg")
            .unwrap()
            .motion
            .is_some()
    );
}

#[tokio::test]
async fn album_download_move_and_recovery_preserve_the_whole_tree_and_favorites() {
    let (_temporary, state) = fixture();
    let root = state.index.read().await.root.clone();
    std::fs::create_dir_all(root.join("旅行/子相册/空目录")).unwrap();
    std::fs::copy(root.join("one.png"), root.join("旅行/cover.png")).unwrap();
    std::fs::copy(root.join("one.png"), root.join("旅行/子相册/photo.png")).unwrap();
    std::fs::write(root.join("旅行/说明.txt"), b"album notes").unwrap();
    *state.index.write().await = Arc::new(scan_gallery(&root, None).unwrap());
    let photo = state
        .index
        .read()
        .await
        .images
        .iter()
        .find(|image| image.relative_path == "旅行/子相册/photo.png")
        .unwrap()
        .id
        .clone();
    let app = router(state.clone());
    for body in [
        json!({"ids":[photo], "action":"favorite", "favorite":true}),
        json!({"ids":["旅行/子相册", "旅行"], "kind":"albums", "action":"favorite", "favorite":true}),
    ] {
        let (_, result) = call(&app, "POST", "/api/management/batch", body).await;
        assert!(
            result["results"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["ok"] == true),
            "{result}"
        );
    }
    let (_, prepared) = call(
        &app,
        "POST",
        "/api/management/downloads",
        json!({"ids":["旅行/子相册", "旅行"], "kind":"albums"}),
    )
    .await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(prepared["url"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert_eq!(
        archive.len(),
        6,
        "overlapping selections must not duplicate ZIP entries"
    );
    for name in [
        "旅行/",
        "旅行/子相册/",
        "旅行/子相册/空目录/",
        "旅行/子相册/photo.png",
        "旅行/说明.txt",
    ] {
        assert!(archive.by_name(name).is_ok(), "archive must contain {name}");
    }
    let (_, rejected) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":["旅行/子相册", "旅行"], "kind":"albums", "action":"move", "destination":"旅行/子相册"}),
    ).await;
    assert_eq!(rejected["results"].as_array().unwrap().len(), 2);
    assert!(
        rejected["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["ok"] == false)
    );
    assert!(root.join("旅行/子相册/photo.png").is_file());
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":["旅行/子相册", "旅行"], "kind":"albums", "action":"move", "destination":"目标"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    assert_eq!(result["results"][0]["id"], "旅行/子相册");
    assert_eq!(result["results"][1]["ok"], true, "{result}");
    assert_eq!(result["results"][1]["id"], "旅行");
    assert!(!root.join("旅行").exists());
    assert!(root.join("目标/旅行/子相册/空目录").is_dir());
    assert_eq!(
        std::fs::read(root.join("目标/旅行/说明.txt")).unwrap(),
        b"album notes"
    );
    let (_, favorites) = call(&app, "GET", "/api/management", json!(null)).await;
    assert_eq!(
        favorites["favoriteAlbums"],
        json!(["目标/旅行", "目标/旅行/子相册"])
    );
    let (_, photos) = call(&app, "GET", "/api/management/favorites", json!(null)).await;
    assert_eq!(photos["total"], 1);
    let moved_photo = state
        .index
        .read()
        .await
        .images
        .iter()
        .find(|image| image.relative_path == "目标/旅行/子相册/photo.png")
        .unwrap()
        .id
        .clone();
    assert_eq!(photos["items"][0]["id"], moved_photo);

    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":["目标/旅行", "目标/旅行/子相册"], "kind":"albums", "action":"trash"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    assert_eq!(result["results"][1]["ok"], true, "{result}");
    assert!(!root.join("目标/旅行").exists());
    let reopened = router(state.clone());
    let (_, entries) = call(&reopened, "GET", "/api/management/trash", json!(null)).await;
    let entry = &entries["items"][0];
    assert_eq!(entry["album"], true);
    assert_eq!(entries["items"].as_array().unwrap().len(), 1);
    assert_eq!(entry["fileCount"], 3);
    let restore = json!({"ids":[entry["id"]], "action":"restore"});
    std::fs::create_dir(root.join("目标/旅行")).unwrap();
    let (_, result) = call(&reopened, "POST", "/api/management/batch", restore.clone()).await;
    assert_eq!(result["results"][0]["ok"], false, "{result}");
    std::fs::remove_dir(root.join("目标/旅行")).unwrap();
    let (_, result) = call(&reopened, "POST", "/api/management/batch", restore).await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    assert!(root.join("目标/旅行/子相册/空目录").is_dir());
    assert_eq!(
        std::fs::read(root.join("目标/旅行/子相册/photo.png")).unwrap(),
        std::fs::read(root.join("one.png")).unwrap()
    );
    let (_, after) = call(&reopened, "GET", "/api/management", json!(null)).await;
    assert_eq!(after["favoriteAlbums"], favorites["favoriteAlbums"]);
    assert_eq!(after["favoriteIds"], favorites["favoriteIds"]);
    assert_eq!(after["trashCount"], 0);
}

#[tokio::test]
async fn album_selection_rejects_unsafe_paths_and_local_storage_recovers_empty_folders() {
    let (_temporary, state) = fixture();
    let root = state.index.read().await.root.clone();
    std::fs::create_dir_all(root.join("empty/child")).unwrap();
    *state.index.write().await = Arc::new(scan_gallery(&root, None).unwrap());
    let app = router(state.clone());
    for ids in [
        json!([""]),
        json!(["."]),
        json!(["../outside"]),
        json!(["empty", "empty"]),
    ] {
        let (status, _) = call(
            &app,
            "POST",
            "/api/management/batch",
            json!({"ids":ids, "kind":"albums", "action":"trash"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(root.join("empty/child").is_dir());
    }
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":["empty"], "kind":"albums", "action":"trash"}),
    )
    .await;
    assert_eq!(
        result["results"][0]["ok"], false,
        "empty directories are not albums"
    );
    for destination in ["empty", "empty/child", ""] {
        let (status, result) = call(
            &app,
            "POST",
            "/api/management/directories",
            json!({"path":"empty", "action":"move", "destination":destination}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{result}");
        assert!(root.join("empty/child").is_dir());
    }
    let (status, result) = call(
        &app,
        "POST",
        "/api/management/directories",
        json!({"path":"empty", "action":"trash"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (_, entries) = call(&app, "GET", "/api/management/trash", json!(null)).await;
    assert_eq!(entries["items"][0]["fileCount"], 0);
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":[entries["items"][0]["id"]], "action":"restore"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    assert!(root.join("empty/child").is_dir());
}

#[cfg(unix)]
#[tokio::test]
async fn album_operations_reject_nested_symlinks_without_touching_outside_files() {
    let (temporary, state) = fixture();
    let root = state.index.read().await.root.clone();
    let outside = temporary.path().join("outside.txt");
    std::fs::write(&outside, b"outside").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("目标/link.txt")).unwrap();
    std::fs::copy(root.join("one.png"), root.join("目标/cover.png")).unwrap();
    *state.index.write().await = Arc::new(scan_gallery(&root, None).unwrap());
    let app = router(state.clone());
    for action in ["move", "trash"] {
        let (_, result) = call(
            &app,
            "POST",
            "/api/management/batch",
            json!({"ids":["目标"], "kind":"albums", "action":action, "destination":""}),
        )
        .await;
        assert_eq!(result["results"][0]["ok"], false, "{result}");
    }
    let (status, _) = call(
        &app,
        "POST",
        "/api/management/downloads",
        json!({"ids":["目标"], "kind":"albums"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(std::fs::read(outside).unwrap(), b"outside");
    assert!(root.join("目标/link.txt").is_symlink());
}

#[tokio::test]
async fn live_photo_download_and_recycling_keep_the_pair() {
    let (temporary, state) = fixture();
    let root = state.index.read().await.root.clone();
    std::fs::copy(
        "frontend/scripts/fixtures/live-photo.jpg",
        root.join("live.jpg"),
    )
    .unwrap();
    std::fs::copy(
        "frontend/scripts/fixtures/live-photo.mp4",
        root.join("live.mp4"),
    )
    .unwrap();
    *state.index.write().await = Arc::new(scan_gallery(&root, None).unwrap());
    let record = state
        .index
        .read()
        .await
        .images
        .iter()
        .find(|image| image.name == "live.jpg")
        .unwrap()
        .clone();
    assert!(record.motion.is_some());
    let app = router(state.clone());
    let (_, prepared) = call(
        &app,
        "POST",
        "/api/management/downloads",
        json!({"ids":[record.id]}),
    )
    .await;
    let head = app
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri(prepared["url"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers()[header::CONTENT_TYPE], "application/zip");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(prepared["url"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/zip");
    let bytes = axum::body::to_bytes(response.into_body(), 20 * 1024 * 1024)
        .await
        .unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert_eq!(zip.len(), 2);
    for name in ["live.jpg", "live.mp4"] {
        let mut entry = zip.by_name(name).unwrap();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
        assert_eq!(bytes, std::fs::read(root.join(name)).unwrap());
    }
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":[record.id],"action":"trash"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    assert!(!root.join("live.jpg").exists() && !root.join("live.mp4").exists());
    let entries = files::read_trash(&root).unwrap();
    assert_eq!(entries[0].files.len(), 2);
    let scanned = scan_gallery(&root, None).unwrap();
    assert!(
        !scanned
            .albums
            .iter()
            .any(|album| album.path.contains(files::TRASH))
    );
    let (_, result) = call(
        &router(state.clone()),
        "POST",
        "/api/management/batch",
        json!({"ids":[entries[0].id],"action":"restore"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    assert!(root.join("live.jpg").is_file() && root.join("live.mp4").is_file());
    drop(temporary);
}

#[cfg(unix)]
#[test]
fn paths_and_restore_reject_symlinks_and_conflicts() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("gallery");
    let outside = temporary.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    assert!(gallery_path(&root, "link/file", true).is_err());
    std::fs::write(root.join("original"), b"original").unwrap();
    std::fs::write(root.join("exists"), b"existing").unwrap();
    assert!(files::move_file(&root.join("original"), &root.join("exists")).is_err());
    assert_eq!(std::fs::read(root.join("original")).unwrap(), b"original");
    assert_eq!(std::fs::read(root.join("exists")).unwrap(), b"existing");
    std::fs::create_dir_all(root.join(files::TRASH)).unwrap();
    assert!(gallery_path(&root, ".pixhelf-trash/file", true).is_err());
}

#[tokio::test]
async fn restore_conflicts_keep_both_new_and_recycled_files() {
    let (_temporary, state) = fixture();
    let record = state.index.read().await.images[0].clone();
    let root = state.index.read().await.root.clone();
    let original = std::fs::read(&record.path).unwrap();
    let app = router(state.clone());
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":[record.id], "action":"trash"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true);
    let entry = files::read_trash(&root).unwrap().remove(0);
    std::fs::write(&record.path, b"new file at the original name").unwrap();
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"ids":[entry.id], "action":"restore"}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], false);
    assert_eq!(
        std::fs::read(&record.path).unwrap(),
        b"new file at the original name"
    );
    assert_eq!(
        std::fs::read(
            root.join(files::TRASH)
                .join(&entry.id)
                .join(&entry.files[0].stored)
        )
        .unwrap(),
        original
    );
    assert_eq!(files::read_trash(&root).unwrap().len(), 1);
}

#[tokio::test]
async fn corrupt_favorites_fail_before_moving_originals() {
    let (_temporary, state) = fixture();
    let record = state.index.read().await.images[0].clone();
    let directory = state.thumbnails.settings_directory().join("management");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("favorites.json"), b"invalid json").unwrap();
    let app = router(state);
    for action in ["favorite", "trash", "move"] {
        let (status, _) = call(
            &app,
            "POST",
            "/api/management/batch",
            json!({"ids":[record.id], "action":action, "favorite":true, "destination":"目标"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(record.path.is_file());
    }
}

#[test]
fn partially_recycled_live_photos_remain_recoverable() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    std::fs::copy(
        "frontend/scripts/fixtures/live-photo.jpg",
        root.join("live.jpg"),
    )
    .unwrap();
    std::fs::copy(
        "frontend/scripts/fixtures/live-photo.mp4",
        root.join("live.mp4"),
    )
    .unwrap();
    let index = scan_gallery(root, None).unwrap();
    let record = index
        .images
        .iter()
        .find(|record| record.name == "live.jpg")
        .unwrap();
    let (entry, directory) = files::new_trash_entry(root, record, true).unwrap();
    // Recreate the state left by interruption after moving only the photo.
    files::move_file(
        &directory.join(&entry.files[1].stored),
        &root.join(&entry.files[1].original),
    )
    .unwrap();
    assert_eq!(files::read_trash(root).unwrap().len(), 1);
    files::restore(root, &entry).unwrap();
    assert_eq!(
        std::fs::read(root.join("live.jpg")).unwrap(),
        std::fs::read("frontend/scripts/fixtures/live-photo.jpg").unwrap()
    );
    assert_eq!(
        std::fs::read(root.join("live.mp4")).unwrap(),
        std::fs::read("frontend/scripts/fixtures/live-photo.mp4").unwrap()
    );
    assert!(files::read_trash(root).unwrap().is_empty());
}

#[tokio::test]
async fn directory_viewer_pages_follow_file_order_and_skip_non_media() {
    let (_temporary, state) = fixture();
    let root = state.index.read().await.root.clone();
    for index in 0..201 {
        std::fs::write(root.join(format!("note-{index:03}.txt")), b"notes").unwrap();
    }
    let app = router(state);
    let (status, first) = call(
        &app,
        "GET",
        "/api/management/directories?content=true",
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["images"], json!([]));
    assert_eq!(first["nextOffset"], 200);
    let (_, next) = call(
        &app,
        "GET",
        "/api/management/directories?content=true&offset=200",
        json!(null),
    )
    .await;
    let images = next["images"].as_array().unwrap();
    assert_eq!(
        images
            .iter()
            .map(|image| image["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["one.png", "two.png"]
    );
    let ids: Vec<_> = next["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["imageId"].as_str())
        .collect();
    assert_eq!(
        images
            .iter()
            .map(|image| image["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ids
    );
    assert!(
        images
            .iter()
            .all(|image| image["width"] == 4 && image["height"] == 3)
    );
    assert!(next["nextOffset"].is_null());
    let (_, filtered) = call(
        &app,
        "GET",
        "/api/management/directories?content=true&search=two",
        json!(null),
    )
    .await;
    assert_eq!(filtered["images"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["images"][0]["name"], "two.png");
}

#[tokio::test]
async fn local_directories_create_list_rename_move_and_recycle_preserve_metadata() {
    let (_temporary, state) = fixture();
    let app = router(state.clone());
    let root = state.index.read().await.root.clone();
    for (parent, name) in [("", "旅行"), ("旅行", "夜景"), ("旅行", "空目录")] {
        let (status, value) = call(
            &app,
            "POST",
            "/api/management/directories",
            json!({"action":"create", "path":parent, "name":name}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{value}");
    }
    let (_, listed) = call(&app, "GET", "/api/management/directories", json!(null)).await;
    assert_eq!(listed["items"].as_array().unwrap().len(), 2);
    assert!(
        listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| !entry["path"].as_str().unwrap().contains('/'))
    );
    assert!(
        listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "旅行" && entry["hasChildren"] == true)
    );
    let (_, matching) = call(
        &app,
        "GET",
        "/api/management/directories?search=%E5%A4%9C%E6%99%AF",
        json!(null),
    )
    .await;
    assert_eq!(matching["items"][0]["path"], "旅行/夜景");
    let id = state.index.read().await.images[0].id.clone();
    for payload in [
        json!({"ids":[id], "action":"move", "destination":"旅行/夜景"}),
        json!({"ids":["旅行/夜景"], "kind":"albums", "action":"favorite", "favorite":true}),
    ] {
        let (_, value) = call(&app, "POST", "/api/management/batch", payload).await;
        assert_eq!(value["results"][0]["ok"], true, "{value}");
    }
    let (_, shared) = call(&app, "GET", "/api/management", json!(null)).await;
    assert_eq!(
        shared["privateAlbums"],
        json!([]),
        "new albums share by default"
    );
    let (status, _) = call(
        &app,
        "POST",
        "/api/management/sharing",
        json!({"path":"旅行/夜景", "shared":false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, result) = call(
        &app,
        "POST",
        "/api/management/directories",
        json!({"action":"rename", "path":"旅行", "name":"假期"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, result) = call(
        &app,
        "POST",
        "/api/management/directories",
        json!({"action":"move", "path":"假期", "destination":"目标"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(root.join("目标/假期/夜景/one.png").is_file());
    assert!(root.join("目标/假期/空目录").is_dir());
    let (_, metadata) = call(
        &router(state.clone()),
        "GET",
        "/api/management",
        json!(null),
    )
    .await;
    assert_eq!(metadata["favoriteAlbums"], json!(["目标/假期/夜景"]));
    assert_eq!(metadata["privateAlbums"], json!(["目标/假期/夜景"]));
    let (status, result) = call(
        &app,
        "POST",
        "/api/management/directories",
        json!({"action":"trash", "path":"目标/假期"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (_, trash) = call(&app, "GET", "/api/management/trash", json!(null)).await;
    let (_, result) = call(
        &app,
        "POST",
        "/api/management/batch",
        json!({"action":"restore", "ids":[trash["items"][0]["id"]]}),
    )
    .await;
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    assert!(root.join("目标/假期/空目录").is_dir());
    let (_, metadata) = call(&app, "GET", "/api/management", json!(null)).await;
    assert_eq!(metadata["privateAlbums"], json!(["目标/假期/夜景"]));
    let (_, listing) = call(
        &app,
        "GET",
        "/api/management/directories?content=true",
        json!(null),
    )
    .await;
    assert!(
        !listing["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["name"] == files::TRASH)
    );
}

#[tokio::test]
async fn local_directory_changes_reject_unsafe_paths_conflicts_and_root_deletion() {
    let (_temporary, state) = fixture();
    let root = state.index.read().await.root.clone();
    let app = router(state.clone());
    for payload in [
        json!({"action":"create", "path":"", "name":"../escape"}),
        json!({"action":"create", "path":"", "name":".pixhelf-trash"}),
        json!({"action":"create", "path":"", "name":"目标"}),
        json!({"action":"create", "path":"..", "name":"escape"}),
        json!({"action":"rename", "path":"目标", "name":"one.png"}),
        json!({"action":"move", "path":"目标", "destination":"目标"}),
        json!({"action":"trash", "path":""}),
        json!({"action":"trash", "path":"."}),
        json!({"action":"trash", "path":"../gallery"}),
    ] {
        let (status, result) = call(&app, "POST", "/api/management/directories", payload).await;
        assert_eq!(status, StatusCode::CONFLICT, "{result}");
        assert!(root.join("one.png").is_file());
        assert!(root.join("目标").is_dir());
    }
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
        for action in ["create", "rename", "trash"] {
            let (status, result) = call(
                &app,
                "POST",
                "/api/management/directories",
                json!({"action":action, "path":"link", "name":"blocked"}),
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT, "{result}");
        }
        let (_, listing) = call(&app, "GET", "/api/management/directories", json!(null)).await;
        assert!(
            !listing["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["name"] == "link")
        );
        assert!(!outside.path().join("blocked").exists());
    }
}
