mod change_password;
mod config;
mod guest;
mod password;
mod persistence;
mod store;

pub use config::AuthConfig;
pub use password::print_password_hash;

use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use argon2::{
    Argon2, PasswordHash, PasswordVerifier,
    password_hash::rand_core::{OsRng, RngCore},
};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use tower_sessions::{
    Expiry, Session, SessionManagerLayer,
    cookie::{Cookie, SameSite, time},
};
use zeroize::Zeroizing;

use crate::support::{mutex_lock, read_lock, write_lock};
use config::{Credentials, SetupConfig};
use store::{IDLE_TIMEOUT, SessionMemory};

const COOKIE_NAME: &str = "pixhelf-session";
const ORIGIN_HEADER: &str = "x-pixhelf-origin";
const AUTH_KEY: &str = "account";
const RATE_WINDOW: Duration = Duration::from_secs(60);
const GLOBAL_LOGIN_LIMIT: usize = 30;
const IP_LOGIN_LIMIT: usize = 10;

#[derive(Clone)]
pub struct AuthState {
    enabled: bool,
    guest: Arc<Mutex<guest::GuestConfig>>,
    credentials: Arc<std::sync::RwLock<Option<Arc<Credentials>>>>,
    setup: Option<Arc<SetupConfig>>,
    store: SessionMemory,
    attempts: Arc<Mutex<LoginAttempts>>,
    password_workers: Arc<Semaphore>,
}

#[derive(Default)]
struct LoginAttempts {
    global: VecDeque<Instant>,
    clients: HashMap<IpAddr, VecDeque<Instant>>,
}

impl LoginAttempts {
    fn allow(&mut self, ip: IpAddr, now: Instant) -> bool {
        self.global
            .retain(|at| now.duration_since(*at) < RATE_WINDOW);
        self.clients.retain(|_, attempts| {
            attempts.retain(|at| now.duration_since(*at) < RATE_WINDOW);
            !attempts.is_empty()
        });
        // The global budget also bounds the number of IP buckets, including behind trusted proxies.
        if self.global.len() >= GLOBAL_LOGIN_LIMIT {
            return false;
        }
        let attempts = self.clients.entry(ip).or_default();
        if attempts.len() >= IP_LOGIN_LIMIT {
            return false;
        }
        attempts.push_back(now);
        self.global.push_back(now);
        true
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    username: String,
    credential_revision: String,
    csrf_token: String,
    secure_cookie: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthView {
    pub enabled: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub guest: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(crate) can_change_password: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub setup_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) csrf_token: Option<String>,
}

impl AuthView {
    fn authenticated(account: Account, can_change_password: bool) -> Self {
        Self {
            enabled: true,
            authenticated: true,
            guest: false,
            can_change_password,
            setup_required: false,
            username: Some(account.username),
            csrf_token: Some(account.csrf_token),
        }
    }
}

impl AuthState {
    pub fn new(config: AuthConfig) -> Self {
        Self {
            enabled: config.enabled(),
            guest: Arc::new(Mutex::new(config.guest)),
            credentials: Arc::new(std::sync::RwLock::new(config.credentials.map(Arc::new))),
            setup: config.setup.map(Arc::new),
            store: SessionMemory::default(),
            attempts: Arc::new(Mutex::new(LoginAttempts::default())),
            password_workers: Arc::new(Semaphore::new(2)),
        }
    }

    fn credentials(&self) -> Option<Arc<Credentials>> {
        read_lock(&self.credentials).clone()
    }

    fn needs_setup(&self) -> bool {
        self.enabled && self.credentials().is_none()
    }

    fn guest_enabled(&self) -> bool {
        self.enabled && !self.needs_setup() && mutex_lock(&self.guest).enabled
    }

    fn authenticated_view(&self, account: Account) -> AuthView {
        AuthView::authenticated(
            account,
            self.credentials()
                .is_some_and(|credentials| credentials.account_path.is_some()),
        )
    }

    fn anonymous_view(&self) -> AuthView {
        let setup_required = self.needs_setup();
        AuthView {
            enabled: self.enabled,
            guest: self.guest_enabled(),
            setup_required,
            username: setup_required.then(|| {
                self.setup
                    .as_ref()
                    .expect("setup configuration")
                    .username
                    .clone()
            }),
            ..AuthView::default()
        }
    }

    pub fn session_layer(&self) -> SessionManagerLayer<SessionMemory> {
        SessionManagerLayer::new(self.store.clone())
            .with_name(COOKIE_NAME)
            .with_path("/")
            .with_secure(true)
            .with_http_only(true)
            .with_same_site(SameSite::Lax)
            .with_expiry(Expiry::OnInactivity(time::Duration::seconds(
                IDLE_TIMEOUT.as_secs() as i64,
            )))
            .with_always_save(true)
    }

    async fn account(&self, session: &Session) -> Result<Option<Account>, StatusCode> {
        let Some(credentials) = self.credentials() else {
            return Ok(None);
        };
        let account = session
            .get::<Account>(AUTH_KEY)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        match account {
            Some(account)
                if account.username == credentials.username
                    && account.credential_revision == credential_revision(&credentials) =>
            {
                Ok(Some(account))
            }
            _ => {
                if session.id().is_some() {
                    session
                        .flush()
                        .await
                        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                }
                Ok(None)
            }
        }
    }
}

pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/login", get(login_page))
        .route("/setup", get(setup_page))
        .route(
            "/api/auth/setup",
            post(setup_account).layer(DefaultBodyLimit::max(8192)),
        )
        .route("/api/auth/session", get(session_info))
        .route(
            "/api/auth/guest",
            get(guest::read_settings)
                .post(guest::save_settings)
                .layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/auth/login",
            post(login).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/auth/logout", post(logout))
        .route(
            "/api/auth/password",
            post(change_password::change_password).layer(DefaultBodyLimit::max(8192)),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            check_auth_request,
        ))
        .with_state(state)
}

pub async fn require_auth(
    State(auth): State<AuthState>,
    session: Session,
    request: Request,
    next: Next,
) -> Response {
    authorize(auth, session, request, next, true).await
}

pub async fn require_admin(
    State(auth): State<AuthState>,
    session: Session,
    request: Request,
    next: Next,
) -> Response {
    authorize(auth, session, request, next, false).await
}

async fn authorize(
    auth: AuthState,
    session: Session,
    mut request: Request,
    next: Next,
    allow_guest: bool,
) -> Response {
    let reading = matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if !auth.enabled {
        if !reading && !valid_write_origin(request.headers(), None) {
            return error(StatusCode::FORBIDDEN, "请求来源校验失败，请刷新页面后重试");
        }
        request.extensions_mut().insert(AuthView::default());
        return next.run(request).await;
    }
    let view = match auth.account(&session).await {
        Ok(Some(account)) => {
            let credentials = auth.credentials();
            if !reading
                && (!valid_write_origin(
                    request.headers(),
                    credentials
                        .as_ref()
                        .and_then(|value| value.public_origin.as_deref()),
                ) || !valid_csrf(request.headers(), &account))
            {
                return error(StatusCode::FORBIDDEN, "请求已失效，请刷新页面后重试");
            }
            auth.authenticated_view(account)
        }
        Ok(None) if allow_guest && auth.guest_enabled() => {
            if !reading {
                // Uploaded queries are read-only and never stored in the gallery.
                if *request.method() != Method::POST
                    || request.uri().path() != "/api/images/similar"
                {
                    return error(StatusCode::FORBIDDEN, "访客仅可浏览图库");
                }
                let credentials = auth.credentials();
                if !valid_write_origin(
                    request.headers(),
                    credentials
                        .as_ref()
                        .and_then(|value| value.public_origin.as_deref()),
                ) {
                    return error(StatusCode::FORBIDDEN, "请求来源校验失败，请刷新页面后重试");
                }
            }
            auth.anonymous_view()
        }
        Ok(None) => {
            return if request.uri().path() == "/"
                && matches!(*request.method(), Method::GET | Method::HEAD)
            {
                no_store(
                    Redirect::to(if auth.needs_setup() {
                        "/setup"
                    } else {
                        "/login"
                    })
                    .into_response(),
                )
            } else {
                error(StatusCode::UNAUTHORIZED, "请先登录")
            };
        }
        Err(status) => return error(status, "暂时无法验证登录状态"),
    };
    let is_page = request.uri().path() == "/";
    request.extensions_mut().insert(view);
    let mut response = next.run(request).await;
    let no_cache_storage = is_page
        || response
            .headers()
            .get(header::CACHE_CONTROL)
            .is_some_and(|value| {
                value
                    .to_str()
                    .is_ok_and(|value| value.split(',').any(|part| part.trim() == "no-store"))
            });
    // Authenticate before conditional/range responses; a shared cache must never serve private photos.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if no_cache_storage {
            "no-store"
        } else {
            "private, no-cache"
        }),
    );
    response
        .headers_mut()
        .append(header::VARY, HeaderValue::from_static("Cookie"));
    response
}

#[derive(Clone)]
struct RequestOrigin(String);

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

async fn check_auth_request(
    State(auth): State<AuthState>,
    mut request: Request,
    next: Next,
) -> Response {
    if request.method() == Method::POST {
        if !auth.enabled {
            return error(StatusCode::NOT_FOUND, "登录功能未启用");
        }
        let credentials = auth.credentials();
        let is_setup = request.uri().path() == "/api/auth/setup";
        if is_setup && credentials.is_some() {
            return error(StatusCode::CONFLICT, "已完成初始化，请刷新页面登录");
        }
        let expected_origin = credentials
            .as_ref()
            .and_then(|credentials| credentials.public_origin.as_deref())
            .or_else(|| {
                auth.setup
                    .as_ref()
                    .and_then(|setup| setup.public_origin.as_deref())
            });
        let headers = request.headers();
        let origin = single_header(headers, "origin");
        let valid_origin = origin
            .and_then(|origin| config::web_origin(origin).ok())
            .filter(|canonical| Some(canonical.as_str()) == origin);
        if valid_origin.is_none()
            || single_header(headers, ORIGIN_HEADER) != origin
            || (headers.contains_key("sec-fetch-site")
                && !matches!(
                    single_header(headers, "sec-fetch-site"),
                    Some("same-origin" | "none")
                ))
        {
            return error(StatusCode::FORBIDDEN, "请求来源校验失败，请刷新页面后重试");
        }
        if expected_origin.is_some_and(|expected| Some(expected) != origin) {
            return error(StatusCode::FORBIDDEN, "当前访问地址与配置的访问地址不一致");
        }
        let origin = valid_origin.expect("validated origin");
        // A custom header requires a CORS preflight for cross-origin requests. This app grants
        // no CORS access; also reject simple forms, mismatched origins and cross-site metadata.
        // Do not compare with the proxy's internal Host or an address saved during setup.
        request.extensions_mut().insert(RequestOrigin(origin));
        if matches!(
            request.uri().path(),
            "/api/auth/login" | "/api/auth/setup" | "/api/auth/password"
        ) {
            let proxies = credentials
                .as_ref()
                .map(|credentials| credentials.trusted_proxies.as_slice())
                .or_else(|| {
                    auth.setup
                        .as_ref()
                        .map(|setup| setup.trusted_proxies.as_slice())
                })
                .unwrap_or_default();
            let ip = client_ip(&request, proxies);
            if !mutex_lock(&auth.attempts).allow(ip, Instant::now()) {
                return throttled(60);
            }
        }
    }
    match tokio::time::timeout(Duration::from_secs(15), next.run(request)).await {
        Ok(response) => no_store(response),
        Err(_) => error(StatusCode::REQUEST_TIMEOUT, "请求超时，请重试"),
    }
}

fn client_ip(request: &Request, proxies: &[ipnet::IpNet]) -> IpAddr {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or(IpAddr::from([0, 0, 0, 0]), |peer| peer.0.ip());
    let trusted = |ip| proxies.iter().any(|network| network.contains(&ip));
    if !trusted(peer) {
        return peer;
    }
    let forwarded = request
        .headers()
        .get_all("x-forwarded-for")
        .iter()
        .collect::<Vec<_>>();
    if forwarded.len() != 1 {
        return peer;
    }
    let Ok(value) = forwarded[0].to_str() else {
        return peer;
    };
    if value.len() > 1024 {
        return peer;
    }
    let Ok(chain) = value
        .split(',')
        .map(|part| part.trim().parse::<IpAddr>())
        .collect::<Result<Vec<_>, _>>()
    else {
        return peer;
    };
    if chain.len() > 16 {
        return peer;
    }
    let mut client = peer;
    for hop in chain.into_iter().rev() {
        if !trusted(client) {
            break;
        }
        client = hop;
    }
    client
}

async fn login_page(State(auth): State<AuthState>, session: Session) -> Response {
    if !auth.enabled {
        return Redirect::to("/").into_response();
    }
    if auth.needs_setup() {
        return Redirect::to("/setup").into_response();
    }
    match auth.account(&session).await {
        Ok(Some(_)) => Redirect::to("/").into_response(),
        Ok(None) => {
            let mut response = crate::web::authentication_html(&auth.anonymous_view());
            // Also discard browser image caches left by an earlier public deployment.
            response
                .headers_mut()
                .insert("clear-site-data", HeaderValue::from_static("\"cache\""));
            response
        }
        Err(status) => error(status, "暂时无法验证登录状态"),
    }
}

async fn session_info(State(auth): State<AuthState>, session: Session) -> Response {
    match auth.account(&session).await {
        Ok(Some(account)) => Json(auth.authenticated_view(account)).into_response(),
        Ok(None) => Json(auth.anonymous_view()).into_response(),
        Err(status) => error(status, "暂时无法验证登录状态"),
    }
}

async fn setup_page(State(auth): State<AuthState>) -> Response {
    if !auth.needs_setup() {
        return Redirect::to(if auth.enabled { "/login" } else { "/" }).into_response();
    }
    crate::web::authentication_html(&auth.anonymous_view())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountInput {
    username: String,
    password: String,
}

async fn setup_account(
    State(auth): State<AuthState>,
    session: Session,
    Extension(RequestOrigin(origin)): Extension<RequestOrigin>,
    payload: Result<Json<AccountInput>, JsonRejection>,
) -> Response {
    let Some(setup) = auth.setup.clone().filter(|_| auth.needs_setup()) else {
        return error(StatusCode::CONFLICT, "已完成初始化，请刷新页面登录");
    };
    let input = match payload {
        Ok(Json(input)) => input,
        Err(rejection) => return error(rejection.status(), "设置请求格式无效"),
    };
    let password = Zeroizing::new(input.password);
    if let Err(reason) = config::validate_username(&input.username)
        .and_then(|_| password::validate_password(&password))
    {
        return error(StatusCode::BAD_REQUEST, &reason.to_string());
    }
    let Ok(permit) = auth.password_workers.clone().try_acquire_owned() else {
        return throttled(1);
    };
    let initializing = auth.clone();
    let secure_cookie = origin.starts_with("https://");
    let outcome =
        tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Arc<Credentials>>> {
            let _permit = permit;
            let credentials = Credentials {
                username: input.username,
                password_hash: password::hash_password(&password)?,
                account_path: Some(setup.path.clone()),
                public_origin: setup.public_origin.clone(),
                trusted_proxies: setup.trusted_proxies.clone(),
            };
            let mut current = write_lock(&initializing.credentials);
            if current.is_some() {
                return Ok(None);
            }
            // The write and in-memory activation finish even if the requesting browser disconnects.
            if let Err(reason) = persistence::create(&setup.path, &credentials) {
                if let Some(mut saved) = persistence::load(&setup.path)? {
                    saved.public_origin = setup.public_origin.clone();
                    saved.trusted_proxies = setup.trusted_proxies.clone();
                    *current = Some(Arc::new(saved));
                }
                return Err(reason);
            }
            let credentials = Arc::new(credentials);
            *current = Some(credentials.clone());
            tracing::info!("管理员账号已创建，初始化入口已关闭");
            Ok(Some(credentials))
        })
        .await;
    match outcome {
        Ok(Ok(Some(credentials))) => start_session(&session, &credentials, secure_cookie).await,
        Ok(Ok(None)) => error(StatusCode::CONFLICT, "已完成初始化，请刷新页面登录"),
        failure => {
            match failure {
                Ok(Err(reason)) => {
                    tracing::error!(error = %reason, "无法保存管理员配置")
                }
                Err(reason) => tracing::error!(error = %reason, "管理员初始化任务中断"),
                _ => unreachable!(),
            }
            if auth.credentials().is_some() {
                error(StatusCode::CONFLICT, "设置已保存，请刷新页面登录")
            } else {
                error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "无法保存设置，请确认应用数据卷可写后重试",
                )
            }
        }
    }
}

async fn login(
    State(auth): State<AuthState>,
    session: Session,
    Extension(RequestOrigin(origin)): Extension<RequestOrigin>,
    payload: Result<Json<AccountInput>, JsonRejection>,
) -> Response {
    let Some(credentials) = auth.credentials() else {
        return error(StatusCode::CONFLICT, "请先完成初始设置");
    };
    let input = match payload {
        Ok(Json(input)) => input,
        Err(rejection) => return error(rejection.status(), "登录请求格式无效"),
    };
    let password = Zeroizing::new(input.password);
    if input.username.len() > 128 || password.is_empty() || password.len() > 1024 {
        return error(StatusCode::BAD_REQUEST, "用户名或密码长度无效");
    }
    let Ok(permit) = auth.password_workers.clone().try_acquire_owned() else {
        return throttled(1);
    };
    let verifier = credentials.clone();
    let verified = tokio::task::spawn_blocking(move || {
        // Keep the permit inside the worker even if the HTTP client disconnects.
        let _permit = permit;
        let Ok(hash) = PasswordHash::new(&verifier.password_hash) else {
            return false;
        };
        let password_matches = Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok();
        let username_matches = bool::from(
            input
                .username
                .as_bytes()
                .ct_eq(verifier.username.as_bytes()),
        );
        password_matches && username_matches
    })
    .await;
    match verified {
        Ok(true) => {}
        Ok(false) => return error(StatusCode::UNAUTHORIZED, "用户名或密码不正确"),
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "登录暂时不可用，请稍后重试",
            );
        }
    }
    start_session(&session, &credentials, origin.starts_with("https://")).await
}

pub(super) fn random_token(bytes: usize) -> anyhow::Result<String> {
    let mut token = vec![0u8; bytes];
    OsRng
        .try_fill_bytes(&mut token)
        .map_err(|_| anyhow::anyhow!("secure random source unavailable"))?;
    Ok(token.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn credential_revision(credentials: &Credentials) -> String {
    blake3::hash(credentials.password_hash.as_bytes())
        .to_hex()
        .to_string()
}

async fn start_session(
    session: &Session,
    credentials: &Credentials,
    secure_cookie: bool,
) -> Response {
    let token = match random_token(32) {
        Ok(token) => token,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "登录暂时不可用，请稍后重试",
            );
        }
    };
    let account = Account {
        username: credentials.username.clone(),
        credential_revision: credential_revision(credentials),
        csrf_token: token,
        secure_cookie,
    };
    if session.cycle_id().await.is_err() || session.insert(AUTH_KEY, &account).await.is_err() {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "无法建立登录会话，请重试",
        );
    }
    Json(AuthView::authenticated(
        account,
        credentials.account_path.is_some(),
    ))
    .into_response()
}

fn valid_write_origin(headers: &HeaderMap, expected: Option<&str>) -> bool {
    let origin = single_header(headers, "origin");
    origin.is_some_and(|origin| {
        config::web_origin(origin).is_ok_and(|canonical| canonical == origin)
            && single_header(headers, ORIGIN_HEADER) == Some(origin)
            && expected.is_none_or(|expected| expected == origin)
            && (!headers.contains_key("sec-fetch-site")
                || matches!(
                    single_header(headers, "sec-fetch-site"),
                    Some("same-origin" | "none")
                ))
    })
}

fn valid_csrf(headers: &HeaderMap, account: &Account) -> bool {
    single_header(headers, "x-csrf-token")
        .is_some_and(|token| bool::from(token.as_bytes().ct_eq(account.csrf_token.as_bytes())))
}

async fn logout(State(auth): State<AuthState>, session: Session, headers: HeaderMap) -> Response {
    let account = match auth.account(&session).await {
        Ok(Some(account)) => account,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "登录已失效"),
        Err(status) => return error(status, "暂时无法验证登录状态"),
    };
    if !valid_csrf(&headers, &account) {
        return error(StatusCode::FORBIDDEN, "请求已失效，请刷新页面后重试");
    }
    if session.flush().await.is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "退出失败，请重试");
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert("clear-site-data", HeaderValue::from_static("\"cache\""));
    response
}

fn throttled(seconds: u32) -> Response {
    let mut response = error(StatusCode::TOO_MANY_REQUESTS, "尝试次数过多，请稍后再试");
    response.headers_mut().insert(
        header::RETRY_AFTER,
        HeaderValue::from_str(&seconds.to_string()).expect("numeric header"),
    );
    response
}

fn error(status: StatusCode, message: &str) -> Response {
    no_store((status, Json(serde_json::json!({ "error": message }))).into_response())
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Clone, Copy)]
struct CookieSecurity(bool);

pub async fn session_cookie_security(session: Session, request: Request, next: Next) -> Response {
    let previous = match session.get::<Account>(AUTH_KEY).await {
        Ok(account) => account,
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "暂时无法验证登录状态"),
    };
    let mut response = next.run(request).await;
    let account = match session.get::<Account>(AUTH_KEY).await {
        Ok(account) => account.or(previous),
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "暂时无法验证登录状态"),
    };
    // Preserve the flag when logout clears the session, so HTTP deletion also works.
    response.extensions_mut().insert(CookieSecurity(
        account.is_some_and(|account| account.secure_cookie),
    ));
    response
}

pub async fn response_security(request: Request, next: Next) -> Response {
    let auth_endpoint = matches!(request.uri().path(), "/login" | "/setup")
        || request.uri().path().starts_with("/api/auth/");
    let mut response = next.run(request).await;
    if auth_endpoint || response.status() == StatusCode::UNAUTHORIZED {
        response = no_store(response);
    }
    // Each session uses its login protocol, including refresh and removal cookies. Proxies
    // can rewrite Host or terminate TLS; untrusted forwarding headers cannot downgrade it.
    let secure = response
        .extensions()
        .get::<CookieSecurity>()
        .is_none_or(|flag| flag.0);
    let cookies = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    response.headers_mut().remove(header::SET_COOKIE);
    for value in cookies {
        let hardened = value
            .to_str()
            .ok()
            .and_then(|value| Cookie::parse(value.to_owned()).ok())
            .and_then(|mut cookie| {
                if cookie.name() != COOKIE_NAME {
                    return None;
                }
                cookie.set_secure(secure);
                cookie.set_http_only(true);
                cookie.set_same_site(SameSite::Lax);
                cookie.set_path("/");
                HeaderValue::from_str(&cookie.to_string()).ok()
            });
        response
            .headers_mut()
            .append(header::SET_COOKIE, hardened.unwrap_or(value));
    }
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ));
    response
}

#[cfg(test)]
mod tests;
