import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

// Production assets with isolated, controllable APIs; never operates on user media.
const dist = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8");
const photo = await readFile(new URL("fixtures/live-photo.jpg", import.meta.url));
const output = "/tmp/pixhelf-ui-check";
await mkdir(output, { recursive: true });
const images = Array.from({ length: 240 }, (_, i) => ({ id: String(i).padStart(32, "0"), name: `photo-${i}.jpg`, width: 1200, height: 900 }));
const imagePage = (offset = 0) => ({ items: images.slice(offset, offset + 60), total: images.length, offset, limit: 60, nextOffset: offset + 60 < images.length ? offset + 60 : null });
const summary = { total: images.length, albums: [], revision: "stress" };
const status = { total: 240, ready: 240, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const auth = { enabled: true, authenticated: true, username: "admin", canChangePassword: true, csrfToken: "1".repeat(64) };
const browser = await launchBrowser();
const failures = [];
let checks = 0;

async function fixture(width, overrides = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width <= 720, isMobile: width <= 720 });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.addInitScript(() => localStorage.setItem("pixhelf.sidebar-collapsed", "false"));
  await page.addInitScript(() => {
    const Observer = window.IntersectionObserver;
    window.IntersectionObserver = class extends Observer {
      constructor(callback, options) {
        super((entries, observer) => {
          if (window.delayPaginationObserver && entries.some(entry => entry.target.matches('.load-sentinel') && entry.isIntersecting)) {
            window.delayedPaginationCallbacks = (window.delayedPaginationCallbacks ?? 0) + 1;
            setTimeout(() => callback(entries, observer), 200);
          } else callback(entries, observer);
        }, options);
      }
    };
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const reply = json => route.fulfill({ json }).catch(() => {});
    if (url.hostname !== "pixhelf.test") return route.abort();
    if (overrides[path]) return overrides[path](route, reply);
    if (path === "/" || path === "/login") return route.fulfill({ contentType: "text/html", body: html
      .replace("__PIXHELF_AUTH__", JSON.stringify(auth))
      .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage() })) });
    if (path.startsWith("/assets/")) return serveFrontendAsset(route);
    if (path.endsWith("/thumbnail") || /^\/api\/images\/[^/]+\.[a-z0-9]+$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: photo });
    if (path === "/api/gallery") return reply(summary);
    if (path === "/api/status") return reply(status);
    if (path === "/api/images") return reply(imagePage(Number(url.searchParams.get("offset") ?? 0)));
    if (path === "/api/management") return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
    if (path === "/api/management/trash") return reply({ items: [] });
    if (path === "/api/auth/session") return reply(auth);
    if (path === "/api/auth/guest") return reply({ enabled: false });
    if (path === "/api/storage/config") return reply({ configured: false, name: "OpenList", url: "", rootPath: "/", authMode: "password", username: "", hasSecret: false });
    if (path === "/api/management/directories") return reply({ path: "", items: [], images: [], total: 0, nextOffset: null });
    if (path.endsWith("/similar")) return reply({ items: [], offset: 0, limit: 30, total: 0, nextOffset: null });
    if (path.endsWith("/info")) return reply({ fileSize: photo.length, modifiedMs: 0, exif: [], histogram: null });
    const image = images.find(image => path === `/api/images/${image.id}`);
    if (image) return reply(image);
    return route.fulfill({ status: 404, json: { error: "unknown fixture API" } });
  });
  await page.goto("https://pixhelf.test/");
  await page.locator('.image-card[data-loaded="true"]').first().waitFor();
  const sidebar = width <= 720 ? ".mobile-sidebar" : ".desktop-sidebar";
  const openNavigation = async () => {
    if (await page.locator(".gallery-sidebar-toggle").getAttribute("aria-expanded") !== "true") await page.locator(".gallery-sidebar-toggle").click();
    await page.locator(sidebar).waitFor();
  };
  return { page, requests, errors, openNavigation, sidebar, close: async () => {
    await context.close(); assert.deepEqual(errors, [], "no unhandled browser errors");
  } };
}

async function check(name, run) {
  const filter = process.argv.find(argument => argument.startsWith("--filter="))?.slice(9);
  if (filter && !name.includes(filter)) return;
  try { await run(); checks++; console.log(`${name} passed`); }
  catch (error) { failures.push({ name, error: String(error) }); console.error(`${name}: ${error.stack}`); }
}

try {
  await check("fast scroll reversal does not consume a stale pagination notification", async () => {
    const f = await fixture(390);
    try {
      await f.page.waitForTimeout(300);
      const before = f.requests.filter(path => path === "/api/images").length;
      await f.page.evaluate(() => { window.delayPaginationObserver = true; document.querySelector('.load-sentinel').scrollIntoView(); });
      await f.page.waitForFunction(() => window.delayedPaginationCallbacks > 0);
      await f.page.evaluate(() => scrollTo(0, 0));
      await f.page.waitForTimeout(400);
      assert.equal(f.requests.filter(path => path === "/api/images").length, before, "returning to the top must not load invisible pages");
    } finally { await f.close(); }
  });
  for (const width of [1440, 390, 320]) {
    await check(`${width}: repeated dialogs, focus and drag dismissal`, async () => {
      const f = await fixture(width);
      const { page } = f;
      try {
        for (let cycle = 0; cycle < 6; cycle++) {
          await f.openNavigation();
          await page.locator(`${f.sidebar} .sidebar-settings-button`).click();
          await page.locator(".settings-dialog[open]").waitFor();
          for (const label of ["访客模式", "外部存储", "关于", "账号安全"]) {
            await page.locator(".settings-nav").getByRole("button", { name: label }).click();
          }
          assert.equal(await page.locator("dialog[open]").count(), 1);
          const box = await page.locator(".settings-dialog").boundingBox();
          assert(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 845, "modal fits viewport");
          await page.keyboard.press("Tab");
          assert(await page.evaluate(() => document.activeElement.closest(".settings-dialog") !== null), "focus stays in modal");
          if (cycle === 0) {
            const input = await page.locator("#settings-username").boundingBox();
            await page.mouse.move(input.x + 10, input.y + 10); await page.mouse.down();
            await page.mouse.move(2, 2); await page.mouse.up();
            assert.equal(await page.locator(".settings-dialog[open]").count(), 1, "dragging out does not dismiss");
            await page.screenshot({ path: `${output}/settings-${width}.png` });
          }
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          assert(await page.evaluate(() => !document.querySelector("#root[inert]") && getComputedStyle(document.documentElement).overflow !== "hidden"), "closing releases the page");
        }
        await page.goto("https://pixhelf.test/login");
        await page.locator("#login-username").waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "login has no horizontal overflow");
        await page.screenshot({ path: `${output}/login-${width}.png` });
      } finally { await f.close(); }
    });
  }

  await check("late trash response cannot resurrect stale items", async () => {
    const old = Promise.withResolvers();
    let calls = 0;
    const f = await fixture(1440, { "/api/management/trash": async (_route, reply) => {
      const request = ++calls;
      if (request === 1) await old.promise;
      return reply({ items: request === 1 ? [{ id: "old", name: "stale.jpg", originalPath: "stale.jpg", deletedAt: 1, size: 1, fileCount: 1 }] : [] });
    } });
    try {
      await f.openNavigation();
      await f.page.locator(f.sidebar).getByText("回收站", { exact: true }).click();
      await f.page.waitForResponse(response => response.url().endsWith("/api/management/trash"), { timeout: 300 }).catch(() => {});
      await f.page.evaluate(() => dispatchEvent(new CustomEvent("pixhelf:management-changed")));
      await f.page.getByText("回收站为空", { exact: true }).waitFor();
      old.resolve();
      await f.page.waitForTimeout(200);
      assert.equal(await f.page.getByText("stale.jpg", { exact: true }).count(), 0);
      assert.equal(await f.page.getByText("回收站为空", { exact: true }).count(), 1);
    } finally { old.resolve(); await f.close(); }
  });

  await check("a burst of form submissions sends exactly one mutation", async () => {
    const pending = Promise.withResolvers();
    let writes = 0;
    const f = await fixture(1440, { "/api/auth/guest": async (route, reply) => {
      if (route.request().method() === "POST") { writes++; await pending.promise; return route.fulfill({ status: 204 }).catch(() => {}); }
      return reply({ enabled: writes > 0 });
    } });
    try {
      await f.page.locator(".sidebar-settings-button").first().click();
      await f.page.locator(".settings-nav").getByRole("button", { name: "访客模式" }).click();
      await f.page.getByRole("switch").waitFor();
      await f.page.getByRole("switch").evaluate(input => { for (let i = 0; i < 40; i++) input.click(); });
      await f.page.waitForTimeout(100);
      assert.equal(writes, 1);
      await f.page.keyboard.press("Escape");
      assert.equal(await f.page.locator(".settings-dialog[open]").count(), 1, "pending mutation keeps its dialog");
      pending.resolve();
      await f.page.waitForFunction(() => !document.querySelector('.settings-switch').disabled);
      assert.equal(await f.page.getByRole("switch").getAttribute("aria-checked"), "true");
    } finally { pending.resolve(); await f.close(); }
  });

  await check("rapid sidebar reversals and repeated viewer sessions leave no animation or scroll locks", async () => {
    const f = await fixture(1440);
    const { page } = f;
    try {
      const trace = await page.evaluate(async () => {
        const intervals = []; let previous = performance.now(), stopped = false;
        const frame = now => { intervals.push(now - previous); previous = now; if (!stopped) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        for (let i = 0; i < 30; i++) {
          document.querySelector('.gallery-sidebar-toggle').click();
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        await new Promise(resolve => setTimeout(resolve, 450)); stopped = true;
        return { intervals, staleResize: Boolean(document.querySelector('[data-resizing="true"]')), finiteAnimations: document.getAnimations().filter(animation => animation.playState === "running" && animation.effect.getComputedTiming().iterations !== Infinity).length };
      });
      assert.equal(trace.staleResize, false);
      assert.equal(trace.finiteAnimations, 0);
      assert(Math.max(...trace.intervals) < 500, "rapid toggles do not freeze the main thread for half a second");
      for (let i = 0; i < 12; i++) {
        await page.locator(".photo-card-open").first().click();
        await page.locator(".image-viewer").waitFor();
        await page.evaluate(() => { for (let i = 0; i < 20; i++) {
          const key = i % 2 ? "ArrowLeft" : "ArrowRight";
          window.dispatchEvent(new KeyboardEvent("keydown", { key })); window.dispatchEvent(new KeyboardEvent("keyup", { key }));
        } });
        await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
        await page.locator(".image-viewer").waitFor({ state: "detached" });
        await page.waitForFunction(() => !document.querySelector('.viewer-return-layer, #root[inert]'));
      }
      await page.screenshot({ path: `${output}/gallery-desktop.png` });
      console.log(JSON.stringify({ sidebarToggles: 30, viewerSessions: 12, keyEvents: 480, maximumFrameGapMs: Math.round(Math.max(...trace.intervals)) }));
    } finally { await f.close(); }
  });

  for (const width of [1440, 390]) await check(`${width}: viewer return follows scrolling without pulling the page back`, async () => {
    const f = await fixture(width);
    const { page } = f;
    try {
      await page.locator('.photo-card-open').first().click();
      await page.locator('.image-viewer').waitFor();
      await page.getByRole('button', { name: '关闭查看器', exact: true }).click();
      const checkLanding = async (retargeted = false) => {
        const snapshot = await page.waitForFunction(requireRetarget => {
          const layer = document.querySelector('.viewer-return-layer[data-phase="flying"]');
          const media = layer?.querySelector('.viewer-return-media');
          const card = document.querySelector('[data-viewer-return-target="true"]');
          const animation = media?.getAnimations()[0];
          if (!animation || !card || (requireRetarget && !(Number(layer.dataset.retargets) > 0))) return null;
          // Resize can replace the animation between browser calls. Hold and
          // measure the same generation just before landing in a single frame.
          animation.pause();
          animation.currentTime = animation.effect.getTiming().duration - 1;
          const source = media.getBoundingClientRect(), target = card.getBoundingClientRect();
          return { distance: Math.hypot(source.x - target.x, source.y - target.y), scroll: scrollY };
        }, retargeted);
        const state = await snapshot.jsonValue();
        await snapshot.dispose();
        assert(state.distance < 2, `returning image must land on the current card: ${JSON.stringify(state)}`);
        return state.scroll;
      };
      await checkLanding();
      await page.mouse.move(width / 2, 600);
      await page.mouse.wheel(0, 180);
      await page.waitForFunction(() => scrollY >= 150);
      await checkLanding();
      await page.evaluate(() => scrollBy({ top: -90, behavior: 'instant' }));
      await page.waitForTimeout(50);
      await checkLanding();
      await page.setViewportSize({ width: width + 20, height: 844 });
      const finalScroll = await checkLanding(true);
      await page.evaluate(() => { for (const animation of document.querySelector('.viewer-return-media').getAnimations()) animation.finish(); });
      await page.waitForFunction(() => !document.querySelector('.viewer-return-layer, [data-viewer-return-target="true"], #root[inert]'));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => scrollY), finalScroll, 'return must preserve the user’s new scroll position');
    } finally { await f.close(); }
  });
} finally { await browser.close(); }
assert.deepEqual(failures, [], `${failures.length} UI stress checks failed`);
console.log(`${checks} UI stress checks passed.`);
