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
    if (path === "/api/gallery") return reply(summary);
    if (path === "/api/status") return reply(status);
    if (path === "/api/images") return reply(imagePage);
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
      const contentBefore = await page.locator('.content').boundingBox();
      assert.equal(await toggle.getAttribute('title'), null, 'navigation uses icons without a hover tooltip');
      if (width > 720) {
        const arrow = toggle.locator('.sidebar-toggle-arrow');
        const settleLayout = () => page.locator('.justified-gallery[data-resizing="true"]').waitFor({ state: 'detached' });
        const pinned = () => page.locator('.app-shell').getAttribute('data-sidebar-pinned');
        assert.equal(await toggle.getAttribute('data-mode'), 'automatic');
        assert.equal(await arrow.evaluate(element => getComputedStyle(element).opacity), '0');
        await toggle.hover(); await collapsed(false);
        await page.waitForTimeout(220);
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
        await page.mouse.move(width - 30, 400); await collapsed(true);
        await toggle.hover(); await collapsed(false);
        await page.locator('.desktop-sidebar .sidebar-heading').click({ position: { x: 15, y: 25 } });
        assert.equal(await pinned(), 'false', 'clicking inside must not pin automatic navigation');
        await page.mouse.move(width - 30, 400); await collapsed(true);
        for (const [label, card] of [['相册', '.album-card'], ['照片', '.image-card']]) {
          await toggle.hover(); await collapsed(false);
          const link = page.locator(`.desktop-sidebar .album-link[title="${label}"]`);
          await link.click();
          await page.locator(card).first().waitFor();
          assert.equal(await pinned(), 'true', 'choosing a section pins automatic navigation');
          const sidebar = await page.locator('.desktop-sidebar').boundingBox();
          assert((await page.locator(card).first().boundingBox()).x >= sidebar.x + sidebar.width, 'the destination leaves room for navigation');
          await link.click();
          assert.equal(await pinned(), 'true', 'choosing the current section keeps navigation pinned');
          await page.mouse.move(width - 30, 400);
          await page.waitForTimeout(250);
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'navigation stays pinned after the mouse leaves');
          await toggle.click(); await collapsed(true); await settleLayout();
          await page.mouse.move(width - 30, 400);
        }
        await toggle.hover(); await collapsed(false);
        await page.locator('.topbar .brand').click();
        assert.equal(await pinned(), 'false', 'clicking the logo must not pin automatic navigation');
        await page.mouse.move(width - 30, 400); await collapsed(true);

        await toggle.hover(); await collapsed(false);
        await toggle.click(); await settleLayout();
        assert.equal(await pinned(), 'true');
        assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
        assert.equal(await toggle.getAttribute('data-mode'), 'pinned');
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
        await page.locator('.topbar .brand').click();
        assert.equal(await pinned(), 'true', 'navigation keeps an explicitly fixed sidebar');
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
        assert.equal(await toggle.getAttribute('data-mode'), 'mobile');
        assert.equal(await toggle.locator('.sidebar-toggle-arrow').count(), 0);
        await toggle.tap();
        await page.locator('.mobile-sidebar').waitFor();
        assert.deepEqual(await bounds(), before);
        const search = await page.locator('.search-toggle').boundingBox(), menu = await page.locator('.gallery-menu-toggle').boundingBox();
        assert(menu.x >= search.x + search.width, 'menu follows search at the right edge');
        await page.locator('.mobile-sidebar').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
        await page.screenshot({ path: `${output}/drawer-${width}.png` });
        await page.locator('.search-toggle').tap();
        await page.locator('.search-dialog[open]').waitFor();
        await page.locator('.mobile-nav-layer').waitFor({ state: 'detached' });
        await page.getByRole('button', { name: '关闭搜索' }).click();
        for (const [label, card] of [['相册', '.album-card'], ['照片', '.image-card']]) {
          await toggle.tap();
          await page.locator(`.mobile-sidebar .album-link[title="${label}"]`).tap();
          await page.locator('.mobile-nav-layer').waitFor({ state: 'detached' });
          await page.locator(card).first().waitFor();
          assert.equal(await page.locator('.app-shell').getAttribute('data-sidebar-pinned'), 'false', 'mobile navigation does not pin the desktop sidebar');
          const content = await page.locator('.content').boundingBox();
          assert.equal(content.x, contentBefore.x);
          assert.equal(content.width, contentBefore.width, 'mobile destinations keep the full content width');
        }
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
      console.log(`${width}px: automatic hover, pinning on navigation, explicit fixed layout, icon states, mobile navigation, menu keyboard access, upload and retry passed`);
    } finally { await f.close(); }
  }
  const guest = await fixture(390, true);
  try {
    assert.equal(await guest.page.locator('.gallery-menu-toggle').count(), 0);
    assert.equal(await guest.page.getByRole('menuitem', { name: '上传图片' }).count(), 0);
    await guest.page.locator('.search-toggle').click();
    await guest.page.locator('.search-dialog').waitFor();
    assert.equal(await guest.page.getByRole('button', { name: '管理分类' }).count(), 0);
    console.log('guest search works; administrative actions are absent');
  } finally { await guest.close(); }
} finally { await browser.close(); }
