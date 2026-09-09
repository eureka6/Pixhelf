import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

// Real Pixhelf backend and browser against the OpenList login/hash, me, fs/list and fs/get protocol.
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = await mkdtemp(join(tmpdir(), "pixhelf-storage-check-"));
const localPassword = "storage-check-local-password";
const remotePassword = "storage-check-openlist-password";
const remoteHash = createHash("sha256").update(`${remotePassword}-https://github.com/alist-org/alist`).digest("hex");
const remoteRoot = "/vault/相册";
const remoteToken = "storage-check-token";
const directoryPassword = "directory-check-password";
let backend, browser, mock, media, origin, remoteOrigin, mediaOrigin;
let backendLog = "", validPasswordToken = "", logins = 0;
const apiCalls = [], mediaCalls = [], browserErrors = [], mockErrors = [];

function png(index) {
  const width = 360, height = 240;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    raw[offset] = (index * 57 + x / 3) % 256;
    raw[offset + 1] = (90 + y / 3) % 256;
    raw[offset + 2] = 125;
  }
  const chunk = (type, data) => {
    const contents = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of contents) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, contents, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function wav() {
  const bytes = Buffer.alloc(44 + 16000);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(16000, 40);
  return bytes;
}
const photo = png(1), sound = wav();
const entry = (name, is_dir = false) => ({ name, is_dir, size: is_dir ? 0 : name.endsWith(".png") ? photo.length : 128, modified: "2026-09-01T09:00:00Z", type: is_dir ? 1 : 0, thumb: "" });
const rootEntries = [entry("项目 & 2026", true), entry("空目录", true), entry("山 + 海.png"), entry("秋日.png"), entry("自然声音.wav"), entry("说明.html"), ...Array.from({ length: 59 }, (_, index) => entry(`文档-${index + 1}.txt`))];
const envelope = (response, code, data = null) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ code, message: code === 200 ? "success" : "fixture error", data })); };
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}
async function eventually(predicate, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}
async function stopBackend() {
  if (backend && backend.exitCode === null) {
    const exited = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM"); await exited;
  }
}
async function navigate(page, label) {
  const toggle = page.locator(".gallery-sidebar-toggle");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const panel = page.viewportSize().width <= 720 ? ".mobile-sidebar" : ".desktop-sidebar";
  await page.locator(`${panel} .album-link`).getByText(label, { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".mobile-nav-layer"));
}
async function waitEntries(page, count) {
  await page.waitForFunction(count => document.querySelectorAll(".storage-entry").length === count, count);
}
function track(page) {
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /Content Security Policy|violates.*directive/i.test(message.text())) browserErrors.push(message.text()); });
  page.on("request", request => { if (new URL(request.url()).origin !== origin) browserErrors.push("browser contacted a remote storage host directly"); });
}

try {
  await mkdir(join(directory, "gallery"));
  await writeFile(join(directory, "gallery/local.png"), photo);
  media = http.createServer((request, response) => {
    mediaCalls.push({ authorization: request.headers.authorization, cookie: request.headers.cookie, range: request.headers.range });
    const url = new URL(request.url, mediaOrigin);
    const name = url.searchParams.get("name") || "photo.png";
    if (url.pathname === "/redirect") { response.writeHead(302, { Location: `/file?name=${encodeURIComponent(name)}` }); response.end(); return; }
    const bytes = name.endsWith(".png") ? photo : name.endsWith(".wav") ? sound : Buffer.from("<script>window.untrustedRemoteHtml = true</script>");
    const headers = { "Content-Type": name.endsWith(".png") ? "image/png" : name.endsWith(".wav") ? "audio/wav" : "text/html", "Accept-Ranges": "bytes", ETag: '"storage-fixture"', "Set-Cookie": "remote-cookie=must-not-forward" };
    if (request.headers["if-none-match"] === headers.ETag) { response.writeHead(304, headers); response.end(); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
    if (range) {
      const start = Number(range[1]), end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
      if (start >= bytes.length) { response.writeHead(416, { ...headers, "Content-Range": `bytes */${bytes.length}` }); response.end(); return; }
      const part = bytes.subarray(start, end + 1);
      response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": part.length }); response.end(part); return;
    }
    response.writeHead(200, { ...headers, "Content-Length": bytes.length }); response.end(bytes);
  });
  mediaOrigin = `http://127.0.0.1:${await listen(media)}`;
  mock = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const endpoint = new URL(request.url, remoteOrigin).pathname;
      apiCalls.push({ endpoint, method: request.method, body, token: request.headers.authorization });
      if (endpoint === "/openlist/api/auth/login/hash") {
        assert.equal(request.headers.authorization, undefined);
        if (body.username !== "reader" || body.password !== remoteHash) return envelope(response, 401);
        validPasswordToken = `password-token-${++logins}`;
        return envelope(response, 200, { token: validPasswordToken });
      }
      if (![validPasswordToken, remoteToken].filter(Boolean).includes(request.headers.authorization)) return envelope(response, 401);
      if (endpoint === "/openlist/api/me") return envelope(response, 200, { role: 0, username: "reader", disabled: false });
      assert.equal(body.password, directoryPassword);
      assert.equal(body.path === remoteRoot || body.path.startsWith(`${remoteRoot}/`), true, "request escaped the configured root");
      if (endpoint === "/openlist/api/fs/list") {
        assert.equal(body.refresh, false, "reader account was asked to refresh OpenList's cache");
        const content = body.path === remoteRoot ? rootEntries : body.path === `${remoteRoot}/项目 & 2026` ? [entry("中文 & +.png")] : body.path === `${remoteRoot}/空目录` ? [] : null;
        if (!content) return envelope(response, 404);
        const offset = (body.page - 1) * body.per_page;
        return envelope(response, 200, { content: content.length ? content.slice(offset, offset + body.per_page) : null, total: content.length, header: "<script>untrusted</script>", readme: "<iframe>untrusted</iframe>" });
      }
      if (endpoint === "/openlist/api/fs/get") {
        const name = body.path.split("/").pop();
        return envelope(response, 200, { ...entry(name), raw_url: `${mediaOrigin}/redirect?name=${encodeURIComponent(name)}&sign=fixture-private-signature`, thumb: name.endsWith(".png") ? `${mediaOrigin}/file?name=${encodeURIComponent(name)}` : "" });
      }
      return envelope(response, 404);
    } catch (error) { mockErrors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  remoteOrigin = `http://127.0.0.1:${await listen(mock)}`;
  const reservation = net.createServer(); const port = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, RUST_LOG: "warn" };
  for (const key of Object.keys(environment)) if (key.startsWith("PIXHELF_AUTH_") || ["PIXHELF_PUBLIC_URL", "PIXHELF_TRUSTED_PROXIES"].includes(key)) delete environment[key];
  const startBackend = async () => {
    backendLog = "";
    backend = spawn(process.env.PIXHELF_TEST_BINARY ?? join(project, "target/debug/pixhelf"), ["--listen", `127.0.0.1:${port}`, "--gallery-dir", join(directory, "gallery"), "--cache-dir", join(directory, "cache"), "--text-search-model", "false", "--workers", "1"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [backend.stdout, backend.stderr]) stream.on("data", chunk => { backendLog = (backendLog + chunk.toString()).slice(-16000); });
    await eventually(async () => { assert.equal(backend.exitCode, null, backendLog); try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } }, "backend startup");
  };
  await startBackend();
  assert.equal((await fetch(`${origin}/api/storage/config`)).status, 401);
  assert.equal((await fetch(`${origin}/api/storage/file?path=/a.png`)).status, 401);
  assert.equal(apiCalls.length, 0);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-features=OverlayScrollbar"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const setup = await context.request.post(`${origin}/api/auth/setup`, { headers: { Origin: origin, "X-Pixhelf-Origin": origin }, data: { username: "admin", password: localPassword } });
  assert.equal(setup.status(), 200);
  const session = await setup.json();
  let writeHeaders = { Origin: origin, "X-Pixhelf-Origin": origin, "X-CSRF-Token": session.csrfToken };
  const page = await context.newPage(); track(page);
  await page.goto(origin);
  await navigate(page, "外部存储");
  await page.getByRole("button", { name: "连接外部存储", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.locator("#storage-url").fill(`${remoteOrigin}/openlist`);
  await dialog.locator("#storage-name").fill("家庭文件");
  await dialog.locator("#storage-username").fill("reader");
  await dialog.locator("#storage-secret").fill(remotePassword);
  await dialog.locator("#storage-root").fill(remoteRoot);
  await dialog.locator("#storage-directory-password").fill(directoryPassword);
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "连接成功" }).waitFor();
  assert.equal((await (await context.request.get(`${origin}/api/storage/config`)).json()).configured, false, "testing committed configuration");
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "连接已保存" }).waitFor();
  assert.equal(await dialog.locator("#storage-secret").inputValue(), "");
  await page.screenshot({ path: join(tmpdir(), "pixhelf-storage-settings-1440.png") });
  await page.mouse.click(2, 2); await dialog.waitFor({ state: "detached" });
  await waitEntries(page, 60);
  assert.equal(logins, 1, "saved connection did not reuse the verified token");
  const configResponse = await context.request.get(`${origin}/api/storage/config`);
  const config = await configResponse.json();
  assert.equal(config.hasSecret, true); assert.equal(config.hasDirectoryPassword, true);
  for (const secret of [remotePassword, remoteHash, directoryPassword, validPasswordToken]) assert.equal(JSON.stringify(config).includes(secret), false);
  const persistedPath = join(directory, "cache/settings/openlist.json");
  const persisted = await readFile(persistedPath, "utf8");
  assert.equal(persisted.includes(remotePassword), false);
  assert.equal((await stat(persistedPath)).mode & 0o777, 0o600);
  const storageInput = { name: config.name, url: config.url, rootPath: config.rootPath, authMode: config.authMode, username: config.username, secret: "" };
  const callsBeforeInvalid = apiCalls.length;
  for (const path of ["/api/storage/test", "/api/storage/config", "/api/storage/disconnect"]) {
    assert.equal((await context.request.post(origin + path, { headers: { ...writeHeaders, "X-CSRF-Token": "forged" }, data: storageInput })).status(), 403);
    assert.equal((await context.request.post(origin + path, { headers: { ...writeHeaders, Origin: "https://wrong-origin.example" }, data: storageInput })).status(), 403);
  }
  for (const path of ["/../private", "/a/../../private", "/%2e%2e/private", "/a\\b"]) {
    assert.equal((await context.request.get(`${origin}/api/storage/list?${new URLSearchParams({ path })}`)).status(), 400);
    assert.equal((await context.request.get(`${origin}/api/storage/file?${new URLSearchParams({ path })}`)).status(), 400);
  }
  assert.equal(apiCalls.length, callsBeforeInvalid, "rejected requests still contacted OpenList");
  assert.equal((await context.request.post(`${origin}/api/storage/config`, { headers: writeHeaders, data: { ...storageInput, url: `${mediaOrigin}/changed-host` } })).status(), 400);
  assert.equal((await context.request.post(`${origin}/api/storage/config`, { headers: writeHeaders, data: { ...storageInput, rootPath: `${remoteRoot}/missing` } })).status(), 404);
  assert.equal(await readFile(persistedPath, "utf8"), persisted, "a failed save overwrote the existing connection");
  await page.getByRole("button", { name: "加载更多", exact: true }).click(); await waitEntries(page, 65);
  await page.getByRole("button", { name: "打开搜索", exact: true }).click();
  await page.getByRole("searchbox", { name: "筛选已加载文件", exact: true }).fill("文档-59"); await waitEntries(page, 1);
  await page.getByRole("button", { name: "清空搜索", exact: true }).click(); await waitEntries(page, 65);
  await page.getByRole("button", { name: "收起搜索", exact: true }).click();
  await page.getByRole("button", { name: "打开文件夹 项目 & 2026", exact: true }).click(); await waitEntries(page, 1);
  assert.equal(new URL(page.url()).searchParams.get("path"), "/项目 & 2026");
  await page.reload(); await waitEntries(page, 1);
  await page.getByRole("button", { name: "预览文件 中文 & +.png", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".storage-preview img")?.naturalWidth > 0);
  const downloadEvent = page.waitForEvent("download"); await page.getByRole("link", { name: "下载文件", exact: true }).click();
  const download = await downloadEvent; assert.equal(download.suggestedFilename(), "中文 & +.png");
  assert.deepEqual(await readFile(await download.path()), photo);
  await page.keyboard.press("Escape");
  await page.goBack(); await waitEntries(page, 60);
  await page.goForward(); await waitEntries(page, 1);
  await page.getByRole("button", { name: "全部文件", exact: true }).click(); await waitEntries(page, 60);
  await page.getByRole("button", { name: "打开文件夹 空目录", exact: true }).click();
  await page.getByText("目录为空", { exact: true }).waitFor();
  await page.getByRole("button", { name: "全部文件", exact: true }).click(); await waitEntries(page, 60);
  const fileUrl = `${origin}/api/storage/file?${new URLSearchParams({ path: "/山 + 海.png" })}`;
  const range = await context.request.get(fileUrl, { headers: { Range: "bytes=0-7", Authorization: "must-not-forward" } });
  assert.equal(range.status(), 206); assert.deepEqual(await range.body(), photo.subarray(0, 8));
  assert.equal((range.headers()["set-cookie"] || "").includes("remote-cookie"), false); assert.equal(range.headers()["cache-control"], "private, no-cache");
  assert.equal((await context.request.get(fileUrl, { headers: { "If-None-Match": '"storage-fixture"' } })).status(), 304);
  assert.equal((await context.request.get(fileUrl, { headers: { Range: "bytes=99999999-" } })).status(), 416);
  const html = await context.request.get(`${origin}/api/storage/file?${new URLSearchParams({ path: "/说明.html" })}`);
  assert.equal(html.headers()["content-type"], "application/octet-stream"); assert.match(html.headers()["content-disposition"], /^attachment;/);
  const previousLogins = logins; validPasswordToken = "expired";
  const renewed = await context.request.get(`${origin}/api/storage/list`); assert.equal(renewed.status(), 200); assert.equal(logins, previousLogins + 1);
  await page.getByRole("button", { name: "预览文件 自然声音.wav", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".storage-preview audio")?.readyState >= 1);
  await page.keyboard.press("Escape");

  for (const width of [1440, 720, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?view=storage`); await waitEntries(page, 60);
    await page.getByRole("button", { name: "网格视图", exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(tmpdir(), `pixhelf-storage-grid-${width}.png`) });
    await page.getByRole("button", { name: "列表视图", exact: true }).click();
    await page.screenshot({ path: join(tmpdir(), `pixhelf-storage-list-${width}.png`) });
    const before = await page.locator(".storage-heading").boundingBox();
    await page.getByRole("button", { name: "外部存储设置", exact: true }).click();
    await dialog.locator("#storage-url").waitFor();
    const during = await page.locator(".storage-heading").boundingBox();
    assert.ok(Math.abs(during.x - before.x) < 0.1 && Math.abs(during.width - before.width) < 0.1, `settings moved the background: ${JSON.stringify({ width, before, during })}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(tmpdir(), `pixhelf-storage-settings-${width}.png`) });
    await page.mouse.click(2, 2); await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "预览文件 山 + 海.png", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".storage-preview img")?.naturalWidth > 0);
    await page.screenshot({ path: join(tmpdir(), `pixhelf-storage-preview-${width}.png`) });
    await page.getByRole("button", { name: "上一张", exact: true }).click();
    assert.equal(await page.locator(".storage-preview img").getAttribute("alt"), "秋日.png");
    await page.keyboard.press("Escape");
    await navigate(page, "图片"); await page.locator(".image-card").waitFor();
    await navigate(page, "外部存储"); await waitEntries(page, 60);
    console.log(JSON.stringify({ width, directoryBrowser: true, settingsBackdrop: true, stableBackground: true, preview: true }));
  }
  await page.getByRole("button", { name: "外部存储设置", exact: true }).click();
  await dialog.locator("#storage-auth-mode").selectOption("token");
  await dialog.locator("#storage-secret").fill("invalid-token");
  await dialog.locator("#storage-directory-password").fill(directoryPassword);
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "OpenList 认证已失效" }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/", "upstream authentication failure signed out Pixhelf");
  await dialog.locator("#storage-secret").fill(remoteToken);
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "连接已保存" }).waitFor();
  await page.mouse.click(2, 2); await dialog.waitFor({ state: "detached" });
  await stopBackend(); await startBackend();
  const login = await context.request.post(`${origin}/api/auth/login`, { headers: { Origin: origin, "X-Pixhelf-Origin": origin }, data: { username: "admin", password: localPassword } });
  assert.equal(login.status(), 200); writeHeaders = { ...writeHeaders, "X-CSRF-Token": (await login.json()).csrfToken };
  await page.goto(`${origin}/?view=storage`); await waitEntries(page, 60);
  assert.equal((await (await context.request.get(`${origin}/api/storage/config`)).json()).authMode, "token");
  await page.getByRole("button", { name: "外部存储设置", exact: true }).click();
  await dialog.getByRole("button", { name: "断开此连接", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "已断开连接" }).waitFor();
  await page.mouse.click(2, 2); await dialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "连接外部存储", exact: true }).waitFor();
  assert.equal((await context.request.get(fileUrl)).status(), 409);
  assert.equal(await stat(persistedPath).then(() => true, () => false), false);
  const logouts = await context.request.post(`${origin}/api/auth/logout`, { headers: writeHeaders }); assert.equal(logouts.status(), 204);
  assert.equal((await context.request.get(fileUrl, { headers: { Range: "bytes=0-7", "If-None-Match": '"storage-fixture"' } })).status(), 401);
  assert.equal(mediaCalls.length > 0, true);
  assert.equal(mediaCalls.every(call => !call.authorization && !call.cookie), true, "credentials were forwarded to a file host");
  assert.equal(apiCalls.some(call => call.token === remoteToken), true);
  assert.deepEqual(mockErrors, []); assert.deepEqual(browserErrors, []);
  console.log("OpenList authentication, renewal, persistence, pagination, paths, downloads, range responses, media isolation and responsive browser checks passed");
} catch (error) {
  console.error(backendLog);
  if (mockErrors.length) console.error(mockErrors);
  throw error;
} finally {
  await browser?.close(); await stopBackend();
  for (const server of [mock, media]) { server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
