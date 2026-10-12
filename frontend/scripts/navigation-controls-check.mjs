import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const photo = await readFile(new URL("fixtures/live-photo.jpg", import.meta.url));
const categories = JSON.parse(await readFile(new URL("../src/defaultCategories.json", import.meta.url), "utf8"));
const output = "/tmp/pixhelf-navigation-controls";
await mkdir(output, { recursive: true });
const images = Array.from({ length: 48 }, (_, i) => ({ id: i.toString(16).padStart(32, "0"), name: `photo-${i}.jpg`, width: 960, height: 720 }));
const summary = { total: images.length, albums: [{ path: "旅行", name: "旅行", count: 48, cover: images[0].id }], revision: "controls" };
const imagePage = { items: images, total: images.length, offset: 0, limit: 60, nextOffset: null };
const status = { total: 48, ready: 48, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: true, total: 48, ready: 48, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const browser = await launchBrowser();
async function fixture(width, guest = false) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width <= 720, isMobile: width <= 720 });
  const page = await context.newPage(), errors = [], uploads = [];
  const auth = guest ? { enabled: true, authenticated: false, guest: true } : { enabled: true, authenticated: true, username: "admin", csrfToken: "a".repeat(64) };
  page.setDefaultTimeout(6000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (url.hostname !== "pixhelf.test") return route.abort();
    const reply = json => route.fulfill({ json });
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html.replace("__PIXHELF_AUTH__", JSON.stringify(auth))
      .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage })) });
    if (path.startsWith("/assets/")) return serveFrontendAsset(route);
    if (path.endsWith("/thumbnail")) return route.fulfill({ body: photo, contentType: "image/jpeg" });
    if (path === "/api/auth/session") return reply(auth);
    if (path === "/api/categories") return reply({ categories });
    if (path === "/api/management") return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
    if (path === "/api/management/directories") return reply({ path: '', items: [], total: 0, nextOffset: null });
    if (path === "/api/gallery") return reply(summary);
    if (path === "/api/status") return reply(status);
    if (path === "/api/images" || path === "/api/images/similar") return reply(imagePage);
    if (path === "/api/management/upload") {
      const name = url.searchParams.get("name");
      uploads.push({ name, destination: url.searchParams.get("destination"), headers: route.request().headers(), bytes: route.request().postDataBuffer() });
      if (name === "retry.jpg" && uploads.filter(item => item.name === name).length === 1) return route.fulfill({ status: 409, json: { error: "测试：暂时无法写入" } });
      return reply({ path: `${url.searchParams.get("destination")}/${name === "new.png" ? "new.jpg" : name}` });
    }
    return route.fulfill({ status: 404, json: { error: "unknown API" } });
  });
  await page.goto("https://pixhelf.test/");
  await page.locator('.image-card[data-loaded="true"]').first().waitFor();
  return { page, uploads, close: async () => { await context.close(); assert.deepEqual(errors, []); } };
}

try {
  for (const width of [1440, 1000, 390, 320]) {
    const f = await fixture(width);
    try {
      const { page } = f;
      const toggle = page.locator('.gallery-sidebar-toggle');
      const collapsed = value => page.waitForFunction(value => document.querySelector('.app-shell').dataset.sidebarCollapsed === String(value), value);
      const bounds = () => page.locator('.image-card').first().boundingBox();
      const before = await bounds();
      const galleryBefore = await page.locator('.justified-gallery').boundingBox();
      assert.equal(await toggle.getAttribute('title'), null, 'navigation uses icons without a hover tooltip');
      assert(await page.locator('.topbar .brand').isVisible(), 'the logo is visible before opening navigation');
      assert(await page.locator('.topbar .brand').evaluate(brand => {
        const box = brand.getBoundingClientRect();
        return brand.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), 'the logo is clickable while the sidebar is closed');
      if (width > 720) {
        const arrow = toggle.locator('.sidebar-toggle-arrow');
        const settleLayout = () => page.locator('.justified-gallery[data-resizing="true"]').waitFor({ state: 'detached' });
        const pinned = () => page.locator('.app-shell').getAttribute('data-sidebar-pinned');
        assert.equal(await toggle.getAttribute('data-mode'), 'automatic');
        assert.equal(await arrow.evaluate(element => getComputedStyle(element).opacity), '0');
        await toggle.hover(); await collapsed(false);
        await page.waitForTimeout(220);
        assert.deepEqual(await page.locator('.desktop-sidebar .sidebar-group-label').allTextContents(), ['浏览', '图片工具', '存储管理']);
        assert.deepEqual(await page.locator('.desktop-sidebar .album-link strong').allTextContents(), ['图库', '相册', '收藏', '相似图片', '本地存储', '外部存储', '回收站']);
        assert.equal(await arrow.evaluate(element => getComputedStyle(element).opacity), '1');
        assert(await arrow.evaluate(element => element.getBBox().x > 12), 'hover shows an arrow pointing right');
        await page.screenshot({ path: `${output}/sidebar-hover-${width}.png` });
        await page.locator('.topbar .brand').hover();
        await page.waitForTimeout(220);
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'hovering the fixed logo keeps navigation open');
        await page.locator('.desktop-sidebar .album-nav').hover();
        await page.waitForTimeout(220);
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'hover can move from the button to the sidebar');
        assert.equal(await arrow.evaluate(element => getComputedStyle(element).opacity), '0', 'the automatic mode returns to three lines away from its button');
        assert.deepEqual(await bounds(), before, 'hover overlays the gallery without moving it');
        const closeDelay = await page.evaluate(() => new Promise(resolve => {
          const shell = document.querySelector('.app-shell'), started = performance.now();
          const observer = new MutationObserver(() => {
            if (shell.dataset.sidebarCollapsed === 'true') { observer.disconnect(); resolve(performance.now() - started); }
          });
          observer.observe(shell, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
          document.querySelector('.desktop-sidebar').dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse', relatedTarget: document.body }));
        }));
        assert(closeDelay < 140, 'automatic sidebar responds promptly when the pointer leaves');
        await page.mouse.move(width - 30, 400); await collapsed(true);
        assert(await page.locator('.topbar .brand').isVisible(), 'closing the sidebar keeps the logo visible');
        await page.locator('.topbar .brand').hover();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'hovering the home link alone does not open navigation');
        await toggle.hover(); await collapsed(false);
        await page.locator('.desktop-sidebar .sidebar-heading').click({ position: { x: 15, y: 25 } });
        assert.equal(await pinned(), 'false', 'clicking inside must not pin automatic navigation');
        await page.mouse.move(width - 30, 400); await collapsed(true);
        await toggle.hover(); await collapsed(false);
        await page.locator('.desktop-sidebar .album-link[title="相册"]').click();
        assert.equal(await pinned(), 'false', 'choosing a section must not pin automatic navigation');
        await collapsed(true);
        await toggle.hover(); await collapsed(false);
        await page.locator('.topbar .brand').click();
        assert.equal(await pinned(), 'false', 'clicking the logo must not pin automatic navigation');
        await page.mouse.move(width - 30, 400); await collapsed(true);

        await toggle.hover(); await collapsed(false);
        await toggle.click(); await settleLayout();
        assert.equal(await pinned(), 'true');
        assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
        assert.equal(await toggle.getAttribute('data-mode'), 'pinned');
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.app-shell'), '::before').opacity === '0');
        const sidebar = await page.locator('.desktop-sidebar').boundingBox();
        const fixedBounds = await bounds();
        assert(fixedBounds.x >= sidebar.x + sidebar.width, 'fixed navigation makes room in the gallery');
        const galleryPinned = await page.locator('.justified-gallery').boundingBox();
        assert(Math.abs(galleryBefore.width - galleryPinned.width - sidebar.width) < 1, 'the waterfall uses the width remaining beside the sidebar');
        await page.mouse.click(width - 20, 28);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        assert.equal(await pinned(), 'true', 'outside interaction must not release a fixed sidebar');
        assert.equal(await arrow.evaluate(element => getComputedStyle(element).opacity), '1');
        assert(await arrow.evaluate(element => element.getBBox().x < 12), 'fixed mode always points left');
        await page.screenshot({ path: `${output}/sidebar-pinned-${width}.png` });
        await page.locator('.desktop-sidebar .album-link[title="相册"]').click();
        await collapsed(false);
        assert.equal(await pinned(), 'true', 'choosing a section preserves the explicitly pinned sidebar');
        await page.locator('.topbar .brand').click();
        await collapsed(false);
        await page.locator('.search-toggle').click();
        await page.getByRole('button', { name: '关闭搜索' }).click();
        assert.equal(await pinned(), 'true', 'search does not change the fixed layout');
        await toggle.click(); await collapsed(true); await settleLayout();
        assert.deepEqual(await bounds(), before, 'releasing the sidebar restores the full gallery width');

        await page.mouse.move(width - 30, 400);
        await toggle.focus(); await page.keyboard.press('Enter'); await collapsed(false);
        assert.equal(await pinned(), 'true', 'keyboard activation can pin navigation');
        await page.keyboard.press('Enter'); await collapsed(true); await settleLayout();
        await page.evaluate(() => document.activeElement?.blur());
        await page.evaluate(() => scrollTo(0, 500));
        await page.waitForTimeout(250);
        const scrolled = await bounds();
        await toggle.hover(); await collapsed(false);
        await page.mouse.move(width - 30, 400); await collapsed(true);
        assert.deepEqual(await bounds(), scrolled, 'hover preserves the scrolled reading position');
        await toggle.hover(); await collapsed(false);
        await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await collapsed(true);
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(250);
      } else {
        const navigation = page.locator('.mobile-bottom-nav'), dock = page.locator('.bottom-dock');
        const dockState = hidden => page.waitForFunction(hidden => document.querySelector('.bottom-dock').dataset.navigationHidden === String(hidden), hidden);
        const settleDock = () => dock.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
        assert.deepEqual(await navigation.locator('.mobile-tab-label').allTextContents(), ['图库', '相册', '搜索', '更多']);
        const compactBar = await dock.boundingBox();
        assert(compactBar.height <= 50 && compactBar.width <= 320 && Math.abs(compactBar.y + compactBar.height - 832) < 1, 'navigation stays compact with breathing room below');
        assert(await navigation.locator('.mobile-tab').evaluateAll(tabs => tabs.every(tab => {
          const rect = tab.getBoundingClientRect();
          return rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth;
        })), 'every mobile tab has a usable touch target');
        await navigation.getByRole('button', { name: '相册', exact: true }).tap();
        await page.waitForFunction(() => document.querySelector('.app-shell').dataset.gallerySection === 'albums');
        assert.equal(await navigation.getByRole('button', { name: '相册', exact: true }).getAttribute('aria-current'), 'page');
        await navigation.getByRole('button', { name: '图库', exact: true }).tap();
        await page.locator('.image-card').first().waitFor();
        await page.goBack();
        await page.waitForFunction(() => document.querySelector('.app-shell').dataset.gallerySection === 'albums');
        await page.goForward();
        await page.locator('.image-card').first().waitFor();
        assert.equal(await navigation.getByRole('button', { name: '图库', exact: true }).getAttribute('aria-current'), 'page');

        await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 500); });
        await dockState(true); await settleDock();
        assert((await dock.boundingBox()).y >= 844, 'downward scrolling slides navigation below the viewport');
        assert.equal(await navigation.evaluate(nav => getComputedStyle(nav).opacity), '1', 'navigation slides without fading');
        assert.equal(await page.getByRole('navigation', { name: '底部导航' }).count(), 0, 'collapsed navigation is absent from the accessibility tree');
        assert(await dock.evaluate((element, point) => !element.contains(document.elementFromPoint(point.x, point.y)),
          { x: compactBar.x + compactBar.width / 2, y: compactBar.y + compactBar.height / 2 }), 'collapsed navigation does not intercept the gallery');
        await page.waitForTimeout(250);
        assert.equal(await dock.getAttribute('data-navigation-hidden'), 'true', 'stopping does not reopen navigation');
        await page.evaluate(() => scrollBy(0, -4));
        await page.waitForTimeout(40);
        assert.equal(await dock.getAttribute('data-navigation-hidden'), 'true', 'minor scroll jitter does not reopen navigation');
        await page.evaluate(() => scrollTo(0, 400));
        await dockState(false); await settleDock();
        await page.screenshot({ path: `${output}/bottom-navigation-resting-${width}.png`, animations: 'disabled' });
        await navigation.locator('.search-toggle').tap();
        await page.locator('.search-dialog[open]').waitFor();
        assert.equal(await dock.getAttribute('data-navigation-hidden'), 'false', 'search keeps navigation expanded');
        const searchBox = await page.locator('.search-dialog').boundingBox();
        assert(searchBox.height < 290, 'search uses a compact layout');
        assert(await page.locator('.search-dialog .gallery-filter-options button').evaluateAll(buttons => buttons.every(button =>
          Math.abs(button.getBoundingClientRect().top - buttons[0].getBoundingClientRect().top) < 1)), 'categories occupy a single scrollable row');
        await page.screenshot({ path: `${output}/compact-search-${width}.png`, animations: 'disabled' });
        await page.getByRole('button', { name: '关闭搜索' }).click();
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        const lastCard = await page.locator('.image-card').last().boundingBox();
        assert(lastCard.y + lastCard.height < compactBar.y, 'the last row can scroll fully above expanded navigation');
        await page.evaluate(() => scrollTo(0, 0));
        await page.locator('.image-card .photo-card-select').first().focus();
        await page.keyboard.press('Space');
        const selectionBar = page.locator('.gallery-selection-bar');
        await selectionBar.waitFor(); await dockState(false); await settleDock();
        const selectionBox = await selectionBar.boundingBox(), expandedNav = await navigation.boundingBox();
        assert(Math.abs(selectionBox.x - expandedNav.x) < 1 && Math.abs(selectionBox.width - expandedNav.width) < 1, 'selection and navigation stay aligned');
        const panelGap = expandedNav.y - selectionBox.y - selectionBox.height;
        assert(panelGap >= 7 && panelGap <= 9, 'separate rounded panels have a clear, compact gap');
        await page.screenshot({ path: `${output}/bottom-navigation-selection-${width}.png`, animations: 'disabled' });
        const traceDock = top => page.evaluate(async top => {
          document.activeElement?.blur();
          scrollTo(0, top);
          const start = performance.now(), samples = [];
          while (performance.now() - start < 360) {
            await new Promise(requestAnimationFrame);
            const selected = document.querySelector('.gallery-selection-bar').getBoundingClientRect();
            const slot = document.querySelector('.mobile-navigation-slot').getBoundingClientRect();
            samples.push({ elapsed: performance.now() - start, bottom: selected.bottom, top: selected.top, overlap: selected.bottom > slot.top + 1 });
          }
          return samples;
        }, top);
        const closingFrames = await traceDock(500);
        await dockState(true); await settleDock();
        assert(closingFrames.every(frame => !frame.overlap && frame.top >= 0 && frame.bottom <= 833), 'selection remains on screen throughout collapse without overlap');
        const lowered = await selectionBar.boundingBox();
        assert(Math.abs(lowered.y - selectionBox.y - expandedNav.height - panelGap) < 1, 'selection follows navigation down to the lower edge');
        assert(844 - lowered.y - lowered.height >= 12 && 844 - lowered.y - lowered.height <= 16, 'collapsed selection keeps its bottom safety margin');
        assert(closingFrames.filter(frame => frame.elapsed >= 240).every(frame => Math.abs(frame.top - lowered.y) < 1), 'collapse settles promptly');
        await page.screenshot({ path: `${output}/bottom-selection-collapsed-${width}.png`, animations: 'disabled' });
        await selectionBar.getByRole('button', { name: '移动', exact: true }).tap();
        await page.locator('.selection-dialog[open]').waitFor();
        assert.equal(await dock.getAttribute('data-navigation-hidden'), 'true', 'using selection actions does not move them away from the finger');
        await page.getByRole('button', { name: '关闭管理对话框', exact: true }).tap();
        const openingFrames = await traceDock(400);
        await dockState(false); await settleDock();
        assert(openingFrames.every(frame => !frame.overlap && frame.top >= 0 && frame.bottom <= 833), 'selection rises with navigation throughout expansion');
        assert(Math.abs((await selectionBar.boundingBox()).y - selectionBox.y) < 1, 'selection returns to its original position');
        assert(openingFrames.filter(frame => frame.elapsed >= 240).every(frame => Math.abs(frame.top - selectionBox.y) < 1), 'expansion settles promptly');
        const selectionHost = await page.locator('.bottom-selection').elementHandle();
        await page.setViewportSize({ width: 1000, height: 844 });
        assert(await selectionHost.evaluate(element => element.isConnected), 'resizing keeps the selection portal attached');
        assert.equal(await selectionBar.getAttribute('data-selected-count'), '1');
        await page.setViewportSize({ width, height: 844 });
        await dockState(false); await settleDock();
        assert.equal(await page.locator('.bottom-dock .gallery-selection-bar').count(), 1);
        await page.waitForTimeout(250);
        assert.equal(await dock.getAttribute('data-navigation-hidden'), 'false', 'layout scrolling after a resize must not collapse navigation');
        await selectionHost.dispose();
        await navigation.locator('.gallery-menu-toggle').tap();
        await page.getByRole('menu', { name: '图库操作' }).waitFor();
        assert.deepEqual(await page.getByRole('menu', { name: '图库操作' }).getByRole('menuitem').allTextContents(), ['上传图片']);
        assert.equal(await page.locator('.mobile-more-panel .album-link, .mobile-more-panel .sidebar-footer').count(), 0, 'More shares the desktop actions without duplicating navigation');
        await page.locator('.mobile-more-panel').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
        const menuBox = await page.locator('.mobile-more-panel').boundingBox(), joinedBox = await dock.boundingBox();
        assert(menuBox.y + menuBox.height <= joinedBox.y - 4, 'More opens above the entire dock without covering selection actions');
        await page.screenshot({ path: `${output}/bottom-navigation-more-${width}.png`, animations: 'disabled' });
        assert.equal(await page.locator('.gallery-selection-bar').count(), 1, 'opening More preserves selection');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.gallery-menu-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('.gallery-selection-bar').count(), 1, 'closing More does not clear selection');
        await navigation.locator('.search-toggle').tap();
        await page.locator('.search-dialog[open]').waitFor();
        assert(await page.getByRole('button', { name: '以图搜图', exact: true }).isVisible());
        assert.equal(await page.locator('.gallery-menu-toggle').getAttribute('aria-expanded'), 'false');
        await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
        assert.equal(await page.locator('.gallery-selection-bar').count(), 1, 'opening and cancelling image search preserves selection');
        assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
        await page.getByRole('button', { name: '取消全部选择', exact: true }).click();
        await navigation.getByRole('button', { name: '图库', exact: true }).tap();
        await page.locator('.image-card').first().waitFor();

        await page.setViewportSize({ width, height: 420 });
        await navigation.locator('.gallery-menu-toggle').tap();
        const morePanel = page.locator('.mobile-more-panel');
        await morePanel.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
        const moreBox = await morePanel.boundingBox(), shortNav = await navigation.boundingBox();
        assert(moreBox.y >= 0 && moreBox.y + moreBox.height <= shortNav.y, 'More fits a short mobile viewport');
        assert(moreBox.width <= 200 && moreBox.height <= 120, 'More remains a small action menu');
        assert(await morePanel.getByRole('menuitem', { name: '上传图片', exact: true }).evaluate(button => {
          const rect = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }), 'menu actions remain reachable on short screens');
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width, height: 844 });

        assert.equal(await toggle.getAttribute('data-mode'), 'mobile');
        assert.equal(await toggle.locator('.sidebar-toggle-arrow').count(), 0);
        await page.locator('.image-card .photo-card-select').first().focus(); await page.keyboard.press('Space');
        await page.locator('.gallery-selection-bar').waitFor();
        const selectedId = await page.locator('.image-card[data-selected="true"]').getAttribute('data-image-id');
        await page.evaluate(() => {
          window.drawerOverlap = [];
          const check = () => {
            const drawer = document.querySelector('.mobile-nav-layer'), dock = document.querySelector('.bottom-dock');
            if (drawer && (getComputedStyle(dock).display !== 'none' || !dock.inert || dock.getAttribute('aria-hidden') !== 'true')) {
              window.drawerOverlap.push({ state: drawer.dataset.state, display: getComputedStyle(dock).display, inert: dock.inert });
            }
            window.drawerFrame = requestAnimationFrame(check);
          };
          check();
        });
        await toggle.tap();
        await page.locator('.mobile-sidebar').waitFor();
        assert.deepEqual(await bounds(), before);
        assert.equal(await navigation.isVisible(), false, 'the bottom navigation cannot overlap the drawer');
        assert.equal(await page.locator('.gallery-selection-bar').isVisible(), false, 'selected actions also give the drawer exclusive space');
        assert.equal(await page.getByRole('navigation', { name: '底部导航' }).count(), 0, 'the obscured dock leaves the accessibility tree');
        assert(await dock.evaluate((element, point) => !element.contains(document.elementFromPoint(point.x, point.y)),
          { x: compactBar.x + compactBar.width / 2, y: compactBar.y + compactBar.height / 2 }),
          'the dock cannot intercept drawer or scrim taps');
        await page.locator('.mobile-sidebar').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
        await page.screenshot({ path: `${output}/drawer-${width}.png` });
        const footerButton = page.locator('.mobile-sidebar .sidebar-footer button').first();
        assert(await footerButton.evaluate(button => {
          const rect = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }), 'the drawer footer is unobstructed');
        await toggle.tap();
        await page.waitForTimeout(60);
        assert.equal(await navigation.isVisible(), false, 'the dock remains hidden throughout drawer exit');
        await toggle.tap();
        await page.waitForTimeout(60);
        assert.equal(await navigation.isVisible(), false, 'reversing the drawer animation must not flash the dock');
        await toggle.tap();
        await page.locator('.mobile-nav-layer').waitFor({ state: 'detached' });
        await navigation.waitFor({ state: 'visible' });
        assert.equal(await dock.getAttribute('inert'), null);
        assert.equal(await page.locator('.image-card[data-selected="true"]').getAttribute('data-image-id'), selectedId, 'closing navigation retains the selection');
        assert(await page.locator('.gallery-selection-bar').isVisible(), 'selection actions return after the drawer closes');
        await page.getByRole('button', { name: '取消全部选择', exact: true }).click();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await toggle.tap(); await page.locator('.mobile-sidebar').waitFor();
        assert.equal(await navigation.isVisible(), false, 'reduced motion must not briefly reveal the dock');
        await page.keyboard.press('Escape'); await page.locator('.mobile-nav-layer').waitFor({ state: 'detached' });
        assert(await navigation.isVisible(), 'reduced motion restores the dock when the drawer exits');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        assert.deepEqual(await page.evaluate(() => { cancelAnimationFrame(window.drawerFrame); return window.drawerOverlap; }), [],
          'the dock stays hidden and inert during every visible drawer frame');
        await page.locator('.search-toggle').tap();
        await page.locator('.search-dialog[open]').waitFor();
        await page.getByRole('button', { name: '关闭搜索' }).click();
      }
      if (width > 720) { await toggle.click(); await collapsed(false); }
      await page.locator('.gallery-menu-toggle').focus();
      await page.keyboard.press('ArrowDown');
      await page.getByRole('menuitem', { name: '上传图片' }).waitFor();
      await page.keyboard.press('Escape');
      assert(await page.locator('.gallery-menu-toggle').evaluate(button => button === document.activeElement));
      await page.locator('.gallery-menu-toggle').click();
      await page.getByRole('menuitem', { name: '上传图片' }).click();
      await page.locator('.upload-dialog[open]').waitFor();
      if (width > 720) assert.equal(await toggle.getAttribute('data-mode'), 'pinned', 'opening upload preserves fixed navigation');
      await page.locator('.upload-dialog').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
      await page.screenshot({ path: `${output}/upload-${width}.png` });
      const files = page.locator('.upload-dialog input[type="file"]');
      await files.setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') });
      await page.locator('.upload-error').waitFor();
      assert.equal(f.uploads.length, 0);
      await files.setInputFiles([{ name: 'new.png', mimeType: 'image/png', buffer: photo }, { name: 'retry.jpg', mimeType: 'image/jpeg', buffer: photo }]);
      await page.getByLabel('上传到').selectOption('旅行');
      await page.getByRole('button', { name: '开始上传' }).click();
      await page.getByRole('button', { name: '重试失败项' }).waitFor();
      assert.equal(f.uploads.length, 2);
      await page.getByText('已上传 · 已保存为 new.jpg', { exact: true }).waitFor();
      assert(f.uploads.every(item => item.destination === '旅行' && item.headers['x-csrf-token'] === 'a'.repeat(64) && item.headers['x-pixhelf-origin'] === 'https://pixhelf.test' && item.bytes.equals(photo)));
      await page.getByRole('button', { name: '重试失败项' }).click();
      await page.getByRole('button', { name: '完成', exact: true }).waitFor();
      assert.equal(f.uploads.filter(item => item.name === 'new.png').length, 1, 'retry does not reupload successful files');
      await page.screenshot({ path: `${output}/upload-complete-${width}.png` });
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.locator('.upload-dialog').waitFor({ state: 'detached' });
      assert(await page.locator('.gallery-menu-toggle').evaluate(button => button === document.activeElement));
      console.log(`${width}px: grouped navigation, pinned layout, directional dock, selection motion without overlap, menu access, upload and retry passed`);
    } finally { await f.close(); }
  }
  const guest = await fixture(390, true);
  try {
    await guest.page.locator('.gallery-menu-toggle').click();
    assert.equal(await guest.page.getByRole('menuitem', { name: '上传图片' }).count(), 0);
    assert.deepEqual(await guest.page.getByRole('menu', { name: '图库操作' }).getByRole('menuitem').allTextContents(), ['管理员登录']);
    assert.equal(await guest.page.getByRole('menuitem', { name: '管理员登录' }).getAttribute('href'), '/login');
    await guest.page.keyboard.press('Escape');
    assert(await guest.page.locator('.gallery-menu-toggle').evaluate(button => button === document.activeElement));
    await guest.page.locator('.search-toggle').click();
    await guest.page.locator('.search-dialog').waitFor();
    assert.equal(await guest.page.getByRole('button', { name: '管理分类' }).count(), 0);
    const choosing = guest.page.waitForEvent('filechooser');
    await guest.page.getByRole('button', { name: '以图搜图', exact: true }).tap();
    await (await choosing).setFiles({ name: 'guest-query.jpg', mimeType: 'image/jpeg', buffer: photo });
    await guest.page.getByRole('region', { name: '以图搜图结果' }).waitFor();
    assert.equal(await guest.page.locator('.similar-source-copy strong').textContent(), 'guest-query.jpg');
    await guest.page.locator('.search-dialog').waitFor({ state: 'detached' });
    console.log('guest image search works from the shared search dialog; administrative actions are absent');
  } finally { await guest.close(); }
} finally { await browser.close(); }
