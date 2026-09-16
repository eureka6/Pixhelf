// Component regression checks: all content is supplied in memory, with no HTTP
// listener, backend process, real gallery, or generated playback files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { engine, launchBrowser, loadSample, serveMotion, serveLibmediaAsset, imageDimensions } from "./live-photo-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sample = await loadSample();
const { poster } = sample;
const fixture = await build({
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import { render } from "preact";
    import { useRef, useState } from "preact/hooks";
    import { MediaPreview, stopMediaPreview } from "./src/MediaPreview";
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
            <MediaPreview image={image} />
            <button className="photo-card-open" onClick={() => { stopMediaPreview(); setOpen(image); }}>open</button>
          </div>)}
        </div>
        {open && (window.fixtureRealViewer ? <ImageViewer images={images} activeIndex={images.indexOf(open)}
          hasMore={false} loadingMore={false} onNavigate={direction => setOpen(images[images.indexOf(open) + direction])}
          onClose={() => setOpen(null)} similarActive={false} similarImages={[]} similarTotal={0}
          similarHasMore={false} similarLoading={false} similarLoadingMore={false} similarError={null}
          onSearchSimilar={() => {}} onLoadMoreSimilar={() => {}} onOpenImage={setOpen} /> : <div ref={viewer} className="fixture-viewer">
          <button className="close" onClick={() => setOpen(null)}>close</button>
          <div className="viewer-media" data-image-id={open.id}><img src="/poster.jpg" /><MediaPreview image={open} autoPlay /></div>
        </div>)}
      </>;
    }
    render(<Fixture />, document.getElementById("root"));
  ` },
  bundle: true, write: false, format: "esm", target: "es2022", jsx: "automatic", jsxImportSource: "preact",
  define: { "import.meta.env.DEV": "true" },
});
const css = (await Promise.all(["styles.css", "video.css"].map(name => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")))).join("\n");
const browser = await launchBrowser();
const errors = [];

async function pageFixture(options = {}) {
  const { realViewer = false, transientVisibility = false, ...contextOptions } = options;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...contextOptions });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://pixhelf.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/assets/libmedia/")) return serveLibmediaAsset(route);
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
  await page.addScriptTag({ type: "module", content: fixture.outputFiles[0].text });
  await page.locator(".image-card").first().waitFor();
  return page;
}

async function playing(card) {
  await card.page().waitForFunction(element => {
    const player = element.querySelector(".media-player-surface");
    return element.querySelector(".media-preview")?.dataset.playing === "true"
      && player?.querySelector("canvas")?.width > 0 && Number(player.dataset.currentTime) > .05
      && player.dataset.playerState === "playing";
  }, await card.elementHandle());
}

async function noPlayers(page) {
  await page.waitForFunction(() => !document.querySelector(".media-player-surface"));
  await page.waitForFunction(async () => {
    const { default: Player } = await import("/assets/libmedia/avplayer.js");
    return Player.Instances.length === 0;
  });
  assert.equal(await page.locator(".media-player-surface").count(), 0);
}

try {
  for (const width of [1440, 390]) {
    const touch = width < 720;
    const page = await pageFixture({ realViewer: true, transientVisibility: touch,
      viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch });
    const first = page.locator('.image-card[data-image-id="one"]');
    const second = page.locator('.image-card[data-image-id="two"]');
    assert.equal(await page.locator(".media-player-surface").count(), 0);
    await first.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 });
    assert.equal(await first.getAttribute("data-card-active"), "true");
    assert.equal(await page.locator(".media-player-surface").count(), 0, "raw contact must not start decoding");
    await first.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 });
    if (touch) await first.locator(".photo-card-open").tap(); else await first.hover();
    await playing(first);
    const previous = await first.locator(".media-player-surface").elementHandle();
    if (touch) await second.locator(".photo-card-open").tap(); else await second.hover();
    await playing(second);
    assert.equal(await previous.evaluate(player => !player.isConnected && player.dataset.playerState === "destroyed"), true);
    await first.dispatchEvent("pointerleave", { pointerType: "mouse" });
    await playing(second);
    assert.equal(await page.locator(".media-player-surface").count(), 1);
    await second.dispatchEvent("pixhelf:card-menu");
    await noPlayers(page);

    // A completed preview still opens on the next tap. The real image viewer
    // must recover from an initially invisible layout and allow tap replay.
    await first.dispatchEvent("pixhelf:card-touch");
    await playing(first);
    await noPlayers(page);
    if (touch) await first.locator(".photo-card-open").tap(); else await first.locator(".photo-card-open").click();
    const viewer = page.locator(".viewer-media:not(.viewer-swipe-outgoing)");
    await playing(viewer);
    await noPlayers(page);
    assert.equal(await viewer.locator(".media-preview").getAttribute("data-playing"), "false");
    if (touch) await viewer.tap(); else await viewer.click();
    await playing(viewer);
    await page.locator(".viewer-close").click();
    await noPlayers(page);
    await page.close();
    console.log(`${engine.name()}: ${width}px contact feedback, handoff, decoder cleanup, transient visibility and replay passed`);
  }

  // Cancel while HEAD is still pending, then start another clip. Releasing the
  // old response must never resurrect its player or damage the active one.
  const page = await pageFixture();
  const first = page.locator('.image-card[data-image-id="one"]');
  const second = page.locator('.image-card[data-image-id="two"]');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/motion/one", async route => { await held; await serveMotion(route, sample); });
  try {
    await first.dispatchEvent("pixhelf:card-touch");
    await first.locator('.media-preview[data-loading="true"]').waitFor();
    await second.dispatchEvent("pixhelf:card-touch");
    release();
    await playing(second);
    assert.equal(await first.locator(".media-preview").getAttribute("data-playing"), "false");
    assert.equal(await page.locator(".media-player-surface").count(), 1);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await noPlayers(page);
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: pending load cancellation and hidden-page cleanup passed`);
  } finally { release(); await page.close(); }
} finally { await browser.close(); }
