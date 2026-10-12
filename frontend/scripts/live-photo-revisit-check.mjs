// Revisit actual MOV bytes, including before playback finishes. Browser routing
// disables HTTP caching, so zero requests requires the application's cache.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { launchBrowser, serveLibmediaAsset, serveMotion } from "./live-photo-fixture.mjs";

const paths = process.argv.slice(2).filter(path => !path.startsWith("--"));
const clips = paths.length ? paths : ["live-photo.mp4", "live-photo-hevc.mov"].map(name => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)));
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx", contents: `
  import { render } from "preact";
  import { MediaPreview, stopMediaPreview } from "./src/MediaPreview";
  window.stopPreview = stopMediaPreview;
  window.show = (image, viewer = true) => render(image ? <div className={viewer ? "viewer-media" : "image-card"}
    style={{ position: "relative", width: 300, height: 300 }}><MediaPreview key={image.id} image={image} autoPlay={viewer} /></div> : null, document.getElementById("root"));
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
      await page.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true } }));
      await page.route("https://pixhelf.test/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/") return route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>' });
        if (path.startsWith("/assets/libmedia/")) return serveLibmediaAsset(route);
        if (path.endsWith(".mov")) {
          requests.push({ path, method: route.request().method() });
          return serveMotion(route, { clip, contentType: "video/quicktime" });
        }
        return route.fulfill({ json: { enabled: false, authenticated: false } });
      });
      try {
        await page.goto("https://pixhelf.test/");
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ type: "module", content: bundle.outputFiles[0].text });
        await page.waitForFunction(() => typeof window.show === "function");

        async function show(image, viewer = true) {
          await page.evaluate(({ image, viewer }) => {
            delete window.firstFrameMs;
            window.loaderSeen = false;
            const start = performance.now();
            window.show(image, viewer);
            if (!viewer) document.querySelector(".image-card").dispatchEvent(new CustomEvent("pixhelf:card-touch"));
            const sample = () => {
              const layer = document.querySelector(".media-preview");
              const bar = layer?.querySelector(".media-preview-loading");
              if (bar) {
                const style = getComputedStyle(bar);
                if (style.display !== "none" && Number(style.opacity) > .1) window.loaderSeen = true;
              }
              if (layer?.dataset.playing === "true") window.firstFrameMs = performance.now() - start;
              else requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          }, { image, viewer });
          await page.waitForFunction(() => window.firstFrameMs !== undefined, null, { timeout: 30000 }).catch(async error => {
            console.error("Playback failed", basename(path), width, image.id, await page.evaluate(() => ({
              layer: { ...document.querySelector(".media-preview")?.dataset },
              player: { ...document.querySelector(".media-player-surface")?.dataset },
            })), errors);
            throw error;
          });
          return page.evaluate(() => ({ ms: Math.round(window.firstFrameMs), loaderSeen: window.loaderSeen }));
        }
        const surface = () => page.locator(".media-player-surface");
        const position = () => surface().evaluate(player => Number(player.dataset.currentTime));
        async function warm(image, viewer, original, before, label, maxMs = 300) {
          const result = await show(image, viewer);
          assert(await original.evaluate(player => player === document.querySelector(".media-player-surface")), `${label}: reuse the decoder`);
          assert.equal(requests.length, before, `${label}: no new HEAD or GET`);
          assert(result.ms < maxMs && !result.loaderSeen, `${label}: no repeat loader (${JSON.stringify(result)})`);
          return result;
        }
        const image = { id: "first", name: "Live.heic", ...metadata, motion: "/first.mov" };
        await show(image, false);
        const original = await surface().elementHandle();
        await page.waitForFunction(player => Number(player.dataset.currentTime) > .05, original);
        const at = await position(), before = requests.length;

        // Do not wait for an end event or a background rewind before reopening.
        // The previous tests hid this delay by waiting for the seek to finish.
        await page.evaluate(() => window.stopPreview());
        const handoff = await warm(image, true, original, before, "card to viewer during playback");
        assert(await position() >= at - .06, "handoff continues from the decoded position instead of seeking to zero");
        await page.evaluate(() => window.show(null));
        const immediate = await warm(image, true, original, before, "immediate close and reopen");
        await page.evaluate(() => window.show(null));
        await page.waitForFunction(player => player.dataset.playerState === "paused", original);
        const pausedAt = await original.evaluate(player => Number(player.dataset.currentTime));

        // A six-photo album used to evict the first decoder despite cached MOV
        // bytes, forcing several seconds of HEVC startup on every second lap.
        const retained = [original];
        for (let i = 1; i < 6; i++) {
          await show({ ...image, id: `other-${i}`, motion: `/other-${i}.mov` });
          retained.push(await surface().elementHandle());
          await page.evaluate(() => window.show(null));
        }
        assert(Math.abs(await original.evaluate(player => Number(player.dataset.currentTime)) - pausedAt) < .06,
          "cached players must remain paused while viewing other photos");
        const afterOthers = requests.length;
        const returned = await warm(image, true, original, afterOthers, "return after six photos");

        // A playing flag must also correspond to moving, visible pixels. This
        // catches a resumed native canvas that never notifies its new owner.
        const capture = () => page.locator(".media-preview-viewport").screenshot();
        const firstPicture = await capture(), resumedAt = await position();
        await page.waitForFunction(({ player, time }) => Number(player.dataset.currentTime) > time + .2,
          { player: original, time: resumedAt });
        assert.notDeepEqual(await capture(), firstPicture, "warm playback must advance the visible picture");
        await page.locator('.media-preview[data-playback-state="ended"]').waitFor({ timeout: 20000 });
        // Reopen immediately, while the decoder may still be rewinding. Do
        // not wait for "paused", which would conceal this user-visible delay.
        await page.evaluate(() => window.show(null));
        const endedReplay = await warm(image, true, original, afterOthers, "immediate replay after ending", 1000);
        assert(await position() < .8, "completed clips still replay from the beginning");
        assert.equal(requests.length, afterOthers, "completed replay also uses cached bytes");

        if (path === clips[0] && width === 390) {
          await page.evaluate(() => window.show(null));
          await page.waitForFunction(player => player.dataset.playerState === "paused", original);
          await page.evaluate(async surface => {
            const video = surface.querySelector("video");
            const { default: Player } = await import("/assets/libmedia/avplayer.js");
            const player = video ?? Player.Instances.find(player => player.getOptions().container === surface);
            const play = player.play;
            player.play = () => new Promise((resolve, reject) => {
              window.releaseStall = () => { player.play = play; play.call(player).then(resolve, reject); };
            });
          }, original);
          const stalled = show(image);
          void stalled.catch(() => {});
          await page.waitForFunction(() => window.releaseStall !== undefined);
          await page.waitForFunction(() => {
            const bar = document.querySelector(".media-preview-loading");
            return getComputedStyle(bar).display !== "none" && Number(getComputedStyle(bar).opacity) > .5;
          });
          await page.evaluate(() => window.releaseStall());
          const result = await stalled;
          assert(result.loaderSeen && result.ms >= 1000, "a stalled warm decoder must still show loading feedback");
          assert.equal(requests.length, afterOthers);
        }

        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        for (const player of retained) assert.equal(await player.evaluate(player => player.dataset.playerState), "destroyed", "page exit releases every decoder");
        await page.waitForFunction(async () => {
          const { default: Player } = await import("/assets/libmedia/avplayer.js");
          return Player.Instances.length === 0;
        });
        assert.deepEqual(errors, []);
        console.log(`${basename(path)} ${width}px: handoff ${JSON.stringify(handoff)}, reopen ${JSON.stringify(immediate)}, six-photo return ${JSON.stringify(returned)}, immediate ended replay ${JSON.stringify(endedReplay)}; moving pixels, zero repeat requests and cleanup passed`);
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
