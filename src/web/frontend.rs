//! Embedded assets, initial gallery data and authentication documents.
use super::{
    cache::{is_not_modified, not_modified, with_cache_headers},
    listing::summary_from_index,
    models::{GallerySummary, ImageRequest, ImagesResponse},
    pagination::image_page,
};
use crate::{assets, auth::AuthView, management::sharing::ReadState, thumbs::ThumbnailStatus};
use axum::{
    body::Body,
    extract::{Path, Request},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};
use tracing::error;

const INDEX_HTML: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/frontend/dist/index.html"
));
const APP_CSS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/frontend/dist/assets/app.css"
));
pub(super) const ASSET_VERSION: &str = env!("PIXHELF_ASSET_VERSION");

#[derive(Serialize)]
struct BootstrapResponse {
    summary: GallerySummary,
    status: ThumbnailStatus,
    images: ImagesResponse,
}

pub(super) async fn frontend_asset(
    Path((version, path)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if version != ASSET_VERSION {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(asset) = assets::find(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let compressed = asset.brotli.filter(|_| accepts_brotli(&headers));
    let encoding = if compressed.is_some() { "-br" } else { "" };
    let etag = format!("\"asset-{path}-{ASSET_VERSION}{encoding}\"");
    let content = if is_not_modified(&headers, &etag) {
        None
    } else if let Some(bytes) = compressed {
        Some(axum::body::Bytes::from_static(bytes))
    } else {
        Some(match asset.read().await {
            Ok(content) => content,
            Err(error) => {
                error!(%path, %error, "无法读取内置前端资源");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        })
    };
    let content_type = if path.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else {
        "text/plain; charset=utf-8"
    };
    let mut response = if let Some(content) = content {
        let mut response = Response::new(Body::from(content.clone()));
        response
            .headers_mut()
            .insert(header::CONTENT_LENGTH, HeaderValue::from(content.len()));
        response
    } else {
        StatusCode::NOT_MODIFIED.into_response()
    };
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .append(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if compressed.is_some() {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static("br"));
    }
    with_cache_headers(response, &etag, "public, max-age=31536000, immutable")
}

fn accepts_brotli(headers: &HeaderMap) -> bool {
    let mut wildcard = false;
    for value in headers.get_all(header::ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else { continue };
        for entry in value.split(',') {
            let mut parts = entry.split(';');
            let coding = parts.next().unwrap_or_default().trim();
            let quality = parts
                .find_map(|part| {
                    let (key, value) = part.trim().split_once('=')?;
                    key.trim()
                        .eq_ignore_ascii_case("q")
                        .then(|| value.trim().parse::<f32>().unwrap_or(0.0))
                })
                .unwrap_or(1.0);
            let allowed = quality > 0.0 && quality <= 1.0;
            if coding.eq_ignore_ascii_case("br") {
                return allowed;
            }
            if coding == "*" {
                wildcard = allowed;
            }
        }
    }
    wildcard
}

fn gallery_asset_preloads() -> &'static str {
    #[derive(serde::Deserialize)]
    struct Chunk {
        file: String,
        #[serde(default)]
        imports: Vec<String>,
        #[serde(default)]
        css: Vec<String>,
    }
    static PRELOADS: OnceLock<String> = OnceLock::new();
    PRELOADS.get_or_init(|| {
        let manifest: BTreeMap<String, Chunk> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/frontend/dist/.vite/manifest.json"
        )))
        .expect("valid Vite manifest");
        let entry = manifest
            .iter()
            .find(|(_, chunk)| chunk.file == "assets/GalleryApp.js")
            .expect("gallery entry in manifest")
            .0
            .clone();
        let mut pending = vec![entry];
        let mut visited = BTreeSet::new();
        let mut styles = BTreeSet::new();
        let mut result = String::new();
        while let Some(name) = pending.pop() {
            if !visited.insert(name.clone()) {
                continue;
            }
            let chunk = manifest
                .get(&name)
                .expect("gallery static dependency in manifest");
            let file = chunk
                .file
                .strip_prefix("assets/")
                .expect("built asset path");
            result.push_str(&format!(
                r#"<link rel="modulepreload" crossorigin href="/assets/{ASSET_VERSION}/{file}" />"#
            ));
            pending.extend(chunk.imports.iter().cloned());
            styles.extend(chunk.css.iter().cloned());
        }
        // Only static imports belong here. Management screens stay on demand.
        for style in styles {
            let file = style
                .strip_prefix("assets/")
                .expect("built stylesheet path");
            if file == "app.css" {
                continue;
            } // Already inlined in the document.
            result.push_str(&format!(
                r#"<link rel="stylesheet" crossorigin href="/assets/{ASSET_VERSION}/{file}" />"#
            ));
        }
        result
    })
}

pub(super) async fn frontend(ReadState(state): ReadState, request: Request) -> Response {
    if request.uri().path() != "/" {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let authentication = request
        .extensions()
        .get::<AuthView>()
        .cloned()
        .unwrap_or_default();
    let index = state.index.read().await;
    let status = if index.initializing {
        ThumbnailStatus::pending()
    } else {
        state.thumbnails.status()
    };
    let etag = format!(
        "\"index-{ASSET_VERSION}-{}-{}-{}\"",
        index.revision, status.ready, status.failed
    );
    if !authentication.enabled && is_not_modified(request.headers(), &etag) {
        return not_modified(&etag, "private, no-cache");
    }
    let summary = summary_from_index(&index);
    let images = image_page(&index, &ImageRequest::default());

    let mut preload = images.items.first().map_or_else(String::new, |image| {
        let url = format!("/api/images/{}/thumbnail", image.id);
        format!(r#"<link rel="preload" as="image" href="{url}" fetchpriority="high" />"#)
    });
    if !index.initializing {
        // Start the authenticated gallery assets with the document, before its entry module runs.
        preload.push_str(gallery_asset_preloads());
    }
    let bootstrap = BootstrapResponse {
        summary,
        status,
        images,
    };
    let bootstrap_json = match serde_json::to_string(&bootstrap) {
        Ok(json) => escape_script_json(json),
        Err(error) => {
            error!(%error, "无法生成页面初始数据");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let html = frontend_document(&bootstrap_json, &authentication, &preload);
    drop(index);

    let body = if request.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(html)
    };
    let mut response = Response::new(body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    with_cache_headers(response, &etag, "private, no-cache")
}

pub(crate) fn authentication_html(authentication: &AuthView) -> Response {
    // Keep login independent of a potentially large browser cache purge. Protected
    // media revalidates authentication, and explicit logout still clears caches.
    let title = if authentication.setup_required {
        "<title>欢迎使用 · Pixhelf</title>"
    } else {
        "<title>登录 · Pixhelf</title>"
    };
    let html =
        frontend_document("null", authentication, "").replace("<title>Pixhelf</title>", title);
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        html,
    )
        .into_response()
}

fn frontend_document(bootstrap_json: &str, authentication: &AuthView, preload: &str) -> String {
    let authentication = escape_script_json(
        serde_json::to_string(authentication).expect("serializable authentication view"),
    );
    let inline_styles = format!(
        "<style>{}</style>",
        std::str::from_utf8(APP_CSS).expect("Vite app.css must be UTF-8")
    );
    let template = std::str::from_utf8(INDEX_HTML)
        .expect("Vite index.html must be UTF-8")
        .replace(
            r#"<link rel="stylesheet" crossorigin href="./assets/app.css">"#,
            &inline_styles,
        )
        .replace("./assets/", &format!("/assets/{ASSET_VERSION}/"))
        .replace("<!--PIXHELF_IMAGE_PRELOAD-->", preload);
    // Substitute each template slot once without interpreting markers inside usernames or filenames.
    let (before_auth, remainder) = template
        .split_once("__PIXHELF_AUTH__")
        .expect("authentication template slot");
    let (between, after_bootstrap) = remainder
        .split_once("__PIXHELF_BOOTSTRAP__")
        .expect("gallery template slot");
    format!("{before_auth}{authentication}{between}{bootstrap_json}{after_bootstrap}")
}

fn escape_script_json(json: String) -> String {
    json.replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_json_cannot_close_its_script_element() {
        let escaped = escape_script_json(r#"{"name":"</script><script>"}"#.to_owned());
        assert!(!escaped.contains('<'));
        assert!(escaped.contains(r#"\u003c/script\u003e"#));
    }

    #[test]
    fn gallery_preloads_include_static_dependencies_only() {
        let links = gallery_asset_preloads();
        for file in ["GalleryApp.js", "app.js", "GalleryApp.css"] {
            assert!(links.contains(&format!("/assets/{ASSET_VERSION}/{file}")));
        }
        for file in [
            "SettingsDialog",
            "LocalStorageView",
            "ExternalStorageView",
            "UploadDialog",
        ] {
            assert!(!links.contains(file));
        }
    }

    #[test]
    fn brotli_negotiation_respects_explicit_rejections() {
        for (encoding, accepted) in [
            ("br, gzip", true),
            ("gzip", false),
            ("*", true),
            ("gzip, br;q=0", false),
            ("*;q=1, br;q=0", false),
            ("BR; q=0.5", true),
            ("br;q=invalid", false),
            ("br;q=2", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::ACCEPT_ENCODING,
                HeaderValue::from_str(encoding).unwrap(),
            );
            assert_eq!(accepts_brotli(&headers), accepted, "{encoding}");
        }
        assert!(!accepts_brotli(&HeaderMap::new()));
    }
}
