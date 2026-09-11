// Component regression checks: all content is supplied in memory, with no HTTP
// listener, backend process, real gallery, or generated playback files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { engine, launchBrowser, loadSample, serveMotion, imageDimensions } from "./live-photo-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sample = await loadSample();
const { poster } = sample;
const fixture = await build({
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import { render } from "preact";
    import { useRef, useState } from "preact/hooks";
    import { LivePhoto, stopLivePhotoPlayback } from "./src/LivePhoto";
    import { ImageViewer } from "./src/ImageViewer";
    import { useCardInteraction } from "./src/cardInteraction";
    const images = ["one", "two"].map(id => ({ id, name: id + ".jpg", ...window.fixtureDimensions, motion: "/motion/" + id }));
    function Fixture() {
      const [open, setOpen] = useState(null);
      const gallery = useRef(null), viewer = useRef(null);
      useCardInteraction(gallery);
      useCardInteraction(viewer, open !== null);
      return <>
        <div ref={gallery} className="gallery" inert={open !== null}>
          {images.map(image => <div key={image.id} className="image-card" data-loaded="true" data-image-id={image.id}>
            <img src="/poster.jpg" />
            <LivePhoto image={image} />
            <button className="photo-card-open" onClick={() => { stopLivePhotoPlayback(); setOpen(image); }}>open</button>
          </div>)}
        </div>
        {open && (window.fixtureRealViewer ? <ImageViewer images={images} activeIndex={images.indexOf(open)}
          hasMore={false} loadingMore={false} onNavigate={direction => setOpen(images[images.indexOf(open) + direction])}
          onClose={() => setOpen(null)} similarActive={false} similarImages={[]} similarTotal={0}
          similarHasMore={false} similarLoading={false} similarLoadingMore={false} similarError={null}
          onSearchSimilar={() => {}} onLoadMoreSimilar={() => {}} onOpenImage={setOpen} /> : <div ref={viewer} className="fixture-viewer">
          <button className="close" onClick={() => setOpen(null)}>close</button>
          <div className="viewer-media" data-image-id={open.id}><img src="/poster.jpg" /><LivePhoto image={open} autoPlay /></div>
        </div>)}
      </>;
    }
    render(<Fixture />, document.getElementById("root"));
  ` },
  bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: "preact",
});
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const browser = await launchBrowser();
const errors = [];

async function pageFixture(options = {}) {
  const { realViewer = false, transientVisibility = false, ...contextOptions } = options;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...contextOptions });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://pixhelf.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script id="pixhelf-auth" type="application/json">{"enabled":false,"authenticated":false}</script>' });
    if (url.pathname.endsWith("/details")) return route.fulfill({ status: 404, json: {} });
    if (!url.pathname.startsWith("/motion/")) return route.fulfill({ contentType: "image/jpeg", body: poster });
    return serveMotion(route, sample);
  });
  await page.goto("https://pixhelf.test/", { waitUntil: "domcontentloaded" });
  await page.evaluate(dimensions => { window.fixtureDimensions = dimensions; }, await imageDimensions(page, poster));
  await page.addStyleTag({ content: css + `
    body { margin: 0; min-height: 1800px; }
    .gallery { display: flex; gap: 12px; padding: 24px; }
    .image-card { width: 160px; height: 120px; position: relative; }
    .image-card img, .viewer-media img { width: 100%; height: 100%; object-fit: cover; }
    .photo-card-open { position: absolute; inset: 0; opacity: 0; z-index: 3; }
    .fixture-viewer { position: fixed; inset: 0; background: white; padding: 50px 20px; }
    .fixture-viewer .viewer-media { position: relative; width: 320px; height: 240px; }
  ` });
  await page.evaluate(value => { window.fixtureRealViewer = value; }, realViewer);
  if (transientVisibility) await page.evaluate(() => {
    const NativeObserver = IntersectionObserver;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) { super(callback, options); this.notify = callback; }
      observe(target) {
        super.observe(target);
        if (target.matches(".viewer-media")) queueMicrotask(() => this.notify([{ target, isIntersecting: false }], this));
      }
    };
  });
  await page.evaluate(() => {
    window.metrics = { sources: [], resets: 0, plays: 0, loadStarts: 0 };
    document.addEventListener("loadstart", event => {
      if (event.target instanceof HTMLVideoElement) window.metrics.loadStarts++;
    }, true);
    const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    Object.defineProperty(HTMLMediaElement.prototype, "src", { ...source, set(value) {
      window.metrics.sources.push(value); source.set.call(this, value);
    } });
    const load = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function () { window.metrics.resets++; return load.call(this); };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.metrics.plays++;
      if (window.rejectNextPlay) {
        window.rejectNextPlay = false;
        return Promise.reject(new DOMException("gesture required", "NotAllowedError"));
      }
      if (window.abortNextPlay) {
        window.abortNextPlay = false;
        return Promise.reject(new DOMException("player moved", "AbortError"));
      }
      return play.call(this);
    };
  });
  await page.addScriptTag({ content: fixture.outputFiles[0].text });
  return page;
}

async function playing(card) {
  await card.page().waitForFunction(element => {
    const video = element.querySelector("video");
    return element.querySelector(".live-photo")?.dataset.playing === "true"
      && video?.videoWidth > 0 && video.currentTime > 0 && !video.paused;
  }, await card.elementHandle());
  const brightness = await card.locator("video").evaluate(video => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 24;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, 24, 24);
    const pixels = context.getImageData(0, 0, 24, 24).data;
    return pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0) / (24 * 24 * 3);
  });
  assert.ok(brightness > 10, "the video clock advanced without decoded picture pixels");
}

async function finished(card) {
  await card.locator("video").evaluate(video => new Promise(resolve => {
    if (video.ended) resolve();
    else video.addEventListener("ended", () => resolve(), { once: true });
  }));
  assert.equal(await card.locator(".live-photo").getAttribute("data-playing"), "false");
}

try {
  for (const width of [1440, 390]) {
    const real = await pageFixture({ realViewer: true, transientVisibility: width <= 720, viewport: { width, height: 844 }, isMobile: width <= 720, hasTouch: width <= 720 });
    const card = real.locator('.image-card[data-image-id="one"]');
    if (width > 720) await card.hover();
    else await card.dispatchEvent("pixhelf:card-touch");
    await playing(card);
    if (width > 720) await real.evaluate(() => { window.abortNextPlay = true; });
    await card.locator(".photo-card-open").click();
    const viewer = real.locator(".viewer-media:not(.viewer-swipe-outgoing)");
    try { await playing(viewer); }
    catch (error) {
      console.error(await real.evaluate(() => ({ metrics, layers: [...document.querySelectorAll('.live-photo')].map(layer => ({
        card: layer.parentElement.className, playing: layer.dataset.playing, failed: layer.dataset.failed,
        inert: !!layer.closest('[inert]'), connected: layer.isConnected, rect: layer.getBoundingClientRect().toJSON(),
        video: layer.querySelector('video') && { paused: layer.querySelector('video').paused, time: layer.querySelector('video').currentTime, source: layer.querySelector('video').currentSrc }
      })) })));
      throw error;
    }
    await viewer.locator("video").evaluate(video => video.pause());
    await playing(viewer);
    await viewer.locator("video").evaluate(video => {
      Object.defineProperty(video, "videoWidth", { configurable: true, value: 0 });
      Object.defineProperty(video, "videoHeight", { configurable: true, value: 0 });
      video.dispatchEvent(new Event("loadeddata"));
    });
    assert.equal(await viewer.locator(".live-photo").getAttribute("data-failed"), null, "temporary decoder dimensions must not permanently disable playback");
    await viewer.locator("video").evaluate(video => {
      delete video.videoWidth;
      delete video.videoHeight;
      video.dispatchEvent(new Event("resize"));
    });
    await playing(viewer);
    await real.locator(".viewer-close").click();
    await real.close();
  }
  const page = await pageFixture();
  const first = page.locator('.image-card[data-image-id="one"]');
  const second = page.locator('.image-card[data-image-id="two"]');
  assert.equal(await page.locator("video").count(), 0, "idle cards must not create or load video elements");
  await first.hover();
  await playing(first);
  const before = await page.evaluate(() => {
    window.originalPlayer = document.querySelector("video");
    return { resets: metrics.resets, sources: metrics.sources.length, loadStarts: metrics.loadStarts };
  });
  await page.mouse.move(380, 400);
  assert.equal(await first.locator("video").evaluate(video => video.paused), true);
  const immediate = await first.evaluate(card => {
    card.dispatchEvent(new Event("pixhelf:card-touch"));
    return card.querySelector(".live-photo").dataset.playing;
  });
  assert.equal(immediate, "true", "a decoded clip should reveal in the touch handler without a timer");
  assert.deepEqual(await page.evaluate(() => ({ resets: metrics.resets, sources: metrics.sources.length, loadStarts: metrics.loadStarts })), before);
  await first.locator(".photo-card-open").click();
  const viewer = page.locator(".viewer-media");
  await playing(viewer);
  assert.equal(await page.evaluate(() => window.originalPlayer.paused && !window.originalPlayer.hasAttribute("src")), true,
    "opening the viewer must release the gallery decoder");
  assert.equal(await page.locator("video").count(), 1);
  await page.locator(".close").click();
  await second.hover();
  await playing(second);
  assert.equal(await page.locator("video").count(), 1);
  await first.dispatchEvent("pointerleave", { pointerType: "mouse" });
  await playing(second);
  await second.dispatchEvent("pixhelf:card-menu");
  assert.equal(await page.locator("video[src]").count(), 0, "menus should release the active decoder");

  const mobile = await pageFixture({ isMobile: true, hasTouch: true });
  const card = mobile.locator('.image-card[data-image-id="one"]');
  await card.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 });
  assert.equal(await card.getAttribute("data-card-active"), "true");
  assert.equal(await mobile.locator("video").count(), 0, "raw contact should show feedback without starting playback");
  await card.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 });
  await mobile.evaluate(() => { window.rejectNextPlay = true; });
  await card.locator(".photo-card-open").tap();
  assert.equal(await mobile.locator(".viewer-media").count(), 0);
  assert.equal(await card.locator(".live-photo").getAttribute("data-loading"), "false", "gesture denial should not leave a loading indicator running");
  const playsBeforeRetry = await mobile.evaluate(() => metrics.plays);
  await card.locator(".photo-card-open").tap();
  assert.ok(await mobile.evaluate(() => metrics.plays) > playsBeforeRetry, "a later tap must retry a denied play request");
  assert.equal(await mobile.locator(".viewer-media").count(), 0);
  await playing(card);
  const loading = await card.evaluate(card => {
    const video = card.querySelector("video"), layer = card.querySelector(".live-photo");
    // Simulate a stalled download with two buffered ranges totaling half the clip.
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 20 },
      buffered: { configurable: true, value: { length: 2, start: i => i * 10, end: i => i * 10 + 5 } },
    });
    video.dispatchEvent(new Event("waiting"));
    const feedback = { loading: layer.dataset.loading, value: card.querySelector(".live-photo-loading").getAttribute("aria-valuenow"),
      progress: layer.style.getPropertyValue("--live-buffer-progress") };
    delete video.readyState;
    delete video.duration;
    delete video.buffered;
    video.dispatchEvent(new Event("playing"));
    return { ...feedback, resumed: layer.dataset.loading };
  });
  assert.deepEqual(loading, { loading: "true", value: "50", progress: "0.5", resumed: "false" });
  await mobile.waitForFunction(card => new DOMMatrix(getComputedStyle(card.querySelector("img")).transform).a > 1.02, await card.elementHandle());
  await card.dispatchEvent("pointerleave", { pointerType: "mouse" });
  await playing(card);
  const next = mobile.locator('.image-card[data-image-id="two"]');
  await next.locator(".photo-card-open").tap();
  await playing(next);
  assert.equal(await mobile.locator("video").count(), 1);
  assert.equal(await card.locator(".live-photo").getAttribute("data-playing"), "false");
  // Unsupported HEVC can expose only an audio track. Never reveal it as a video.
  await next.locator("video").evaluate(video => {
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 0 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 0 });
    video.dispatchEvent(new Event("loadeddata"));
  });
  assert.equal(await next.locator(".live-photo").getAttribute("data-playing"), "false");
  await mobile.waitForFunction(() => document.querySelector('.image-card[data-image-id="two"] .live-photo')?.dataset.failed === "true");
  assert.equal(await next.locator(".live-photo").getAttribute("data-failed"), "true");
  assert.equal(await mobile.locator("video[src]").count(), 0);
  assert.equal(await next.locator(".live-photo").getAttribute("data-loading"), "false");
  await next.locator(".photo-card-open").tap();
  await mobile.locator('.viewer-media[data-image-id="two"]').waitFor();

  const sequence = await pageFixture({ isMobile: true, hasTouch: true });
  const a = sequence.locator('.image-card[data-image-id="one"]');
  const b = sequence.locator('.image-card[data-image-id="two"]');
  await a.locator(".photo-card-open").tap();
  await playing(a);
  await finished(a);
  // Contact feedback on B alone is not playback and must not change A's tap.
  await b.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", isPrimary: true, button: 0 });
  await b.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch", isPrimary: true, button: 0 });
  await a.locator(".photo-card-open").tap();
  await sequence.locator('.viewer-media[data-image-id="one"]').waitFor();
  await sequence.locator(".close").click();
  await b.locator(".photo-card-open").tap();
  await playing(b);
  await finished(b);
  await a.locator(".photo-card-open").tap();
  assert.equal(await sequence.locator(".viewer-media").count(), 0, "returning after playing B must preview A first");
  await playing(a);
  await finished(a);
  await a.locator(".photo-card-open").tap();
  await sequence.locator('.viewer-media[data-image-id="one"]').waitFor();
  await sequence.close();

  // Exercise a decoder that reports buffered frames but stops advancing its
  // clock. A single pause/resume should recover without resetting the source.
  const stalled = await pageFixture({ userAgent: "Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15" });
  const stalledCard = stalled.locator('.image-card[data-image-id="one"]');
  await stalledCard.hover();
  await playing(stalledCard);
  const beforeStall = await stalled.evaluate(() => ({ ...metrics, sources: [...metrics.sources] }));
  await stalledCard.locator("video").evaluate(video => {
    const time = video.currentTime, duration = video.duration;
    Object.defineProperties(video, {
      currentTime: { configurable: true, get: () => time },
      readyState: { configurable: true, value: 2 },
      buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => duration } },
    });
    video.dispatchEvent(new Event("waiting"));
  });
  await stalled.waitForFunction(plays => metrics.plays > plays, beforeStall.plays);
  await stalledCard.locator("video").evaluate(video => video.dispatchEvent(new Event("waiting")));
  await stalled.waitForTimeout(750);
  const afterStall = await stalled.evaluate(() => ({ ...metrics, sources: [...metrics.sources] }));
  assert.equal(afterStall.plays, beforeStall.plays + 1, "buffer recovery must not repeatedly restart a stuck decoder");
  assert.equal(afterStall.resets, beforeStall.resets);
  assert.deepEqual(afterStall.sources, beforeStall.sources);
  await stalledCard.locator("video").evaluate(video => {
    delete video.currentTime;
    delete video.readyState;
    delete video.buffered;
  });
  await playing(stalledCard);
  await stalled.close();
  assert.deepEqual(errors, []);
  console.log(`${engine.name()}: ${sample.name} interaction checks passed`);
} finally {
  await browser.close();
}
