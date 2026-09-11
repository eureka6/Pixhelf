// Exercise the production app with browser routes only: no HTTP listener or
// backend process. Build the frontend before running this check.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { engine, isChromium, launchBrowser, loadSample, serveMotion, imageDimensions } from "./live-photo-fixture.mjs";

const [html, js, css, filler, sample] = await Promise.all([
  readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
  readFile(new URL("../dist/assets/app.js", import.meta.url)),
  readFile(new URL("../dist/assets/app.css", import.meta.url)),
  readFile(new URL("fixtures/live-photo.jpg", import.meta.url)),
  loadSample(),
]);
const { name: sampleName, poster } = sample;
const blackNativeSurface = process.env.PIXHELF_TEST_NATIVE_VIDEO_BLACK === "1";
const browser = await launchBrowser();
const probe = await browser.newPage();
let dimensions;
try {
  dimensions = await imageDimensions(probe, poster);
} finally { await probe.close(); }
const images = Array.from({ length: 32 }, (_, i) => {
  const live = i === 0 || i === 26 || i === 27;
  return { id: `photo-${i}`, name: live ? `${sampleName}.jpg` : `image-${i}.jpg`,
    ...(live ? dimensions : { width: 160, height: 120 }),
    ...(live ? { motion: `/api/images/photo-${i}/motion/original/fixture` } : {}),
  };
});
const summary = { total: images.length, revision: "offline", albums: ["Live", "Live/Apple", "Live/Samsung"].map(path => ({
  path, name: path.split("/").at(-1), count: images.length, cover: "photo-0",
})) };
const status = { total: images.length, ready: images.length, queued: 0, processing: 0, failed: 0,
  initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: images.length, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true },
};
const pageData = { items: images, total: images.length, offset: 0, limit: 60, nextOffset: null };
const documentHtml = html.replace("__PIXHELF_AUTH__", JSON.stringify({ enabled: false, authenticated: false }))
  .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: pageData }));

async function state(page) {
  return page.evaluate(() => ({
    events: window.mediaEvents.slice(-24), inputs: window.inputEvents.slice(-16), scroll: scrollY,
    layers: [...document.querySelectorAll(".live-photo")].map(layer => {
      const video = layer.querySelector("video");
      return {
        parent: layer.parentElement.className, playing: layer.dataset.playing, loading: layer.dataset.loading, failed: layer.dataset.failed,
        rect: layer.getBoundingClientRect().toJSON(), inert: !!layer.closest("[inert]"),
        video: video && {
          paused: video.paused, time: video.currentTime, width: video.videoWidth,
          ready: video.readyState, network: video.networkState, src: video.currentSrc,
          buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
        },
      };
    }),
  }));
}

async function playing(card) {
  await card.page().waitForFunction(element => {
    const video = element.querySelector("video");
    return element.querySelector(".live-photo")?.dataset.playing === "true"
      && element.querySelector(".live-photo")?.dataset.loading === "false"
      && video?.videoWidth > 0 && video.currentTime > 0 && !video.paused;
  }, await card.elementHandle(), { timeout: 12_000 });
}

async function finished(card) {
  const video = await card.locator("video").elementHandle();
  assert.equal(await video.evaluate(video => video.loop), false, "live photos must not loop");
  await card.page().waitForFunction(video => window.endedVideos.has(video), video, { timeout: 10_000 });
  // The pause handler must not turn a natural ending into another play request.
  await card.page().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await video.evaluate(video => video.paused), true);
  assert.equal(await card.locator(".live-photo").getAttribute("data-playing"), "false");
}

async function visiblePicture(card, verifyMotion = false) {
  const rect = await card.boundingBox();
  assert.ok(rect && rect.width > 80 && rect.height > 80);
  const capture = async () => {
    const png = await card.page().screenshot({ clip: {
      x: rect.x + rect.width * 0.15, y: rect.y + rect.height * 0.15,
      width: rect.width * 0.7, height: rect.height * 0.7,
    } });
    // Inspect the rendered screenshot, not drawImage(video), which can succeed
    // even when a compositor surface fails to paint after a DOM move.
    return card.page().evaluate(async base64 => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 24;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, 24, 24);
      const pixels = context.getImageData(0, 0, 24, 24).data;
      return [...pixels].filter((_, i) => i % 4 !== 3);
    }, png.toString("base64"));
  };
  const pixels = await capture();
  const brightness = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  assert.ok(brightness > 25, `the visible photo is black (brightness ${brightness})`);
  if (verifyMotion) {
    let changed = false;
    for (let attempt = 0; attempt < 3 && !changed; attempt++) {
      const before = await card.locator("video").evaluate(video => video.currentTime);
      await card.page().waitForFunction(({ element, before }) => {
        const video = element.querySelector("video");
        return video.currentTime < before || video.currentTime - before > 0.4;
      }, { element: await card.elementHandle(), before });
      const next = await capture();
      changed = next.reduce((sum, value, i) => sum + Math.abs(value - pixels[i]), 0) / pixels.length > 0.2;
    }
    assert.ok(changed, "the video clock advanced but the visible photo stayed still");
  }
}

try {
  for (const width of process.env.PIXHELF_TEST_WIDTH ? [Number(process.env.PIXHELF_TEST_WIDTH)] : [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width <= 720, hasTouch: width <= 720 });
    const errors = [];
    const motionRequests = [];
    let holdMotion = null;
    let releaseMotion = () => {};
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.mediaEvents = [];
      window.inputEvents = [];
      for (const type of ["touchstart", "touchend", "pointerdown", "mousedown", "click"]) {
        document.addEventListener(type, event => window.inputEvents.push({ type, detail: event.detail,
          pointerType: event.pointerType, target: event.target.className }), true);
      }
      window.endedVideos = new WeakSet();
      for (const event of ["loadstart", "loadeddata", "playing", "pause", "ended", "error", "emptied", "resize", "seeking", "seeked", "waiting", "timeupdate"]) {
        document.addEventListener(event, e => {
          if (!(e.target instanceof HTMLVideoElement)) return;
          const video = e.target;
          if (event === "ended") window.endedVideos.add(video);
          if (event === "playing") window.endedVideos.delete(video);
          window.mediaEvents.push({ event, parent: video.closest(".viewer-media") ? "viewer" : "gallery",
            paused: video.paused, time: video.currentTime, width: video.videoWidth, ready: video.readyState,
            seeking: video.seeking, loading: video.closest(".live-photo")?.dataset.loading,
            shown: video.closest(".live-photo")?.dataset.playing,
            error: video.error?.message });
        }, true);
      }
    });
    await page.route("https://pixhelf.test/**", async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: documentHtml });
      if (path === "/assets/app.js") return route.fulfill({ contentType: "text/javascript", body: js });
      if (path === "/assets/app.css") return route.fulfill({ contentType: "text/css", body: css });
      if (path === "/api/gallery") return route.fulfill({ json: summary });
      if (path === "/api/status") return route.fulfill({ json: status });
      if (path === "/api/images") return route.fulfill({ json: pageData });
      const image = images.find(image => path.startsWith(`/api/images/${image.id}/`) || path === `/api/images/${image.id}`);
      if (image && path.endsWith(`/${image.id}`)) return route.fulfill({ json: image });
      if (image && ["thumbnail", "original"].some(kind => path === `/api/images/${image.id}/${kind}`)) return route.fulfill({ contentType: "image/jpeg", body: image.motion ? poster : filler });
      if (image && path.endsWith("/similar")) return route.fulfill({ json: { ...pageData, items: [], total: 0 } });
      if (image && path.endsWith("/details")) return route.fulfill({ json: { fileSize: poster.length, modifiedMs: 0, exif: [],
        histogram: Object.fromEntries(["red", "green", "blue", "luminance"].map(key => [key, Array(256).fill(0)])),
      } });
      if (image && path.endsWith("/motion/original/fixture")) {
        const request = { path, range: route.request().headers().range, fulfilled: false };
        motionRequests.push(request);
        if (holdMotion) await holdMotion;
        await serveMotion(route, sample);
        request.fulfilled = true;
        return;
      }
      errors.push(`unhandled request: ${url.pathname}`);
      return route.fulfill({ status: 404, json: {} });
    });
    try {
      await page.goto("https://pixhelf.test/", { waitUntil: "networkidle" });
      if (blackNativeSurface) {
        // Fault injection: decoding continues, but the native video surface
        // paints black. CSS does not affect drawImage(video) frame pixels.
        await page.addStyleTag({ content: ".viewer-media .live-photo-video { filter: brightness(0) !important; }" });
      }
      for (const index of [0, 26]) {
        const card = page.locator(`.image-card[data-image-id="photo-${index}"]`);
        await card.scrollIntoViewIfNeeded();
        await page.waitForFunction(element => element.dataset.loaded === "true", await card.elementHandle());
        if (index === 0) holdMotion = new Promise(resolve => { releaseMotion = resolve; });
        if (width > 720) await card.hover();
        else await card.locator(".photo-card-open").tap();
        assert.equal(await page.locator(".image-viewer").count(), 0, "the first tap must play in the gallery");
        if (holdMotion) {
          await card.locator(".live-photo-loading").waitFor({ state: "visible" });
          assert.equal(await card.locator(".live-photo").getAttribute("data-playing"), "false");
          await card.screenshot({ path: `/tmp/pixhelf-live-loading-card-${sampleName}-${engine.name()}-${width}.png` });
          if (width <= 720) {
            await card.locator(".photo-card-open").tap();
            const loadingViewer = page.locator(".viewer-media:not(.viewer-swipe-outgoing)");
            await loadingViewer.waitFor();
            await loadingViewer.locator(".live-photo-loading").waitFor({ state: "visible" });
            assert.equal(await loadingViewer.getAttribute("data-image-id"), `photo-${index}`, "a second tap while loading must open the viewer");
            releaseMotion();
            holdMotion = null;
            await playing(loadingViewer);
            await visiblePicture(loadingViewer, true);
            await page.locator(".viewer-close").click();
            await page.locator(".image-viewer").waitFor({ state: "detached" });
            await page.locator(".viewer-return-layer").waitFor({ state: "detached" });
            // Playing another photo resets A's next tap to preview, even when
            // that other photo has already finished before returning to A.
            const other = page.locator('.image-card[data-image-id="photo-27"]');
            await other.scrollIntoViewIfNeeded();
            await page.waitForFunction(element => element.dataset.loaded === "true", await other.elementHandle());
            await other.locator(".photo-card-open").tap();
            await playing(other);
            await finished(other);
            await card.locator(".photo-card-open").tap();
          } else {
            releaseMotion();
            holdMotion = null;
          }
        }
        await playing(card);
        assert.equal(await card.locator(".live-photo").getAttribute("data-loading"), "false");
        assert.equal(await page.locator(".image-viewer").count(), 0, "the first mobile tap should only play the live photo");
        await visiblePicture(card);
        if (index === 0) {
          const galleryPlayer = await card.locator("video").elementHandle();
          const galleryDimensions = await galleryPlayer.evaluate(video => [video.videoWidth, video.videoHeight]);
          await finished(card);
          if (width > 720) {
            const beforeReplay = motionRequests.length;
            await page.mouse.move(0, 0);
            await card.hover();
            await playing(card);
            await visiblePicture(card, true);
            await card.screenshot({ path: `/tmp/pixhelf-live-replay-card-${sampleName}-${engine.name()}-${width}.png` });
            assert.deepEqual(await card.locator("video").evaluate(video => [video.videoWidth, video.videoHeight]), galleryDimensions, "replay must retain the original orientation");
            if (isChromium) {
              assert.equal(await card.locator("video").evaluate((video, previous) => video === previous, galleryPlayer), true, "replay should keep the current photo's player");
              assert.equal(motionRequests.length, beforeReplay, "gallery replay should not request the original clip again");
            }
            assert.equal(await page.locator(".image-viewer").count(), 0, "hovering again should replay a completed gallery clip");
          }
        }
        if (index === 0) holdMotion = new Promise(resolve => { releaseMotion = resolve; });
        if (width > 720) await card.locator(".photo-card-open").click();
        else await card.locator(".photo-card-open").tap();
        const viewer = page.locator(".viewer-media:not(.viewer-swipe-outgoing)");
        await viewer.waitFor();
        assert.equal(await viewer.getAttribute("data-image-id"), `photo-${index}`, "the most recently played photo must open on the next tap, including after playback ends");
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".image-viewer")).opacity === "1");
        if (holdMotion) {
          assert.equal(await viewer.locator(".live-photo").getAttribute("data-playing"), "false");
          await viewer.locator(".live-photo-loading").waitFor({ state: "visible" });
          await visiblePicture(viewer);
          await page.screenshot({ path: `/tmp/pixhelf-live-loading-viewer-${sampleName}-${engine.name()}-${width}.png` });
          releaseMotion();
          holdMotion = null;
        }
        await playing(viewer);
        assert.equal(await viewer.locator(".live-photo").getAttribute("data-loading"), "false");
        await visiblePicture(viewer, true);
        await page.screenshot({ path: `/tmp/pixhelf-live-app-${sampleName}-${engine.name()}-${width}-${index}.png` });
        if (index === 0) {
          const viewerPlayer = await viewer.locator("video").elementHandle();
          const viewerDimensions = await viewerPlayer.evaluate(video => [video.videoWidth, video.videoHeight]);
          await finished(viewer);
          const beforeReplay = motionRequests.length;
          await page.mouse.move(0, 0);
          await viewer.hover();
          await viewer.dispatchEvent("pixhelf:card-touch");
          // Re-entering the viewport after completion must not auto-replay.
          for (const display of ["none", ""]) {
            await viewer.evaluate(async (media, display) => {
              media.style.display = display;
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }, display);
          }
          assert.equal(await viewer.locator(".live-photo").getAttribute("data-playing"), "false", "hover, contact and visibility must not replay a completed viewer clip");
          if (width > 720) {
            const rect = await viewer.boundingBox();
            const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + 25, y, { steps: 2 });
            await page.mouse.move(x, y, { steps: 2 });
            await page.mouse.up();
            assert.equal(await viewer.locator(".live-photo").getAttribute("data-playing"), "false", "a drag returning to its starting point is not a replay tap");
            await viewer.click();
          } else await viewer.tap();
          await playing(viewer);
          await visiblePicture(viewer, true);
          assert.deepEqual(await viewer.locator("video").evaluate(video => [video.videoWidth, video.videoHeight]), viewerDimensions);
          await page.screenshot({ path: `/tmp/pixhelf-live-replay-viewer-${sampleName}-${engine.name()}-${width}.png` });
          await finished(viewer);
          if (isChromium) {
            assert.equal(await viewer.locator("video").evaluate((video, previous) => video === previous, viewerPlayer), true);
            assert.equal(motionRequests.length, beforeReplay, "viewer replay should not request the original clip again");
          }
        }
        if (index === 26) {
          for (const direction of ["next", "previous"]) {
            const previousId = await viewer.getAttribute("data-image-id");
            const control = page.locator(`.viewer-${direction}`);
            if (width > 720) await control.click();
            else if (isChromium) {
              const client = await page.context().newCDPSession(page);
              const rect = await viewer.boundingBox();
              const point = { id: 1, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
              await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, x: point.x + (direction === "next" ? -120 : 120) }] });
              await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              await client.detach();
            } else await page.keyboard.press(direction === "next" ? "ArrowRight" : "ArrowLeft");
            await page.waitForFunction(id => document.querySelector(".viewer-media:not(.viewer-swipe-outgoing)")?.dataset.imageId !== id, previousId);
            await playing(viewer);
            await page.waitForFunction(() => !document.querySelector(".image-viewer").hasAttribute("data-swipe-direction"));
            await visiblePicture(viewer, true);
            assert.equal(await page.locator("video").count(), 1);
          }
        }
        await page.locator(".viewer-close").click();
        await page.locator(".image-viewer").waitFor({ state: "detached" });
        await page.locator(".viewer-return-layer").waitFor({ state: "detached" });
      }
      if (width <= 720) {
        const still = page.locator('.image-card[data-image-id="photo-1"]');
        await still.locator(".photo-card-open").tap();
        await page.locator('.viewer-media[data-image-id="photo-1"]').waitFor();
        await page.locator(".viewer-close").click();
        await page.locator(".image-viewer").waitFor({ state: "detached" });
      }
      await page.goto("https://pixhelf.test/?view=albums&album=Live", { waitUntil: "networkidle" });
      await page.locator(".album-folder").first().waitFor();
      await page.screenshot({ path: `/tmp/pixhelf-album-folders-${engine.name()}-${width}.png` });
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}: ${sampleName}, ${width}px app checks passed${blackNativeSurface ? " (canvas fallback)" : ""}`);
    } catch (error) {
      console.error(JSON.stringify({ motionRequests }, null, 2));
      console.error(JSON.stringify(await state(page), null, 2));
      await page.screenshot({ path: `/tmp/pixhelf-live-app-failure-${sampleName}-${engine.name()}-${width}.png` });
      throw error;
    } finally { releaseMotion(); await page.close(); }
  }
} finally { await browser.close(); }
