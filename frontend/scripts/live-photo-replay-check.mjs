import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { launchBrowser, serveLibmediaAsset, serveMotion } from "./live-photo-fixture.mjs";

const paths = process.argv.slice(2).filter(path => !path.startsWith('--'));
const clips = paths.length ? paths : [fileURLToPath(new URL("fixtures/live-photo.mp4", import.meta.url)),
  fileURLToPath(new URL("fixtures/live-photo-hevc.mov", import.meta.url))];
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx", contents: `
  import { render } from "preact";
  import { MediaPreview } from "./src/MediaPreview";
  window.show = (image, viewer, paused = false, playbackRequest = 0) => render(image ? <div className={viewer ? "viewer-media" : "image-card"}
    style={{ position: "relative", width: 300, height: 300 }}><MediaPreview key={image.id} image={image} autoPlay={viewer} paused={paused} playbackRequest={playbackRequest} /></div> : null, document.getElementById("root"));
` }, bundle: true, write: false, format: "esm", target: "es2022", jsx: "automatic", jsxImportSource: "preact",
  define: { "import.meta.env.DEV": "true" } });
const css = (await Promise.all(["base.css", "styles.css", "video.css"].map(name => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")))).join("\n");
const browser = await launchBrowser();
try {
  for (const path of clips) {
    const clip = await readFile(path);
    const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path], { encoding: "utf8" })).streams[0];
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width <= 720, isMobile: width <= 720 });
      const requests = [], errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/") return route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' });
        if (path.startsWith("/assets/libmedia/")) return serveLibmediaAsset(route);
        if (path.endsWith(".mov")) { requests.push(`${route.request().method()} ${path}`); return serveMotion(route, { clip, contentType: "video/quicktime" }); }
        return route.fulfill({ json: { enabled: false, authenticated: false } });
      });
      await page.goto("https://pixhelf.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ type: "module", content: bundle.outputFiles[0].text });
      await page.waitForFunction(() => typeof window.show === "function");
      try {
        for (const viewer of [false, true]) {
          const image = { id: viewer ? "viewer" : "card", name: "Live.heic", ...metadata, motion: "/motion.mov" };
          await page.evaluate(({ image, viewer }) => window.show(image, viewer), { image, viewer });
          const start = () => page.locator(viewer ? ".viewer-media" : ".image-card").dispatchEvent(viewer ? "pixhelf:media-preview-play"
            : width > 720 ? "pointerenter" : "pixhelf:card-touch", width > 720 && !viewer ? { pointerType: "mouse" } : undefined);
          if (!viewer) await start();
          await page.locator('.media-preview[data-playing="true"]').waitFor({ timeout: 30000 });
          const original = await page.locator('.media-player-surface').elementHandle();
          await page.locator('.media-preview[data-playback-state="ended"]').waitFor({ timeout: 20000 });
          await page.waitForFunction(element => element.dataset.playerState === "paused", original);
          const before = requests.length;
          await page.evaluate(() => {
            window.replayStarted = performance.now(); window.loaderSeen = false;
            const sample = () => {
              const layer = document.querySelector('.media-preview');
              const bar = layer.querySelector('.media-preview-loading');
              const style = getComputedStyle(bar);
              if (style.display !== 'none' && Number(style.opacity) > .1) window.loaderSeen = true;
              if (layer.dataset.playing === 'true') window.replayLatency = performance.now() - window.replayStarted;
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          await start();
          await page.locator('.media-preview[data-playing="true"]').waitFor();
          await page.waitForFunction(() => window.replayLatency !== undefined);
          assert(await original.evaluate(element => element === document.querySelector('.media-player-surface')), 'replay reuses the same decoder and surface');
          assert.equal(requests.length, before, 'replay makes no new source requests');
          const result = await page.evaluate(() => ({ ms: Math.round(window.replayLatency), loaderSeen: window.loaderSeen }));
          assert(result.ms < 300, `warm replay should start promptly: ${JSON.stringify(result)}`);
          assert.equal(result.loaderSeen, false, 'warm replay must not flash a loading bar');
          if (viewer) {
            // User pause, backgrounding and menus must preserve the current
            // position and decoder, including the HEVC compatibility renderer.
            const position = () => original.evaluate(element => Number(element.dataset.currentTime));
            const suspend = async action => {
              await action();
              await page.locator('.media-preview[data-playback-state="paused"]').waitFor();
              await page.waitForTimeout(100);
              const pausedAt = await position();
              await page.waitForTimeout(350);
              assert(Math.abs(await position() - pausedAt) < .06, 'suspended playback must stop advancing');
              return pausedAt;
            };
            const resume = async (action, pausedAt) => {
              await action();
              await page.locator('.media-preview[data-playback-state="playing"]').waitFor();
              assert(await position() >= pausedAt - .06, 'resume must keep the current position');
              assert(await original.evaluate(element => element.isConnected), 'resume must keep the same decoder');
              assert.equal(requests.length, before, 'resume must not redownload the clip');
            };
            let pausedAt = await suspend(() => page.evaluate(image => window.show(image, true, true), image));
            await resume(() => page.evaluate(image => window.show(image, true, false), image), pausedAt);
            pausedAt = await suspend(() => page.evaluate(() => {
              Object.defineProperty(document, 'hidden', { configurable: true, value: true });
              document.dispatchEvent(new Event('visibilitychange'));
            }));
            await resume(() => page.evaluate(() => {
              delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
            }), pausedAt);
            pausedAt = await suspend(() => page.evaluate(() => window.dispatchEvent(new Event('blur'))));
            await resume(() => page.evaluate(() => window.dispatchEvent(new Event('focus'))), pausedAt);
            pausedAt = await suspend(async () => {
              await page.locator('.viewer-media').dispatchEvent('pixhelf:card-menu');
              await page.evaluate(image => window.show(image, true, true), image);
            });
            await resume(() => page.evaluate(image => window.show(image, true, false), image), pausedAt);
          }
          await page.locator('.media-preview[data-playback-state="ended"]').waitFor({ timeout: 20000 });
          if (viewer) {
            await page.evaluate(image => window.show(image, true, false, 1), image);
            await page.locator('.media-preview[data-playing="true"]').waitFor();
            assert(await original.evaluate(element => element.isConnected && Number(element.dataset.currentTime) < 1), 'starting a slideshow replays a completed Live Photo');
            assert.equal(requests.length, before, 'starting a slideshow reuses the downloaded clip');
          }
          await page.evaluate(() => window.show(null));
          await page.waitForFunction(element => !element.isConnected && element.dataset.playerState === 'paused', original);
          assert.equal(await page.locator('.media-player-surface').count(), 0);

          // Visiting a different card and remounting the original used to
          // destroy the HEVC decoder even though its source bytes were cached.
          const other = { ...image, id: 'other', motion: '/other.mov' };
          await page.evaluate(image => window.show(image, false), other);
          await page.locator('.image-card').dispatchEvent('pixhelf:card-touch');
          await page.locator('.media-preview[data-playing="true"]').waitFor({ timeout: 30000 });
          const otherPlayer = await page.locator('.media-player-surface').elementHandle();
          await page.locator('.media-preview[data-playback-state="ended"]').waitFor({ timeout: 20000 });
          await page.evaluate(() => window.show(null));
          const warmRequests = requests.length;
          await page.evaluate(() => {
            window.replayStarted = performance.now(); window.loaderSeen = false; delete window.replayLatency;
            const sample = () => {
              const layer = document.querySelector('.media-preview');
              if (layer) {
                const style = getComputedStyle(layer.querySelector('.media-preview-loading'));
                if (style.display !== 'none' && Number(style.opacity) > .1) window.loaderSeen = true;
                if (layer.dataset.playing === 'true') { window.replayLatency = performance.now() - window.replayStarted; return; }
              }
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          await page.evaluate(({ image, viewer }) => window.show(image, viewer), { image, viewer });
          if (!viewer) await start();
          await page.waitForFunction(() => window.replayLatency !== undefined);
          assert(await original.evaluate(element => element === document.querySelector('.media-player-surface')), 'A → B → A must reuse the decoded player');
          assert.equal(requests.length, warmRequests, 'returning to a previously played card must not redownload');
          const returned = await page.evaluate(() => ({ ms: Math.round(window.replayLatency), loaderSeen: window.loaderSeen }));
          assert(returned.ms < 300 && !returned.loaderSeen, `returning to a warm clip must not show a loader: ${JSON.stringify(returned)}`);
          await page.waitForFunction(element => !element.isConnected && element.dataset.playerState === 'paused', otherPlayer);
          await page.evaluate(() => window.show(null));
          // The same decoder can move between the card and full-size viewer.
          await page.evaluate(({ image, viewer }) => window.show(image, !viewer), { image, viewer });
          if (viewer) await page.locator('.image-card').dispatchEvent('pixhelf:card-touch');
          await page.locator('.media-preview[data-playing="true"]').waitFor();
          assert(await original.evaluate(element => element === document.querySelector('.media-player-surface')), 'gallery/viewer handoff must reuse the decoded player');
          assert.equal(requests.length, warmRequests, 'gallery/viewer handoff uses the complete cached source');
          await page.evaluate(() => window.show(null));
          console.log(`${path.split('/').at(-1)} ${width}px ${viewer ? 'viewer' : 'card'}: replay ${JSON.stringify(result)}, A → B → A ${JSON.stringify(returned)}, same decoder, zero requests, gallery/viewer handoff passed`);
          await page.evaluate(() => { delete window.replayLatency; });
        }
        const evicted = [];
        for (let i = 0; i < 13; i++) {
          const image = { id: `extra-${i}`, name: 'Extra.jpg', ...metadata, motion: `/extra-${i}.mov` };
          await page.evaluate(image => window.show(image, true), image);
          await page.locator('.media-preview[data-playing="true"]').waitFor({ timeout: 30000 });
          evicted.push(await page.locator('.media-player-surface').elementHandle());
          await page.evaluate(() => window.show(null));
        }
        assert.equal(await evicted[0].evaluate(element => element.dataset.playerState), 'destroyed', 'the decoder cache stays bounded after browsing many clips');
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        for (const player of evicted) assert.equal(await player.evaluate(element => element.dataset.playerState), 'destroyed', 'leaving the page releases cached decoders');
        await page.waitForFunction(async () => {
          const { default: Player } = await import('/assets/libmedia/avplayer.js');
          return Player.Instances.length === 0;
        });
        console.log(`${width}px: bounded decoder cache and page cleanup passed`);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
