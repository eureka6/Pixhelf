import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const photo = await readFile(new URL("fixtures/live-photo.jpg", import.meta.url));
const images = Array.from({ length: 30 }, (_, i) => ({ id: String(i).padStart(32, "0"), name: `photo-${i}.jpg`, width: 1200, height: 900 }));
const summary = { total: images.length, albums: [], revision: "viewer-switch" };
const imagePage = { items: images, total: images.length, offset: 0, limit: 60, nextOffset: null };
const status = { total: 30, ready: 30, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const reportOnly = process.argv.includes("--report-only");
const results = [];
const browser = await launchBrowser();

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 720, isMobile: width < 720, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [], requests = [], failed = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => failed.push(new URL(request.url()).pathname));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "connection", { configurable: true, value: { effectiveType: "4g", downlink: 8, rtt: 350 } });
    });
    await page.route("**/*", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: html
        .replace("__PIXHELF_AUTH__", '{"enabled":false,"authenticated":false}')
        .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage })) });
      if (path.startsWith("/assets/")) return serveFrontendAsset(route);
      if (path.endsWith(".jpg")) {
        requests.push(path);
        await delay(600);
        return route.fulfill({ contentType: "image/jpeg", body: photo }).catch(() => {});
      }
      if (path.endsWith("/thumbnail")) return route.fulfill({ contentType: "image/jpeg", body: photo });
      if (path === "/api/gallery") return route.fulfill({ json: summary });
      if (path === "/api/status") return route.fulfill({ json: status });
      if (path === "/api/images") return route.fulfill({ json: imagePage });
      if (path === "/api/categories") return route.fulfill({ json: { categories: [] } });
      return route.fulfill({ json: { favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 } });
    });
    try {
      const ready = index => page.waitForFunction(id => {
        const viewer = document.querySelector(".image-viewer");
        const original = viewer?.querySelector(".viewer-media:not(.viewer-swipe-outgoing) .viewer-original");
        const displayed = original instanceof HTMLImageElement ? original.complete && original.naturalWidth > 0
          : original instanceof HTMLCanvasElement && original.dataset.renderedSource?.includes(id);
        return viewer?.dataset.imageId === id && viewer.dataset.fullLoaded === "true" && displayed;
      }, images[index].id);
      await page.goto("https://pixhelf.test/");
      await page.locator(`.image-card[data-image-id="${images[10].id}"]`).evaluate(card => card.click());
      await ready(10);
      let previous = 10;
      const switches = [];
      for (const index of [11, 12, 11, 10, 9]) {
        // A short reading pause gives a 600 ms original time to be prepared.
        await delay(900);
        const before = requests.filter(path => path.endsWith(`/${images[index].id}.jpg`)).length;
        const started = performance.now();
        await page.locator(index > previous ? ".viewer-next" : ".viewer-previous").evaluate(button => button.click());
        await ready(index);
        switches.push({ image: index, readyMs: Math.round(performance.now() - started), requestedBeforeSwitch: before > 0,
          requestsOnSwitch: requests.filter(path => path.endsWith(`/${images[index].id}.jpg`)).length - before });
        previous = index;
      }
      if (!reportOnly) {
        assert(switches.every(item => item.requestedBeforeSwitch), "forward and backward originals must be prepared before switching");
        assert(switches.every(item => item.readyMs < 250), "prepared originals should display without another network wait");
        assert(switches.every(item => item.requestsOnSwitch === 0), "switching reuses completed or pending originals");
        for (const index of [10, 11, 12, 9]) assert.equal(requests.filter(path => path.endsWith(`/${images[index].id}.jpg`)).length,
          1 + failed.filter(path => path.endsWith(`/${images[index].id}.jpg`)).length,
          `photo-${index}: only unfinished preloads cancelled on navigation may be requested again`);
        assert(requests.length < 12, "original prefetch stays near the current image");
      }
      results.push({ width, originalDelayMs: 600, dwellMs: 900, switches, originalRequests: requests.length });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log(JSON.stringify(results, null, 2));
  if (process.env.PIXHELF_VIEWER_SWITCH_REPORT) await writeFile(process.env.PIXHELF_VIEWER_SWITCH_REPORT, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
