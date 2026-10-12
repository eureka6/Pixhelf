import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const dist = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8");
const photo = await readFile(new URL("fixtures/live-photo.jpg", import.meta.url));
const defaults = JSON.parse(await readFile(new URL("../src/defaultCategories.json", import.meta.url), "utf8"));
const output = "/tmp/pixhelf-image-filters";
await mkdir(output, { recursive: true });
const images = Array.from({ length: 270 }, (_, i) => ({
  id: i.toString(16).padStart(32, "0"), name: `${i % 3 === 2 ? "video" : "photo"}-${String(i).padStart(3, "0")}.jpg`,
  width: [1200, 900, 900][Math.floor(i / 3) % 3], height: [900, 1200, 900][Math.floor(i / 3) % 3],
  ...(i % 3 === 1 ? { motion: `/motion/${i}` } : i % 3 === 2 ? { video: { duration: 1, codec: "h264", audioCodec: null, frameRate: 30, container: "mp4" } } : {}),
}));
const summary = { total: images.length, albums: [], revision: "filters" };
const auth = { enabled: true, authenticated: true, username: "admin", csrfToken: "1".repeat(64) };

function imagePage(params = new URLSearchParams()) {
  const kind = params.get("kind"), orientation = params.get("orientation"), search = params.get("search");
  let records = images.filter(image => (!kind || kind === "photo" && !image.motion && !image.video || kind === "live" && image.motion || kind === "video" && image.video)
    && (!orientation || orientation === "landscape" && image.width > image.height || orientation === "portrait" && image.width < image.height || orientation === "square" && image.width === image.height));
  if (search === "missing-file") records = [];
  // The real semantic model is covered by Rust tests; this fixture checks the query sent by the UI.
  if (["name-desc", "newest"].includes(params.get("sort"))) records.reverse();
  const offset = Number(params.get("offset") ?? 0), limit = Number(params.get("limit") ?? 60);
  return { items: records.slice(offset, offset + limit), total: records.length, offset, limit, nextOffset: offset + limit < records.length ? offset + limit : null };
}

const browser = await launchBrowser();
async function fixture(width, ready = true, touch = width <= 720) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [], requests = [];
  let categories = structuredClone(defaults), categoryWrites = 0;
  page.on("pageerror", error => errors.push(error.message));
  const status = { total: 270, ready: 270, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
    textSearch: { enabled: ready, total: ready ? 270 : 0, ready: ready ? 270 : 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const reply = json => route.fulfill({ json }).catch(() => {});
    if (url.hostname !== "pixhelf.test") return route.abort();
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html.replace("__PIXHELF_AUTH__", JSON.stringify(auth))
      .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage() })) });
    if (path.startsWith("/assets/")) return serveFrontendAsset(route);
    if (path.endsWith("/thumbnail") || /^\/api\/images\/[^/]+\.[a-z0-9]+$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: photo });
    if (path === "/api/categories") return reply({ categories });
    if (path === "/api/management/categories") {
      categoryWrites++; categories = route.request().postDataJSON().categories;
      return reply({ categories });
    }
    if (path === "/api/gallery") return reply(summary);
    if (path === "/api/status") return reply(status);
    if (path === "/api/images") { requests.push(url.searchParams); return reply(imagePage(url.searchParams)); }
    if (path === "/api/auth/session") return reply(auth);
    if (path === "/api/management") return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
    return route.fulfill({ status: 404, json: { error: "unknown fixture API" } });
  });
  await page.goto("https://pixhelf.test/");
  await page.locator('.image-card[data-loaded="true"]').first().waitFor();
  const idle = () => page.waitForFunction(() => document.querySelector('.content').getAttribute('aria-busy') === 'false');
  const open = async () => {
    if (await page.locator('.search-toggle').getAttribute('aria-expanded') !== 'true') {
      await page.locator('.gallery-sidebar-toggle').focus();
      await page.locator('.search-toggle').focus();
      await page.locator('.search-toggle').click();
    }
    await page.getByRole('dialog', { name: '搜索图库', exact: true }).waitFor();
  };
  const request = (key, value) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/images' && url.searchParams.get(key) === value && url.searchParams.get('offset') === '0';
  });
  const change = async (label, value, key) => {
    const response = request(key, value === 'all' ? null : value);
    await page.getByLabel(label, { exact: true }).selectOption(value);
    await response; await idle();
  };
  return { page, requests, idle, open, request, change, categoryWrites: () => categoryWrites, close: async () => { await context.close(); assert.deepEqual(errors, []); } };
}

async function checkSearchDisclosure(f, width) {
  const { page } = f;
  await page.keyboard.press('Escape');
  const input = page.locator('.gallery-search-input input'), panel = page.locator('.search-dialog');
  assert.equal(await input.count(), 0, 'toolbar only contains a search button');
  if (width <= 720) {
    await page.locator('.gallery-sidebar-toggle').click();
    assert(await page.locator('.mobile-sidebar').isVisible());
    assert.equal(await page.locator('.search-toggle').isVisible(), false, 'the drawer temporarily hides bottom navigation');
    await page.locator('.gallery-sidebar-toggle').click();
    await page.locator('.mobile-nav-layer').waitFor({ state: 'detached' });
    await f.open();
  } else await f.open();
  assert.equal(await input.evaluate(element => element === document.activeElement), width > 720, 'desktop search focuses the input; touch search leaves the keyboard closed');
  await input.fill('输入法测试');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
  assert(await panel.isVisible(), 'IME confirmation must not close the dialog');
  await input.press('Enter');
  await panel.waitFor({ state: 'detached' });
  assert(await page.locator('.search-toggle').evaluate(button => button === document.activeElement));
  await f.open();
  assert.equal(await input.inputValue(), '输入法测试');
  assert.deepEqual(await page.locator('.search-history-items button').allTextContents(), ['输入法测试']);
  const layout = await panel.evaluate(element => {
    const bounds = selector => element.querySelector(selector).getBoundingClientRect();
    const filters = bounds('.gallery-filter-fields'), categories = bounds('.gallery-filter-content');
    const input = bounds('.gallery-search-input'), history = bounds('.search-history');
    const selects = [...element.querySelectorAll('select')].map(select => select.getBoundingClientRect().top);
    return { ordered: filters.bottom <= categories.top && categories.bottom <= input.top && input.bottom <= history.top,
      singleRow: selects.every(top => Math.abs(top - selects[0]) < 1), fits: element.scrollWidth <= element.clientWidth };
  });
  assert(layout.ordered && layout.singleRow && layout.fits, JSON.stringify(layout));
  assert.equal(await panel.getByText('内容分类', { exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '管理分类', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden');
  await page.keyboard.press('Shift+Tab');
  assert(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest('.search-dialog')), 'modal focus never enters the gallery behind it');
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => !!document.activeElement.closest('.search-dialog')));
  await panel.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: `${output}/search-dialog-${width}.png` });
  if (width <= 720) {
    await input.focus();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', { configurable: true, value: 300 });
      Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 24 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--visual-viewport-height') === '300px');
    await page.waitForTimeout(200);
    const viewport = await panel.evaluate(element => {
      const box = element.getBoundingClientRect(), footer = element.querySelector('footer').getBoundingClientRect();
      const input = element.querySelector('input').getBoundingClientRect(), header = element.querySelector('header').getBoundingClientRect();
      const body = element.querySelector('.search-dialog-content');
      return { top: box.top, bottom: box.bottom, footer: footer.bottom, scrolls: body.scrollHeight > body.clientHeight,
        inputVisible: input.top >= header.bottom && input.bottom <= footer.top,
        inputTop: input.top, inputBottom: input.bottom, headerBottom: header.bottom, footerTop: footer.top, active: document.activeElement.tagName, scrollTop: body.scrollTop };
    });
    assert(viewport.top >= 24 && viewport.bottom <= 324 && viewport.footer <= 324 && viewport.inputVisible, JSON.stringify(viewport));
    await page.screenshot({ path: `${output}/search-keyboard-${width}.png` });
    await page.evaluate(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); });
  }
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden');
  await page.reload();
  await f.open();
  await page.locator('.search-history-items').getByRole('button', { name: '输入法测试', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  await f.open();
  assert.equal(await input.inputValue(), '输入法测试', 'history restores the query after a reload');
  await input.fill('  海边的日落  ');
  await input.press('Enter');
  await f.open();
  assert.deepEqual(await page.locator('.search-history-items button').allTextContents(), ['海边的日落', '输入法测试']);
  await input.press('Enter');
  await f.open();
  assert.equal(await page.locator('.search-history-items button').count(), 2, 'repeated searches are deduplicated');
  await page.getByRole('button', { name: '清空搜索历史', exact: true }).click();
  await page.getByText('暂无搜索历史', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '  海边的日落  ', 'clearing history preserves the active query');
  await page.reload();
  await f.open();
  await page.getByText('暂无搜索历史', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  console.log(`${width}px: modal search, persistence, IME, focus, drawer handoff and keyboard viewport passed`);
}

try {
  for (const width of [1440, 390, 320]) {
    const f = await fixture(width);
    const { page } = f;
    try {
      await f.open();
      const bounds = await page.locator('.search-dialog').boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 844, 'filter panel fits the screen');
      await f.change('媒体类型', 'photo', 'kind');
      assert.equal(f.requests.at(-1).get('kind'), 'photo');
      await page.locator('.gallery-filter-summary').getByText('90 项', { exact: true }).waitFor();
      if (width === 1440) {
        await page.locator('.search-dialog').getByRole('button', { name: '搜索', exact: true }).click();
        const more = page.waitForResponse(response => new URL(response.url()).searchParams.get('offset') === '60');
        await page.locator('.load-sentinel').scrollIntoViewIfNeeded();
        await more; await f.idle();
        assert.equal(f.requests.at(-1).get('kind'), 'photo', 'pagination keeps the filter');
        assert.equal(f.requests.at(-1).get('offset'), '60');
        await f.open();
      }
      await f.change('图片画幅', 'portrait', 'orientation');
      await page.locator('.gallery-filter-summary').getByText('30 项', { exact: true }).waitFor();
      assert(f.requests.at(-1).get('kind') === 'photo' && f.requests.at(-1).get('orientation') === 'portrait');
      await f.change('排序方式', 'name-desc', 'sort');
      assert.equal(await page.locator('.image-card').first().getAttribute('data-image-name'), 'photo-264.jpg');
      const semantic = f.request('search', '自然风景');
      await page.getByRole('button', { name: '风景', exact: true }).click();
      await semantic; await f.idle();
      assert.equal(f.requests.at(-1).get('kind'), 'photo');
      assert.equal(f.requests.at(-1).get('orientation'), 'portrait');
      await page.screenshot({ path: `${output}/filters-${width}.png` });
      assert.equal(await page.locator('.filter-toggle').count(), 0, 'search and filtering share one entry');
      assert.equal(await page.locator('.gallery-search-input input').inputValue(), '自然风景');
      assert(await page.locator('.gallery-search-input input').isVisible());
      await page.keyboard.press('Escape');
      assert(await page.locator('.search-toggle').evaluate(button => document.activeElement === button));
      await f.open();
      await f.change('排序方式', 'explore', 'sort');
      const seed = f.requests.at(-1).get('seed');
      assert.equal(f.requests.at(-1).get('search'), '自然风景', 'random browsing keeps the content search');
      assert.equal(f.requests.at(-1).get('kind'), 'photo');
      assert.equal(f.requests.at(-1).get('orientation'), 'portrait');
      await f.change('媒体类型', 'live', 'kind');
      assert.equal(f.requests.at(-1).get('seed'), seed, 'changing filters keeps the random order');
      const updatedSearch = f.request('search', '海边的日落');
      await page.locator('.gallery-search-input input').fill('海边的日落');
      await updatedSearch; await f.idle();
      assert.equal(f.requests.at(-1).get('sort'), 'explore', 'searching does not silently change the chosen sort');
      assert.equal(f.requests.at(-1).get('seed'), seed);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.topbar-actions .explore-toggle').count(), 0);
      assert.equal(await page.locator(width <= 720 ? '.mobile-bottom-nav .mobile-tab' : '.topbar-actions > button, .topbar-actions .toolbar-popover-trigger').count(), width <= 720 ? 4 : 2);
      const next = f.request('sort', 'explore');
      await page.getByRole('button', { name: '换一组', exact: true }).click();
      await next; await f.idle();
      assert.notEqual(f.requests.at(-1).get('seed'), seed);
      assert.equal(f.requests.at(-1).get('search'), '海边的日落');
      assert.equal(f.requests.at(-1).get('kind'), 'live');
      assert.equal(f.requests.at(-1).get('orientation'), 'portrait');
      await page.locator('.search-dialog').waitFor({ state: 'hidden' });
      await page.screenshot({ path: `${output}/random-browsing-${width}.png` });
      await f.open();
      await f.change('排序方式', 'name-asc', 'sort');
      assert.equal(f.requests.at(-1).has('seed'), false);
      assert.equal(await page.getByRole('button', { name: '换一组', exact: true }).count(), 0);
      const reset = f.request('kind', null);
      await page.getByRole('button', { name: '重置条件', exact: true }).click();
      await reset; await f.idle();
      assert.equal(f.requests.at(-1).has('orientation'), false);
      assert.equal(f.requests.at(-1).has('search'), false);
      assert.equal(await page.locator('.gallery-filter-summary').count(), 0);
      await checkSearchDisclosure(f, width);
      console.log(`${width}px: combined filters, sorting, content search, reset, focus and exploration passed`);
    } finally { await f.close(); }
  }

  const landscape = await fixture(844, true, true);
  try {
    await landscape.page.setViewportSize({ width: 844, height: 390 });
    await landscape.open();
    const input = landscape.page.locator('.gallery-search-input input');
    assert.equal(await input.evaluate(element => document.activeElement === element), false, 'landscape touch search forces the keyboard open');
    assert.equal(await input.evaluate(element => getComputedStyle(element).fontSize), '16px');
    const panel = landscape.page.locator('.search-dialog');
    await panel.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const bounds = await panel.boundingBox();
    assert(bounds.y >= 0 && bounds.y + bounds.height <= 390, 'landscape dialog fits the screen');
    await landscape.page.screenshot({ path: `${output}/search-landscape.png` });
    await landscape.page.getByRole('button', { name: '关闭搜索', exact: true }).click();
    await panel.waitFor({ state: 'detached' });
    console.log('landscape touch search fits the screen and closes cleanly');
  } finally { await landscape.close(); }

  const f = await fixture(1440);
  const release = Promise.withResolvers();
  try {
    await f.open();
    await f.page.route('**/api/images?*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('kind') !== 'live') return route.fallback();
      await release.promise;
      await route.fulfill({ json: imagePage(url.searchParams) }).catch(() => {});
    });
    const liveRequest = f.page.waitForRequest(request => new URL(request.url()).searchParams.get('kind') === 'live');
    await f.page.getByLabel('媒体类型', { exact: true }).selectOption('live');
    await liveRequest;
    await f.change('媒体类型', 'video', 'kind');
    release.resolve();
    await f.page.waitForTimeout(200);
    assert(await f.page.locator('.image-card').evaluateAll(cards => cards.every(card => card.dataset.imageName.startsWith('video-'))), 'stale response must not replace the newest filter');
    await f.open();
    const empty = f.request('search', 'missing-file');
    await f.page.locator('.gallery-search-input input').fill('missing-file');
    await empty; await f.idle();
    await f.page.getByText('没有符合筛选条件的内容', { exact: true }).waitFor();
    assert.equal(await f.page.locator('.image-card').count(), 0);
    console.log('rapid filter changes ignore late results; empty results stay empty');
  } finally { release.resolve(); await f.close(); }

  const custom = await fixture(390);
  try {
    const { page } = custom;
    const openCategories = async () => {
      await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
      await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
      await page.locator('.mobile-sidebar').getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.settings-nav').getByRole('button', { name: '图片分类', exact: true }).click();
    };
    await custom.open();
    await openCategories();
    assert.equal(await page.locator('.search-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#category-name-0').fill('亲友');
    await page.locator('#category-query-0').fill('朋友\u007f的合照');
    await page.getByRole('button', { name: '保存分类', exact: true }).click();
    await page.getByText('分类不能包含控制字符', { exact: true }).waitFor();
    assert.equal(custom.categoryWrites(), 0, 'invalid control characters are rejected before saving');
    await page.locator('#category-query-0').fill('朋友的合照');
    await page.getByRole('button', { name: '新增分类', exact: true }).click();
    await page.locator('#category-name-6').fill('旅行');
    await page.locator('#category-query-6').fill('海边的日落');
    await page.getByRole('button', { name: '保存分类', exact: true }).click();
    await page.getByText('分类已保存', { exact: true }).waitFor();
    assert.equal(custom.categoryWrites(), 1);
    await page.screenshot({ path: `${output}/category-settings-390.png` });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await custom.open();
    assert(await page.getByRole('button', { name: '亲友', exact: true }).isVisible());
    const request = custom.request('search', '海边的日落');
    await page.getByRole('button', { name: '旅行', exact: true }).click();
    await request; await custom.idle();
    assert.equal(await page.locator('.gallery-search-input input').inputValue(), '海边的日落');
    await page.reload();
    await custom.open();
    await page.getByRole('button', { name: '旅行', exact: true }).waitFor();
    await openCategories();
    await page.locator('#category-query-0').fill('海边的日落');
    await page.getByRole('button', { name: '保存分类', exact: true }).click();
    await page.getByText('搜索描述不能重复', { exact: true }).waitFor();
    assert.equal(custom.categoryWrites(), 1, 'invalid categories are not written');
    await page.getByRole('button', { name: '删除分类 亲友', exact: true }).click();
    await page.getByRole('button', { name: '保存分类', exact: true }).click();
    await page.getByText('分类已保存', { exact: true }).waitFor();
    assert.equal(custom.categoryWrites(), 2);
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    await page.getByRole('button', { name: '保存分类', exact: true }).click();
    await page.getByText('分类已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await custom.open();
    await page.getByRole('button', { name: '人物', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '旅行', exact: true }).count(), 0);
    console.log('custom categories can be added, edited, removed, saved, reloaded and restored; duplicate queries are rejected');
  } catch (error) {
    await custom.page.screenshot({ path: `${output}/category-settings-failure.png` }).catch(() => {});
    console.error(await custom.page.locator('.category-settings').evaluate(element => ({
      text: element.innerText, inputs: [...element.querySelectorAll('input')].map(input => ({ id: input.id, value: input.value, valid: input.validity.valid })),
    })).catch(() => null));
    throw error;
  } finally { await custom.close(); }

  const unavailable = await fixture(390, false);
  try {
    await unavailable.open();
    assert(await unavailable.page.getByRole('button', { name: '人物', exact: true }).isDisabled());
    await unavailable.change('媒体类型', 'live', 'kind');
    await unavailable.page.locator('.gallery-filter-summary').getByText('90 项', { exact: true }).waitFor();
    const searched = unavailable.request('search', defaults[0].query);
    await unavailable.page.locator('.gallery-search-input input').fill(defaults[0].query);
    await searched; await unavailable.idle();
    assert.equal(await unavailable.page.locator('.search-toggle').getAttribute('data-active'), 'true');
    console.log('metadata filters work when semantic search is unavailable');
  } finally { await unavailable.close(); }
} finally { await browser.close(); }
