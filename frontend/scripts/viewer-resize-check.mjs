import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
let releaseResize;

try {
  const page = await browser.newPage({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let activeOriginal = "";
  let activeRequests = 0;
  let delayResize = false;
  let resizeRequested;
  const requestStarted = new Promise((resolve) => { resizeRequested = resolve; });
  const resizeGate = new Promise((resolve) => { releaseResize = resolve; });
  await page.route(/\/api\/images\/[^/]+\/original(?:\?|$)/, async (route) => {
    if (new URL(route.request().url()).pathname === activeOriginal) {
      activeRequests += 1;
      if (delayResize) {
        resizeRequested();
        await resizeGate;
      }
    }
    await route.continue();
  });

  await page.goto(process.env.PIXHELF_URL ?? "http://127.0.0.1:3002", {
    waitUntil: "domcontentloaded",
  });
  // Headless browsers have no retractable toolbar; model a 64px difference between viewports.
  await page.addStyleTag({ content: `
    @media (hover: none) and (pointer: coarse) {
      .viewer-image-frame { height: calc(100svh - 64px); }
      .viewer-nav { top: calc((100svh - 64px) / 2 + var(--viewer-frame-offset)); }
    }
  ` });
  const coveredOnOpen = [];
  const checkImagePageCoverage = async () => {
    const coverage = await page.evaluate(() => {
      const viewer = document.querySelector(".image-viewer");
      const image = document.querySelector(".viewer-media").getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        viewportHeight: visualViewport.height,
        stageHeight: document.querySelector(".viewer-stage").clientHeight,
        imageFrameHeight: document.querySelector(".viewer-image-frame").clientHeight,
        detailsTop: document.querySelector(".viewer-details-page").getBoundingClientRect().top,
        imageTop: image.top,
        imageBottom: image.bottom,
        scrollTop: viewer.scrollTop,
      };
    });
    assert.equal(coverage.scrollTop, 0);
    assert.ok(coverage.detailsTop >= coverage.viewportHeight - 1, "image details leaked into the first screen");
    assert.ok(coverage.imageTop >= -1 && coverage.imageBottom <= coverage.viewportHeight + 1);
    return coverage;
  };
  await page.locator(".image-card").first().click();
  await page.waitForSelector('.image-viewer[data-full-loaded="true"]', { timeout: 60_000 });
  coveredOnOpen.push(await checkImagePageCoverage());
  assert.ok(coveredOnOpen[0].imageFrameHeight < coveredOnOpen[0].viewportHeight);
  activeOriginal = await page.locator(".viewer-original-canvas").getAttribute("data-original-url");
  assert.ok(activeOriginal, "the resize fixture must use the mobile canvas renderer");

  await page.evaluate(() => {
    const viewer = document.querySelector(".image-viewer");
    const canvas = document.querySelector(".viewer-original-canvas");
    const probe = window.__viewerResizeProbe = {
      canvas,
      frames: 0,
      replacements: 0,
      fallbackFrames: 0,
      blankFrames: 0,
      dimensionWrites: 0,
      initialSource: canvas.dataset.renderedSource,
      initialTop: document.querySelector(".viewer-media").getBoundingClientRect().top,
    };
    const observer = new MutationObserver((records) => {
      probe.dimensionWrites += records.filter((record) => record.target === canvas).length;
    });
    observer.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    const sample = () => {
      probe.frames += 1;
      if (document.querySelector(".viewer-original-canvas") !== canvas) probe.replacements += 1;
      if (viewer.dataset.fullLoaded !== "true") probe.fallbackFrames += 1;
      const pixel = canvas.getContext("2d").getImageData(
        Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1,
      ).data;
      if (!pixel[3]) probe.blankFrames += 1;
      probe.frame = requestAnimationFrame(sample);
    };
    probe.frame = requestAnimationFrame(sample);
    probe.stop = () => {
      cancelAnimationFrame(probe.frame);
      observer.disconnect();
    };

    // Browser chrome changes the visual viewport without resizing the small viewport.
    const viewport = visualViewport;
    let reportedHeight = viewport.height;
    Object.defineProperty(viewport, "height", { configurable: true, get: () => reportedHeight });
    window.__resizeVisualViewport = (height) => {
      reportedHeight = height;
      viewport.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    };
    window.__restoreVisualViewport = () => { delete viewport.height; };
  });

  const resizeBrowserChrome = async () => {
    for (const height of [374, 350, 326, 344, 368, 390]) {
      await page.evaluate((nextHeight) => window.__resizeVisualViewport(nextHeight), height);
      await page.waitForTimeout(32);
    }
  };
  await resizeBrowserChrome();
  await page.waitForTimeout(220);
  assert.equal(await page.evaluate(() => document.querySelector(".viewer-media")
    .getBoundingClientRect().top - window.__viewerResizeProbe.initialTop), 0);
  assert.equal(activeRequests, 0, "toolbar animation must not request another bitmap");
  assert.equal(await page.evaluate(() => window.__viewerResizeProbe.dimensionWrites), 0);

  await page.evaluate(() => window.__resizeVisualViewport(326));
  await page.waitForTimeout(220);
  const expandedToolbar = await checkImagePageCoverage();
  await page.evaluate(() => window.__resizeVisualViewport(390));
  await page.waitForTimeout(220);

  await page.keyboard.press("=");
  await resizeBrowserChrome();
  const scale = await page.locator(".viewer-media").evaluate((media) =>
    new DOMMatrix(getComputedStyle(media).transform).a);
  assert.ok(Math.abs(scale - 1.5) < 0.01, "toolbar animation must preserve zoom");

  const cdp = await page.context().newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  await touch("touchStart", [{ id: 1, x: 422, y: 195 }]);
  await touch("touchMove", [{ id: 1, x: 442, y: 205 }]);
  await resizeBrowserChrome();
  await touch("touchMove", [{ id: 1, x: 462, y: 215 }]);
  await page.waitForTimeout(32);
  const drag = await page.locator(".viewer-media").evaluate((media) => {
    const matrix = new DOMMatrix(getComputedStyle(media).transform);
    return { x: matrix.e, y: matrix.f, scale: matrix.a, dragging: document.querySelector(".image-viewer").dataset.dragging };
  });
  assert.equal(drag.dragging, "true");
  assert.ok(drag.y > 15 && Math.abs(drag.scale - 1.5) < 0.01);
  await touch("touchEnd", []);
  await cdp.detach();
  await page.evaluate(() => window.__restoreVisualViewport());
  await page.keyboard.press("0");
  await page.waitForTimeout(220);
  await page.screenshot({ path: "/tmp/pixhelf-viewer-resize-landscape.png" });

  delayResize = true;
  await page.setViewportSize({ width: 390, height: 844 });
  let requestTimeout;
  try {
    await Promise.race([
      requestStarted,
      new Promise((_, reject) => {
        requestTimeout = setTimeout(() => reject(new Error("resized bitmap was not requested")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(requestTimeout);
  }
  await page.waitForTimeout(240);
  assert.equal(await page.evaluate(() => document.querySelector(".viewer-original-canvas")
    === window.__viewerResizeProbe.canvas), true);
  assert.equal(await page.locator(".image-viewer").getAttribute("data-full-loaded"), "true");
  assert.equal(await page.evaluate(() => window.__viewerResizeProbe.canvas.dataset.renderedSource
    === window.__viewerResizeProbe.initialSource), true);
  delayResize = false;
  releaseResize();
  await page.waitForFunction(() => window.__viewerResizeProbe.canvas.dataset.renderedSource
    !== window.__viewerResizeProbe.initialSource, null, { timeout: 60_000 });
  await page.screenshot({ path: "/tmp/pixhelf-viewer-resize-portrait.png" });

  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => Math.abs(document.querySelector(".image-viewer").scrollTop
    - document.querySelector(".viewer-details-page").offsetTop) < 2);
  await page.setViewportSize({ width: 430, height: 844 });
  await page.waitForFunction(() => Math.abs(document.querySelector(".image-viewer").scrollTop
    - document.querySelector(".viewer-details-page").offsetTop) < 2);
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => document.querySelector(".image-viewer").scrollTop < 1);

  const result = await page.evaluate(() => {
    const probe = window.__viewerResizeProbe;
    probe.stop();
    return {
      frames: probe.frames,
      canvasReplacements: probe.replacements,
      fallbackFrames: probe.fallbackFrames,
      blankFrames: probe.blankFrames,
      dimensionWrites: probe.dimensionWrites,
    };
  });
  assert.ok(result.frames > 10);
  assert.equal(result.canvasReplacements, 0);
  assert.equal(result.fallbackFrames, 0);
  assert.equal(result.blankFrames, 0);
  await page.locator(".viewer-close").click();
  await page.waitForSelector(".image-viewer", { state: "detached" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".image-card").first().click();
  await page.waitForSelector('.image-viewer[data-full-loaded="true"]', { timeout: 60_000 });
  coveredOnOpen.push(await checkImagePageCoverage());
  await page.screenshot({ path: "/tmp/pixhelf-viewer-collapsed-toolbar-open.png", animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...result, coveredOnOpen, expandedToolbar, toolbarZoomPreserved: true, drag, detailsAnchorPreserved: true, errors }, null, 2));
} finally {
  releaseResize?.();
  await browser.close();
}
