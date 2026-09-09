import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const origin = process.env.PIXHELF_URL ?? "http://127.0.0.1:3002";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const reports = [];

async function checkSearchRequests(page, upload, images) {
  const pattern = "**/api/images/similar?*";
  const input = page.getByLabel("上传查询图片");
  const clear = () => page.getByRole("button", { name: "清除查询图片", exact: true }).click();
  const pageData = (items, offset = 0, nextOffset = null, total = items.length) => ({ items, offset, nextOffset, total, limit: 60 });
  const cards = page.locator(".similar-search-page .image-card");
  let pages = 0;
  const duplicates = route => {
    pages++;
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    return route.fulfill({ json: offset === 0
      ? pageData([images[0], images[0], images[1]], 0, 3, 6)
      : pageData([images[1], images[2], images[2]], 3, null, 6) });
  };
  await page.route(pattern, duplicates);
  await input.setInputFiles(upload);
  await page.locator(".similar-results-footer").getByText("已显示 3 张相似图片", { exact: true }).waitFor();
  assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => element.dataset.imageId)), images.map(image => image.id));
  assert.equal(pages, 2, "pagination must not issue duplicate requests");
  await page.unroute(pattern, duplicates);
  await clear();

  // A cursor that repeats the current offset must stop, then allow an explicit retry.
  await page.route(pattern, route => route.fulfill({ json: pageData([images[0]], 0, 0, 100) }), { times: 1 });
  await input.setInputFiles(upload);
  await page.getByRole("alert").filter({ hasText: "服务器返回了无效数据" }).waitFor();
  assert.equal(await cards.count(), 0);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await cards.first().waitFor();
  await clear();

  // A late error from the previous query must not replace the new query's results.
  let capture;
  const received = new Promise(resolve => { capture = resolve; });
  await page.route(pattern, capture, { times: 1 });
  await input.setInputFiles(upload);
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
  await input.setInputFiles({ ...upload, name: "replacement.webp" });
  await cards.first().waitFor();
  await delayed.fulfill({ status: 500, json: { error: "过期查询错误" } });
  assert.equal(await page.locator(".similar-source-copy strong").textContent(), "replacement.webp");
  assert.equal(await page.getByRole("alert").count(), 0);

  // Clearing a query also aborts its pending pagination request.
  await page.locator(".similar-results-footer").scrollIntoViewIfNeeded();
  await page.locator(".similar-results-footer").getByText("正在加载更多", { exact: true }).waitFor();
  const delayedPage = await nextPage;
  const pageCancelled = page.waitForEvent("requestfailed", { predicate: request => request === delayedPage.request() });
  await clear();
  await pageCancelled;
  await delayedPage.fulfill({ json: pageData(images.slice(2), 2, null, 3) });
  await page.unroute(pattern, replacement);
  await page.getByRole("button", { name: "选择图片", exact: true }).waitFor();
  assert.equal(await cards.count(), 0);
  assert.equal(await page.getByRole("alert").count(), 0);
}

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width <= 720, storageState: process.env.PIXHELF_BROWSER_STORAGE_STATE });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const library = await (await context.request.get(`${origin}/api/images?limit=3`)).json();
    const source = library.items[0];
    assert(library.items.length >= 3, "Use a gallery with at least three searchable images");
    const original = await context.request.get(`${origin}/api/images/${source.id}/original`);
    const upload = { name: source.name, mimeType: original.headers()["content-type"], buffer: await original.body() };
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
      await route.continue();
    });
    await page.goto(`${origin}/?view=similar`);
    await page.getByRole("heading", { name: "相似图片", exact: true }).waitFor();
    assert.equal(await page.locator(".image-card").count(), 0);
    await page.screenshot({ path: `/tmp/pixhelf-search-empty-${width}.png` });
    const input = page.getByLabel("上传查询图片");
    await input.setInputFiles({ name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("invalid") });
    await page.getByRole("alert").filter({ hasText: "请选择 JPG" }).waitFor();
    assert.equal(uploadRequests, 0);
    await input.setInputFiles(upload);
    await page.getByRole("alert").filter({ hasText: "搜索暂时失败" }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.locator(".similar-search-page .image-card").first().waitFor();
    assert.equal(await page.locator(".similar-source-copy strong").textContent(), source.name);
    assert((await page.locator(".similar-source-preview").getAttribute("src")).startsWith("blob:"));
    await page.locator('.similar-search-page .image-card[data-loaded="true"]').first().waitFor();
    await page.screenshot({ path: `/tmp/pixhelf-search-results-${width}.png`, animations: "disabled" });
    const more = page.getByRole("button", { name: "加载更多", exact: true });
    if (await more.count()) {
      const initial = await page.locator(".image-card").count();
      await more.scrollIntoViewIfNeeded();
      await page.waitForFunction(count => document.querySelectorAll(".image-card").length > count, initial);
      assert(uploadRequests >= 3);
    }
    const navigation = async () => {
      if (width <= 720) {
        await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
        return page.locator(".mobile-sidebar");
      }
      return page.locator(".desktop-sidebar");
    };
    await (await navigation()).getByRole("button", { name: /^图片/ }).click();
    await page.locator('.app-shell[data-gallery-section="library"] .image-card').first().waitFor();
    await (await navigation()).getByRole("button", { name: "相似图片", exact: true }).click();
    await page.locator(".similar-source-copy strong").waitFor();
    assert.equal(await page.locator(".similar-source-copy strong").textContent(), source.name);
    await page.getByRole("button", { name: "清除查询图片", exact: true }).click();
    await page.getByRole("button", { name: "选择图片", exact: true }).waitFor();
    assert.equal(await page.locator(".image-card").count(), 0);
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
    assert(await page.locator(".settings-nav").evaluate(element => element.scrollWidth <= element.clientWidth + 1));
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
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    reports.push({ width, upload: true, retry: true, pagination: uploadRequests >= 3, rememberedQuery: true, about: true, restoredSource: true });
    await context.close();
  }
} finally { await browser.close(); }
console.log(JSON.stringify(reports, null, 2));
