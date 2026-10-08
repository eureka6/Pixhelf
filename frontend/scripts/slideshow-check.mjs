import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const photo = await readFile(new URL("fixtures/live-photo.jpg", import.meta.url));
const gif = await readFile(new URL("fixtures/animated.gif", import.meta.url));
const images = Array.from({ length: 5 }, (_, index) => ({
  id: String(index).padStart(32, "0"), name: index === 0 ? "animated.GIF" : `photo-${index}.jpg`, width: 960, height: 720,
  ...(index === 1 ? { video: { duration: 1, codec: "h264", audioCodec: null, frameRate: 30, container: "mp4" } } : {}),
}));
const related = images.slice(2).map((image, i) => ({ ...image, id: String(i + 10).padStart(32, "0") }));
const auth = { enabled: false, authenticated: false };
const browser = await launchBrowser();

async function fixture(width, paginated = false) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width <= 720,
    isMobile: width <= 720, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  let releasePage, pageRequests = 0, allowPages = !paginated;
  page.on("pageerror", error => errors.push(error.message));
  const summary = { total: images.length, albums: [], revision: "slideshow" };
  const status = { total: 5, ready: 5, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
    textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
  const imagePage = offset => ({ items: paginated && !offset ? images.slice(0, 2) : images.slice(offset),
    offset, limit: 60, total: images.length, nextOffset: paginated && !offset ? 2 : null });
  await page.clock.install();
  await page.route("**/*", async route => {
    const { pathname: path, searchParams, hostname } = new URL(route.request().url());
    const reply = json => route.fulfill({ json }).catch(() => {});
    if (hostname !== "pixhelf.test") return route.abort();
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html.replace("__PIXHELF_AUTH__", JSON.stringify(auth))
      .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage(0) })) });
    if (path.startsWith("/assets/")) return serveFrontendAsset(route);
    if (/\.gif$/i.test(path)) return route.fulfill({ contentType: "image/gif", body: gif });
    if (path.endsWith("/thumbnail") || /\.jpg$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: photo });
    if (path === "/api/gallery") return reply(summary);
    if (path === "/api/status") return reply(status);
    if (path === "/api/categories") return reply({ categories: [] });
    if (path === "/api/images") {
      const offset = Number(searchParams.get("offset") ?? 0);
      if (offset) {
        pageRequests++;
        if (!allowPages) await new Promise(resolve => { releasePage = resolve; });
      }
      return reply(imagePage(offset));
    }
    if (path === "/api/auth/session") return reply(auth);
    if (path === "/api/management") return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
    if (path.endsWith("/info")) return reply({ fileSize: photo.length, modifiedMs: 0, exif: [], histogram: null });
    if (path.endsWith("/similar")) return reply({ items: related, offset: 0, limit: 30, total: related.length, nextOffset: null });
    const image = [...images, ...related].find(image => path === `/api/images/${image.id}`);
    if (image) return reply(image);
    return route.fulfill({ status: 404, json: { error: "unknown fixture API" } });
  });
  await page.goto("https://pixhelf.test/");
  await page.locator('.image-card[data-loaded="true"]').first().waitFor().catch(async error => {
    throw new Error(`${error.message}\n${JSON.stringify({ errors, body: await page.locator('body').innerText() })}`);
  });
  const tick = async ms => { await page.clock.runFor(ms); await page.evaluate(() => {}); };
  const start = async selector => {
    const card = page.locator(selector).first();
    const bounds = await card.boundingBox();
    await card.dispatchEvent("contextmenu", { button: 2, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 });
    await page.getByRole("menuitem", { name: "幻灯片播放", exact: true }).click();
    await tick(100);
    await page.locator(".viewer-slideshow").waitFor();
  };
  const id = () => page.locator(".image-viewer").getAttribute("data-image-id");
  const ready = async image => {
    const loaded = page.locator(`.image-viewer[data-image-id="${image.id}"][data-full-loaded="true"]`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await loaded.count()) return;
      await tick(50);
      // Network decoding is real while the slideshow and idle renderer use the clock.
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`image ${image.id} did not load: ${JSON.stringify(await page.locator('.image-viewer').evaluate(viewer => viewer.dataset))}`);
  };
  return { page, tick, start, id, ready, pageRequests: () => pageRequests,
    release: () => { allowPages = true; releasePage?.(); },
    close: async () => { allowPages = true; releasePage?.(); await context.close(); assert.deepEqual(errors, []); } };
}

try {
  for (const width of [1440, 390]) {
    const f = await fixture(width);
    try {
      const { page, tick } = f;
      await f.start('.image-card');
      await f.ready(images[0]);
      assert.equal(await page.locator('.image-viewer').getAttribute('data-source-strategy'), 'direct-original');
      assert.equal(await page.locator('.viewer-original-canvas').count(), 0, 'mobile GIF must stay animated');
      const bounds = await page.locator('.viewer-original').boundingBox();
      const clip = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2), width: 20, height: 20 };
      const firstFrame = await page.screenshot({ clip });
      let changed = false;
      for (let attempt = 0; attempt < 4 && !changed; attempt++) {
        await page.waitForTimeout(170);
        changed = !firstFrame.equals(await page.screenshot({ clip }));
      }
      assert(changed, 'GIF pixels must change in the rendered viewer');
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
      await page.getByRole('button', { name: '暂停幻灯片', exact: true }).click();
      await tick(12_000);
      assert.equal(await f.id(), images[0].id, 'pause prevents switching');
      await page.getByRole('button', { name: '继续幻灯片', exact: true }).click();
      await tick(4900);
      assert.equal(await f.id(), images[0].id, 'each slide stays for five seconds');
      await tick(200);
      await f.ready(images[2]);
      assert.equal(await page.locator('.video-viewer-stage').count(), 0, 'slideshow skips videos');

      await page.locator('.image-viewer').focus();
      await page.keyboard.press(' ');
      await tick(10_000);
      assert.equal(await f.id(), images[2].id, 'Space pauses');
      await page.keyboard.press(' ');
      await page.keyboard.press('+');
      await tick(6000);
      assert.equal(await f.id(), images[2].id, 'zoom suspends switching');
      await page.keyboard.press('0');
      await tick(100);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await tick(20_000);
      assert.equal(await f.id(), images[2].id, 'background tabs do not advance');
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      await tick(4900);
      assert.equal(await f.id(), images[2].id, 'resume has no catch-up burst');
      await tick(200);
      await f.ready(images[3]);

      await page.locator('.viewer-media').dispatchEvent('contextmenu', { button: 2, clientX: width / 2, clientY: 400 });
      await tick(7000);
      assert.equal(await f.id(), images[3].id, 'context menus suspend switching');
      await page.keyboard.press('Escape');
      await page.locator('.image-viewer').focus();
      await page.keyboard.press('PageDown');
      await tick(7000);
      assert.equal(await page.locator('.image-viewer').getAttribute('data-page'), 'details');
      assert.equal(await f.id(), images[3].id, 'details suspend switching');
      await page.keyboard.press('PageUp');
      await tick(5200);
      await f.ready(images[4]);
      await tick(5100);
      await f.ready(images[0]);
      await page.getByRole('button', { name: '结束幻灯片', exact: true }).click();
      await tick(10_000);
      assert.equal(await page.locator('.viewer-slideshow').count(), 0);
      assert.equal(await f.id(), images[0].id, 'ending clears the timer');
      await page.locator('.image-viewer').focus();
      await page.keyboard.press('PageDown');
      await tick(500);
      await page.locator('.viewer-similar-card').first().waitFor();
      await page.locator('.viewer-similar-card').first().evaluate(card => card.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await tick(100);
      await f.start('.viewer-similar-card');
      await f.ready(related[0]);
      await tick(5100);
      await f.ready(related[1]);
      await page.locator('.viewer-close').click();
      await tick(200);
      assert.equal(await f.id(), images[0].id, 'closing related slides restores the parent image');
      assert.equal(await page.locator('.viewer-slideshow').count(), 0);
      await page.locator('.image-viewer').focus();
      await page.keyboard.press('PageUp');
      await tick(300);
      await f.start('.viewer-media');
      await page.locator('.viewer-close').click();
      await tick(10_000);
      assert.equal(await page.locator('.image-viewer').count(), 0, 'closing cannot reopen a slideshow');
      await page.goForward();
      await tick(300);
      assert.equal(await page.locator('.viewer-slideshow').count(), 0, 'history does not restart playback');
      console.log(`${width}px: animated GIF, gallery/viewer/related menus, cadence, pause, Space, zoom, visibility, menus, details, looping, stop and history passed`);
    } finally { await f.close(); }
  }

  for (const action of ['wait', 'pause', 'close', 'timeout']) {
    const f = await fixture(1440, true);
    try {
      const { page, tick } = f;
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
      await f.start('.image-card');
      await f.ready(images[0]);
      await tick(action === 'timeout' ? 16_000 : 9000);
      assert.equal(await f.id(), images[0].id, 'wait on a pending page without skipping slides');
      assert.equal(f.pageRequests(), 1, 'pagination is deduplicated');
      if (action === 'close') { await page.locator('.viewer-close').click(); await tick(200); }
      if (action === 'pause') await page.getByRole('button', { name: '暂停幻灯片', exact: true }).click();
      if (action === 'timeout') await page.getByRole('button', { name: '继续幻灯片', exact: true }).waitFor();
      f.release();
      await tick(300);
      if (action === 'close') {
        await tick(8000);
        assert.equal(await page.locator('.image-viewer').count(), 0, 'late pages cannot reopen a closed viewer');
      } else {
        if (action === 'pause' || action === 'timeout') {
          await tick(8000);
          assert.equal(await f.id(), images[0].id, 'late or failed pages cannot override a pause');
          await page.getByRole('button', { name: '继续幻灯片', exact: true }).click();
          await tick(5100);
        }
        await f.ready(images[2]);
        await tick(4500);
        assert.equal(await f.id(), images[2].id, 'slow pages do not shorten the next slide');
      }
      console.log(`pagination: ${action}, cancelled callbacks and fresh intervals passed`);
    } finally { await f.close(); }
  }
} finally { await browser.close(); }
