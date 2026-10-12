import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const images = [[960, 720], [640, 960], [1600, 900]].map(([width, height], i) => ({
  id: String(i).padStart(32, "0"), name: `slide-${i}.jpg`, width, height,
}));
const colors = [[36, 88, 138], [196, 111, 68], [46, 139, 113]];
const browser = await launchBrowser();

async function fixture(width, { delayed = false, reduced = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 },
    hasTouch: width <= 720, isMobile: width <= 720, reducedMotion: reduced ? "reduce" : "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const pictures = (await page.evaluate(({ images, colors }) => images.map((image, i) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `rgb(${colors[i].join(",")})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL().split(",")[1];
  }), { images, colors })).map(data => Buffer.from(data, "base64"));
  const auth = { enabled: false, authenticated: false };
  const summary = { total: images.length, albums: [], revision: "dissolve" };
  const imagePage = { items: images, offset: 0, limit: 60, total: images.length, nextOffset: null };
  const status = { total: 3, ready: 3, queued: 0, processing: 0, failed: 0, initialBatchReady: true,
    backgroundComplete: true, textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
  let released = !delayed;
  const pending = [];
  const release = () => { released = true; pending.splice(0).forEach(resolve => resolve()); };
  await page.clock.install();
  await page.route("**/*", async route => {
    const { pathname: path, hostname } = new URL(route.request().url());
    if (hostname !== "pixhelf.test") return route.abort();
    const reply = json => route.fulfill({ json }).catch(() => {});
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html
      .replace("__PIXHELF_AUTH__", JSON.stringify(auth))
      .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage })) });
    if (path.startsWith("/assets/")) return serveFrontendAsset(route);
    const index = images.findIndex(image => path.includes(image.id));
    if (index >= 0 && (path.endsWith("/thumbnail") || path.endsWith(".jpg"))) {
      if (index === 1 && path.endsWith(".jpg") && !released) await new Promise(resolve => pending.push(resolve));
      return route.fulfill({ contentType: "image/png", body: pictures[index] }).catch(() => {});
    }
    if (path === "/api/gallery") return reply(summary);
    if (path === "/api/status") return reply(status);
    if (path === "/api/images") return reply(imagePage);
    if (path === "/api/categories") return reply({ categories: [] });
    if (path === "/api/auth/session") return reply(auth);
    if (path === "/api/management") return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
    if (path.endsWith("/info")) return reply({ fileSize: 1000, modifiedMs: 0, exif: [], histogram: null });
    if (path.endsWith("/similar")) return reply({ items: [], offset: 0, total: 0, nextOffset: null });
    if (index >= 0) return reply(images[index]);
    return route.fulfill({ status: 404, json: { error: "unknown fixture API" } });
  });
  await page.goto("https://pixhelf.test/");
  await page.locator('.image-card[data-loaded="true"]').first().waitFor();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  const tick = ms => page.clock.runFor(ms);
  const ready = async index => {
    for (let i = 0; i < 100; i++) {
      if (await page.locator(`.image-viewer[data-image-id="${images[index].id}"][data-full-loaded="true"]`).count()) return;
      await tick(20);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`slide ${index} did not become ready`);
  };
  const start = async () => {
    await page.locator('.image-card').first().dispatchEvent('contextmenu', { button: 2, clientX: 150, clientY: 150 });
    await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
    await ready(0);
    // The fake clock advances timers; CSS animations use the real compositor.
    await page.waitForTimeout(220);
  };
  const pixel = async () => {
    const png = await page.screenshot({ clip: { x: Math.floor(width / 2), y: 422, width: 1, height: 1 } });
    return page.evaluate(async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    }, png.toString('base64'));
  };
  return { page, tick, ready, start, pixel, release,
    close: async () => { release(); await context.close(); assert.deepEqual(errors, []); } };
}

try {
  for (const width of [1440, 390]) {
    const f = await fixture(width);
    try {
      const { page, tick } = f;
      await f.start();
      await tick(5050); await f.ready(1);
      await page.locator('.image-viewer[data-slideshow-transition="dissolving"]').waitFor();
      const seek = ms => page.evaluate(ms => {
        const layer = document.querySelector('.viewer-slideshow-outgoing');
        const media = document.querySelector('.viewer-media');
        for (const animation of [...layer.getAnimations(), ...media.getAnimations()]) {
          animation.pause(); animation.currentTime = ms;
        }
      }, ms);
      await seek(0);
      assert.deepEqual(await f.pixel(), colors[0], 'the outgoing full image stays visible at the start');
      await seek(350);
      const middle = await f.pixel();
      assert(middle.every((value, i) => value > Math.min(colors[0][i], colors[1][i]) && value < Math.max(colors[0][i], colors[1][i])),
        `the midpoint blends both slides without a dark flash: ${middle}`);
      await page.screenshot({ path: `/tmp/pixhelf-slideshow-dissolve-${width}.png` });
      assert.equal(await page.locator('.viewer-close').getAttribute('data-slideshow-playing'), 'true');
      assert.equal(await page.locator('.viewer-slideshow-outgoing').getAttribute('inert'), '');
      await seek(900);
      assert.deepEqual(await f.pixel(), colors[1], 'the portrait image is fully revealed');
      await page.evaluate(() => document.querySelector('.viewer-slideshow-outgoing').getAnimations().forEach(animation => animation.finish()));
      await page.locator('.viewer-slideshow-outgoing').waitFor({ state: 'detached' });
      await tick(5100); await f.ready(2);
      await page.locator('.viewer-slideshow-outgoing').waitFor({ state: 'attached' });
      await page.locator('.image-viewer').focus();
      await page.keyboard.press('+'); await tick(50);
      assert.equal(await page.locator('.viewer-slideshow-outgoing').count(), 0, 'zoom immediately takes over the transition');
      await page.keyboard.press('0'); await tick(5100); await f.ready(0);
      await page.locator('.viewer-slideshow-outgoing').waitFor({ state: 'attached' });
      await page.locator('.viewer-close').click(); await tick(200);
      assert.equal(await page.locator('.image-viewer, .viewer-slideshow-outgoing').count(), 0, 'closing disposes every transition layer');
      console.log(`${width}px: real pixel dissolve, mixed aspect ratios, looping, zoom interruption and close passed`);
    } finally { await f.close(); }
  }

  for (const action of ['release', 'navigate', 'close']) {
    const f = await fixture(390, { delayed: true });
    try {
      const { page, tick } = f;
      await f.start(); await tick(6500);
      assert.deepEqual(await f.pixel(), colors[0], 'slow images keep the previous full image on screen');
      assert.equal(await page.locator('.image-viewer').getAttribute('data-slideshow-transition'), 'waiting');
      if (action === 'navigate') { await page.locator('.image-viewer').focus(); await page.keyboard.press('ArrowRight'); }
      if (action === 'close') await page.locator('.viewer-close').click();
      f.release();
      if (action === 'release') {
        await f.ready(1);
        await page.locator('.image-viewer[data-slideshow-transition="dissolving"]').waitFor();
      } else {
        if (action === 'navigate') await f.ready(2);
        await tick(200);
        assert.equal(await page.locator('.viewer-slideshow-outgoing').count(), 0, 'late decoding cannot resurrect an interrupted transition');
        if (action === 'close') assert.equal(await page.locator('.image-viewer').count(), 0);
      }
      console.log(`slow image: ${action} passed`);
    } finally { await f.close(); }
  }

  const f = await fixture(1440, { reduced: true });
  try {
    await f.start(); await f.tick(5100); await f.ready(1);
    assert.equal(await f.page.locator('.viewer-slideshow-outgoing').count(), 0, 'reduced motion skips the animated transition');
    console.log('reduced motion passed');
  } finally { await f.close(); }
} finally { await browser.close(); }
