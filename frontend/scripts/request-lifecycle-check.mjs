// Exercise deadlines and cancellation at both response headers and body reads.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

globalThis.document = { getElementById: () => ({ textContent: '{"enabled":false,"authenticated":false}', remove() {} }) };
globalThis.location = { origin: "https://pixhelf.test" };
const bundle = await build({ stdin: {
  resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  contents: 'export { getStorageConfig } from "./src/storage"; export { managementRequest } from "./src/management";',
}, bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
const { getStorageConfig, managementRequest } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
const deadlines = [];
AbortSignal.timeout = ms => {
  const controller = new AbortController();
  deadlines.push({ ms, controller });
  return controller.signal;
};
function untilAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

try {
  for (const [name, request, timeout] of [
    ["storage", signal => getStorageConfig(signal), 40_000],
    ["management read", signal => managementRequest("", undefined, signal), 30_000],
    ["management write", signal => managementRequest("/batch", { ids: [] }, signal), 900_000],
  ]) {
    for (const body of [false, true]) {
      for (const cancel of [false, true]) {
        let received, readingBody = false;
        globalThis.fetch = async (_, options) => {
          received = options.signal;
          return body ? { ok: true, status: 200, json: () => { readingBody = true; return untilAborted(received); } } : untilAborted(received);
        };
        const caller = new AbortController();
        const before = deadlines.length;
        const reason = new DOMException(cancel ? "Navigated away" : "Deadline exceeded", cancel ? "AbortError" : "TimeoutError");
        const result = request(caller.signal);
        const rejected = assert.rejects(result, error => cancel || name !== "storage"
          ? error === reason : error.code === "network");
        assert.equal(deadlines.length, before + 1, `${name} keeps a deadline with a caller signal`);
        assert.equal(deadlines.at(-1).ms, timeout, `${name} uses the same deadline with or without cancellation`);
        await Promise.resolve();
        assert.equal(readingBody, body, "abort at the intended response stage");
        if (cancel) caller.abort(reason);
        else deadlines.at(-1).controller.abort(reason);
        await rejected;
        assert(received.aborted, `${name} cancels the underlying request`);
        assert.equal(caller.signal.aborted, cancel, "a deadline does not abort its caller");
      }
    }
    globalThis.fetch = async () => Response.json({ ok: true });
    assert.deepEqual(await request(), { ok: true }, `${name} still accepts a successful response`);
    assert.equal(deadlines.at(-1).ms, timeout);
  }

  globalThis.fetch = async () => Response.json({ error: "Storage is offline", code: "offline" }, { status: 503 });
  await assert.rejects(getStorageConfig(), { message: "Storage is offline", code: "offline" });
  globalThis.fetch = async () => new Response("not json");
  await assert.rejects(getStorageConfig(), { code: "response" });
  console.log("Request lifecycle: GET/POST deadlines, cancellation during headers/body, successful responses and error handling passed");
} finally {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
}
