import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const origin = process.env.PIXHELF_URL ?? "https://pixhelf.test";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const reports = [];
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const photo = await readFile(new URL("fixtures/live-photo.jpg", import.meta.url));
const fixtureImages = Array.from({ length: 96 }, (_, i) => ({ id: i.toString(16).padStart(32, "0"), name: `photo-${i}.jpg`, width: 960, height: 720 }));
const summary = { total: fixtureImages.length, albums: [], revision: "image-search" };
const status = { total: 96, ready: 96, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const auth = { enabled: true, authenticated: true, canChangePassword: true, username: "admin", csrfToken: "a".repeat(64) };
const imagePage = (offset = 0, limit = 60) => ({ items: fixtureImages.slice(offset, offset + limit), total: fixtureImages.length,
  offset, limit, nextOffset: offset + limit < fixtureImages.length ? offset + limit : null });

async function setupFixture(page) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const reply = json => route.fulfill({ json }).catch(() => {});
    if (url.hostname !== "pixhelf.test") return route.abort();
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html.replace("__PIXHELF_AUTH__", JSON.stringify(auth))
      .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage() })) });
    if (path.startsWith("/assets/")) return serveFrontendAsset(route);
    if (path.endsWith("/thumbnail") || path.endsWith("/original") || /\/api\/images\/[^/]+\.jpg$/.test(path)) return route.fulfill({ body: photo, contentType: "image/jpeg" });
    if (path === "/api/gallery") return reply(summary);
    if (path === "/api/status") return reply(status);
    if (path === "/api/categories") return reply({ categories: [] });
    if (path === "/api/images/duplicates") return reply({ groups: [], plan: [], total: 0, scanned: 96, imageTotal: 96, skipped: 0, scanning: false, revision: summary.revision, offset: 0, nextOffset: null });
    if (path === "/api/management") return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
    if (path === "/api/auth/session") return reply(auth);
    if (path === "/api/storage/config") return reply({ configured: false });
    if (path === "/api/images" || path.endsWith("/similar")) return reply(imagePage(Number(url.searchParams.get("offset")), Number(url.searchParams.get("limit") ?? 60)));
    const image = fixtureImages.find(image => path === `/api/images/${image.id}`);
    if (image) return reply(image);
    return route.fulfill({ status: 404, json: { error: "unknown fixture API" } });
  });
}

async function openImageSearch(page) {
  await page.locator(".search-toggle").focus();
  await page.locator(".search-toggle").click();
  await page.locator(".search-dialog[open]").waitFor();
}

async function uploadFile(page, upload) {
  if (!await page.locator(".search-dialog[open]").count()) await openImageSearch(page);
  await page.getByLabel("上传查询图片").setInputFiles(upload);
}

async function checkSearchRequests(page, upload, images) {
  const pattern = "**/api/images/similar?*";
  const clear = () => page.getByRole("button", { name: "清除查询图片", exact: true }).click();
  const pageData = (items, offset = 0, nextOffset = null, total = items.length) => ({ items, offset, nextOffset, total, limit: 60 });
  const cards = page.locator(".app-shell[data-gallery-section=similar] .image-card");
  let pages = 0;
  const duplicates = route => {
    pages++;
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    return route.fulfill({ json: offset === 0
      ? pageData([images[0], images[0], images[1]], 0, 3, 6)
      : pageData([images[1], images[2], images[2]], 3, null, 6) });
  };
  await page.route(pattern, duplicates);
  await uploadFile(page, upload);
  await page.locator(".similar-results-footer").getByText("已显示 3 张相似图片", { exact: true }).waitFor();
  assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => element.dataset.imageId)), images.map(image => image.id));
  assert.equal(pages, 2, "pagination must not issue duplicate requests");
  await page.unroute(pattern, duplicates);
  await clear();

  // A cursor that repeats the current offset must stop, then allow an explicit retry.
  await page.route(pattern, route => route.fulfill({ json: pageData([images[0]], 0, 0, 100) }), { times: 1 });
  await uploadFile(page, upload);
  await page.getByRole("alert").filter({ hasText: "服务器返回了无效数据" }).waitFor();
  assert.equal(await cards.count(), 0);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await cards.first().waitFor();
  await clear();

  // A late error from the previous query must not replace the new query's results.
  let capture;
  const received = new Promise(resolve => { capture = resolve; });
  await page.route(pattern, capture, { times: 1 });
  await uploadFile(page, upload);
  const delayed = await received;
  const cancelled = page.waitForEvent("requestfailed", { predicate: request => request === delayed.request() });
  await clear();
  await cancelled;
  const nextPage = new Promise(resolve => { capture = resolve; });
  const replacement = route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    if (offset === 0) return route.fulfill({ json: pageData(images.slice(0, 2), 0, 2, 3) });
    capture(route);
  };
  await page.route(pattern, replacement);
  await uploadFile(page, { ...upload, name: "replacement.webp" });
  await cards.first().waitFor();
  await delayed.fulfill({ status: 500, json: { error: "过期查询错误" } });
  assert.equal(await page.locator(".similar-source-copy strong").textContent(), "replacement.webp");
  assert.equal(await page.getByRole("alert").count(), 0);

  // Clearing a query also aborts its pending pagination request.
  await page.locator(".similar-results-footer").scrollIntoViewIfNeeded();
  await page.locator(".similar-results-footer [aria-label=加载更多]").waitFor();
  const delayedPage = await nextPage;
  const pageCancelled = page.waitForEvent("requestfailed", { predicate: request => request === delayedPage.request() });
  await clear();
  await pageCancelled;
  await delayedPage.fulfill({ json: pageData(images.slice(2), 2, null, 3) });
  await page.unroute(pattern, replacement);
  await page.locator('.app-shell[data-gallery-section="library"] .image-card').first().waitFor();
  assert.equal(await cards.count(), 0);
  assert.equal(await page.getByRole("alert").count(), 0);
}

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width <= 720, storageState: process.env.PIXHELF_BROWSER_STORAGE_STATE });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    if (!process.env.PIXHELF_URL) await setupFixture(page);
    const library = process.env.PIXHELF_URL ? await (await context.request.get(`${origin}/api/images?limit=3`)).json() : { items: fixtureImages.slice(0, 3) };
    const source = library.items[0];
    assert(library.items.length >= 3, "Use a gallery with at least three searchable images");
    const original = process.env.PIXHELF_URL ? await context.request.get(`${origin}/api/images/${source.id}/original`) : null;
    const upload = { name: source.name, mimeType: original?.headers()["content-type"] ?? "image/jpeg", buffer: original ? await original.body() : photo };
    let rejectNext = true;
    let uploadRequests = 0;
    await page.route("**/api/images/similar?*", async route => {
      const request = route.request();
      assert.equal(request.method(), "POST");
      assert.equal(request.headers()["x-pixhelf-origin"], new URL(origin).origin);
      assert(request.postDataBuffer().equals(upload.buffer));
      uploadRequests++;
      if (rejectNext) {
        rejectNext = false;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "搜索暂时失败，请重试" }) });
      }
      if (process.env.PIXHELF_URL) await route.continue();
      else await route.fallback();
    });
    await page.goto(origin);
    await page.locator(".image-card").first().waitFor();
    assert.equal(await page.locator('.desktop-sidebar .album-nav button[title="相似图片"]').count(), 1);
    await page.locator(".gallery-menu-toggle").focus();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menuitem", { name: "上传图片", exact: true }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "以图搜图", exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    await page.locator(".search-toggle").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "搜索图库", exact: true }).waitFor();
    assert.equal(new URL(page.url()).search, "", "opening image search keeps the current gallery");
    await page.screenshot({ path: `/tmp/pixhelf-search-empty-${width}.png` });
    const dialogBounds = await page.locator('.search-dialog').boundingBox();
    assert(dialogBounds.width <= Math.min(520, width - 16) && dialogBounds.height < 290, 'text and image search share the compact dialog');
    const picker = page.getByRole('button', { name: '以图搜图', exact: true });
    const pickerBounds = await picker.boundingBox(), submitBounds = await page.locator('.search-dialog button[type=submit]').boundingBox();
    assert(pickerBounds.x + pickerBounds.width <= submitBounds.x && Math.abs(pickerBounds.y - submitBounds.y) < 1, 'image picker sits next to search submission');
    const choosing = page.waitForEvent('filechooser');
    await picker.focus();
    await page.keyboard.press('Enter');
    const chooser = await choosing;
    assert.equal(chooser.isMultiple(), false);
    await chooser.setFiles({ name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("invalid") });
    await page.getByRole("alert").filter({ hasText: "请选择 JPG" }).waitFor();
    await uploadFile(page, { name: "empty.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) });
    await page.getByRole("alert").filter({ hasText: "图片文件为空" }).waitFor();
    if (width === 1440) {
      await uploadFile(page, { name: 'large.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
      await page.getByRole('alert').filter({ hasText: '图片不能超过 20 MB' }).waitFor();
    }
    assert.equal(uploadRequests, 0);
    await uploadFile(page, upload);
    await page.getByRole("alert").filter({ hasText: "搜索暂时失败" }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.locator(".app-shell[data-gallery-section=similar] .image-card").first().waitFor();
    assert.equal(await page.locator(".similar-source-copy strong").textContent(), source.name);
    assert((await page.locator(".similar-source-preview").getAttribute("src")).startsWith("blob:"));
    await page.locator('.app-shell[data-gallery-section=similar] .image-card[data-loaded="true"]').first().waitFor();
    await page.screenshot({ path: `/tmp/pixhelf-search-results-${width}.png`, animations: "disabled" });
    const more = page.getByRole("button", { name: "加载更多", exact: true });
    if (await more.count()) {
      const nextPage = page.waitForResponse(response => new URL(response.url()).pathname === "/api/images/similar" && Number(new URL(response.url()).searchParams.get("offset")) > 0);
      await more.scrollIntoViewIfNeeded();
      await nextPage;
      assert(uploadRequests >= 3);
    }
    const navigation = async () => {
      if (width <= 720) {
        await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
        return page.locator(".mobile-sidebar");
      }
      if (await page.locator(".app-shell").getAttribute("data-sidebar-collapsed") === "true") await page.locator(".gallery-sidebar-toggle").click();
      return page.locator(".desktop-sidebar");
    };
    await (await navigation()).getByRole("button", { name: /^图库/ }).click();
    await page.locator('.app-shell[data-gallery-section="library"] .image-card').first().waitFor();
    await uploadFile(page, upload);
    await page.locator(".similar-source-copy strong").waitFor();
    assert.equal(await page.locator(".similar-source-copy strong").textContent(), source.name);
    await page.getByRole("button", { name: "清除查询图片", exact: true }).click();
    await page.locator('.app-shell[data-gallery-section="library"] .image-card').first().waitFor();
    assert.equal(await page.locator(".image-search-summary").count(), 0);
    if (width === 1440) await checkSearchRequests(page, upload, library.items);
    await (await navigation()).getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.locator(".settings-dialog");
    if (width === 1440) {
      let capture;
      const received = new Promise(resolve => { capture = resolve; });
      await page.route("**/api/auth/password", capture, { times: 1 });
      await settings.getByLabel("用户名", { exact: true }).fill("settings-test-admin");
      await settings.getByLabel("当前密码", { exact: true }).fill("settings-test-password");
      await settings.getByRole("button", { name: "保存账号", exact: true }).click();
      const pendingSave = await received;
      await settings.getByRole("button", { name: "正在保存…", exact: true }).waitFor();
      assert(await settings.getByRole("button", { name: "关闭设置", exact: true }).isDisabled());
      await page.keyboard.press("Escape");
      await page.mouse.click(2, 2);
      assert(await settings.isVisible(), "saving settings must block Escape and backdrop dismissal");
      await pendingSave.fulfill({ status: 400, json: { error: "保存失败，请重试" } });
      await settings.getByRole("alert").filter({ hasText: "保存失败" }).waitFor();
      assert(await settings.getByRole("button", { name: "关闭设置", exact: true }).isEnabled());
    }
    for (const height of [900, 420, 900]) {
      await page.setViewportSize({ width, height });
      const sizes = [];
      for (const section of ["账号安全", "外部存储", "关于"]) {
        await settings.getByRole("button", { name: section, exact: true }).click();
        await page.waitForTimeout(150);
        sizes.push(await settings.boundingBox());
        assert.equal(await page.locator(".settings-content").evaluate(element => element.scrollTop), 0, "new settings sections should start at the top");
        if (section === "外部存储") {
          await page.locator(".settings-content").evaluate(element => { element.scrollTop = element.scrollHeight; });
          const size = await settings.boundingBox();
          assert(Math.abs(size.height - sizes[0].height) < 1, "scrolling long settings must not resize the dialog");
        }
      }
      assert(sizes.every(size => size && size.y >= 10 && size.y + size.height <= height - 10));
      for (const size of sizes.slice(1)) {
        for (const dimension of ["width", "height", "x", "y"]) assert(Math.abs(size[dimension] - sizes[0][dimension]) < 1, `settings ${dimension} should stay fixed across sections`);
      }
      assert(await page.locator(".settings-content").evaluate(element => element.clientHeight > 100 && getComputedStyle(element).overflowY === "auto"));
    }
    await page.locator(".settings-dialog").getByRole("button", { name: "关于", exact: true }).click();
    await page.locator(".about-settings").waitFor();
    assert.equal(await page.locator(".about-links a").count(), 3);
    assert.match(await page.locator(".about-identity span").textContent(), /^v\d+\.\d+\.\d+/);
    assert(await page.locator(".settings-dialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    assert(await page.locator(".settings-nav").evaluate(element => element.scrollWidth <= element.clientWidth + 1 || getComputedStyle(element).overflowX === "auto"));
    await page.screenshot({ path: `/tmp/pixhelf-about-${width}.png`, animations: "disabled" });
    const heading = await settings.locator(".settings-header h2").boundingBox();
    await page.mouse.move(heading.x + 10, heading.y + 10);
    await page.mouse.down();
    await page.mouse.move(2, 2);
    await page.mouse.up();
    assert(await settings.isVisible(), "a drag starting inside the dialog must not dismiss it");
    await settings.dispatchEvent("pointerdown", { clientX: 2, clientY: 2, pointerType: "touch" });
    await settings.dispatchEvent("pointercancel", { pointerType: "touch" });
    await settings.dispatchEvent("click", { clientX: 2, clientY: 2 });
    assert(await settings.isVisible(), "a cancelled backdrop contact must not dismiss the dialog");
    await page.mouse.click(2, 2);
    await settings.waitFor({ state: "detached" });
    assert(await page.evaluate(() => document.activeElement instanceof HTMLButtonElement && document.activeElement.getClientRects().length > 0), "closing settings should restore focus to a visible button");
    // A gallery query can be restored from its URL without opening the viewer.
    await page.goto(`${origin}/?view=similar&source=${encodeURIComponent(source.id)}`);
    await page.waitForFunction(name => document.querySelector(".similar-source-copy strong")?.textContent === name, source.name);
    assert.equal(await page.locator(".image-viewer").count(), 0);
    await page.getByRole("button", { name: "更换图片", exact: true }).click();
    await page.locator('.search-dialog[open]').waitFor();
    assert(await page.getByRole('button', { name: '以图搜图', exact: true }).isVisible());
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".similar-source-copy strong").textContent(), source.name, "cancelling replacement preserves the query");
    assert(await page.getByRole('button', { name: '更换图片', exact: true }).evaluate(button => button === document.activeElement));
    await page.goto(`${origin}/?view=similar&source=upload`);
    await page.getByRole("dialog", { name: "搜索图库", exact: true }).waitFor();
    assert.equal(await page.locator(".similar-search-page").count(), 0, "legacy upload links open the dialog over the gallery");
    await page.getByRole("button", { name: "关闭搜索", exact: true }).click();
    await page.locator('.duplicate-page').waitFor();
    await openImageSearch(page);
    const dropzone = page.locator('.search-dialog');
    assert(await dropzone.locator('input[type=search]').evaluate(input => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', '文字搜索');
      return input.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    }), 'text drops keep the native search input behavior');
    const transfer = await page.evaluateHandle(({ data, name, mimeType }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(data), character => character.charCodeAt(0))], name, { type: mimeType }));
      return transfer;
    }, { data: upload.buffer.toString('base64'), name: upload.name, mimeType: upload.mimeType });
    await dropzone.locator('header').dispatchEvent('dragenter', { dataTransfer: transfer });
    await page.waitForFunction(() => document.querySelector('.search-dialog').dataset.dragging === 'true');
    await dropzone.evaluate(element => element.querySelector('header').dispatchEvent(new DragEvent('dragleave', {
      bubbles: true, relatedTarget: element.querySelector('footer'),
    })));
    await dropzone.locator('footer').dispatchEvent('dragover', { dataTransfer: transfer });
    assert.equal(await dropzone.getAttribute('data-dragging'), 'true', 'moving between dialog sections keeps the image drop target active');
    const hint = await dropzone.locator('.search-image-drop-hint').boundingBox(), surface = await dropzone.boundingBox();
    assert(hint.width >= surface.width - 20 && hint.height >= surface.height - 20, 'the drop hint covers the entire search interface');
    await page.screenshot({ path: `/tmp/pixhelf-search-drop-${width}.png`, animations: 'disabled' });
    await dropzone.locator('form').evaluate(element => element.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body })));
    await page.waitForFunction(() => document.querySelector('.search-dialog').dataset.dragging === 'false');
    await dropzone.locator(width === 1440 ? 'header' : width === 390 ? 'footer' : '.search-history').dispatchEvent('drop', { dataTransfer: transfer });
    await transfer.dispose();
    await page.locator('.search-dialog').waitFor({ state: 'detached' });
    await page.locator('.app-shell[data-gallery-section=similar] .photo-card-open').first().click();
    await page.locator('.image-viewer').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.image-viewer').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.similar-source-copy strong').textContent(), source.name, 'closing the viewer preserves the uploaded query');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    reports.push({ width, imagePicker: true, wholeDialogDrop: true, retry: true, pagination: uploadRequests >= 3, about: true, restoredSource: true });
    await context.close();
  }
} finally { await browser.close(); }
console.log(JSON.stringify(reports, null, 2));
