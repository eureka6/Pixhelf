import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = await mkdtemp(join(tmpdir(), "pixhelf-albums-check-"));
const gallery = join(directory, "gallery");
let backend, browser;
let backendLog = "";

function png(index) {
  const width = 180 + index % 3 * 40, height = 140 + index % 4 * 35;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    raw[offset] = (index * 17 + x / 3) % 256;
    raw[offset + 1] = (index * 31 + y / 2) % 256;
    raw[offset + 2] = 120;
  }
  const chunk = (type, data) => {
    const contents = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of contents) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, contents, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function eventually(predicate, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}

async function navigate(page, title) {
  if (await page.locator(".gallery-sidebar-toggle").getAttribute("aria-expanded") !== "true") {
    await page.locator(".gallery-sidebar-toggle").click();
  }
  const panel = page.viewportSize().width <= 720 ? ".mobile-sidebar" : ".desktop-sidebar";
  assert.deepEqual(await page.locator(`${panel} .album-link strong`).allTextContents(), ["图片", "相册", "相似图片", "外部存储"]);
  await page.locator(`${panel} .album-link`).getByText(title, { exact: true }).click();
  if (title === "相册") await page.locator(".albums-grid").waitFor();
  else await page.locator(".image-card").nth(24).waitFor();
  if (page.viewportSize().width <= 720) {
    await page.waitForFunction(() => !document.querySelector(".mobile-nav-layer") && document.body.style.overflow !== "hidden");
  }
}

function card(page, path) { return page.locator(`[data-album-path=${JSON.stringify(path)}]`); }
async function waitCount(page, selector, count) {
  await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector, count });
}
async function openAlbum(page, path) {
  if (!await card(page, path).count()) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    assert.ok(parent && parent !== path, `album is not reachable: ${path}`);
    await openAlbum(page, parent);
  }
  await card(page, path).click();
  await page.locator(".album-heading").waitFor();
  await page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
  assert.equal(new URL(page.url()).searchParams.get("album"), path);
}
async function catalog(page) {
  await page.getByRole("navigation", { name: "相册路径" }).getByRole("link", { name: "相册", exact: true }).click();
  await page.locator(".albums-grid").waitFor();
}

try {
  const fixtures = new Map([["", 4], ["旅行", 1], ["旅行/山野", 65], ["旅行/海边", 3], ["旅行集", 1], ["日常", 3], ["项目 & 2026/同名", 2], ["收藏/同名", 2], ["空相册", 0]]);
  let imageIndex = 0;
  for (const [path, count] of fixtures) {
    await mkdir(join(gallery, path), { recursive: true });
    for (let i = 0; i < count; i++) await writeFile(join(gallery, path, `photo-${i}.png`), png(imageIndex++));
  }
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, RUST_LOG: "warn" };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("PIXHELF_AUTH_") || ["PIXHELF_PUBLIC_URL", "PIXHELF_TRUSTED_PROXIES"].includes(key)) delete environment[key];
  }
  environment.PIXHELF_AUTH_ENABLED = "false";
  backend = spawn(process.env.PIXHELF_TEST_BINARY ?? join(project, "target/debug/pixhelf"), ["--listen", `127.0.0.1:${port}`, "--gallery-dir", gallery, "--cache-dir", join(directory, "cache"), "--scan-interval", "2", "--text-search-model", "false", "--workers", "1"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [backend.stdout, backend.stderr]) stream.on("data", chunk => { backendLog = (backendLog + chunk.toString()).slice(-16_000); });
  await eventually(async () => {
    assert.equal(backend.exitCode, null, backendLog);
    try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; }
  }, "backend startup");
  const summary = await (await fetch(`${origin}/api/gallery`)).json();
  assert.equal(summary.total, imageIndex);
  assert.equal(summary.albums.length, 10);
  assert.equal(summary.albums.find(album => album.path === "旅行").count, 69);
  assert.equal(summary.albums.find(album => album.path === "空相册").cover, null);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width <= 720 });
    const errors = [], imageRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/images") imageRequests.push(request.url()); });
    await page.goto(origin);
    await page.locator(".image-card").nth(24).waitFor();
    assert.equal(await page.locator(".album-heading").count(), 0, "library no longer starts with the waterfall");
    await navigate(page, "相册");
    const requestsBeforeCatalog = imageRequests.length;
    await waitCount(page, ".album-card", 6);
    assert.equal(await page.locator(".image-card").count(), 0);
    assert.deepEqual(await page.locator(".album-card p").allTextContents(), summary.albums.filter(album => !album.path.includes("/")).map(album => album.path));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.waitForFunction(() => [...document.querySelectorAll(".album-cover img")].filter(img => img.getBoundingClientRect().top < innerHeight).every(img => img.complete && img.naturalWidth > 0));
    await page.screenshot({ path: join(tmpdir(), `pixhelf-albums-${width}.png`), fullPage: true });

    await page.locator(".search-toggle").click();
    await page.getByRole("searchbox", { name: "搜索相册", exact: true }).fill("同名");
    await waitCount(page, ".album-card", 2);
    assert.deepEqual((await page.locator(".album-card p").allTextContents()).sort(), ["收藏/同名", "项目 & 2026/同名"].sort());
    await page.getByRole("searchbox", { name: "搜索相册", exact: true }).fill("不存在的相册");
    await page.getByText("没有找到相册", { exact: true }).waitFor();
    await page.locator(".clear-search").click();
    await page.locator(".search-toggle").click();
    await waitCount(page, ".album-card", 6);
    assert.equal(imageRequests.length, requestsBeforeCatalog, "catalog search fetched images");

    await openAlbum(page, "空相册");
    await page.getByText("相册暂无图片", { exact: true }).waitFor();
    assert.equal(await page.locator(".image-card").count(), 0);
    await catalog(page);
    await openAlbum(page, "项目 & 2026/同名");
    await waitCount(page, ".image-card", 2);
    await page.reload();
    await page.getByRole("heading", { name: "同名", exact: true }).waitFor();
    await waitCount(page, ".image-card", 2);
    await page.getByRole("navigation", { name: "相册路径" }).getByRole("link", { name: "项目 & 2026", exact: true }).click();
    await page.getByRole("heading", { name: "项目 & 2026", exact: true }).waitFor();
    await waitCount(page, ".image-card", 2);
    await page.goBack();
    await page.getByRole("heading", { name: "同名", exact: true }).waitFor();
    await page.goForward();
    await page.getByRole("heading", { name: "项目 & 2026", exact: true }).waitFor();
    await catalog(page);

    await openAlbum(page, "旅行/山野");
    await page.locator(".image-card").nth(59).waitFor({ state: "attached" });
    await page.locator(".load-sentinel").scrollIntoViewIfNeeded();
    await waitCount(page, ".image-card", 65);
    assert.ok(imageRequests.some(url => { const p = new URL(url).searchParams; return p.get("album") === "旅行/山野" && p.get("offset") === "60"; }), "album pagination was not requested");
    const expected = await (await fetch(`${origin}/api/images?album=${encodeURIComponent("旅行/山野")}&limit=100`)).json();
    assert.deepEqual(await page.locator(".image-card").evaluateAll(cards => cards.map(card => card.dataset.imageId).sort()), expected.items.map(image => image.id).sort());
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(tmpdir(), `pixhelf-album-detail-${width}.png`) });
    await page.locator(".image-card").first().click();
    await page.locator(".image-viewer").waitFor();
    await page.goBack();
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    assert.equal(new URL(page.url()).searchParams.get("album"), "旅行/山野");
    await page.goBack();
    await page.getByRole("heading", { name: "旅行", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("album"), "旅行");
    assert.equal(await card(page, "旅行/山野").count(), 1);
    await page.goForward();
    await page.getByRole("heading", { name: "山野", exact: true }).waitFor();
    await page.goForward();
    await page.locator(".image-viewer").waitFor();
    await page.locator(".viewer-close").click();
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    await page.locator(".viewer-return-layer").waitFor({ state: "detached" });
    await navigate(page, "图片");
    assert.equal(new URL(page.url()).search, "");
    assert.equal(await page.locator(".album-heading").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    if (width === 1440) {
      await navigate(page, "相册");
      // Switching while an album request is pending must leave the catalog intact.
      let release;
      const blocked = new Promise(resolve => { release = resolve; });
      await page.route("**/api/images?*", async route => { await blocked; await route.continue().catch(() => {}); }, { times: 1 });
      await card(page, "日常").click();
      await page.locator(".album-heading").waitFor();
      await navigate(page, "相册");
      release();
      await page.unrouteAll({ behavior: "wait" });
      await waitCount(page, ".album-card", 6);
      assert.equal(await page.locator(".image-card").count(), 0);
      await mkdir(join(gallery, "新增空相册"));
      await card(page, "新增空相册").waitFor({ timeout: 20_000 });
      await openAlbum(page, "新增空相册");
      await page.getByText("相册暂无图片", { exact: true }).waitFor();
      await rm(join(gallery, "新增空相册"), { recursive: true });
      await page.locator(".albums-grid").waitFor({ timeout: 20_000 });
      await waitCount(page, ".album-card", 6);
      assert.equal(new URL(page.url()).searchParams.get("album"), null);
    }
    await navigate(page, "相册");
    await page.locator(".topbar .explore-toggle").click();
    await page.locator(".image-card").nth(24).waitFor();
    assert.equal(new URL(page.url()).search, "");
    assert.equal(await page.locator(".topbar .explore-toggle").getAttribute("aria-pressed"), "true");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, albums: 10, pathsAndCovers: true, emptyAndNestedAlbums: true, localSearch: true, pagination: true, viewerHistory: true, liveDirectories: width === 1440 }));
    await page.close();
  }
  await browser.close();
  browser = null;
  const motionUrl = `${origin}/?${new URLSearchParams({ view: "albums", album: "旅行/山野" })}`;
  const motion = spawn(process.execPath, [join(project, "frontend/scripts/navigation-motion-check.mjs")], { env: { ...process.env, PIXHELF_URL: motionUrl }, stdio: "inherit" });
  const motionCode = await new Promise((resolve, reject) => { motion.once("error", reject); motion.once("exit", resolve); });
  assert.equal(motionCode, 0, "navigation motion regression failed");
} finally {
  await browser?.close();
  if (backend && backend.exitCode === null) {
    const exited = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
