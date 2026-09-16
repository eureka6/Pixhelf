import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { engine, launchBrowser, loadSample, serveMotion } from "./live-photo-fixture.mjs";

const [html, js, css, sample] = await Promise.all([
  readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
  readFile(new URL("../dist/assets/app.js", import.meta.url)),
  readFile(new URL("../dist/assets/app.css", import.meta.url)),
  loadSample(),
]);
const video = { duration: 3, codec: "h264", audioCodec: null, frameRate: 30, container: "mov,mp4" };
const images = Array.from({ length: 32 }, (_, i) => ({
  id: `preview-${i}`, name: `sample-${i}.${[0, 2, 3].includes(i) ? "mp4" : "jpg"}`, width: 160, height: 120,
  ...([0, 2, 3].includes(i) ? { video, playback: `/api/images/preview-${i}/video/fixture/playback.mp4` } : {}),
  ...([0, 1, 2, 3].includes(i) ? { preview: `/api/images/preview-${i}/video/fixture/preview.mp4` } : {}),
  ...(i === 1 ? { motion: "/api/images/preview-1/motion/original/fixture" } : {}),
}));
const summary = { total: images.length, revision: "preview-fixture", albums: [] };
const status = { total: images.length, ready: images.length, queued: 0, processing: 0, failed: 0,
  initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: images.length, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true },
};
const pageData = { items: images, total: images.length, offset: 0, limit: 60, nextOffset: null };
const documentHtml = html.replace("__PIXHELF_AUTH__", JSON.stringify({ enabled: false, authenticated: false }))
  .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: pageData }));

async function playing(card) {
  await card.page().waitForFunction(element => {
    const video = element.querySelector(".media-player-surface");
    const layer = element.querySelector(".media-preview");
    return layer?.dataset.playing === "true" && layer.dataset.loading === "false"
      && video instanceof HTMLVideoElement && video.videoWidth > 0 && Number(video.dataset.currentTime) > .05 && video.dataset.playerState === "playing";
  }, await card.elementHandle());
  assert.equal(await card.locator(".media-player-surface").getAttribute("data-muted"), "true");
  assert.equal(await card.locator(".media-preview-viewport").evaluate(layer => getComputedStyle(layer).opacity), "1");
  assert.equal(await card.page().locator(".media-preview .media-player-surface").count(), 1, "only one card preview may own a player");
}

async function released(video) {
  assert.equal(await video.evaluate(v => v.dataset.playerState === "destroyed" && !v.isConnected), true,
    "stopping a video preview must release its decoder and source");
}

const browser = await launchBrowser();
try {
  for (const width of [1440, 390]) {
    const touch = width <= 720;
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch });
    page.setDefaultTimeout(15_000);
    const errors = [], requests = [];
    let held = null, release = () => {};
    page.on("pageerror", error => errors.push(error.message));
    if (process.env.PIXHELF_TEST_DEBUG) page.on("console", message => console.log(message.type(), message.text()));
    await page.route("https://pixhelf.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: documentHtml });
      if (path === "/assets/app.js") return route.fulfill({ contentType: "text/javascript", body: js });
      if (path === "/assets/app.css") return route.fulfill({ contentType: "text/css", body: css });
      if (path === "/api/gallery") return route.fulfill({ json: summary });
      if (path === "/api/status") return route.fulfill({ json: status });
      if (path === "/api/images") return route.fulfill({ json: pageData });
      const image = images.find(image => path === `/api/images/${image.id}` || path.startsWith(`/api/images/${image.id}/`));
      if (image && path === `/api/images/${image.id}`) return route.fulfill({ json: image });
      if (image && path.endsWith("/similar")) return route.fulfill({ json: { ...pageData, items: images.slice(0, 3), total: 3 } });
      if (image && path.endsWith("/details")) return route.fulfill({ json: { fileSize: sample.poster.length, modifiedMs: 0, exif: [], histogram: null, ...(image.video ? { video } : {}) } });
      if (image && path.includes("/video/")) {
        requests.push({ path, type: route.request().resourceType() });
        if (held && image.id === "preview-0") await held;
        if (new URL(route.request().url()).searchParams.has("status")) return route.fulfill({
          status: image.id === "preview-3" ? 422 : 200, json: { state: image.id === "preview-3" ? "failed" : "ready" },
        });
        if (image.id === "preview-3") return route.fulfill({ contentType: "video/mp4", body: "damaged video" });
        return serveMotion(route, sample);
      }
      if (image && (path.endsWith("/thumbnail") || path.endsWith("/original"))) return route.fulfill({ contentType: "image/jpeg", body: sample.poster });
      return route.fulfill({ status: 404, json: {} });
    });
    const card = id => page.locator(`.image-card[data-image-id="preview-${id}"]`);
    const preview = async target => {
      await target.scrollIntoViewIfNeeded();
      await target.locator(".media-preview").waitFor({ state: "attached" });
      if (touch) await target.locator(".photo-card-open").tap();
      else await target.hover();
    };
    const closeVideo = async () => {
      const close = page.locator(".video-viewer").getByRole("button", { name: "关闭查看器", exact: true });
      if (touch) await close.tap();
      else await close.click();
      await page.locator(".video-viewer").waitFor({ state: "detached" });
      await page.waitForFunction(() => !document.getElementById("root").inert);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    try {
      await page.goto("https://pixhelf.test/", { waitUntil: "networkidle" });
      assert.equal(requests.length, 0, "loading the library must not fetch preview videos");
      held = new Promise(resolve => { release = resolve; });
      await preview(card(0));
      await card(0).getByRole("progressbar", { name: "加载视频预览" }).waitFor({ state: "visible" });
      assert.equal(await page.locator(".image-viewer").count(), 0);
      assert.equal(await card(0).locator(".live-photo-badge").count(), 0, "standalone videos keep their video badge");
      if (touch) {
        // A second tap must open even before the preview has buffered a frame.
        await card(0).locator(".photo-card-open").tap();
        await page.locator(".video-viewer").waitFor();
        assert.equal(await page.locator(".media-preview .media-player-surface").count(), 0);
        release(); held = null;
        await page.waitForFunction(() => document.querySelector(".video-viewer")?.dataset.videoState === "ready");
        await closeVideo();
      } else { release(); held = null; await playing(card(0)); }

      await preview(card(1));
      await playing(card(1));
      const livePlayer = await card(1).locator(".media-player-surface").elementHandle();
      await preview(card(0));
      await playing(card(0));
      await released(livePlayer);
      const firstPlayer = await card(0).locator(".media-player-surface").elementHandle();
      await preview(card(2));
      await playing(card(2));
      await released(firstPlayer);
      const secondPlayer = await card(2).locator(".media-player-surface").elementHandle();
      await preview(card(0));
      await playing(card(0));
      await released(secondPlayer);
      await page.screenshot({ path: `/tmp/pixhelf-video-preview-${engine.name()}-${width}.png` });

      if (touch) {
        const ended = await card(0).locator(".media-player-surface").elementHandle();
        // Let the short fixture finish naturally; ending must release the player.
        await card(0).locator(".media-player-surface").waitFor({ state: "detached" });
        await released(ended);
        await card(0).locator(".photo-card-open").tap();
      } else {
        const departed = await card(0).locator(".media-player-surface").elementHandle();
        await page.mouse.move(0, 0);
        await card(0).locator(".media-player-surface").waitFor({ state: "detached" });
        await released(departed);
        await card(0).locator(".photo-card-open").focus();
        await playing(card(0));
        await card(0).click({ button: "right" });
        await page.getByRole("menu").waitFor();
        assert.equal(await page.locator(".media-preview .media-player-surface").count(), 0, "opening the card menu stops preview playback");
        await page.getByRole("menuitem", { name: "播放视频", exact: true }).click();
      }
      await page.locator(".video-viewer").waitFor();
      assert.equal(await page.locator(".media-preview .media-player-surface").count(), 0, "opening the player stops the card preview");
      await closeVideo();
      await preview(card(2));
      await playing(card(2));
      const offscreen = await card(2).locator(".media-player-surface").elementHandle();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction(() => !document.querySelector(".media-preview .media-player-surface"));
      await released(offscreen);

      await preview(card(3));
      await page.waitForFunction(() => document.querySelector('[data-image-id="preview-3"] .video-preview')?.dataset.failed === "true");
      assert.equal(await card(3).locator("img.loaded").count(), 1, "unsupported media retains the poster");
      if (touch) await card(3).locator(".photo-card-open").tap();
      else await card(3).locator(".photo-card-open").click();
      await page.locator(".video-viewer [role=alert]").waitFor();
      assert.equal(await page.locator(".video-viewer [role=alert] a").getAttribute("download"), images[3].name);
      await closeVideo();

      // The same preview interaction must also work inside similar results.
      if (touch) await card(4).locator(".photo-card-open").tap();
      else await card(4).locator(".photo-card-open").click();
      await page.locator('.image-viewer[data-full-loaded="true"]').waitFor();
      const showSimilar = page.locator(".viewer-header").getByRole("button", { name: "相似图片", exact: true });
      if (touch) await showSimilar.tap();
      else await showSimilar.click();
      // Preview another item first: the last played video's next tap opens it,
      // including when that same item reappears in the similar results.
      const similarLive = page.locator('.viewer-similar-card[data-image-id="preview-1"]');
      await preview(similarLive);
      await playing(similarLive);
      const similar = page.locator('.viewer-similar-card[data-image-id="preview-2"]');
      await preview(similar);
      await playing(similar);
      if (touch) await similar.locator(".photo-card-open").tap();
      else await similar.locator(".photo-card-open").click();
      await page.locator('.video-viewer[data-image-id="preview-2"]').waitFor();
      assert.equal(await page.locator(".media-preview .media-player-surface").count(), 0);

      // Prepared live photos also autoplay and replay in the full image viewer.
      await closeVideo();
      await preview(card(1));
      await playing(card(1));
      if (touch) await card(1).locator(".photo-card-open").tap();
      else await card(1).locator(".photo-card-open").click();
      const liveViewer = page.locator('.image-viewer[data-image-id="preview-1"] .viewer-media');
      await liveViewer.waitFor();
      await playing(liveViewer);
      await liveViewer.locator(".media-player-surface").waitFor({ state: "detached" });
      if (touch) await liveViewer.tap();
      else await liveViewer.click();
      await playing(liveViewer);
      assert.deepEqual(errors, []);
      assert.equal(requests.some(r => r.type === "image"), false, "original videos must never use the image loader");
      console.log(`${engine.name()}: ${width}px video hover/touch, live-photo handoff, cleanup, similar results and fallback passed`);
    } catch (error) {
      console.error(await page.evaluate(() => ({
        viewer: document.querySelector(".image-viewer")?.getAttribute("data-image-id"),
        previews: [...document.querySelectorAll(".media-preview")].map(layer => ({
          id: layer.parentElement.dataset.imageId, ...layer.dataset,
          player: { ...layer.querySelector(".media-player-surface")?.dataset },
        })),
      })));
      await page.screenshot({ path: `/tmp/pixhelf-video-preview-failure-${engine.name()}-${width}.png` });
      throw error;
    } finally { release(); await page.close(); }
  }
} finally { await browser.close(); }
