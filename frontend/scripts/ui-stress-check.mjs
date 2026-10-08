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
  for (const width of [1440, 390, 320]) await check(`${width}: scrolling hides and restores the topbar independently of navigation`, async () => {
    const f = await fixture(width);
    const { page } = f;
    const bar = page.locator('.topbar');
    const toggle = page.locator('.gallery-sidebar-toggle');
    const scroll = async top => {
      await page.evaluate(top => { document.activeElement?.blur(); scrollTo({ top, behavior: 'instant' }); }, top);
      await page.waitForTimeout(250);
    };
    const hidden = async expected => assert.equal(await bar.getAttribute('data-hidden'), String(expected));
    try {
      const sidebarBounds = await page.locator('.desktop-sidebar').boundingBox();
      const brandBounds = width > 720 ? await page.locator('.desktop-sidebar .brand').boundingBox() : null;
      const toggleBounds = await toggle.boundingBox();
      assert.equal(await page.locator('.topbar .brand, .brand-version').count(), 0);
      const galleryTop = await page.locator('.content').evaluate(element => element.getBoundingClientRect().top + scrollY);
      await scroll(320); await hidden(true);
      assert((await page.locator('.search-toggle').boundingBox()).y < 0);
      assert.deepEqual(await toggle.boundingBox(), toggleBounds, 'the sidebar button must remain in place');
      assert.equal(await page.locator('.content').evaluate(element => element.getBoundingClientRect().top + scrollY), galleryTop, 'hiding the bar must not shift the gallery');
      if (width > 720) {
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.deepEqual(await page.locator('.desktop-sidebar').boundingBox(), sidebarBounds, 'hiding the topbar must leave the expanded sidebar in place');
        assert.deepEqual(await page.locator('.desktop-sidebar .brand').boundingBox(), brandBounds, 'the logo stays with the sidebar');
        await page.screenshot({ path: `${output}/sidebar-brand-${width}.png` });
        await scroll(280); await hidden(false);
        await toggle.click();
        await page.waitForTimeout(300);
        await scroll(600); await hidden(true);
      }
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert(await toggle.evaluate(button => {
        const box = button.getBoundingClientRect();
        return box.top >= 0 && button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), 'the collapsed sidebar retains a reachable expand button');
      await page.screenshot({ path: `${output}/topbar-hidden-${width}.png` });
      await toggle.click(); await hidden(false);
      await page.locator(f.sidebar).waitFor();
      await page.locator(`${f.sidebar} .brand-name`).waitFor();
      await page.waitForTimeout(250);
      assert(await page.locator(`${f.sidebar} .brand`).evaluate(brand => {
        const box = brand.getBoundingClientRect();
        const icon = brand.querySelector('img').getBoundingClientRect();
        const text = brand.querySelector('.brand-name').getBoundingClientRect();
        return brand.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
          && Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2) < 1;
      }), 'sidebar logo and text form one aligned, clickable link');
      await page.screenshot({ path: `${output}/sidebar-brand-open-${width}.png` });
      if (width <= 720) await toggle.click();
      await page.locator('.mobile-nav-layer').waitFor({ state: 'detached' });
      await page.locator('.justified-gallery[data-resizing="true"]').waitFor({ state: 'detached' });
      const top = await page.evaluate(() => scrollY);
      await scroll(top + 160); await hidden(true);
      await scroll(top + 156); await hidden(true);
      await scroll(top + 120); await hidden(false);
      await page.locator('.search-toggle').click();
      await scroll(top + 300); await hidden(false);
      await page.keyboard.press('Escape');
      await scroll(top + 500); await hidden(true);
      await page.locator('.search-toggle').focus();
      await page.keyboard.press('Enter');
      const searchFits = await page.evaluate(async () => {
        const start = performance.now();
        while (performance.now() - start < 250) {
          await new Promise(requestAnimationFrame);
          const box = document.querySelector('.search-popover-panel').getBoundingClientRect();
          if (box.left < 0 || box.right > innerWidth) return false;
        }
        return true;
      });
      assert(searchFits, 'opening search while the bar returns must keep the panel on screen');
      await page.keyboard.press('Escape');
      await toggle.focus();
      await page.waitForTimeout(250); await hidden(false);
      await scroll(top + 700); await hidden(true);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await scroll(0); await hidden(false);
      assert((await page.locator('.search-toggle').boundingBox()).y >= 0);
    } finally { await f.close(); }
  });

  for (const width of [1440, 390]) await check(`${width}: gallery and related cards open fullscreen and copy a generic link`, async () => {
    const f = await fixture(width);
    const { page } = f;
    try {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      const card = page.locator('.image-card').first();
      await card.click({ button: 'right' });
      const menu = page.locator('.photo-card-menu:popover-open');
      await menu.getByRole('menuitem', { name: '复制链接', exact: true }).click();
      await menu.getByRole('menuitem', { name: '已复制链接', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `https://pixhelf.test/api/images/${images[0].id}.jpg`);
      await menu.getByRole('menuitem', { name: '全屏查看', exact: true }).click();
      await page.waitForFunction(id => document.fullscreenElement?.classList.contains('image-viewer')
        && document.fullscreenElement.dataset.imageId === id, images[0].id);
      await page.route('**/similar?*', route => route.fulfill({ json: { items: images.slice(1, 4), total: 3, offset: 0, limit: 30, nextOffset: null } }));
      await page.keyboard.press('PageDown');
      const related = page.locator('.viewer-similar-card').first();
      await related.click({ button: 'right' });
      await menu.getByRole('menuitem', { name: '全屏查看', exact: true }).click();
      await page.waitForFunction(id => document.fullscreenElement?.dataset.imageId === id, images[1].id);
      await page.locator('.viewer-media:not(.viewer-swipe-outgoing)').click({ button: 'right' });
      await menu.getByRole('menuitem', { name: '退出全屏', exact: true }).click();
      await page.waitForFunction(() => !document.fullscreenElement);
      await page.goto('https://pixhelf.test/?check=fullscreen-fallback');
      await page.locator('.image-card').first().waitFor();
      await page.evaluate(() => { HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error('denied')); });
      await page.locator('.image-card').first().click({ button: 'right' });
      await menu.getByRole('menuitem', { name: '全屏查看', exact: true }).click();
      await page.locator('.image-viewer').waitFor();
      assert.equal(await page.evaluate(() => document.fullscreenElement), null);
      await page.getByRole('button', { name: '关闭查看器', exact: true }).click();
      await page.locator('.image-viewer').waitFor({ state: 'detached' });
    } finally { await f.close(); }
  });

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

  for (const width of [1440, 390]) await check(`${width}: viewer return handles zoom, fullscreen, navigation and details`, async () => {
    const f = await fixture(width);
    const { page } = f;
    try {
      for (const mode of ['zoom', 'fullscreen', 'navigation', ...(width <= 720 ? ['gesture'] : []), 'details']) {
        let gesture;
        await page.locator('.photo-card-open').first().click();
        await page.locator('.image-viewer[data-full-loaded="true"]').waitFor();
        if (mode === 'zoom') {
          await page.keyboard.press('='); await page.keyboard.press('=');
          await page.waitForTimeout(260);
        } else if (mode === 'fullscreen') {
          await page.locator('.image-viewer').evaluate(viewer => viewer.requestFullscreen());
          await page.waitForTimeout(100);
        } else if (mode === 'navigation') {
          await page.keyboard.press('ArrowRight');
          await page.locator(`.image-viewer[data-image-id="${images[1].id}"][data-full-loaded="true"]`).waitFor();
        } else if (mode === 'gesture') {
          gesture = await page.context().newCDPSession(page);
          await gesture.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: width / 2, y: 400 }] });
          for (const y of [425, 480, 550]) {
            await gesture.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: width / 2, y }] });
          }
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        } else {
          await page.keyboard.press('PageDown');
          await page.waitForFunction(() => document.querySelector('.image-viewer').scrollTop
            >= document.querySelector('.viewer-stage').clientHeight - 2);
        }
        const source = await page.evaluate(() => {
          window.returnStart = null;
          const observer = new MutationObserver(() => {
            const layer = document.querySelector('.viewer-return-layer');
            if (!layer) return;
            const media = layer.querySelector('.viewer-return-media');
            window.returnStart = { bounds: media.getBoundingClientRect().toJSON(), imageId: layer.dataset.imageId,
              details: Boolean(layer.querySelector('.viewer-details-page')), display: getComputedStyle(media).display };
            observer.disconnect();
          });
          observer.observe(document.body, { childList: true, subtree: true });
          return { bounds: document.querySelector('.image-viewer .viewer-media').getBoundingClientRect().toJSON(),
            imageId: document.querySelector('.image-viewer').dataset.imageId };
        });
        // The close button also exits native fullscreen; Escape belongs to the browser there.
        if (gesture) { await gesture.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await gesture.detach(); }
        else if (mode === 'details') await page.keyboard.press('Escape');
        else await page.getByRole('button', { name: '关闭查看器', exact: true }).click();
        await page.waitForFunction(() => window.returnStart);
        const start = await page.evaluate(() => window.returnStart);
        assert.equal(start.imageId, source.imageId, `${mode}: returns the active image`);
        if (mode === 'details') {
          assert(start.details && start.display === 'none', 'details close with a page fade instead of an off-screen flight');
        } else {
          const jump = Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(start.bounds[key] - source.bounds[key])));
          assert(jump < 1, `${mode}: the initial image jumped ${jump}px`);
        }
        await page.waitForFunction(() => !document.querySelector('.image-viewer, .viewer-return-layer, [data-viewer-return-target="true"], #root[inert]'));
        assert.equal(await page.evaluate(() => document.fullscreenElement), null);
      }
    } finally { await f.close(); }
  });

  await check("390: viewer return while the original is loading keeps a visible thumbnail", async () => {
    const pending = Promise.withResolvers();
    const f = await fixture(390, {
      [`/api/images/${images[0].id}.jpg`]: async route => {
        await pending.promise;
        await route.fulfill({ contentType: 'image/jpeg', body: photo }).catch(() => {});
      },
    });
    const { page } = f;
    try {
      await page.locator('.photo-card-open').first().click();
      await page.locator('.image-viewer[data-thumbnail-loaded="true"][data-full-loaded="false"]').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => [...document.querySelectorAll('.viewer-return-visual')]
        .some(image => image.complete && image.naturalWidth > 0 && Number(getComputedStyle(image).opacity) > 0));
      await page.waitForFunction(() => !document.querySelector('.viewer-return-layer, #root[inert]'));
    } finally { pending.resolve(); await f.close(); }
  });

  await check("390: viewer return preserves the displayed bitmap", async () => {
    const f = await fixture(390);
    const { page } = f;
    try {
      await page.locator('.photo-card-open').first().click();
      await page.locator('.image-viewer[data-full-loaded="true"]').waitFor();
      await page.locator('.viewer-original-canvas').evaluate(canvas => {
        const context = canvas.getContext('2d');
        context.fillStyle = '#d32754';
        context.fillRect(0, 0, canvas.width, canvas.height);
      });
      await page.getByRole('button', { name: '关闭查看器', exact: true }).click();
      const snapshot = await page.waitForFunction(() => {
        const layer = document.querySelector('.viewer-return-layer');
        if (!layer) return null;
        const canvas = layer.querySelector('canvas');
        return { pixel: canvas ? [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data] : null,
          maxEdge: canvas ? Math.max(canvas.width, canvas.height) : 0 };
      });
      const result = await snapshot.jsonValue();
      assert.deepEqual(result.pixel, [211, 39, 84, 255], 'closing must preserve the rendered bitmap instead of falling back to the thumbnail');
      assert(result.maxEdge <= 1440, 'the return snapshot must have a bounded pixel buffer');
    } finally { await f.close(); }
  });

  for (const width of [1440, 390]) await check(`${width}: viewer return keeps one continuous timeline during layout changes`, async () => {
    const f = await fixture(width);
    const { page } = f;
    try {
      await page.locator('.photo-card-open').first().click();
      await page.locator('.image-viewer[data-full-loaded="true"]').waitFor();
      await page.getByRole('button', { name: '关闭查看器', exact: true }).click();
      await page.waitForFunction(() => {
        const media = document.querySelector('.viewer-return-media');
        const animation = media?.getAnimations()[0];
        if (!animation) return false;
        animation.pause(); animation.currentTime = 80;
        window.returnMotion = { animation, bounds: media.getBoundingClientRect().toJSON(),
          duration: animation.effect.getTiming().duration };
        return true;
      });
      const continuity = async () => page.evaluate(() => {
        const media = document.querySelector('.viewer-return-media');
        const animation = media?.getAnimations()[0], previous = window.returnMotion;
        const bounds = media?.getBoundingClientRect();
        return { same: animation === previous.animation, phase: media?.parentElement.dataset.phase,
          time: animation?.currentTime, duration: animation?.effect.getTiming().duration,
          jump: bounds ? Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(bounds[key] - previous.bounds[key]))) : Infinity };
      });
      await page.evaluate(async () => {
        for (let i = 0; i < 5; i++) {
          window.dispatchEvent(new Event('resize'));
          visualViewport.dispatchEvent(new Event('resize'));
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
      });
      let motion = await continuity();
      assert(motion.same && motion.phase === 'flying' && motion.time === 80, JSON.stringify(motion));
      for (const nextWidth of [width + 40, width - 20, width]) {
        await page.setViewportSize({ width: nextWidth, height: 844 });
        await page.waitForTimeout(60);
        motion = await continuity();
        assert(motion.same && motion.time === 80 && motion.jump < 1, `layout changes must preserve the current pose and timeline: ${JSON.stringify(motion)}`);
      }
      const landing = await page.evaluate(() => {
        const { animation } = window.returnMotion;
        animation.currentTime = animation.effect.getTiming().duration - .1;
        const media = document.querySelector('.viewer-return-media').getBoundingClientRect();
        const card = document.querySelector('[data-viewer-return-target="true"]').getBoundingClientRect();
        return Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(media[key] - card[key])));
      });
      assert(landing < 1, `returning image missed its target by ${landing}px`);
      await page.evaluate(() => window.returnMotion.animation.finish());
      await page.waitForFunction(() => !document.querySelector('.viewer-return-layer, [data-viewer-return-target="true"]'));
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
