import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser, serveMotion } from './live-photo-fixture.mjs';
import { serveFrontendAsset } from './frontend-fixture.mjs';

const directory = await mkdtemp('/tmp/pixhelf-slide-motion-');
const colors = [[220, 30, 50], [32, 90, 210], [30, 210, 70]];
const clips = await Promise.all(colors.slice(0, 2).map(async (color, index) => {
  const path = join(directory, `${index}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `color=c=0x${color.map(value => value.toString(16).padStart(2, '0')).join('')}:s=320x240:r=20:d=2`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-an', path]);
  return readFile(path);
}));
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const images = [0, 1, 2].map(index => ({ id: String(index).padStart(32, '0'), name: `slide-${index}.jpg`, width: 960, height: 720,
  ...(index < 2 ? { motion: `/motion/${index}.mp4` } : {}),
}));
const auth = { enabled: false, authenticated: false };
const summary = { total: 3, albums: [], revision: 'motion-transition' };
const imagePage = { items: images, total: 3, offset: 0, limit: 60, nextOffset: null };
const status = { total: 3, ready: 3, failed: 0, queued: 0, processing: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const gate = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const near = (actual, expected, message) => assert(actual.every((value, index) => Math.abs(value - expected[index]) <= 5),
  `${message}: expected ${expected}, received ${actual}`);
const browser = await launchBrowser();
try {
  for (const { width, reduced = false, failed = false } of [
    { width: 1440 }, { width: 390 }, { width: 390, reduced: true }, { width: 1440, failed: true },
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width <= 720, isMobile: width <= 720,
      reducedMotion: reduced ? 'reduce' : 'no-preference' });
    page.setDefaultTimeout(12000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    const motions = [gate(), gate()], originals = gate();
    const photo = Buffer.from(await page.evaluate(color => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 720;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = `rgb(${color})`; ctx.fillRect(0, 0, 960, 720);
      return canvas.toDataURL().split(',')[1];
    }, colors[2]), 'base64');
    await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true }));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const reply = json => route.fulfill({ json }).catch(() => {});
      if (url.hostname !== 'pixhelf.test') return route.abort();
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('__PIXHELF_AUTH__', JSON.stringify(auth))
        .replace('__PIXHELF_BOOTSTRAP__', JSON.stringify({ summary, status, images: imagePage })) });
      if (path.startsWith('/assets/')) return serveFrontendAsset(route);
      const motion = /^\/motion\/(\d).mp4$/.exec(path);
      if (motion) {
        const index = Number(motion[1]), method = route.request().method();
        requests.push({ index, method });
        if (method === 'GET') await motions[index].promise;
        if (index === 1 && failed && method === 'GET') return route.fulfill({ status: 503, body: '' }).catch(() => {});
        return serveMotion(route, { clip: clips[index], contentType: 'video/mp4' }).catch(() => {});
      }
      if (path.endsWith('.jpg') || path.endsWith('/thumbnail')) {
        if (path.endsWith('.jpg')) await originals.promise;
        return route.fulfill({ contentType: 'image/png', body: photo }).catch(() => {});
      }
      if (path === '/api/gallery') return reply(summary);
      if (path === '/api/status') return reply(status);
      if (path === '/api/images') return reply(imagePage);
      if (path === '/api/categories') return reply({ categories: [] });
      if (path === '/api/auth/session') return reply(auth);
      if (path === '/api/management') return reply({ favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 });
      if (path.endsWith('/info')) return reply({ fileSize: 1000, modifiedMs: 0, exif: [], histogram: null });
      if (path.endsWith('/similar')) return reply({ items: [], total: 0, offset: 0, nextOffset: null });
      const image = images.find(image => path === `/api/images/${image.id}`);
      return image ? reply(image) : route.fulfill({ status: 404, body: '' });
    });
    const pixel = async () => {
      const png = await page.screenshot({ clip: { x: Math.floor(width / 2), y: 422, width: 1, height: 1 } });
      return page.evaluate(async data => {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      }, png.toString('base64'));
    };
    const slide = index => page.locator(`.image-viewer[data-image-id="${images[index].id}"]`);
    try {
      await page.goto('https://pixhelf.test/');
      await page.locator('.image-card[data-loaded="true"]').first().waitFor();
      await page.locator('.image-card').first().dispatchEvent('contextmenu', { button: 2, clientX: 150, clientY: 150 });
      await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
      await slide(0).locator('.media-preview[data-loading="true"]').waitFor();
      await page.waitForTimeout(400);
      const cold = await pixel();
      near(cold, colors[2], 'the opening live slide keeps its cover while motion loads');
      motions[0].release();
      await slide(0).locator('.media-preview[data-playing="true"]').waitFor();
      assert.equal(await slide(0).getAttribute('data-full-loaded'), 'false');
      near(await pixel(), colors[0], 'motion replaces the opening cover as soon as it is ready');

      await slide(1).waitFor();
      await page.waitForTimeout(400);
      assert.equal(await slide(1).getAttribute('data-slideshow-transition'), 'waiting');
      assert.equal(await slide(1).locator('.viewer-thumbnail').evaluate(image => getComputedStyle(image).visibility), 'hidden',
        'only the opening slide keeps its cover');
      near(await pixel(), colors[0], 'slow incoming motion holds the outgoing final motion frame');
      // Read the canvas as well as screen pixels so a fallback to a poster,
      // an empty copied canvas, or an early dissolve cannot pass this check.
      const snapshot = await page.locator('.viewer-slideshow-snapshot canvas').evaluate(canvas =>
        [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data].slice(0, 3));
      near(snapshot, colors[0], 'the outgoing snapshot contains decoded motion');
      motions[1].release();
      if (failed) {
        await slide(1).locator('.media-preview[data-failed="true"]').waitFor();
        await page.locator('.viewer-slideshow-outgoing').waitFor({ state: 'detached' });
        near(await pixel(), colors[2], 'a failed motion intentionally falls back to its photo');
        await slide(2).waitFor();
      } else {
        await slide(1).locator('.media-preview[data-playing="true"]').waitFor();
        assert.equal(await slide(1).getAttribute('data-full-loaded'), 'false');
        await page.locator('.viewer-slideshow-outgoing').waitFor({ state: 'detached' });
        near(await pixel(), colors[1], 'the incoming slide reveals motion directly');
        await slide(2).waitFor();
        await page.waitForTimeout(200);
        near(await pixel(), colors[1], 'live-to-photo holds the last motion frame until the photo loads');
        assert.equal(requests.length, 4, 'waiting transitions reuse the current and next downloads');
      }
      originals.release();
      await page.locator('.viewer-slideshow-outgoing').waitFor({ state: 'detached' });
      near(await pixel(), colors[2], 'ordinary photos still display after decoding');
      if (width === 390 && !reduced && !failed) {
        await slide(0).waitFor();
        assert.equal(await slide(0).locator('.viewer-thumbnail').evaluate(image => getComputedStyle(image).visibility), 'hidden',
          'looping back to the starting photo must not reintroduce its cover');
      }
      await page.locator('.viewer-close').click();
      await page.locator('.image-viewer').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.viewer-slideshow-outgoing, .media-player-surface').count(), 0);
      if (width === 1440 && !failed) {
        await page.locator('[data-viewer-returning="true"]').waitFor({ state: 'detached' });
        await page.locator('.image-card').nth(1).dispatchEvent('contextmenu', { button: 2, clientX: 150, clientY: 150 });
        await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
        await slide(1).waitFor();
        assert.equal(await slide(1).locator('.viewer-thumbnail').evaluate(image => getComputedStyle(image).visibility), 'visible',
          'starting in the middle of an album still preserves the opening cover');
        await page.locator('.viewer-previous').click(); await slide(0).waitFor();
        assert.equal(await slide(0).locator('.viewer-thumbnail').evaluate(image => getComputedStyle(image).visibility), 'hidden');
        await page.locator('.viewer-media').dispatchEvent('contextmenu', { button: 2, clientX: 200, clientY: 200 });
        await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
        assert.equal(await slide(0).locator('.viewer-thumbnail').evaluate(image => getComputedStyle(image).visibility), 'visible',
          'starting a new slideshow inside the viewer resets its opening cover');
        await page.locator('.viewer-close').click();
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
      }
      assert.deepEqual(errors, []);
      console.log(`${width}px${reduced ? ' reduced motion' : ''}${failed ? ' failed motion' : ''}: startup, delayed motion, actual transition pixels, delayed originals and cleanup passed`);
    } finally {
      motions.forEach(motion => motion.release()); originals.release(); await page.close();
    }
  }
} finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
