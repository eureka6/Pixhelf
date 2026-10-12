import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchBrowser } from './live-photo-fixture.mjs';
import { serveFrontendAsset } from './frontend-fixture.mjs';

const [html, photo] = await Promise.all([
  readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
  readFile(new URL('fixtures/live-photo.jpg', import.meta.url)),
]);
const images = Array.from({ length: 80 }, (_, i) => ({ id: String(i).padStart(32, '0'), name: `${i}.jpg`, width: 960, height: 720 }));
const auth = { enabled: false, authenticated: false };
const summary = { total: images.length, albums: [], revision: 'mobile-viewport' };
const imagePage = { items: images, total: images.length, offset: 0, limit: 100, nextOffset: null };
const status = { total: images.length, ready: images.length, failed: 0, queued: 0, processing: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const browser = await launchBrowser();
try {
  for (const width of [390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 744 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.hostname !== 'pixhelf.test') return route.abort();
      const reply = json => route.fulfill({ json });
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('__PIXHELF_AUTH__', JSON.stringify(auth))
        .replace('__PIXHELF_BOOTSTRAP__', JSON.stringify({ summary, status, images: imagePage })) });
      if (path.startsWith('/assets/')) return serveFrontendAsset(route);
      if (path.endsWith('/thumbnail')) return route.fulfill({ contentType: 'image/jpeg', body: photo });
      if (path === '/api/images') return reply(imagePage);
      if (path === '/api/gallery') return reply(summary);
      if (path === '/api/status') return reply(status);
      if (path === '/api/categories') return reply({ categories: [] });
      if (path === '/api/auth/session') return reply(auth);
      if (path === '/api/management') return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
      return route.fulfill({ status: 404, body: '' });
    });
    const state = hidden => page.waitForFunction(hidden =>
      document.querySelector('.topbar')?.dataset.hidden === String(hidden)
      && document.querySelector('.bottom-dock')?.dataset.navigationHidden === String(hidden), hidden);
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const scroll = async top => { await page.evaluate(top => { document.activeElement?.blur(); scrollTo(0, top); }, top); await frame(); };
    const trace = async hidden => page.evaluate(hidden => {
      window.barErrors = [];
      window.barObserver?.disconnect();
      const check = () => {
        for (const selector of ['.topbar', '.bottom-dock']) {
          const element = document.querySelector(selector);
          const actual = element.dataset.hidden ?? element.dataset.navigationHidden;
          if (actual !== String(hidden)) window.barErrors.push({ selector, actual, scrollY, height: innerHeight });
        }
      };
      window.barObserver = new MutationObserver(check);
      for (const selector of ['.topbar', '.bottom-dock']) window.barObserver.observe(document.querySelector(selector), { attributes: true });
      check();
    }, hidden);
    const endTrace = async label => {
      await page.waitForTimeout(280);
      assert.deepEqual(await page.evaluate(() => { window.barObserver.disconnect(); return window.barErrors; }), [], label);
    };
    const visual = async (height, offset = 0, windowFirst = false) => {
      await page.evaluate(({ height, offset, windowFirst }) => {
        Object.defineProperties(visualViewport, {
          height: { configurable: true, value: height }, offsetTop: { configurable: true, value: offset },
          pageTop: { configurable: true, get: () => scrollY + offset },
        });
        if (windowFirst) window.dispatchEvent(new Event('resize'));
        visualViewport.dispatchEvent(new Event('resize'));
        visualViewport.dispatchEvent(new Event('scroll'));
        if (!windowFirst) window.dispatchEvent(new Event('resize'));
      }, { height, offset, windowFirst });
      await frame();
    };
    const clearVisual = async () => {
      await page.evaluate(() => {
        delete visualViewport.height; delete visualViewport.offsetTop; delete visualViewport.pageTop; delete visualViewport.scale;
        visualViewport.dispatchEvent(new Event('resize'));
      });
      await frame();
    };
    const geometry = () => page.evaluate(() => {
      const nav = document.querySelector('.mobile-bottom-nav').getBoundingClientRect();
      const selection = document.querySelector('.gallery-selection-bar')?.getBoundingClientRect();
      return { top: document.querySelector('.topbar').getBoundingClientRect().top, navTop: nav.top, navBottom: nav.bottom,
        selectionBottom: selection?.bottom, offset: visualViewport.offsetTop, bottom: visualViewport.offsetTop + visualViewport.height };
    });
    try {
      await page.goto('https://pixhelf.test/');
      await page.locator('.image-card[data-loaded="true"]').first().waitFor();
      await scroll(800); await state(true);
      await trace(true);
      for (const height of [768, 796, 820, 844, 808, 776, 744]) { await page.setViewportSize({ width, height }); await frame(); }
      await endTrace('browser chrome resizing must not repeatedly reveal either bar');

      await scroll(680); await state(false);
      await trace(false);
      for (const height of [770, 812, 844, 800, 744]) { await page.setViewportSize({ width, height }); await frame(); }
      await endTrace('height changes alone must also preserve expanded navigation');

      // A real browser can move its fixed bottom edge before visualViewport
      // catches up. Freeze that API while changing the actual viewport; the
      // dock must follow every resize without waiting for JS height updates.
      await visual(744);
      await trace(false);
      for (const height of [708, 672, 624, 690, 780, 824, 744]) {
        await page.setViewportSize({ width, height });
        const nav = await page.locator('.mobile-bottom-nav').boundingBox();
        assert(Math.abs(nav.y + nav.height - (height - 12)) < 1,
          `native bottom attachment must not lag behind stale viewport metrics: ${JSON.stringify({ height, nav })}`);
      }
      await endTrace('late viewport metrics cannot reopen or hide navigation');
      await clearVisual();

      await scroll(900); await state(true); await page.waitForTimeout(180);
      const intent = await page.evaluate(async () => {
        const target = document.querySelector('.content'), initialScroll = scrollY;
        const send = (type, x, y, count = 1) => {
          const touches = Array.from({ length: count }, (_, identifier) => new Touch({ identifier, target,
            clientX: x + identifier * 30, clientY: y, screenX: x + identifier * 30, screenY: y, pageX: x, pageY: scrollY + y }));
          target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
            touches: type === 'touchend' ? [] : touches, changedTouches: touches }));
        };
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        send('touchstart', 150, 200); send('touchmove', 153, 203); await settle();
        const jitterHidden = document.querySelector('.bottom-dock').dataset.navigationHidden;
        send('touchend', 153, 203);
        send('touchstart', 150, 200); send('touchmove', 185, 203); await settle();
        const horizontalHidden = document.querySelector('.bottom-dock').dataset.navigationHidden;
        send('touchend', 185, 203);
        send('touchstart', 150, 200, 2); send('touchmove', 150, 230, 2); await settle();
        const pinchHidden = document.querySelector('.bottom-dock').dataset.navigationHidden;
        send('touchend', 150, 230, 2);
        const started = performance.now();
        send('touchstart', 150, 200); send('touchmove', 150, 212);
        let revealed;
        while (performance.now() - started < 190) {
          await new Promise(requestAnimationFrame);
          if (document.querySelector('.bottom-dock').dataset.navigationHidden === 'false') { revealed = performance.now() - started; break; }
        }
        send('touchend', 150, 212);
        return { initialScroll, finalScroll: scrollY, jitterHidden, horizontalHidden, pinchHidden, revealed };
      });
      assert.equal(intent.finalScroll, intent.initialScroll, 'the gesture models browser chrome consuming scroll before the document moves');
      assert.equal(intent.jitterHidden, 'true'); assert.equal(intent.horizontalHidden, 'true'); assert.equal(intent.pinchHidden, 'true');
      assert(intent.revealed < 80, `a deliberate return gesture reveals the dock before a page scroll event: ${JSON.stringify(intent)}`);
      await state(false);
      await page.waitForTimeout(160);
      assert(Math.abs((await page.locator('.bottom-dock').boundingBox()).y + 50 - 732) < 1,
        'the reveal animation completes promptly');

      // Browser chrome can resize on every scroll frame; real direction must
      // remain responsive instead of being swallowed by a resize debounce.
      for (let i = 0; i < 5; i++) {
        await page.setViewportSize({ width, height: 760 + i * 16 }); await scroll(700 + i * 20);
      }
      await state(true);
      for (let i = 0; i < 5; i++) {
        await page.setViewportSize({ width, height: 824 - i * 16 }); await scroll(760 - i * 20);
      }
      await state(false);

      await scroll(900); await state(true); await trace(true);
      for (const [height, offset] of [[700, 0], [640, 24], [580, 12], [660, 0]]) await visual(height, offset, height === 640);
      await endTrace('visual viewport resize ordering must not reverse the navigation');
      let box = await geometry();
      assert(box.navTop >= box.bottom, 'collapsed navigation stays below the visible viewport');
      await scroll(780); await state(false); await page.waitForTimeout(230);
      for (const [height, offset] of [[620, 24], [560, 40], [700, 0]]) {
        await visual(height, offset);
        box = await geometry();
        assert(Math.abs(box.top - offset) < 1, `the header follows the visible top: ${JSON.stringify(box)}`);
        assert(Math.abs(await page.evaluate(() => innerHeight) - box.navBottom - 12) < 1,
          `ordinary browser chrome uses the native bottom edge: ${JSON.stringify(box)}`);
      }
      await clearVisual();
      await page.locator('.search-toggle').tap();
      await page.locator('.gallery-search-input input').focus();
      for (const [height, offset] of [[500, 24], [360, 40], [440, 0]]) {
        const bottom = await page.evaluate(({ height, offset }) => {
          Object.defineProperties(visualViewport, {
            height: { configurable: true, value: height }, offsetTop: { configurable: true, value: offset },
            pageTop: { configurable: true, get: () => scrollY + offset },
          });
          visualViewport.dispatchEvent(new Event('resize'));
          return document.querySelector('.mobile-bottom-nav').getBoundingClientRect().bottom;
        }, { height, offset });
        assert(Math.abs(bottom - height - offset + 12) < 1, 'keyboard adjustments apply in the resize event without an extra animation frame');
      }
      await clearVisual();
      await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
      await page.evaluate(() => Object.defineProperty(visualViewport, 'scale', { configurable: true, value: 1.5 }));
      await visual(480, 20);
      box = await geometry();
      assert(Math.abs(box.bottom - box.navBottom - 12) < 1, 'pinch zoom still fits the visual viewport');
      await clearVisual();
      await page.setViewportSize({ width, height: 540 });
      await page.locator('.gallery-menu-toggle').tap();
      await page.locator('.mobile-more-panel').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const menu = await page.locator('.mobile-more-panel').boundingBox();
      assert(menu.y >= 0 && menu.y + menu.height < 528, 'More remains inside the visible area');
      await page.keyboard.press('Escape'); await clearVisual();
      await page.setViewportSize({ width, height: 744 });

      await scroll(0);
      await page.locator('.image-card .photo-card-select').first().focus(); await page.keyboard.press('Space');
      await page.locator('.gallery-selection-bar').waitFor();
      await scroll(900); await state(true); await page.waitForTimeout(230);
      await trace(true);
      await visual(744);
      for (const height of [650, 550, 680]) {
        await page.setViewportSize({ width, height });
        box = await geometry();
        assert(box.selectionBottom <= height - 11 && box.selectionBottom >= height - 17,
          `selected actions remain above the moving browser edge: ${JSON.stringify(box)}`);
      }
      await endTrace('selection actions must not cause navigation to reopen on resize');
      await clearVisual();

      await scroll(1e8); await state(true); await trace(true);
      for (const height of [844, 900, 780, 920, 744]) { await page.setViewportSize({ width, height }); await frame(); }
      await endTrace('clamping at the page bottom must not be interpreted as upward scrolling');
      await page.setViewportSize({ width: width + 30, height: 744 }); await state(false);
      await page.waitForTimeout(300);
      await scroll(800); await state(false); await scroll(900); await state(true);
      await scroll(0); await state(false);
      assert.deepEqual(errors, []);
      console.log(`${width}px: native attachment with stale metrics, early touch reveal ${Math.round(intent.revealed)}ms, immediate keyboard adjustment, continuous resizing, menus/selection, pinch zoom, page-bottom clamping and width changes passed`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
