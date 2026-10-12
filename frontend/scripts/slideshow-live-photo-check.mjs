import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser, serveMotion } from './live-photo-fixture.mjs';
import { serveFrontendAsset } from './frontend-fixture.mjs';

const paths = process.argv.slice(2);
const clips = await Promise.all((paths.length ? paths : ['live-photo.mp4', 'live-photo-hevc.mov']
  .map(name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)))).map(path => readFile(path)));
assert.equal(clips.length, 2, 'supply two short Live Photo clips');
const [html, photo] = await Promise.all([
  readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
  readFile(new URL('fixtures/live-photo.jpg', import.meta.url)),
]);
const images = [0, 1, 2].map(index => ({ id: String(index).padStart(32, '0'), name: `image-${index}.jpg`, width: 960, height: 720,
  ...(index < 2 ? { motion: `/motion/${index}.mov` } : {}),
}));
const auth = { enabled: false, authenticated: false };
const summary = { total: images.length, albums: [], revision: 'live-slideshow' };
const imagePage = { items: images, total: images.length, offset: 0, limit: 60, nextOffset: null };
const status = { total: 3, ready: 3, failed: 0, queued: 0, processing: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const browser = await launchBrowser();
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width <= 720, isMobile: width <= 720 });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    // Browsing alone must not preload in data saver. Explicit slideshow
    // playback must still fetch the entire current and next clip immediately.
    await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true }));
    let releasePhoto;
    const originalReady = new Promise(resolve => { releasePhoto = resolve; });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const reply = json => route.fulfill({ json }).catch(() => {});
      if (url.hostname !== 'pixhelf.test') return route.abort();
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('__PIXHELF_AUTH__', JSON.stringify(auth))
        .replace('__PIXHELF_BOOTSTRAP__', JSON.stringify({ summary, status, images: imagePage })) });
      if (path.startsWith('/assets/')) return serveFrontendAsset(route);
      const motion = /^\/motion\/(\d).mov$/.exec(path);
      if (motion) {
        const request = { index: Number(motion[1]), method: route.request().method(), range: route.request().headers().range, done: false };
        requests.push(request);
        // A complete response cannot be mistaken for a metadata-only preload.
        await new Promise(resolve => setTimeout(resolve, 150));
        await serveMotion(route, { clip: clips[request.index], contentType: 'video/quicktime' }).catch(() => {});
        request.done = true;
        return;
      }
      if (path.endsWith('/thumbnail') || path.endsWith('.jpg')) {
        if (path === `/api/images/${images[0].id}.jpg`) await originalReady;
        return route.fulfill({ contentType: 'image/jpeg', body: photo }).catch(() => {});
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
    try {
      await page.goto('https://pixhelf.test/');
      await page.locator('.image-card[data-loaded="true"]').first().waitFor();
      await page.waitForTimeout(500);
      assert.equal(requests.length, 0, 'gallery data saver prevents speculative loading');
      await page.locator('.image-card').first().dispatchEvent('contextmenu', { button: 2, clientX: 150, clientY: 150 });
      await page.evaluate(() => {
        window.slideFlashes = [];
        window.liveEndFrames = [];
        const observed = new WeakSet();
        const check = () => {
          const media = document.querySelector('.viewer-media');
          const layer = media?.querySelector('.media-preview');
          if (layer && layer.dataset.playbackState !== 'failed') {
            const visible = [...media.querySelectorAll(':scope > img, :scope > canvas')]
              .some(source => getComputedStyle(source).visibility !== 'hidden' && Number(getComputedStyle(source).opacity) > 0);
            if (visible && media.dataset.imageId !== '0'.repeat(32)) window.slideFlashes.push(`poster: ${media.dataset.imageId}`);
            const viewer = media.closest('.image-viewer');
            if (viewer.dataset.slideshowTransition === 'dissolving' && layer.dataset.playing !== 'true') {
              window.slideFlashes.push(`dissolve before motion: ${media.dataset.imageId}`);
            }
            if (layer.dataset.playbackState === 'ended' && layer.dataset.playing !== 'true') {
              window.slideFlashes.push(`lost end frame: ${media.dataset.imageId}`);
            }
            if (!observed.has(layer)) {
              observed.add(layer);
              const observer = new MutationObserver(() => {
                if (layer.dataset.playbackState !== 'ended') return;
                const surface = layer.querySelector('.media-player-surface');
                window.liveEndFrames.push({ visible: layer.dataset.playing === 'true', time: Number(surface?.dataset.currentTime) });
                observer.disconnect();
              });
              observer.observe(layer, { attributes: true, attributeFilter: ['data-playback-state'] });
            }
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
      await page.locator('.image-viewer').waitFor();
      for (let i = 0; i < 150 && requests.filter(request => request.method === 'GET' && request.done).length < 2; i++) await page.waitForTimeout(20);
      for (let index = 0; index < 2; index++) {
        assert.deepEqual(requests.filter(request => request.index === index).map(({ method, range, done }) => ({ method, range, done })), [
          { method: 'HEAD', range: undefined, done: true },
          { method: 'GET', range: `bytes=0-${clips[index].length - 1}`, done: true },
        ], 'both complete clips load while the original still image is pending');
      }
      const timings = [];
      for (let index = 0; index < 2; index++) {
        await page.locator(`.image-viewer[data-image-id="${images[index].id}"] .media-preview[data-playing="true"]`).waitFor({ timeout: 30000 });
        if (index === 0) assert.equal(await page.locator('.image-viewer').getAttribute('data-full-loaded'), 'false',
          'Live Photo starts before the still image has loaded');
        const player = await page.locator('.viewer-media .media-player-surface').elementHandle();
        const duration = await player.evaluate(player => Number(player.dataset.duration));
        await page.locator('.viewer-media .media-preview').evaluate(layer => {
          window.liveEnded = undefined;
          window.liveAdvanced = undefined;
          const viewer = layer.closest('.image-viewer'), imageId = viewer.dataset.imageId;
          const navigation = new MutationObserver(() => {
            if (viewer.dataset.imageId === imageId) return;
            window.liveAdvanced = performance.now();
            navigation.disconnect();
          });
          navigation.observe(viewer, { attributes: true, attributeFilter: ['data-image-id'] });
          const observer = new MutationObserver(() => {
            if (layer.dataset.playbackState !== 'ended') return;
            window.liveEnded = performance.now();
            observer.disconnect();
          });
          observer.observe(layer, { attributes: true, attributeFilter: ['data-playback-state'] });
        });
        const started = await page.evaluate(() => performance.now());
        await page.locator(`.image-viewer[data-image-id="${images[index + 1].id}"]`).waitFor({ timeout: 20000 });
        const { ended, advanced } = await page.evaluate(() => ({ ended: window.liveEnded, advanced: window.liveAdvanced }));
        assert(ended > started, 'the slideshow must wait for complete Live Photo playback');
        // HEVC software decoding may run slower than the media clock under
        // load. Measure the actual end event, not the nominal clip duration.
        assert(advanced - ended >= 1950 && advanced - ended < 2800,
          `a Live Photo holds its last frame for two seconds after ending: ${advanced - ended}ms`);
        const snapshot = await page.locator('.viewer-slideshow-snapshot canvas').evaluate(canvas => {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let visible = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 0 && pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) visible++;
          return visible / (pixels.length / 4);
        });
        assert(snapshot > .1, `the decoded outgoing frame must not become an empty/black canvas: ${snapshot}`);
        timings.push({ seconds: duration, playbackMs: Math.round(ended - started), endToNextMs: Math.round(advanced - ended) });
        assert.equal(requests.length, 4, 'slideshow playback reuses both complete preloads');
      }
      assert.deepEqual(await page.evaluate(() => window.slideFlashes), [], 'no poster or premature dissolve may interrupt motion');
      const endFrames = await page.evaluate(() => window.liveEndFrames);
      assert.equal(endFrames.length, 2);
      assert(endFrames.every(frame => frame.visible && frame.time > 0), 'completed live slides retain their final motion frame');
      releasePhoto();
      await page.locator('.viewer-close').click();
      await page.locator('.image-viewer').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.media-player-surface').count(), 0);
      // Ending a live slide now retains its final frame until navigation.
      // Releasing that frame must still leave the cached decoder replayable.
      await page.locator('[data-viewer-returning="true"]').waitFor({ state: 'detached' });
      await page.locator('.image-card').first().dispatchEvent('contextmenu', { button: 2, clientX: 150, clientY: 150 });
      await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
      await page.locator(`.image-viewer[data-image-id="${images[0].id}"] .media-preview[data-playing="true"]`).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.viewer-media .media-preview').getAttribute('data-warm'), 'true', 'a completed slideshow reuses its decoder');
      const replayTime = await page.locator('.viewer-media .media-player-surface').evaluate(player => Number(player.dataset.currentTime));
      assert(replayTime < 1, `restarting a slideshow replays from the beginning: ${replayTime}`);
      assert.equal(requests.length, 4, 'restarting a slideshow does not fetch either clip again');
      await page.locator('.viewer-close').click();
      await page.locator('.image-viewer').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.media-player-surface').count(), 0);
      assert.deepEqual(errors, []);
      console.log(`${width}px: motion without waiting for stills, no poster flashes, retained end frames, complete preloads, two-second end hold ${JSON.stringify(timings)}, no extra motion requests`);
    } finally { releasePhoto(); await page.close(); }
  }
} finally { await browser.close(); }
