import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const [html, photo, gif] = await Promise.all([
  readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
  readFile(new URL("fixtures/live-photo.jpg", import.meta.url)),
  readFile(new URL("fixtures/animated.gif", import.meta.url)),
]);
const images = Array.from({ length: 40 }, (_, index) => ({
  id: String(index).padStart(32, "0"), name: `image-${index}.${index < 2 ? "GIF" : "jpg"}`, width: 960, height: 720,
}));
const related = { ...images[0], id: "a".repeat(32) };
const auth = { enabled: false, authenticated: false };
const summary = { total: images.length, albums: [], revision: "gif-preview" };
const status = { total: images.length, ready: images.length, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const imagePage = { items: images, offset: 0, limit: 60, total: images.length, nextOffset: null };
const browser = await launchBrowser();

async function movingPixels(card) {
  const rect = await card.boundingBox();
  const clip = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), width: 20, height: 20 };
  const first = await card.page().screenshot({ clip });
  for (let attempt = 0; attempt < 4; attempt++) {
    await card.page().waitForTimeout(170);
    if (!first.equals(await card.page().screenshot({ clip }))) return;
  }
  assert.fail("the preview's composited GIF pixels must animate");
}

try {
  for (const width of [1440, 390]) {
    const mobile = width <= 720;
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    let pending = null, release = () => {}, fail = false;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      const { pathname: path, hostname } = new URL(route.request().url());
      const reply = json => route.fulfill({ json });
      if (hostname !== "pixhelf.test") return route.abort();
      if (path === "/") return route.fulfill({ contentType: "text/html", body: html.replace("__PIXHELF_AUTH__", JSON.stringify(auth))
        .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage })) });
      if (path.startsWith("/assets/")) return serveFrontendAsset(route);
      if (/\.gif$/i.test(path)) {
        if (pending) await pending;
        return route.fulfill(fail ? { status: 404, body: "" } : { contentType: "image/gif", body: gif }).catch(() => {});
      }
      if (path.endsWith("/thumbnail") || /\.jpg$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: photo });
      if (path === "/api/gallery") return reply(summary);
      if (path === "/api/status") return reply(status);
      if (path === "/api/categories") return reply({ categories: [] });
      if (path === "/api/images") return reply(imagePage);
      if (path === "/api/auth/session") return reply(auth);
      if (path === "/api/management") return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
      if (path.endsWith("/similar")) return reply({ items: [related], offset: 0, limit: 30, total: 1, nextOffset: null });
      if (path.endsWith("/info")) return reply({ fileSize: photo.length, modifiedMs: 0, exif: [], histogram: null });
      const image = [...images, related].find(image => path === `/api/images/${image.id}`);
      return image ? reply(image) : route.fulfill({ status: 404, json: {} });
    });
    const card = index => page.locator(`.image-card[data-image-id="${images[index].id}"]`);
    const start = async card => {
      await card.scrollIntoViewIfNeeded();
      await card.locator('.media-preview').waitFor({ state: 'attached' });
      if (mobile) await card.locator('.photo-card-open').tap();
      else await card.hover();
    };
    const playing = card => card.locator('.media-preview[data-playing="true"][data-loading="false"]').waitFor();
    const stopped = async card => {
      await card.locator('.animated-preview-image').waitFor({ state: 'detached' });
      assert.equal(await card.locator('.media-preview').getAttribute('data-playing'), 'false');
    };
    const load = async () => {
      await page.goto("https://pixhelf.test/");
      await card(0).locator('.media-preview').waitFor({ state: 'attached' });
    };
    try {
      await load();
      assert.equal(await page.locator('.animated-preview-image').count(), 0, 'idle GIF cards use still thumbnails');
      await start(card(0));
      await playing(card(0));
      assert.equal(await page.locator('.image-viewer').count(), 0, 'the first tap only previews');
      await movingPixels(card(0));
      await start(card(1));
      await playing(card(1));
      await stopped(card(0));
      assert.equal(await page.locator('.animated-preview-image').count(), 1, 'only one preview runs');
      await card(1).dispatchEvent('contextmenu', { button: 2, clientX: width / 2, clientY: 200 });
      await stopped(card(1));
      await page.keyboard.press('Escape');
      await page.mouse.move(0, 0);
      await start(card(0));
      await playing(card(0));
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await stopped(card(0));
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });

      await load();
      pending = new Promise(resolve => { release = resolve; });
      await start(card(0));
      await card(0).locator('.media-preview[data-loading="true"]').waitFor();
      if (mobile) await page.evaluate(() => scrollTo(0, 2400));
      else await page.mouse.move(0, 0);
      await stopped(card(0));
      release(); pending = null;
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.animated-preview-image').count(), 0, 'late loads cannot revive a dismissed preview');

      await load();
      fail = true;
      await start(card(0));
      await card(0).locator('.media-preview[data-failed="true"]').waitFor({ state: 'attached' });
      await stopped(card(0));
      fail = false;
      if (mobile) await card(0).locator('.photo-card-open').tap();
      else await card(0).locator('.photo-card-open').click();
      await page.locator('.image-viewer[data-full-loaded="true"]').waitFor();
      assert.equal(await page.locator('.viewer-original-canvas').count(), 0);
      await page.locator('.viewer-close').click();
      await page.locator('.image-viewer').waitFor({ state: 'detached' });
      await page.locator('.viewer-return-layer').waitFor({ state: 'detached' });

      await card(4).locator('.photo-card-open').click();
      await page.locator('.image-viewer').focus();
      await page.keyboard.press('PageDown');
      const similar = page.locator('.viewer-similar-card').first();
      await start(similar);
      await playing(similar);
      await movingPixels(similar);
      if (mobile) await similar.locator('.photo-card-open').tap();
      else await similar.locator('.photo-card-open').click();
      await page.locator(`.image-viewer[data-image-id="${related.id}"][data-full-loaded="true"]`).waitFor();
      assert.equal(await page.locator('.animated-preview-image').count(), 0, 'opening the viewer releases the card preview');
      assert.deepEqual(errors, []);
      console.log(`${width}px: GIF hover/tap, visible animation, single playback, menus, visibility, cancellation, errors and related images passed`);
    } finally { release(); await context.close(); }
  }
} finally { await browser.close(); }
