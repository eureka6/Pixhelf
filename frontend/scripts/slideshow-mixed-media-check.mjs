import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser, serveMotion } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const directory = await mkdtemp('/tmp/pixhelf-slideshow-media-');
const clipPath = join(directory, 'motion.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=6',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-an', clipPath]);
const [html, photo, gif, clip] = await Promise.all([
  readFile(new URL('../dist/index.html', import.meta.url), 'utf8'),
  readFile(new URL('fixtures/live-photo.jpg', import.meta.url)),
  readFile(new URL('fixtures/animated.gif', import.meta.url)), readFile(clipPath),
]);
const images = Array.from({ length: 5 }, (_, i) => ({ id: String(i).padStart(32, '0'), name: i === 2 ? 'animated.gif' : `image-${i}.jpg`, width: 960, height: 720,
  ...(i === 1 ? { motion: '/motion.mp4' } : {}),
  ...(i === 3 ? { name: 'video.mp4', playback: '/video.mp4', video: { duration: 6, codec: 'h264', audioCodec: null, frameRate: 15, container: 'mp4' } } : {}),
}));
const summary = { total: 5, albums: [], revision: 'mixed' };
const imagePage = { items: images, total: 5, offset: 0, limit: 60, nextOffset: null };
const auth = { enabled: false, authenticated: false };
const status = { total: 5, ready: 5, failed: 0, queued: 0, processing: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const browser = await launchBrowser();
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width <= 720, isMobile: width <= 720 });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const reply = json => route.fulfill({ json }).catch(() => {});
      if (url.hostname !== 'pixhelf.test') return route.abort();
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: html.replace('__PIXHELF_AUTH__', JSON.stringify(auth))
        .replace('__PIXHELF_BOOTSTRAP__', JSON.stringify({ summary, status, images: imagePage })) });
      if (path.startsWith('/assets/')) return serveFrontendAsset(route);
      if (path === '/motion.mp4' || path === '/video.mp4') return url.searchParams.has('status') ? reply({ state: 'ready' })
        : serveMotion(route, { clip, contentType: 'video/mp4' });
      if (path.endsWith('.gif')) return route.fulfill({ contentType: 'image/gif', body: gif });
      if (path.endsWith('/thumbnail') || path.endsWith('.jpg')) return route.fulfill({ contentType: 'image/jpeg', body: photo });
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
    const tick = ms => page.clock.runFor(ms);
    const id = () => page.locator('.image-viewer').getAttribute('data-image-id');
    const ready = async index => {
      for (let i = 0; i < 150; i++) {
        if (await page.locator(`.image-viewer[data-image-id="${images[index].id}"][data-full-loaded="true"]`).count()) return;
        await tick(20); await page.waitForTimeout(10);
      }
      assert.fail(`image ${index} did not load`);
    };
    const motionPlaying = async () => {
      for (let i = 0; i < 300; i++) {
        if (await page.locator('.viewer-media .media-preview[data-playback-state="playing"]').count()) return;
        await tick(20); await page.waitForTimeout(10);
      }
      assert.fail('Live Photo did not start');
    };
    try {
      await page.goto('https://pixhelf.test/');
      await page.locator('.image-card[data-loaded="true"]').first().waitFor().catch(async error => {
        throw new Error(`${error.message}\n${JSON.stringify({ errors, body: await page.locator('body').innerText() })}`);
      });
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
      await page.locator('.image-card').first().dispatchEvent('contextmenu', { button: 2, clientX: 150, clientY: 150 });
      await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
      await ready(0); await page.waitForTimeout(200);
      await tick(5100); await ready(1);
      assert.equal(await page.locator('.viewer-slideshow-outgoing').count(), 1);
      await motionPlaying();
      assert.equal(await page.locator('.viewer-slideshow-outgoing').count(), 1, 'Live Photo plays beneath the dissolve');
      assert.equal(await page.locator('.viewer-thumbnail').evaluate(image => getComputedStyle(image).visibility), 'hidden', 'the live slide never reveals its poster');
      await page.locator('.viewer-slideshow-outgoing').waitFor({ state: 'detached' });
      await tick(100); await motionPlaying();
      const livePlayer = await page.locator('.viewer-media .media-player-surface').elementHandle();
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await tick(9000);
      assert.equal(await id(), images[1].id, 'backgrounding suspends the live slide');
      assert(await livePlayer.evaluate(player => player.isConnected && player.querySelector('video').paused), 'backgrounding preserves and pauses the decoder');
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      await tick(100); await motionPlaying();
      assert(await livePlayer.evaluate(player => player.isConnected), 'returning to the slide reuses the decoder');
      await page.locator('.viewer-media').dispatchEvent('contextmenu', { button: 2, clientX: width / 2, clientY: 400 });
      await tick(9000);
      assert.equal(await id(), images[1].id, 'the menu suspends the live slide');
      assert(await livePlayer.evaluate(player => player.isConnected && player.querySelector('video').paused), 'the menu preserves and pauses the decoder');
      await page.keyboard.press('Escape'); await tick(100); await motionPlaying();
      await tick(6100);
      assert.equal(await id(), images[1].id, 'the five-second timer must not truncate a longer Live Photo');
      await page.locator('.image-viewer').focus(); await page.keyboard.press(' '); await tick(50);
      assert.equal(await page.locator('.viewer-media .media-preview').getAttribute('data-playback-state'), 'paused', 'Space pauses the live decoder too');
      await page.keyboard.press(' '); await tick(50); await motionPlaying();
      await tick(5100);
      await page.locator('.viewer-media .media-preview[data-playback-state="ended"]').waitFor();
      const endTime = await livePlayer.evaluate(player => Number(player.dataset.currentTime));
      const retained = async message => {
        assert.equal(await id(), images[1].id, message);
        assert(await livePlayer.evaluate((player, time) => player.isConnected
          && player.closest('.media-preview').dataset.playing === 'true'
          && player.closest('.media-preview').dataset.playbackState === 'ended'
          && Math.abs(Number(player.dataset.currentTime) - time) < .05, endTime), 'the final frame remains visible without replaying');
      };
      await tick(1500); await retained('a completed live slide leaves time to appreciate the final frame');
      await page.locator('.image-viewer').focus(); await page.keyboard.press(' '); await tick(5000);
      await retained('Space cancels the pending advance during the end hold');
      await page.keyboard.press(' '); await tick(1500);
      await retained('resuming a completed live slide gives it another full hold');
      await page.locator('.viewer-media').dispatchEvent('contextmenu', { button: 2, clientX: width / 2, clientY: 400 });
      await tick(5000); await retained('the menu also pauses the end hold');
      await page.keyboard.press('Escape'); await tick(1500);
      await retained('closing the menu preserves the final frame');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await tick(5000); await retained('a hidden tab cannot consume the end hold');
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      await tick(1500); await retained('returning from the background retains the frame');
      if (width === 1440) await page.locator('.viewer-next').click();
      else await tick(600);
      await ready(2);
      assert.equal(await page.locator('.viewer-original-canvas').count(), 0, 'GIF keeps its animated image renderer');
      if (width === 1440) {
        await tick(1200);
        assert.equal(await id(), images[2].id, 'manually skipping the hold cancels its timer without skipping another slide');
      }
      await tick(width === 1440 ? 3500 : 4800); assert.equal(await id(), images[2].id, 'GIF uses the photo dwell time');
      await tick(400);
      await page.locator('.video-viewer-stage[data-playing="true"]').waitFor();
      assert.equal(await id(), images[3].id, 'ordinary video participates in sequence');
      await tick(8000); assert.equal(await id(), images[3].id, 'video timing comes from playback completion');
      await page.locator('.video-viewer-stage').focus(); await page.keyboard.press(' '); await tick(50);
      await page.locator('.video-viewer-stage[data-playing="false"]').waitFor();
      assert.equal(await page.locator('.viewer-close').getAttribute('data-slideshow-playing'), 'false');
      await page.locator('.video-next').click(); await tick(100); await ready(4);
      await tick(8000);
      assert.equal(await id(), images[4].id, 'manual video-to-photo navigation preserves the slideshow pause');
      await page.locator('.viewer-previous').click(); await tick(100);
      await page.locator('.video-viewer-stage[data-playing="false"]').waitFor();
      assert.equal(await id(), images[3].id, 'manual photo-to-video navigation preserves the slideshow pause');
      await page.locator('.video-viewer-stage').focus();
      await page.keyboard.press(' '); await tick(50);
      await page.locator('.video-viewer-stage[data-playing="true"]').waitFor();
      await page.locator('.media-player-surface[data-player-state="ended"]').waitFor();
      await tick(600); await ready(4);
      assert.equal(await page.locator('.video-viewer, .media-player-surface').count(), 0, 'completed video leaves no active decoder');
      await tick(5100); await ready(0);
      await page.locator('.viewer-close').click(); await tick(500);
      assert.equal(await page.locator('.image-viewer, .viewer-slideshow-outgoing, .media-player-surface').count(), 0);
      for (let i = 0; i < 100 && await page.locator('[data-viewer-returning="true"]').count(); i++) {
        await page.waitForTimeout(20); await tick(50);
      }
      assert.equal(await page.locator('[data-viewer-returning="true"]').count(), 0, 'the gallery regains interactions after the return animation');

      // Pause before a prepared video is available. A late preparation result
      // must not override the user's pause or advance the slideshow.
      let preparing = true;
      await page.route('**/video.mp4?status=true', route => route.fulfill({
        status: preparing ? 202 : 200, json: { state: preparing ? 'processing' : 'ready' },
      }));
      await page.locator('.image-card').nth(3).dispatchEvent('contextmenu', { button: 2, clientX: 150, clientY: 150 });
      await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
      await page.locator('.video-viewer-stage[data-video-state="preparing"]').waitFor();
      await page.locator('.video-viewer-stage').focus(); await page.keyboard.press(' '); await tick(50);
      preparing = false;
      await tick(2000);
      await page.locator('.video-viewer-stage[data-video-state="ready"][data-playing="false"]').waitFor();
      await tick(8000);
      assert.equal(await id(), images[3].id, 'finishing preparation cannot override a pause');
      await page.keyboard.press(' '); await tick(50);
      await page.locator('.video-viewer-stage[data-playing="true"]').waitFor();
      await page.locator('.media-player-surface[data-player-state="ended"]').waitFor();

      // Starting a new slideshow on an already ended video replays it.
      const endedVideo = await page.locator('.media-player-surface').elementHandle();
      await page.locator('.video-viewer-stage').evaluate(stage => stage.dispatchEvent(new CustomEvent('pixhelf:card-menu', {
        detail: { touch: false, point: { x: 150, y: 150 } },
      })));
      await page.getByRole('menuitem', { name: '幻灯片播放', exact: true }).click();
      await tick(100);
      await page.locator('.video-viewer-stage[data-playing="true"]').waitFor();
      assert(await endedVideo.evaluate(video => video.isConnected && video.currentTime < 1), 'a new slideshow restarts the retained video');
      await page.locator('.viewer-close').click(); await tick(500);
      assert.equal(await page.locator('.media-player-surface').count(), 0);
      assert.deepEqual(errors, []);
      console.log(`${width}px: mixed sequence, full playback, retained end hold with Space/menu/background pauses, cross-media pause, pending preparation, replay, looping and cleanup passed`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
