import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const photo = await readFile(new URL('fixtures/live-photo.jpg', import.meta.url));
const image = (number, size = 1000) => ({ id: number.toString(16).padStart(32, '0'), name: `photo-${number}.jpg`, path: `旅行/photo-${number}.jpg`, width: 960, height: 720, size, modifiedMs: number + 1 });
const seed = [{ id: 'first', images: [image(1), image(2, 2000)] }, { id: 'second', images: [image(3), image(4, 3000), image(5)] }, { id: 'third', images: [image(6), image(7)] }];
const browser = await launchBrowser();
async function fixture(width, guest = false, large = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width <= 720, isMobile: width <= 720 });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = [], writes = [], downloads = [], refreshes = [];
  let groups = large ? Array.from({ length: 603 }, (_, i) => ({ id: `large-${i}`, images: [image(1000 + i * 2), image(1001 + i * 2)] })) : structuredClone(seed), revision = 1, scans = 0, rejectNext = !large;
  let favorites = [seed[0].images[0].id];
  const auth = { enabled: true, authenticated: !guest, guest, username: 'admin', csrfToken: 'a'.repeat(64) };
  const summary = { total: 7, albums: [], revision: 'test' };
  const status = { total: 7, ready: 7, failed: 0, queued: 0, processing: 0, initialBatchReady: true, backgroundComplete: true,
    textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
  const library = () => ({ items: groups.flatMap(group => group.images).slice(0, 60), total: groups.reduce((sum, group) => sum + group.images.length, 0), offset: 0, limit: 60, nextOffset: null });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const reply = json => route.fulfill({ json });
    if (url.hostname !== 'pixhelf.test') return route.abort();
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('__PIXHELF_AUTH__', JSON.stringify(auth))
      .replace('__PIXHELF_BOOTSTRAP__', JSON.stringify({ summary, status, images: library() })) });
    if (path.startsWith('/assets/')) return serveFrontendAsset(route);
    if (path.endsWith('/thumbnail') || /\/api\/images\/[^/]+\.jpg$/.test(path)) return route.fulfill({ contentType: 'image/jpeg', body: photo });
    if (path === '/api/gallery') return reply(summary);
    if (path === '/api/status') return reply(status);
    if (path === '/api/auth/session') return reply(auth);
    if (path === '/api/categories') return reply({ categories: [] });
    if (path === '/api/management') return reply({ favoriteIds: favorites, favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
    if (path === '/api/images' || path.endsWith('/similar')) return reply(library());
    if (path === '/api/images/duplicates') {
      scans++;
      if (url.searchParams.get('refresh') === 'true') refreshes.push(url.href);
      const search = url.searchParams.get('search');
      const filtered = groups.filter(group => group.images.length > 1 && (!search || group.images.some(image => image.path.includes(search))));
      const offset = Number(url.searchParams.get('offset')), items = filtered.slice(offset, offset + 2);
      return reply({ groups: scans === 1 ? [] : items, total: filtered.length, scanned: scans === 1 ? 2 : 7, imageTotal: 7, skipped: 0,
        plan: scans > 1 && url.searchParams.get('plan') === 'true' ? filtered.map(group => ({ id: group.id, images: group.images.map(({id, size, modifiedMs}) => ({id, size, modifiedMs})) })) : null,
        scanning: scans === 1, revision: String(revision), offset, nextOffset: offset + items.length < filtered.length ? offset + items.length : null });
    }
    if (path === '/api/management/directories') return reply({ path: url.searchParams.get('path') ?? '', items: [{ path: '整理', name: '整理', directory: true, hasChildren: false, size: 0, imageId: null }], total: 1, nextOffset: null });
    if (path === '/api/management/batch') {
      const data = route.request().postDataJSON(); writes.push(data);
      assert.equal(guest, false);
      assert.equal(route.request().headers()['x-csrf-token'], auth.csrfToken);
      assert(data.ids.length <= 500, 'the full selection is sent in bounded batches');
      if (data.action === 'trash') for (const id of data.ids) {
        const group = groups.find(group => group.images.some(image => image.id === id));
        assert(group.images.some(image => image.id === data.duplicateKeepers[id]), 'every deletion keeps a surviving original');
        assert(!data.ids.includes(data.duplicateKeepers[id]));
      }
      const results = data.ids.map((id, i) => {
        const fail = data.action === 'trash' && rejectNext && i === 0;
        if (!fail && data.action === 'trash') groups = groups.map(group => ({ ...group, images: group.images.filter(image => image.id !== id) }));
        if (!fail && data.action === 'move') groups = groups.map(group => ({ ...group, images: group.images.map(image => image.id === id ? { ...image, path: `${data.destination}/${image.name}` } : image) }));
        if (data.action === 'favorite') favorites.push(id);
        return { id, ok: !fail, error: fail ? '文件暂时不可用' : null };
      });
      rejectNext = false; revision++;
      return reply({ results });
    }
    if (path === '/api/management/downloads') { downloads.push(route.request().postDataJSON()); return reply({ url: `/api/management/downloads/${'b'.repeat(64)}` }); }
    if (path.startsWith('/api/management/downloads/')) return route.fulfill({ body: Buffer.from('fixture'), contentType: 'application/zip' });
    const source = seed.flatMap(group => group.images).find(image => path === `/api/images/${image.id}`);
    if (source) return reply(source);
    return route.fulfill({ status: 404, json: { error: 'fixture endpoint unavailable' } });
  });
  await page.goto(`https://pixhelf.test/${large ? '?view=similar' : ''}`);
  if (!large) {
    await page.locator('.gallery-sidebar-toggle').click();
    await page.locator(width <= 720 ? '.mobile-sidebar' : '.desktop-sidebar').getByRole('button', { name: '相似图片', exact: true }).click();
  }
  await page.locator('.duplicate-group').nth(1).waitFor();
  await page.waitForFunction(collapsed => document.querySelector('.app-shell').dataset.sidebarCollapsed === String(collapsed), width <= 720 || large);
  return { page, writes, downloads, refreshes, close: async () => { await context.close(); assert.deepEqual(errors, []); } };
}
try {
  for (const width of [1440, 390, 320]) {
    const f = await fixture(width), { page } = f;
    try {
      const selected = () => page.locator('[aria-label="重复图片操作"]').evaluateAll(nodes => Number(nodes[0]?.dataset.selectedCount ?? 0));
      assert.equal(await selected(), 4, 'the initial selection includes copies from unloaded groups');
      assert.equal(await page.locator('.duplicate-item[data-retained=true] .image-card').first().getAttribute('data-image-id'), seed[0].images[0].id, 'favorites are preserved even if a copy is larger');
      assert.equal(await page.locator('.duplicate-item[data-retained=true] .photo-card-select').count(), 0, 'each group retains at least one image');
      await page.locator('.duplicate-group').first().getByRole('button', { name: '改为保留这张', exact: true }).click();
      assert.equal(await selected(), 4);
      assert.equal(await page.locator('.duplicate-item[data-retained=true] .image-card').first().getAttribute('data-image-id'), seed[0].images[1].id);
      await page.getByRole('button', { name: '取消选择', exact: true }).click();
      assert.equal(await selected(), 0);
      await page.getByRole('button', { name: '自动选择全部副本', exact: true }).click();
      assert.equal(await selected(), 4);
      const refreshed = page.waitForResponse(response => response.url().includes('/api/images/duplicates?') && response.url().includes('refresh=true'));
      await page.getByRole('button', { name: '重新检查', exact: true }).click();
      await refreshed;
      await page.locator('.duplicate-group').nth(1).waitFor();
      assert.equal(f.refreshes.length, 1);
      assert.equal(await page.locator('.duplicate-item[data-retained=true] .image-card').first().getAttribute('data-image-id'), seed[0].images[1].id, 'rechecking preserves the chosen keeper');
      await page.screenshot({ path: `/tmp/pixhelf-duplicates-${width}.png`, animations: 'disabled' });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('.load-sentinel').scrollIntoViewIfNeeded();
      await page.locator('.duplicate-group').nth(2).waitFor();
      assert.equal(await selected(), 4);
      const toolbar = page.getByRole('region', { name: '重复图片操作', exact: true });
      await toolbar.getByRole('button', { name: '下载', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="重复图片操作"]').getAttribute('aria-busy') === 'false');
      assert.equal(f.downloads[0].ids.length, 4);
      await toolbar.getByRole('button', { name: '删除', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '移入回收站', exact: true });
      assert.equal(f.writes.length, 0, 'automatic selection does not execute deletion');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(f.writes.length, 0);
      await toolbar.getByRole('button', { name: '删除', exact: true }).click();
      await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.getByRole('alert').filter({ hasText: '1 项失败' }).waitFor();
      await page.locator('.duplicate-group').waitFor();
      assert.equal(f.writes[0].ids.length, 4);
      assert.equal(await selected(), 1, 'only failed deletions remain selected after reload');
      await toolbar.getByRole('button', { name: '移动', exact: true }).click();
      const move = page.getByRole('dialog', { name: '移动到目录', exact: true });
      await move.locator('[role=treeitem][data-path="整理"]').click();
      await move.getByRole('button', { name: '移动', exact: true }).click();
      await move.waitFor({ state: 'detached' });
      assert.equal(f.writes.at(-1).destination, '整理');
      await page.locator('.duplicate-copy > span').filter({ hasText: '整理/' }).waitFor();
      assert.equal(await selected(), 0, 'successful moves clear selection');
      await page.locator('.search-toggle').click();
      await page.getByPlaceholder('搜索重复图片名称或路径').fill('missing');
      await page.getByRole('dialog').getByRole('button', { name: '搜索', exact: true }).click();
      await page.getByText('没有匹配的重复图片', { exact: true }).waitFor();
      await page.locator('.search-toggle').click();
      await page.getByPlaceholder('搜索重复图片名称或路径').fill('');
      await page.getByRole('dialog').getByRole('button', { name: '搜索', exact: true }).click();
      await page.locator('.duplicate-group').waitFor();
      await page.getByRole('button', { name: '自动选择全部副本', exact: true }).click();
      const chosen = await selected();
      await page.locator('.duplicate-card .photo-card-open').first().click();
      await page.locator('.image-viewer[data-full-loaded=true]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.image-viewer').waitFor({ state: 'detached' });
      assert.equal(await selected(), chosen, 'viewing an original preserves duplicate selections');
      const source = await page.locator('.duplicate-card').first().getAttribute('data-image-id');
      await page.locator('.duplicate-card .photo-card-open').first().press('Shift+F10');
      await page.getByRole('menuitem', { name: '查找相似图片', exact: true }).click();
      await page.getByRole('region', { name: '以图搜图结果', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('source'), source);
      assert.equal(await page.locator('.duplicate-page').count(), 0);
      await page.getByRole('button', { name: '返回重复图片', exact: true }).click();
      await page.locator('.duplicate-group').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('source'), null);
      console.log(`${width}px: duplicate grouping, keeper changes, rescan, pagination, download, partial deletion, move, search, viewer and similar-image navigation passed`);
    } finally { await f.close(); }
  }
  const all = await fixture(1440, false, true);
  try {
    assert.equal(await all.page.locator('[aria-label="重复图片操作"]').getAttribute('data-selected-count'), '603');
    assert(await all.page.locator('.duplicate-group').count() < 603, 'full selection does not require rendering every group');
    await all.page.getByRole('button', { name: '一键清理副本', exact: true }).click();
    await all.page.getByText('没有发现重复图片', { exact: true }).waitFor();
    assert.deepEqual(all.writes.map(write => write.ids.length), [500, 103]);
    assert.equal(await all.page.locator('[aria-label="重复图片操作"]').count(), 0);
    console.log('603 groups: one-click cleanup covers unloaded groups in two batches and retains an original in every group');
  } finally { await all.close(); }
  const guest = await fixture(390, true);
  try {
    assert.equal(await guest.page.getByRole('region', { name: '重复图片操作', exact: true }).count(), 0);
    assert.equal(await guest.page.locator('.duplicate-keep, .photo-card-select').count(), 0);
    assert.equal(guest.writes.length, 0);
    console.log('guests can browse visible duplicates without management controls');
  } finally { await guest.close(); }
} finally { await browser.close(); }
