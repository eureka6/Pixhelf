import { serveFrontendAsset } from "./frontend-fixture.mjs";
// Production UI, original/preview video bytes and browser requests are supplied
// locally. No HTTP listener or application service is started.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser, serveLibmediaAsset, serveMotion } from "./live-photo-fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "pixhelf-live-quality-"));
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "2", ...args], { timeout: 60_000, stdio: "pipe" });
let browser;
try {
  const originalPath = join(directory, "original.mp4"), previewPath = join(directory, "preview.mp4"), posterPath = join(directory, "poster.jpg");
  ffmpeg("-f", "lavfi", "-i", "testsrc2=size=1440x1080:rate=12:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-threads", "2", "-an", originalPath);
  ffmpeg("-i", originalPath, "-vf", "scale=480:360", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-threads", "2", "-an", previewPath);
  ffmpeg("-i", originalPath, "-frames:v", "1", posterPath);
  const [html, poster, original, preview] = await Promise.all([
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(posterPath), readFile(originalPath), readFile(previewPath),
  ]);
  const photo = { id: "1".repeat(32), name: "Live.jpg", width: 1440, height: 1080,
    motion: "/original-motion.mp4", preview: "/preview.mp4" };
  const images = { items: [photo], total: 1, offset: 0, limit: 60, nextOffset: null };
  const summary = { total: 1, revision: "quality", albums: [] };
  const status = { total: 1, ready: 1, failed: 0, queued: 0, processing: 0, initialBatchReady: true, backgroundComplete: true,
    textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
  const documentHtml = html.replace("__PIXHELF_AUTH__", JSON.stringify({ enabled: false, authenticated: false }))
    .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images }));
  browser = await launchBrowser();
  const results = [];
  for (const [width, deviceScaleFactor] of [[1440, 2], [390, 3]]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor, hasTouch: width < 720, isMobile: width < 720 });
    const errors = [], requests = [], decoderRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.hostname !== "pixhelf.test") return route.abort();
      if (path.startsWith("/assets/libmedia/")) { decoderRequests.push(path); return serveLibmediaAsset(route); }
      if (path === "/") return route.fulfill({ contentType: "text/html", body: documentHtml });
      if (path.startsWith("/assets/")) return serveFrontendAsset(route);
      if (path === "/api/management") return route.fulfill({ json: { favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 } });
      if (path === "/api/gallery") return route.fulfill({ json: summary });
      if (path === "/api/status") return route.fulfill({ json: status });
      if (path === "/api/images") return route.fulfill({ json: images });
      if (path === `/api/images/${photo.id}`) return route.fulfill({ json: photo });
      if (path.endsWith("/similar")) return route.fulfill({ json: { ...images, items: [], total: 0 } });
      if (path.endsWith("/thumbnail") || /^\/api\/images\/[^/]+\.[a-z0-9]+$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: poster });
      if (path === "/preview.mp4" || path === "/original-motion.mp4") {
        requests.push({ path, method: route.request().method(), range: route.request().headers().range });
        if (url.searchParams.has("status")) return route.fulfill({ json: { state: "ready" } });
        return serveMotion(route, { clip: path === "/preview.mp4" ? preview : original, contentType: "video/mp4" });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("https://pixhelf.test/");
    const card = page.locator(".image-card").first();
    await card.waitFor();
    if (width < 720) await card.tap(); else await card.hover();
    await page.waitForFunction(() => document.querySelector('.image-card .media-preview[data-playing="true"] video')?.videoWidth === 1440);
    assert(!requests.some(request => request.path === "/preview.mp4"), "Live Photos must ignore legacy transcoded previews even in cards");
    await card.locator(".photo-card-open").evaluate(button => button.click());
    await page.locator(".image-viewer").waitFor();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.viewer-media .media-preview[data-playing="true"] canvas');
      return canvas && Math.abs(canvas.width - 1440) <= 3 && Math.abs(canvas.height - 1080) <= 3;
    }, null, { timeout: 20000 });
    const viewerRequests = requests.length;
    assert(requests.some(request => request.path === "/original-motion.mp4"), "viewer requests original motion even when a preview is available");
    const bitmap = await page.locator(".viewer-media .media-player-surface canvas").evaluate(canvas => [canvas.width, canvas.height]);
    const media = page.locator(".viewer-media:not(.viewer-swipe-outgoing)");
    await media.dblclick({ position: { x: 80, y: 80 } });
    await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector(".viewer-media")).transform).a > 1.5);
    assert.deepEqual(await page.locator(".viewer-media .media-player-surface canvas").evaluate(canvas => [canvas.width, canvas.height]), bitmap, "zoom keeps the source detail in the canvas");
    assert(!requests.slice(viewerRequests).some(request => request.path === "/preview.mp4"), "zoom must not fall back to preview bytes");
    await page.screenshot({ path: `/tmp/pixhelf-live-quality-${width}.png` });
    // This multi-megabyte clip exercises many network ranges. Replay must work
    // from retained original bytes even though browser routing disables HTTP cache.
    const player = await media.locator(".media-player-surface").elementHandle();
    await media.locator('.media-preview[data-playback-state="ended"]').waitFor({ timeout: 15000 });
    await page.waitForFunction(element => element.dataset.playerState === "paused", player);
    const completedRequests = requests.filter(request => request.path === "/original-motion.mp4");
    const rangeRequests = completedRequests.filter(request => request.method === "GET");
    assert(rangeRequests.length >= 1 && rangeRequests.length <= 4, "continuous playback streams ranges instead of requesting each cache block separately");
    assert.equal(new Set(completedRequests.map(request => `${request.method}:${request.range}`)).size,
      completedRequests.length, "demuxer seeking must not download a completed range twice");
    await media.dispatchEvent("pixhelf:media-preview-play");
    await page.waitForFunction(() => document.querySelector('.viewer-media .media-preview[data-playing="true"] canvas'));
    const replay = await media.locator(".media-player-surface").elementHandle();
    assert(await player.evaluate(element => element === document.querySelector('.viewer-media .media-player-surface')), 'replay keeps the full-resolution decoder');
    await media.locator('.media-preview[data-playback-state="ended"]').waitFor({ timeout: 15000 });
    await page.waitForFunction(element => element.dataset.playerState === "paused", replay);
    assert.deepEqual(requests.filter(request => request.path === "/original-motion.mp4"), completedRequests,
      "a full replay must issue no new HEAD or GET requests");
    assert.deepEqual(decoderRequests, [], "native-supported Live Photos must never load the ordinary video decoder");
    await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    results.push({ width, deviceScaleFactor, native: true, preparedPreview: false, viewerBitmap: bitmap, originalMotion: true, zoom: true,
      originalBytes: original.length, firstPlaybackRequests: completedRequests.length, replayRequests: 0 });
    await page.close();
  }
  console.log(JSON.stringify({ noServer: true, results }));
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
