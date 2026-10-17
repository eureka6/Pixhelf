import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { launchBrowser, loadSample, serveMotion, serveLibmediaAsset } from "./live-photo-fixture.mjs";

const sample = await loadSample();
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx", contents: `
  import { render } from "preact";
  import { MediaPreview } from "./src/MediaPreview";
  import { preloadLivePhoto } from "./src/livePhotoPreload";
  import { motionBlob, isMotionCached } from "./src/mediaSource";
  window.preloadLivePhoto = preloadLivePhoto;
  window.motionBlob = motionBlob;
  window.isMotionCached = isMotionCached;
  render(<div style={{ display: "flex", gap: 8 }}>
    {[0, 1, 2].map(id => <div className="image-card" data-image-id={id} data-loaded="true"
      style={{ position: "relative", width: 100, height: 100 }}>
      <img src="/poster.jpg" /><MediaPreview image={{ id: String(id), name: id + ".jpg", width: 960, height: 720, motion: "/motion/" + id }} />
    </div>)}
  </div>, document.getElementById("root"));
` }, bundle: true, write: false, format: "esm", target: "es2022", jsx: "automatic", jsxImportSource: "preact",
  define: { "import.meta.env.DEV": "true" } });
const css = (await Promise.all(["base.css", "styles.css", "video.css"].map(name => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")))).join("\n");
const browser = await launchBrowser();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await delay(20); }
  assert.fail("preload did not reach the expected network state");
}

async function fixture(width, connection = {}) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  if (process.env.PIXHELF_TEST_DEBUG) {
    page.on("console", message => console.log(message.text()));
    await page.addInitScript(() => {
      let previous = "";
      new MutationObserver(() => {
        const states = [...document.querySelectorAll(".media-player-surface")].map(player => `${player.dataset.player}:${player.dataset.playerState}`).join(",");
        if (states !== previous) { previous = states; console.log(Math.round(performance.now()), states); }
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-player-state"] });
    });
  }
  await page.addInitScript(connection => Object.defineProperty(navigator, "connection", { configurable: true, value: connection }), connection);
  const requests = [], errors = [];
  let active = 0, peak = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://pixhelf.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: `<style>${css}body{padding:8px;min-height:2200px}</style><div id="root"></div><script type="module" src="/fixture.js"></script>` });
    if (path === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0].text });
    if (path === "/poster.jpg") return route.fulfill({ contentType: "image/jpeg", body: sample.poster });
    if (path.startsWith("/assets/libmedia/")) return serveLibmediaAsset(route);
    if (path.startsWith("/motion/")) {
      const request = { path, method: route.request().method(), done: false };
      requests.push(request);
      peak = Math.max(peak, ++active);
      await delay(600);
      try { await serveMotion(route, sample); } catch {}
      finally { active--; request.done = true; }
      return;
    }
    return route.abort();
  });
  await page.goto("https://pixhelf.test/");
  await page.locator(".media-preview").first().waitFor({ state: "attached" });
  return { page, requests, peak: () => peak, close: async () => { await page.close(); assert.deepEqual(errors, []); } };
}

async function play(page) {
  const started = await page.locator('.image-card[data-image-id="0"]').evaluate(card => {
    const now = performance.now();
    card.dispatchEvent(new CustomEvent("pixhelf:card-touch"));
    return now;
  });
  await page.locator('.image-card[data-image-id="0"] .media-preview[data-playing="true"]').waitFor({ state: "attached" });
  return Math.round(await page.evaluate(() => performance.now()) - started);
}

try {
  for (const width of [1440, 390]) {
    const cold = await fixture(width, { saveData: true });
    let coldMs;
    try {
      await delay(650);
      assert.equal(cold.requests.length, 0, "data saver must disable speculative downloads");
      coldMs = await play(cold.page);
    } finally { await cold.close(); }
    const warm = await fixture(width);
    try {
      await until(() => warm.requests.some(request => request.path === "/motion/0" && request.method === "GET" && request.done));
      await warm.page.waitForLoadState("networkidle");
      assert.equal(await warm.page.locator(".media-player-surface").count(), 0, "preloading must not create a decoder or autoplay");
      const before = warm.requests.filter(request => request.path === "/motion/0").length;
      const warmMs = await play(warm.page);
      assert.equal(warm.requests.filter(request => request.path === "/motion/0").length, before, "preloaded playback must reuse the original bytes");
      assert(warmMs < coldMs - 600, `preloading should remove network latency: cold ${coldMs}ms, warm ${warmMs}ms`);
      assert(coldMs < 7000 && warmMs < 5000, `short clips must not wait for a full decode probe: cold ${coldMs}ms, warm ${warmMs}ms`);
      assert(warm.peak() <= 2, "at most two visible clips preload together");
      console.log(`${width}px: first frame ${coldMs}ms cold / ${warmMs}ms preloaded (600ms per request), bounded downloads and data saver passed`);
    } finally { await warm.close(); }
  }
  const handoff = await fixture(390);
  try {
    await until(() => handoff.requests.some(request => request.path === "/motion/0" && request.method === "GET" && !request.done));
    await play(handoff.page);
    assert.deepEqual(handoff.requests.filter(request => request.path === "/motion/0").map(request => request.method), ["GET"],
      "tapping during preload must continue the same download");
  } finally { await handoff.close(); }
  const slideshowHandoff = await fixture(390, { saveData: true });
  try {
    await slideshowHandoff.page.evaluate(() => {
      window.releaseSlide = window.preloadLivePhoto('/motion/0', true);
      window.releaseNext = window.preloadLivePhoto('/motion/1', true);
    });
    await until(() => slideshowHandoff.requests.some(request => request.path === '/motion/1' && request.method === 'GET' && !request.done));
    await slideshowHandoff.page.evaluate(() => {
      window.releaseSlide();
      window.releaseNext();
      window.releaseSlide = window.preloadLivePhoto('/motion/1', true);
    });
    await until(() => slideshowHandoff.requests.some(request => request.path === '/motion/1' && request.method === 'GET' && request.done));
    await slideshowHandoff.page.locator('.image-card[data-image-id="1"]').dispatchEvent('pixhelf:card-touch');
    await slideshowHandoff.page.locator('.image-card[data-image-id="1"] .media-preview[data-playing="true"]').waitFor();
    assert.deepEqual(slideshowHandoff.requests.filter(request => request.path === '/motion/1').map(request => request.method), ['GET'],
      'a photo/video slideshow controller handoff preserves the pending next-clip download');
    await slideshowHandoff.page.evaluate(() => window.releaseSlide());
  } finally { await slideshowHandoff.close(); }
  const evictedPreload = await fixture(390, { saveData: true });
  try {
    await evictedPreload.page.evaluate(() => { window.releaseCard = window.preloadLivePhoto('/motion/0'); });
    await until(() => evictedPreload.requests.some(request => request.method === 'GET' && request.done));
    await evictedPreload.page.waitForLoadState('networkidle');
    await evictedPreload.page.route('**/motion/evict-*', route => serveMotion(route, sample));
    await evictedPreload.page.evaluate(async () => {
      for (let i = 0; i < 32; i++) await window.motionBlob('/motion/evict-' + i, new AbortController().signal);
    });
    assert.equal(await evictedPreload.page.evaluate(() => window.isMotionCached('/motion/0')), false, 'browsing more clips can evict an old speculative preload');
    await evictedPreload.page.evaluate(() => { window.releaseSlide = window.preloadLivePhoto('/motion/0', true); });
    await until(() => evictedPreload.requests.filter(request => request.method === 'GET' && request.done).length === 2);
    const before = evictedPreload.requests.length;
    await play(evictedPreload.page);
    assert.equal(evictedPreload.requests.length, before, 'slideshow promotion refreshes an evicted preload before playback');
    await evictedPreload.page.evaluate(() => { window.releaseCard(); window.releaseSlide(); });
  } finally { await evictedPreload.close(); }
  const cancelled = await fixture(390);
  try {
    await until(() => cancelled.requests.length > 0);
    await cancelled.page.evaluate(() => scrollTo(0, 1700));
    await until(() => cancelled.requests.every(request => request.done));
    await delay(300);
    assert(cancelled.requests.every(request => request.method === "GET"), "metadata and bytes use one request");
    assert.equal(await cancelled.page.evaluate(() => window.isMotionCached('/motion/0')), false,
      "leaving before the response arrives cancels the body and must not cache the clip");
    assert.equal(await cancelled.page.locator(".media-player-surface").count(), 0);
  } finally { await cancelled.close(); }
  console.log("In-flight slideshow handoff, evicted preload refresh and offscreen cancellation passed");
} finally { await browser.close(); }
