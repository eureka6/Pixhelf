interface Authentication {
  enabled: boolean;
  authenticated: boolean;
  guest?: boolean;
  setupRequired?: boolean;
  username?: string;
  csrfToken?: string;
  canChangePassword?: boolean;
}

function readAuthentication(): Authentication {
  const element = document.getElementById("pixhelf-auth");
  try {
    const raw = element?.textContent?.trim();
    // Vite's development HTML has no server bootstrap.
    if (raw === "__PIXHELF_AUTH__") return { enabled: false, authenticated: false };
    const value: unknown = JSON.parse(raw ?? "null");
    if (value && typeof value === "object" && "enabled" in value && "authenticated" in value) {
      const auth = value as Authentication;
      if (auth.enabled === false) return { enabled: false, authenticated: false };
      if (auth.enabled === true && auth.setupRequired === true && auth.authenticated === false) {
        return { enabled: true, authenticated: false, setupRequired: true, username: typeof auth.username === "string" ? auth.username : "admin" };
      }
      if (auth.enabled === true && auth.authenticated === true
        && typeof auth.username === "string" && typeof auth.csrfToken === "string"
        && /^[a-f0-9]{64}$/.test(auth.csrfToken)) return auth;
      if (auth.enabled === true && auth.authenticated === false && auth.guest === true) {
        return { enabled: true, authenticated: false, guest: true };
      }
    }
  } catch { /* Missing or invalid authentication data must not reveal the gallery. */ }
  finally { element?.remove(); }
  return { enabled: true, authenticated: false };
}

export const authentication = readAuthentication();
let redirecting = false;
let channel: BroadcastChannel | undefined;
let checking = false;

export function requireLogin(expired = true): void {
  redirectToLogin(expired && !authentication.guest ? "expired" : "logout");
}

function redirectToLogin(reason: "expired" | "logout" | "account-changed"): void {
  if (!authentication.enabled || window.location.pathname === "/login" || redirecting) return;
  redirecting = true;
  document.documentElement.dataset.authRedirect = "true";
  window.location.replace(reason === "expired" ? "/login?expired=1"
    : reason === "account-changed" ? "/login?accountChanged=1" : "/login");
}

export class AuthRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter = 0) { super(message); }
}

async function requestAuth(path: string, body: unknown, csrfToken?: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "X-Pixhelf-Origin": window.location.origin,
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthRequestError("暂时无法连接，请检查网络后重试", 0);
  }
  if (response.ok) return response;
  const payload = await response.json().catch(() => null);
  const message = payload && typeof payload.error === "string" ? payload.error : "操作失败，请稍后重试";
  const retry = Number(response.headers.get("Retry-After"));
  throw new AuthRequestError(message, response.status, Number.isFinite(retry) ? Math.min(300, Math.max(0, retry)) : 0);
}

export async function authenticate(mode: "login" | "setup", username: string, password: string): Promise<void> {
  let response: Response;
  try {
    response = await requestAuth(`/api/auth/${mode}`, { username, password });
  } catch (error) {
    if (mode === "setup" && error instanceof AuthRequestError && error.status === 409) {
      window.location.replace("/login");
      return;
    }
    throw error;
  }
  const result = await response.json().catch(() => null);
  if (result?.enabled !== true || result?.authenticated !== true) {
    throw new AuthRequestError("服务器返回了无效登录结果，请稍后重试", 502);
  }
  window.location.replace("/");
}

export async function logout(): Promise<void> {
  try {
    const response = await requestAuth("/api/auth/logout", {}, authentication.csrfToken);
    if (response.status !== 204) throw new AuthRequestError("未能确认退出结果，请重试", 502);
  } catch (error) {
    if (!(error instanceof AuthRequestError) || error.status !== 401) throw error;
  }
  channel?.postMessage("logout");
  requireLogin(false);
}

export async function updateAccount(username: string, currentPassword: string, newPassword: string): Promise<void> {
  try {
    const response = await requestAuth("/api/auth/password", { username, currentPassword, newPassword }, authentication.csrfToken);
    if (response.status !== 204) throw new AuthRequestError("未能确认修改结果，请重试", 502);
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 401) {
      requireLogin();
      return;
    }
    throw error;
  }
  channel?.postMessage("account-changed");
  redirectToLogin("account-changed");
}

export async function getGuestMode(signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/auth/guest", {
    cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (response.status === 401) requireLogin();
  if (!response.ok) throw new AuthRequestError("无法读取访客设置，请重试", response.status);
  const result = await response.json().catch(() => null);
  if (typeof result?.enabled !== "boolean") throw new AuthRequestError("服务器返回了无效访客设置", 502);
  return result.enabled;
}

export async function setGuestMode(enabled: boolean): Promise<void> {
  try {
    const response = await requestAuth("/api/auth/guest", { enabled }, authentication.csrfToken);
    if (response.status !== 204) throw new AuthRequestError("未能确认访客设置，请重试", 502);
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 401) requireLogin();
    throw error;
  }
}

export async function checkAuthentication(): Promise<void> {
  if (!authentication.enabled || (!authentication.authenticated && !authentication.guest)
    || checking || redirecting || document.visibilityState !== "visible") return;
  checking = true;
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const session: Authentication = await response.json();
      if (authentication.guest) {
        if (session.authenticated) window.location.reload();
        else if (session.guest !== true) requireLogin(false);
      } else if (!session.authenticated) requireLogin();
      else if (typeof session.csrfToken === "string") authentication.csrfToken = session.csrfToken;
    } else if (response.status === 401) requireLogin();
  } catch { /* Preserve the page on a temporary network failure. */ }
  finally { checking = false; }
}

export function watchAuthentication(): void {
  if (!authentication.enabled || (!authentication.authenticated && !authentication.guest)) return;
  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel("pixhelf-auth");
    channel.onmessage = (event) => {
      if (authentication.guest) { void checkAuthentication(); return; }
      if (event.data === "logout") requireLogin(false);
      if (event.data === "account-changed" || event.data === "password-changed") redirectToLogin("account-changed");
    };
  }
  document.addEventListener("visibilitychange", () => { void checkAuthentication(); });
  window.addEventListener("focus", () => { void checkAuthentication(); });
  // Native <img> errors do not expose HTTP status. Confirm expiry before treating an image failure as logout.
  document.addEventListener("error", (event) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const source = new URL(event.target.currentSrc || event.target.src, window.location.href);
    if (source.origin === window.location.origin && source.pathname.startsWith("/api/images/")) void checkAuthentication();
  }, true);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    document.documentElement.dataset.authRedirect = "true";
    window.location.reload();
  });
}
