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
  assert.deepEqual(await page.locator(`${panel} .album-link strong`).allTextContents(), ["图库", "相册", "收藏", "相似图片", "本地存储", "外部存储", "回收站"]);
  await page.locator(`${panel} .album-link`).getByText(title, { exact: true }).click();
  if (title === "相册") await page.locator(".albums-grid").waitFor();
  else await page.locator(".image-card").nth(24).waitFor();
  if (page.viewportSize().width <= 720) {
    await page.waitForFunction(() => !document.querySelector(".mobile-nav-layer") && document.body.style.overflow !== "hidden");
  } else {
    await page.locator(".gallery-sidebar-toggle").click();
  }
}

function card(page, path) { return page.locator(`[data-album-path=${JSON.stringify(path)}]`); }
async function waitCount(page, selector, count) {
  await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector, count });
}
async function openAlbum(page, path) {
  const link = card(page, path).locator(".album-card-open");
  if (page.viewportSize().width <= 720) await link.tap();
  else await link.click();
  await page.waitForURL(url => url.searchParams.get("album") === path);
  await page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
  assert.equal(await page.locator(".album-children").count(), 0);
  await page.getByRole("link", { name: "返回相册", exact: true }).waitFor();
}
async function catalog(page) { await navigate(page, "相册"); }

async function checkAlbumMotion(page, width) {
  if (width <= 720) await page.setViewportSize({ width, height: 600 });
  const album = card(page, '旅行/山野');
  assert.equal(await album.locator('.album-cover-sheet').count(), 3);
  assert.equal(await card(page, '旅行').locator('.album-cover-sheet').count(), 1, 'single-image albums should not have fake preview layers');
  const before = await album.boundingBox();
  const positions = await page.locator('.album-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().toJSON()));
  const transforms = () => album.locator('.album-cover-sheet').evaluateAll(layers => layers.map(layer => {
    const transform = getComputedStyle(layer).transform;
    return [...new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).toFloat64Array()];
  }));
  const folded = await transforms();
  if (width > 720) {
    await album.locator('.album-card-open').hover();
    await page.waitForTimeout(300);
    assert.notDeepEqual(await transforms(), folded, 'hover does not open the album stack');
    assert.deepEqual(await album.boundingBox(), before, 'the animated album changed its layout');
    assert.deepEqual(await page.locator('.album-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().toJSON())), positions, 'the fan animation moved neighbouring cards');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(tmpdir(), `pixhelf-album-fan-${width}.png`) });
    for (let index = 0; index < 4; index++) {
      await page.mouse.move(0, 0); await page.waitForTimeout(45);
      await album.locator('.album-card-open').hover(); await page.waitForTimeout(45);
    }
    await page.mouse.move(0, 0); await page.waitForTimeout(300);
    assert.deepEqual(await transforms(), folded, 'interrupted album animations did not return to the folded state');
    await page.keyboard.press('Tab');
    await album.locator('.album-card-open').focus();
    await page.waitForTimeout(300);
    assert.notDeepEqual(await transforms(), folded, 'keyboard focus does not preview the album');
    await album.locator('.album-card-open').evaluate(link => link.blur());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await album.locator('.album-card-open').hover();
    assert(await album.locator('.album-cover-sheet').evaluateAll(layers => layers.every(layer => Number.parseFloat(getComputedStyle(layer).transitionDuration) <= .001)), 'reduced motion still animates the album');
    await page.mouse.move(0, 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const viewport of [1000, 721, 320, width]) {
      await page.setViewportSize({ width: viewport, height: 844 });
      for (const path of ['收藏/同名', '旅行/山野', '旅行/海边']) {
        await card(page, path).locator('.album-card-open').hover();
        await page.waitForTimeout(280);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${viewport}px album previews overflow the screen`);
      }
    }
    await page.mouse.move(0, 0);
  } else {
    const cdp = await page.context().newCDPSession(page);
    const cover = await album.locator('.album-cover').boundingBox();
    const point = { x: cover.x + cover.width / 2, y: cover.y + cover.height / 2 };
    const touch = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ id: 1, ...point }] : [] });
    await touch('touchStart', point);
    assert.equal(await album.getAttribute('data-card-active'), 'true', 'touch contact must preview before any click');
    // A brush cancels the management hold and keeps native page gestures available.
    await touch('touchMove', { x: point.x + 14, y: point.y });
    await page.waitForTimeout(280);
    assert.notDeepEqual(await transforms(), folded, 'the mobile album stack did not animate');
    assert.equal(new URL(page.url()).searchParams.get('album'), null, 'touch contact entered the album');
    assert.deepEqual(await album.boundingBox(), before, 'the preview moved its tap target');
    assert.deepEqual(await page.locator('.album-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().toJSON())), positions);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await album.locator('.album-select').evaluate(element => Number(getComputedStyle(element).opacity)), 1, 'the preview must share the selection ball feedback');
    await page.screenshot({ path: join(tmpdir(), `pixhelf-album-fan-${width}.png`) });
    const other = card(page, '旅行/海边');
    const neighbor = await other.locator('.album-cover').boundingBox();
    await touch('touchMove', { x: neighbor.x + neighbor.width / 2, y: neighbor.y + neighbor.height / 2 });
    await page.waitForTimeout(280);
    assert.equal(await other.getAttribute('data-card-active'), 'true', 'brushing another card did not transfer the preview');
    assert.equal(await page.locator('.album-card[data-card-active="true"]').count(), 1);
    assert.deepEqual(await transforms(), folded, 'leaving an album must fold its preview');
    await touch('touchEnd');
    await cdp.detach();
    assert.equal(new URL(page.url()).searchParams.get('album'), null, 'brushing cards must not navigate');
    const scroll = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, 120); await page.waitForTimeout(250);
    assert((await page.evaluate(() => scrollY)) > scroll, 'previews must not block page scrolling');
    await page.evaluate(() => scrollTo(0, 0));
    await openAlbum(page, '旅行/山野');
    await page.getByRole('link', { name: '返回相册', exact: true }).tap();
    await page.locator('.albums-grid').waitFor();
    await page.setViewportSize({ width, height: 844 });
  }
  console.log(JSON.stringify({ width, realAlbumPreviews: true, stableFanAnimation: true, reducedMotion: width > 720 }));
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
  await eventually(async () => !(await (await fetch(`${origin}/api/gallery`)).json()).initializing, "initial gallery scan");
  const summary = await (await fetch(`${origin}/api/gallery`)).json();
  assert.equal(summary.total, imageIndex);
  assert.equal(summary.albums.length, 7);
  assert.equal(summary.albums.find(album => album.path === "旅行").count, 1);
  for (const album of summary.albums) {
    assert.equal(album.previews.length, Math.min(3, album.count));
    assert.equal(album.previews[0], album.cover);
    assert.equal(new Set(album.previews).size, album.previews.length);
  }
  assert(!summary.albums.some(album => ["项目 & 2026", "收藏", "空相册"].includes(album.path)));
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  for (const width of process.argv.includes("--navigation-only") ? [] : process.argv.includes("--mobile") ? [390, 320] : [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width <= 720 });
    const errors = [], imageRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/images") imageRequests.push(request.url());
    });
    await page.goto(origin);
    await page.locator(".image-card").nth(24).waitFor();
    assert.equal(await page.locator(".album-heading").count(), 0, "library no longer starts with the waterfall");
    await navigate(page, "相册");
    await waitCount(page, ".album-card", 7);
    assert.equal(await page.locator(".image-card").count(), 0);
    assert.deepEqual(await page.locator(".album-path > span").allTextContents(), summary.albums.map(album => album.path));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.waitForFunction(() => [...document.querySelectorAll(".album-cover img")].filter(img => img.getBoundingClientRect().top < innerHeight).every(img => img.complete && img.naturalWidth > 0));
    await page.screenshot({ path: join(tmpdir(), `pixhelf-albums-${width}.png`), fullPage: true });
    await checkAlbumMotion(page, width);
    const requestsBeforeCatalog = imageRequests.length;

    await page.locator('.search-toggle').click();
    await page.getByRole("searchbox", { name: "搜索相册", exact: true }).fill("同名");
    assert.equal(await page.locator('.search-dialog .gallery-filter-controls').count(), 0, 'album search omits image filters');
    assert.equal(await page.getByRole('searchbox', { name: '搜索相册', exact: true }).evaluate(input => getComputedStyle(input).outlineStyle), 'none');
    await waitCount(page, ".album-card", 2);
    assert.deepEqual((await page.locator(".album-path > span").allTextContents()).sort(), ["收藏/同名", "项目 & 2026/同名"].sort());
    await page.getByRole("searchbox", { name: "搜索相册", exact: true }).fill("不存在的相册");
    await page.getByText("没有找到相册", { exact: true }).waitFor();
    await page.locator(".clear-search").click();
    await waitCount(page, ".album-card", 7);
    assert.equal(imageRequests.length, requestsBeforeCatalog, "catalog search fetched images");
    await page.locator('.search-dialog').getByRole('button', { name: '搜索', exact: true }).click();

    assert.equal(await page.locator('.album-card[data-album-path="空相册"]').count(), 0);
    await openAlbum(page, "项目 & 2026/同名");
    await waitCount(page, ".image-card", 2);
    await page.reload();
    await waitCount(page, ".image-card", 2);
    await catalog(page);
    await openAlbum(page, "旅行");
    await waitCount(page, ".image-card", 1);
    assert.equal(await page.locator(".album-children").count(), 0);
    await page.goBack();
    await waitCount(page, ".album-card", 7);
    await page.goForward();
    await waitCount(page, ".image-card", 1);
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
    await page.locator(".albums-grid").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("album"), null);
    await waitCount(page, ".album-card", 7);
    await page.goForward();
    await page.locator(".image-card").first().waitFor();
    await page.goForward();
    await page.locator(".image-viewer").waitFor();
    await page.locator(".viewer-close").click();
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    await page.locator(".viewer-return-layer").waitFor({ state: "detached" });
    for (let round = 0; round < 2; round++) {
      const request = page.waitForRequest(request => { const url = new URL(request.url()); return url.pathname === "/api/images" && url.searchParams.get("sort") === "explore"; });
      if (round === 0) {
        await page.locator('.search-toggle').click();
        await page.getByLabel('排序方式', { exact: true }).selectOption('explore');
        await page.keyboard.press('Escape');
      } else await page.getByRole('button', { name: '换一组', exact: true }).click();
      const query = new URL((await request).url()).searchParams;
      assert.equal(query.get("album"), "旅行/山野", "exploration stays inside the open album");
      assert.equal(new URL(page.url()).searchParams.get("album"), "旅行/山野");
      await page.waitForFunction(() => document.querySelector(".gallery-reshuffle").getAttribute("aria-busy") === "false");
      const ids = await page.locator(".image-card").evaluateAll(cards => cards.map(card => card.dataset.imageId));
      assert(ids.length > 0 && ids.every(id => expected.items.some(image => image.id === id)));
    }
    const seeds = imageRequests.map(url => new URL(url).searchParams).filter(query => query.get("sort") === "explore").map(query => query.get("seed"));
    assert.notEqual(seeds.at(-1), seeds.at(-2), "exploring again creates a new queue");
    await navigate(page, "图库");
    assert.equal(new URL(page.url()).search, "");
    assert.equal(await page.locator(".album-heading").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    if (width === 1440) {
      await navigate(page, "相册");
      // Switching while an album request is pending must leave the catalog intact.
      let release;
      const blocked = new Promise(resolve => { release = resolve; });
      await page.route("**/api/images?*", async route => { await blocked; await route.continue().catch(() => {}); }, { times: 1 });
      await card(page, "日常").locator(".album-card-open").click();
      await page.waitForURL(url => url.searchParams.get("album") === "日常");
      await navigate(page, "相册");
      release();
      await page.unrouteAll({ behavior: "wait" });
      await waitCount(page, ".album-card", 7);
      assert.equal(await page.locator(".image-card").count(), 0);
      await mkdir(join(gallery, "新增空相册"));
      await writeFile(join(gallery, "新增空相册/photo.png"), png(1234));
      await card(page, "新增空相册").waitFor({ timeout: 20_000 });
      await openAlbum(page, "新增空相册");
      await waitCount(page, ".image-card", 1);
      await rm(join(gallery, "新增空相册"), { recursive: true });
      await page.locator(".albums-grid").waitFor({ timeout: 20_000 });
      await waitCount(page, ".album-card", 7);
      assert.equal(new URL(page.url()).searchParams.get("album"), null);
    }
    await navigate(page, "相册");
    assert.equal(await page.locator('.topbar .explore-toggle').count(), 0);
    const toggle = page.locator('.gallery-sidebar-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator('.topbar .brand').click();
    await page.locator('.search-toggle').click();
    await page.getByLabel('排序方式', { exact: true }).selectOption('explore');
    await page.keyboard.press('Escape');
    await page.locator(".image-card").nth(24).waitFor();
    assert.equal(new URL(page.url()).search, "");
    assert(await page.getByRole('button', { name: '换一组', exact: true }).isVisible());
    if (width === 1440) {
      const preview = summary.albums.find(album => album.path === '旅行/山野').previews[1];
      await page.route(`**/api/images/${preview}/thumbnail`, route => route.fulfill({ status: 404, body: '' }));
      await catalog(page);
      await page.reload();
      await waitCount(page, '.album-card[data-album-path="旅行/山野"] .album-cover-sheet', 2);
      assert.equal(await page.locator('.album-card').count(), 7, 'a broken preview removed its album');
      await page.unroute(`**/api/images/${preview}/thumbnail`);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, albums: 7, pathsAndCovers: true, emptyAndNestedAlbums: true, localSearch: true, pagination: true, albumExploration: true, viewerHistory: true, liveDirectories: width === 1440 }));
    await page.close();
  }
  await browser.close();
  browser = null;
  const motionUrl = `${origin}/?${new URLSearchParams({ view: "albums", album: "旅行/山野" })}`;
  for (const script of ["navigation-motion-check.mjs", "sidebar-resize-check.mjs"]) {
    const check = spawn(process.execPath, [join(project, "frontend/scripts", script)], { env: { ...process.env, PIXHELF_URL: motionUrl }, stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { check.once("error", reject); check.once("exit", resolve); });
    assert.equal(code, 0, `${script} failed`);
  }
} finally {
  await browser?.close();
  if (backend && backend.exitCode === null) {
    const exited = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
