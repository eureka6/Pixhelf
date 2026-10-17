import { requireLogin } from "../auth";

export const REQUEST_TIMEOUT_MS = 15_000;
type JsonValidator<T> = (value: unknown) => value is T;

export async function requestJson<T>(
  url: string,
  validate: JsonValidator<T>,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
  request?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const headers = new Headers(request?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const response = await fetch(url, {
      cache: "no-cache",
      ...request,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) requireLogin();
      if (request?.method === "POST") {
        if (response.status === 413) throw new Error("图片不能超过 20 MB");
        const payload = await response.json().catch(() => null);
        if (typeof payload?.error === "string") throw new Error(payload.error);
      }
      throw new Error(`请求失败 (${response.status})`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("服务器返回了无效数据");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("服务器返回了无效数据", { cause: error });
    }
    if (!validate(payload)) throw new Error("服务器返回了无效数据");
    return payload;
  } catch (error) {
    if (timedOut) throw new Error("请求超时，请稍后重试", { cause: error });
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
