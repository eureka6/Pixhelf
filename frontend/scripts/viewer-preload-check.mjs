import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx", contents: `
      import { options, render } from "preact";
      import App from "./src/App";
      import { ImageViewer } from "./src/ImageViewer";
      import { ManagementProvider } from "./src/management";
      import { prepareViewerImages, getViewerThumbnailStatus, getViewerOriginalStatus, getViewerViewportRenderAsset,
        getReadyViewerViewportRenderAsset } from "./src/viewerAssets";
      import { viewerHistoryState } from "./src/viewerHistory";
      import { viewportRenderDimensions } from "./src/viewerLogic";
      const previousVNode = options.vnode;
      options.vnode = vnode => {
        previousVNode?.(vnode);
        if (vnode.type === ImageViewer) window.viewerLoadMore = vnode.props.onLoadMoreImages;
      };
      window.prepareImages = prepareViewerImages;
      window.thumbnailStatus = id => getViewerThumbnailStatus({ id });
      window.originalStatus = id => getViewerOriginalStatus({ id, name: id + ".jpg" });
      window.renderAsset = getViewerViewportRenderAsset;
      window.readyRenderAsset = getReadyViewerViewportRenderAsset;
      window.imageRenderAsset = (image, priority = "high") => {
        const frame = document.querySelector(".viewer-image-frame");
        const size = viewportRenderDimensions(image, { width: frame.clientWidth, height: frame.clientHeight });
        return getViewerViewportRenderAsset(image, size.width, size.height, 0, priority);
      };
      window.restoreViewer = entry => {
        history.replaceState(viewerHistoryState(entry), "", location.href);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      };
      render(<ManagementProvider><App /></ManagementProvider>, document.getElementById("root"));
    `,
  },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", jsxImportSource: "preact",
  loader: { ".svg": "dataurl" },
  define: { "import.meta.env.DEV": "true", "import.meta.url": '"https://viewer.test/assets/app.js"' },
});
const photo = readFileSync(new URL("./fixtures/live-photo.jpg", import.meta.url));
const css = ["base.css", "styles.css", "photoCardActions.css", "selection.css", "PhotoInformation.css", "video.css"]
  .map(file => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).join("\n");
const images = Array.from({ length: 120 }, (_, i) => ({ id: `photo-${i}`, name: `photo-${i}.jpg`, width: 1200, height: 900 }));
const similar = Array.from({ length: 60 }, (_, i) => ({ ...images[i], id: `similar-${i}` }));
const status = { total: 120, ready: 120, queued: 0, processing: 0, failed: 0, initialBatchReady: true,
  backgroundComplete: true, textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const imagePage = (items, offset, limit) => ({ items: items.slice(offset, offset + limit), total: items.length,
  offset, limit, nextOffset: offset + limit < items.length ? offset + limit : null });
const bootstrap = { summary: { total: images.length, albums: [], revision: "preload-fixture" }, status, images: imagePage(images, 0, 60) };
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
let checks = 0;

async function fixture(mobile = false, holdThumbnails = false) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
  page.setDefaultTimeout(3000);
  const errors = [], requests = [], failed = [];
  const originals = Promise.withResolvers();
  const pagination = Promise.withResolvers();
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push(new URL(request.url()).pathname + new URL(request.url()).search));
  page.on("requestfailed", request => failed.push(new URL(request.url()).pathname));
  // No waterfall intersection callback can trigger pagination or card downloads.
  await page.addInitScript(() => {
    window.IntersectionObserver = class {
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <script id="pixhelf-auth" type="application/json">{"enabled":false,"authenticated":false}</script>
      <script id="pixhelf-bootstrap" type="application/json">${JSON.stringify(bootstrap)}</script><div id="root"></div>` });
    if (path.endsWith(".jpg")) {
      await originals.promise;
      return route.fulfill({ contentType: "image/jpeg", body: photo }).catch(() => {});
    }
    if (path.endsWith("/thumbnail")) {
      if (holdThumbnails) await originals.promise;
      return route.fulfill({ contentType: "image/jpeg", body: photo }).catch(() => {});
    }
    if (path === "/api/images" || path.endsWith("/similar")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (offset) await pagination.promise;
      return route.fulfill({ json: imagePage(path.endsWith("/similar") ? similar : images, offset, path.endsWith("/similar") ? 30 : 60) });
    }
    if (path === "/api/gallery") return route.fulfill({ json: bootstrap.summary });
    if (path === "/api/status") return route.fulfill({ json: status });
    if (path.endsWith("/details")) return route.fulfill({ json: { fileSize: photo.length, modifiedMs: 0, exif: [],
      histogram: Object.fromEntries(["red", "green", "blue", "luminance"].map(key => [key, Array(256).fill(0)])) } });
    return route.fulfill({ json: { favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 } });
  });
  await page.goto("https://viewer.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForSelector(".image-card");
  const open = async index => {
    await page.locator(`.image-card[data-image-id="photo-${index}"]`).evaluate(card => card.click());
    await expectImage(`photo-${index}`);
  };
  const expectImage = id => page.waitForFunction(id => document.querySelector(".image-viewer")?.dataset.imageId === id, id);
  const next = async id => {
    await page.locator(".viewer-next").evaluate(button => button.click());
    await expectImage(id);
  };
  const dismissViewer = async () => {
    await page.locator(".image-viewer").focus();
    await page.keyboard.press("Escape");
    await page.locator(".image-viewer").waitFor({ state: "detached" });
  };
  const waitForPath = (matches, count = 1) => requests.filter(matches).length >= count
    ? Promise.resolve()
    : page.waitForRequest(request => {
      const url = new URL(request.url());
      return matches(url.pathname + url.search) && requests.filter(matches).length >= count;
    });
  const close = async () => {
    pagination.resolve(); originals.resolve();
    await page.close();
    assert.deepEqual(errors, [], "the app should run without browser errors");
  };
  return { page, requests, failed, originals, pagination, open, next, expectImage, waitForPath, dismissViewer, close };
}

const setVisibility = (page, state) => page.evaluate(state => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}, state);

async function holdBitmapDecodes(page) {
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    window.bitmaps = [];
    window.decodeReleases = [];
    window.holdDecodes = true;
    window.createImageBitmap = async (...args) => {
      const bitmap = await decode(...args);
      window.bitmaps.push(bitmap);
      if (window.holdDecodes) await new Promise(resolve => window.decodeReleases.push(resolve));
      return bitmap;
    };
  });
}

try {
  const paginationRace = await fixture();
  try {
    await paginationRace.open(40);
    await paginationRace.waitForPath(path => path.startsWith("/api/images?"));
    await paginationRace.page.evaluate(() => { window.delayedLoadMore = window.viewerLoadMore; });
    paginationRace.pagination.resolve();
    await paginationRace.page.locator('.image-card[data-image-id="photo-60"]').waitFor({ state: "attached" });
    // A delayed viewer effect can still hold the callback from before the page arrived.
    await paginationRace.page.evaluate(() => window.delayedLoadMore());
    assert.equal(paginationRace.requests.filter(path => path.startsWith("/api/images?")).length, 1,
      "a delayed pagination callback must consult the updated page before issuing another request");
    checks++;
    console.log("pagination completion: stale callbacks do not request an already consumed page passed");
  } finally { await paginationRace.close(); }

  const recovered = await fixture(true);
  try {
    await recovered.page.route("**/photo-40.jpg*", route => new URL(route.request().url()).search
      ? route.fulfill({ contentType: "image/jpeg", body: photo })
      : route.fulfill({ status: 503, body: "temporarily unavailable" }));
    recovered.originals.resolve();
    await recovered.open(40);
    await recovered.page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.fullLoaded === "true");
    await recovered.waitForPath(path => path === "/api/images/photo-41.jpg");
    await recovered.waitForPath(path => path === "/api/images/photo-39.jpg");
    assert.equal(recovered.requests.filter(path => path === "/api/images/photo-40.jpg?retry=1").length, 1,
      "one successful retry should restore display and neighbor preloading without duplicate downloads");
    checks++;
    console.log("mobile recovery: a successful retry also restores neighbor preloading passed");
  } finally { await recovered.close(); }

  const revisited = await fixture();
  const revisitGate = Promise.withResolvers();
  try {
    revisited.originals.resolve();
    await revisited.open(40);
    await revisited.page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.fullLoaded === "true");
    await revisited.open(0);
    await revisited.page.waitForFunction(() => window.originalStatus("photo-40") === "idle");
    const client = await revisited.page.context().newCDPSession(revisited.page);
    await client.send("Network.clearBrowserCache");
    await client.send("HeapProfiler.collectGarbage");
    await client.detach();
    await revisited.page.route("**/photo-40.jpg", async route => {
      await revisitGate.promise;
      await route.fulfill({ contentType: "image/jpeg", body: photo }).catch(() => {});
    });
    await revisited.open(40);
    await revisited.waitForPath(path => path === "/api/images/photo-40.jpg", 2);
    assert.equal(await revisited.page.locator(".image-viewer").getAttribute("data-full-loaded"), "false",
      "having displayed an image earlier must not hide its thumbnail while the evicted original reloads");
    await revisited.page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.thumbnailLoaded === "true");
    revisitGate.resolve();
    await revisited.page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.fullLoaded === "true");
    checks++;
    console.log("cache eviction: returning to a previously viewed image retains its thumbnail until ready passed");
  } finally { revisitGate.resolve(); await revisited.close(); }

  const thumbnailRetry = await fixture();
  try {
    let attempts = 0;
    const image = { ...images[0], id: "thumbnail-retry" };
    await thumbnailRetry.page.route("**/thumbnail-retry/thumbnail", route => ++attempts === 1
      ? route.fulfill({ status: 503, body: "temporarily unavailable" })
      : route.fulfill({ contentType: "image/jpeg", body: photo }));
    await thumbnailRetry.page.evaluate(image => window.prepareImages([image], 0), image);
    await thumbnailRetry.page.waitForFunction(() => window.thumbnailStatus("thumbnail-retry") === "failed");
    await thumbnailRetry.page.evaluate(image => window.prepareImages([image], 0), image);
    await thumbnailRetry.page.waitForFunction(() => window.thumbnailStatus("thumbnail-retry") === "ready");
    assert.equal(attempts, 2, "a new preload request can retry a failed thumbnail without an automatic retry loop");
    checks++;
    console.log("thumbnail recovery: transient failures do not poison future preloads passed");
  } finally { await thumbnailRetry.close(); }

  const hoverRetry = await fixture();
  try {
    let attempts = 0;
    await hoverRetry.page.route("**/photo-0.jpg", route => ++attempts === 1
      ? route.fulfill({ status: 503, body: "temporarily unavailable" })
      : route.fulfill({ contentType: "image/jpeg", body: photo }));
    const card = hoverRetry.page.locator('.image-card[data-image-id="photo-0"]');
    await card.hover({ position: { x: 12, y: 12 } });
    await hoverRetry.page.waitForFunction(() => window.originalStatus("photo-0") === "failed");
    const box = await card.boundingBox();
    for (let i = 13; i < 20; i++) await hoverRetry.page.mouse.move(box.x + i, box.y + i);
    assert.equal(attempts, 1, "moving over a failed speculative preload must not flood the server with retries");
    await card.click();
    await hoverRetry.page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.fullLoaded === "true");
    assert.equal(attempts, 2, "opening the image should retry the failed hover preload immediately");
    checks++;
    console.log("hover recovery: background failures stay quiet until the image is actually requested passed");
  } finally { await hoverRetry.close(); }

  const decodeRetry = await fixture(true);
  try {
    let attempts = 0;
    const image = { ...images[0], id: "decode-retry" };
    await decodeRetry.page.route("**/decode-retry.jpg", route => ++attempts === 1
      ? route.fulfill({ status: 503, body: "temporarily unavailable" })
      : route.fulfill({ contentType: "image/jpeg", body: photo }));
    await decodeRetry.page.evaluate(async image => {
      const failed = window.renderAsset(image, 100, 75);
      await failed.promise;
      if (failed.status !== "failed") throw new Error("fixture must fail the first original request");
      const recovered = window.renderAsset(image, 100, 75);
      await recovered.promise;
      if (recovered.status !== "ready") throw new Error("a later visit must retry the failed render asset");
    }, image);
    assert.equal(attempts, 2);
    checks++;
    console.log("bitmap recovery: revisiting a failed original starts a fresh render task passed");
  } finally { await decodeRetry.close(); }

  const hiddenReady = await fixture(true);
  try {
    await hiddenReady.open(40);
    await hiddenReady.waitForPath(path => path === "/api/images/photo-40.jpg");
    await hiddenReady.page.evaluate(() => dispatchEvent(new Event("pagehide")));
    hiddenReady.originals.resolve();
    await hiddenReady.page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.fullLoaded === "true");
    await hiddenReady.page.waitForTimeout(180);
    assert(!hiddenReady.requests.includes("/api/images/photo-41.jpg"),
      "a late original completion must not restart neighbors after pagehide");
    await hiddenReady.page.evaluate(() => dispatchEvent(new Event("pageshow")));
    await hiddenReady.waitForPath(path => path === "/api/images/photo-41.jpg");
    checks++;
    console.log("page suspension: an original finishing after pagehide waits for pageshow before preloading passed");
  } finally { await hiddenReady.close(); }

  for (const mobile of [false, true]) {
    const f = await fixture(mobile);
    try {
      await f.open(40);
      await f.waitForPath(path => path === "/api/images/photo-40.jpg");
      await f.dismissViewer();
      await f.page.waitForEvent("requestfailed", { predicate: request => request.url().endsWith("/photo-40.jpg"), timeout: 1500 })
        .catch(error => { if (!f.failed.includes("/api/images/photo-40.jpg")) throw error; });
      assert.equal(await f.page.evaluate(() => window.originalStatus("photo-40")), "idle",
        "closing the viewer must remove its original cache entries");
      await f.open(40);
      await f.waitForPath(path => path === "/api/images/photo-40.jpg", 2);
      checks++;
      console.log(`${mobile ? "mobile" : "desktop"}: closing aborts pending downloads and reopening can start fresh passed`);
    } finally { await f.close(); }
  }

  const hovered = await fixture();
  try {
    await hovered.page.emulateMedia({ reducedMotion: "no-preference" });
    await hovered.page.locator('.image-card[data-image-id="photo-0"]').click();
    await hovered.expectImage("photo-0");
    await hovered.waitForPath(path => path === "/api/images/photo-0.jpg");
    await hovered.dismissViewer();
    await hovered.page.evaluate(() => { window.returnVisuals = [...document.querySelectorAll(".viewer-return-media img")]; });
    await hovered.page.locator(".viewer-return-layer").waitFor({ state: "detached" });
    await hovered.page.waitForTimeout(180);
    assert(await hovered.page.evaluate(() => window.returnVisuals.every(image => !image.hasAttribute("src"))),
      "finished return animations must release their cloned image sources");
    assert.equal(await hovered.page.evaluate(() => window.originalStatus("photo-0")), "idle",
      "returning focus and the cursor to the opening card must not restart its cancelled download");
    await hovered.page.locator('.image-card[data-image-id="photo-0"]').hover({ position: { x: 12, y: 12 } });
    await hovered.waitForPath(path => path === "/api/images/photo-0.jpg", 2);
    checks++;
    console.log("close to gallery: restoring focus and pointer position does not restart the original passed");
  } finally { await hovered.close(); }

  const background = await fixture(false, true);
  try {
    await background.open(40);
    await background.waitForPath(path => path === "/api/images/photo-42.jpg");
    await background.waitForPath(path => path === "/api/images/photo-50/thumbnail");
    await setVisibility(background.page, "hidden");
    assert.deepEqual(await background.page.evaluate(() => [window.originalStatus("photo-40"),
      window.originalStatus("photo-42"), window.thumbnailStatus("photo-50")]), ["loading", "idle", "idle"],
    "backgrounding retains the current download and discards speculative neighbors");
    await setVisibility(background.page, "visible");
    await background.waitForPath(path => path === "/api/images/photo-42.jpg", 2);
    await background.page.evaluate(() => dispatchEvent(new Event("pagehide")));
    assert.equal(await background.page.evaluate(() => window.originalStatus("photo-42")), "idle");
    await background.page.evaluate(() => dispatchEvent(new Event("pageshow")));
    await background.waitForPath(path => path === "/api/images/photo-42.jpg", 3);
    await background.dismissViewer();
    const count = background.requests.filter(path => path.endsWith(".jpg")).length;
    await setVisibility(background.page, "visible");
    await background.page.evaluate(() => dispatchEvent(new Event("pageshow")));
    await background.page.waitForTimeout(180);
    assert.equal(background.requests.filter(path => path.endsWith(".jpg")).length, count,
      "closed sessions must not restart downloads on visibility or history lifecycle events");
    checks++;
    console.log("background lifecycle: stops neighbors, resumes on return, removes listeners on close passed");
  } finally { await background.close(); }

  const late = await fixture(true);
  try {
    await holdBitmapDecodes(late.page);
    late.originals.resolve();
    await late.open(40);
    await late.page.waitForFunction(() => window.decodeReleases.length === 1);
    await late.page.evaluate(image => {
      window.oldAsset = window.imageRenderAsset(image);
      window.oldAsset.promise.then(() => { window.oldSettled = true; });
      const queued = window.imageRenderAsset({ ...image, id: "queued-cancelled" }, "low");
      queued.promise.then(() => { window.queueSettled = true; });
    }, images[40]);
    await late.dismissViewer();
    await late.page.waitForFunction(() => window.oldSettled && window.queueSettled);
    await late.open(40);
    assert.equal(await late.page.evaluate(() => window.bitmaps.length), 1,
      "reopening must not create concurrent decodes while the cancelled native decoder is still finishing");
    await late.page.evaluate(() => window.decodeReleases[0]());
    await late.page.waitForFunction(() => window.decodeReleases.length === 2);
    assert.equal(await late.page.evaluate(() => window.bitmaps[0].width), 0, "late bitmap must be explicitly closed");
    assert(!late.requests.includes("/api/images/queued-cancelled.jpg"), "cancelled queued jobs must never start");
    await late.page.evaluate(() => { window.holdDecodes = false; window.decodeReleases[1](); });
    await late.page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.fullLoaded === "true");
    await late.page.evaluate(() => { window.oldCanvas = document.querySelector(".viewer-original-canvas"); });
    await late.dismissViewer();
    assert(await late.page.evaluate(() => window.bitmaps.every(bitmap => bitmap.width === 0)),
      "closing releases all completed bitmaps, including the new asset with the same cache key");
    assert.equal(await late.page.evaluate(() => window.oldCanvas.width), 0, "closing releases the displayed canvas buffer");
    checks++;
    console.log("late decode: cancellation settles callers, drains the queue, closes bitmaps and preserves reopened assets passed");
  } finally { await late.close(); }

  const mobileBackground = await fixture(true);
  const neighbor = Promise.withResolvers();
  try {
    await mobileBackground.page.route("**/photo-41.jpg", async route => {
      await neighbor.promise;
      await route.fulfill({ contentType: "image/jpeg", body: photo }).catch(() => {});
    });
    mobileBackground.originals.resolve();
    await mobileBackground.open(40);
    await mobileBackground.waitForPath(path => path === "/api/images/photo-41.jpg");
    await setVisibility(mobileBackground.page, "hidden");
    await mobileBackground.page.waitForTimeout(180);
    assert(!mobileBackground.requests.includes("/api/images/photo-39.jpg"),
      "a cancelled neighbor must not trigger the next neighbor from its promise continuation");
    await setVisibility(mobileBackground.page, "visible");
    await mobileBackground.waitForPath(path => path === "/api/images/photo-41.jpg", 2);
    neighbor.resolve();
    await mobileBackground.waitForPath(path => path === "/api/images/photo-39.jpg");
    checks++;
    console.log("mobile background: cancels neighbor downloads and delayed continuations, then resumes passed");
  } finally { neighbor.resolve(); await mobileBackground.close(); }

  const timeout = await fixture(true);
  try {
    await timeout.page.clock.install();
    await holdBitmapDecodes(timeout.page);
    timeout.originals.resolve();
    await timeout.page.evaluate(image => {
      window.timedAsset = window.renderAsset(image, 100, 75);
      window.timedAsset.promise.then(() => { window.timeoutSettled = true; });
    }, { ...images[0], id: "decode-timeout" });
    await timeout.page.waitForFunction(() => window.decodeReleases.length === 1);
    await timeout.page.clock.fastForward(30_000);
    assert(await timeout.page.evaluate(() => window.timeoutSettled && window.timedAsset.status === "failed"),
      "decode timeout must settle the logical task even when the native decoder has not returned");
    await timeout.page.evaluate(() => window.decodeReleases[0]());
    await timeout.page.waitForFunction(() => window.bitmaps[0].width === 0);
    checks++;
    console.log("decode timeout: settles waiting callers and disposes the late result passed");
  } finally { await timeout.close(); }

  const pending = await fixture(false, true);
  try {
    const probes = images.map((image, i) => ({ ...image, id: `probe-${i}` }));
    await pending.page.evaluate(items => window.prepareImages(items, 10), probes);
    await pending.waitForPath(path => path === "/api/images/probe-12.jpg");
    await pending.page.evaluate(items => window.prepareImages(items, 60), probes);
    assert.equal(await pending.page.evaluate(() => window.thumbnailStatus("probe-10")), "idle",
      "a pending thumbnail outside the new navigation window must be discarded");
    await pending.page.waitForFunction(() => window.thumbnailStatus("probe-60") === "loading");
    await pending.waitForPath(path => path === "/api/images/probe-62.jpg");
    assert(pending.failed.includes("/api/images/probe-10/thumbnail"), "discarded thumbnails must release their network request");
    assert(pending.failed.includes("/api/images/probe-10.jpg"), "old original preloads must release their network request too");
    await pending.page.evaluate(items => window.prepareImages(items, 10), probes);
    await pending.waitForPath(path => path === "/api/images/probe-10/thumbnail", 2);
    assert.equal(await pending.page.evaluate(() => window.thumbnailStatus("probe-10")), "loading",
      "returning to a cancelled image can request it again");
    checks++;
    console.log("fast navigation: obsolete thumbnail and original requests are cancelled and can restart passed");
  } finally { await pending.close(); }

  for (const mobile of [false, true]) {
    const f = await fixture(mobile);
    try {
      await f.open(40);
      await f.page.waitForFunction(() => window.thumbnailStatus("photo-50") === "ready");
      assert(f.requests.includes("/api/images/photo-50/thumbnail"), "neighbors preload while the original is still pending and the waterfall never intersects");
      assert.equal(await f.page.evaluate(() => window.scrollY), 0, "viewer navigation does not rely on scrolling the waterfall");
      await f.waitForPath(path => path.startsWith("/api/images?"));
      assert.equal(f.requests.filter(path => path.startsWith("/api/images?")).length, 1,
        "fetch the next page before the thumbnail preload window reaches the loaded-list boundary");
      for (let i = 41; i <= 50; i++) await f.next(`photo-${i}`);
      assert.equal(f.requests.filter(path => path.startsWith("/api/images?")).length, 1, "pending pagination is deduplicated while switching");
      assert(!f.requests.includes("/api/images/photo-60/thumbnail"), "only loaded image records are prefetched");
      f.pagination.resolve();
      await f.page.waitForFunction(() => window.thumbnailStatus("photo-60") === "ready");
      assert.equal(await f.page.locator('.image-card[data-image-id="photo-60"] img').count(), 0,
        "new-page thumbnails preload even though their waterfall cards have never loaded");
      for (let i = 51; i <= 60; i++) await f.next(`photo-${i}`);
      await f.page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.thumbnailLoaded === "true");
      assert.equal(f.requests.filter(path => path.startsWith("/api/images?")).length, 1, "the final page is not requested again");
      checks++;
      console.log(`${mobile ? "mobile" : "desktop"}: thumbnails load independently of waterfall, originals and pagination; next page is ready before crossing passed`);
    } finally { await f.close(); }
  }

  const boundary = await fixture();
  try {
    await boundary.open(59);
    await boundary.waitForPath(path => path.startsWith("/api/images?"));
    await boundary.waitForPath(path => path === "/api/images/photo-58.jpg");
    await boundary.page.locator(".image-viewer").focus();
    await boundary.page.keyboard.press("ArrowRight");
    await boundary.expectImage("photo-59");
    boundary.pagination.resolve();
    await boundary.expectImage("photo-60");
    await boundary.page.waitForFunction(() => window.thumbnailStatus("photo-61") === "ready");
    assert(!boundary.failed.includes("/api/images/photo-58.jpg"),
      "crossing a pending page must retain nearby downloads from the preceding page");
    assert.equal(boundary.requests.filter(path => path.startsWith("/api/images?")).length, 1);
    checks++;
    console.log("pending page boundary: advances when the page arrives and retains nearby preloads passed");
  } finally { await boundary.close(); }

  const f = await fixture();
  try {
    await f.open(0);
    const parent = { version: 3, image: images[0], branch: null, depth: 1, session: "preload-branch", similarPage: null, returnAnchor: null };
    const branch = { source: images[0], images: similar.slice(0, 30), total: similar.length, nextOffset: 30, index: 10, parent };
    await f.page.evaluate(entry => window.restoreViewer(entry), { ...parent, depth: 2, image: similar[10], branch });
    await f.expectImage("similar-10");
    await f.waitForPath(path => path.includes("/similar?"));
    for (let i = 11; i <= 20; i++) await f.next(`similar-${i}`);
    assert.equal(f.requests.filter(path => path.includes("/similar?")).length, 1, "similar branch has its own deduplicated early pagination");
    assert(!f.requests.some(path => path.startsWith("/api/images?")), "similar viewer must not page the library behind it");
    f.pagination.resolve();
    await f.page.waitForFunction(() => window.thumbnailStatus("similar-30") === "ready");
    for (let i = 21; i <= 30; i++) await f.next(`similar-${i}`);
    checks++;
    console.log("similar branch: prefetches the next page without reaching the boundary or scrolling its parent passed");
  } finally { await f.close(); }
  console.log(`${checks} viewer preload checks passed`);
} finally { await browser.close(); }
