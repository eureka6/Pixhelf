import { chromium } from "playwright-core";

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const baseUrl = process.env.PIXHELF_URL ?? "http://127.0.0.1:3002";

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const results = [];

async function dispatchTouch(cdp, type, points) {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point) => ({
      id: point.id,
      x: point.x,
      y: point.y,
      radiusX: 5,
      radiusY: 5,
      force: 1,
    })),
  });
}

async function touchTap(cdp, point, pointerId = 1) {
  await dispatchTouch(cdp, "touchStart", [{ ...point, id: pointerId }]);
  await dispatchTouch(cdp, "touchEnd", []);
}

async function touchDrag(cdp, from, to, steps = 10, pointerId = 1) {
  await dispatchTouch(cdp, "touchStart", [{ ...from, id: pointerId }]);
  for (let step = 1; step <= steps; step += 1) {
    await dispatchTouch(cdp, "touchMove", [{
      id: pointerId,
      x: from.x + (to.x - from.x) * (step / steps),
      y: from.y + (to.y - from.y) * (step / steps),
    }]);
  }
  await dispatchTouch(cdp, "touchEnd", []);
}

async function touchPinch(cdp, center, fromDistance, toDistance, steps = 10) {
  const firstStart = { id: 1, x: center.x - fromDistance / 2, y: center.y };
  const secondStart = { id: 2, x: center.x + fromDistance / 2, y: center.y };
  await dispatchTouch(cdp, "touchStart", [firstStart, secondStart]);
  for (let step = 1; step <= steps; step += 1) {
    const distance = fromDistance + (toDistance - fromDistance) * (step / steps);
    await dispatchTouch(cdp, "touchMove", [
      { id: 1, x: center.x - distance / 2, y: center.y },
      { id: 2, x: center.x + distance / 2, y: center.y },
    ]);
  }
  await dispatchTouch(cdp, "touchEnd", []);
}

try {
  for (const target of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({
      viewport: { width: target.width, height: target.height },
      deviceScaleFactor: target.name === "mobile" ? 3 : 1,
      hasTouch: target.name === "mobile",
    });
    const browserErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("[data-image-id]", { timeout: 60_000 });
    await page.waitForFunction(() => {
      const visible = [...document.querySelectorAll("[data-image-id] img")].filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      });
      return visible.length >= 8 && visible.every((image) => image.complete && image.naturalWidth > 0);
    }, undefined, { timeout: 60_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/tmp/pixhelf-${target.name}.png` });

    const layout = await page.evaluate(() => ({
      viewport: [innerWidth, innerHeight],
      bodyWidth: document.documentElement.scrollWidth,
      cards: document.querySelectorAll("[data-image-id]").length,
      masonryColumns: document.querySelectorAll(".masonry-column").length,
      loadedCards: document.querySelectorAll("[data-image-id] img.loaded").length,
      brokenVisibleImages: [...document.images].filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && image.naturalWidth === 0;
      }).length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    }));

    await page.locator("[data-image-id]").first().click();
    await page.waitForSelector(".image-viewer");
    await page.waitForFunction(() => {
      const image = document.querySelector(".viewer-image-original");
      return image instanceof HTMLImageElement &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.classList.contains("is-ready") &&
        Number(getComputedStyle(image).opacity) > 0.98;
    }, undefined, { timeout: 60_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/tmp/pixhelf-viewer-${target.name}.png` });

    const viewerLayout = await page.evaluate(() => {
      const viewer = document.querySelector(".image-viewer");
      const frame = document.querySelector(".viewer-image-frame");
      const image = document.querySelector(".viewer-image-original");
      const transform = document.querySelector(".viewer-transform");
      if (!viewer || !frame || !(image instanceof HTMLImageElement) || !transform) {
        return { visible: false };
      }
      const rect = frame.getBoundingClientRect();
      const imageStyle = getComputedStyle(image);
      return {
        visible: true,
        frame: [rect.left, rect.top, rect.right, rect.bottom],
        naturalSize: [image.naturalWidth, image.naturalHeight],
        imageOpacity: imageStyle.opacity,
        objectFit: imageStyle.objectFit,
        noLegacyLightbox: document.querySelectorAll(".yarl__portal, .yarl__thumbnails_container").length === 0,
        controlsVisible: viewer.getAttribute("data-controls-visible"),
        transform: getComputedStyle(transform).transform,
      };
    });

    const frame = await page.locator(".viewer-canvas").boundingBox();
    if (!frame) throw new Error("viewer canvas is missing");
    const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    const transform = page.locator(".viewer-transform");
    await page.mouse.dblclick(center.x + 48, center.y - 32, { delay: 70 });
    await page.waitForFunction(() => document.querySelector(".viewer-transform")?.getAttribute("data-zoomed") === "true");
    const doubleClickZoom = await transform.evaluate((element) => getComputedStyle(element).transform);
    await page.waitForTimeout(700);
    const zoomedLayout = await page.evaluate(() => {
      const frame = document.querySelector(".viewer-image-frame");
      const transform = document.querySelector(".viewer-transform");
      if (!frame || !transform) return { frame: [0, 0, 0, 0], scale: 0, rasterScale: 0 };
      const rect = frame.getBoundingClientRect();
      return {
        frame: [rect.left, rect.top, rect.width, rect.height],
        scale: Number(transform.getAttribute("data-scale") ?? 0),
        rasterScale: Number(transform.getAttribute("data-raster-scale") ?? transform.getAttribute("data-rasterScale") ?? 0),
      };
    });
    await page.screenshot({ path: `/tmp/pixhelf-viewer-${target.name}-zoomed.png` });

    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(300);
    const singleClickControls = await page.locator(".image-viewer").getAttribute("data-controls-visible");

    await page.mouse.wheel(0, -360);
    await page.waitForTimeout(350);
    const wheelZoom = await transform.evaluate((element) => getComputedStyle(element).transform);

    const counterBefore = await page.locator(".viewer-counter").textContent();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((previous) => document.querySelector(".viewer-counter")?.textContent !== previous, counterBefore);
    const counterAfter = await page.locator(".viewer-counter").textContent();

    let touchChecks = null;
    if (target.name === "mobile") {
      const cdp = await page.context().newCDPSession(page);
      const swipeFrame = await page.locator(".viewer-canvas").boundingBox();
      if (!swipeFrame) throw new Error("mobile viewer canvas is missing");
      const centerPoint = {
        x: swipeFrame.x + swipeFrame.width / 2,
        y: swipeFrame.y + swipeFrame.height / 2,
      };

      await page.keyboard.press("0");
      await page.waitForTimeout(280);
      const pinchBefore = await transform.getAttribute("data-scale");
      await touchPinch(cdp, centerPoint, 82, 210);
      await page.waitForTimeout(300);
      const pinchAfter = await transform.getAttribute("data-scale");
      await page.keyboard.press("0");
      await page.waitForTimeout(280);

      const touchCounterBefore = await page.locator(".viewer-counter").textContent();
      await touchDrag(
        cdp,
        { x: swipeFrame.x + swipeFrame.width * 0.78, y: centerPoint.y },
        { x: swipeFrame.x + swipeFrame.width * 0.2, y: centerPoint.y + 3 },
      );
      await page.waitForFunction(
        (previous) => document.querySelector(".viewer-counter")?.textContent !== previous,
        touchCounterBefore,
      );
      const touchCounterAfter = await page.locator(".viewer-counter").textContent();

      const controlsBeforeTap = await page.locator(".image-viewer").getAttribute("data-controls-visible");
      await touchTap(cdp, { x: 18, y: centerPoint.y });
      await page.waitForTimeout(330);
      const viewerStillOpenAfterBlankTap = await page.locator(".image-viewer").count();
      const controlsAfterTap = await page.locator(".image-viewer").getAttribute("data-controls-visible");

      await touchDrag(
        cdp,
        { x: centerPoint.x, y: swipeFrame.y + swipeFrame.height * 0.34 },
        { x: centerPoint.x + 3, y: swipeFrame.y + swipeFrame.height * 0.7 },
      );
      await page.waitForSelector(".image-viewer", { state: "detached" });

      touchChecks = {
        pinchBefore: Number(pinchBefore),
        pinchAfter: Number(pinchAfter),
        touchCounterBefore,
        touchCounterAfter,
        controlsBeforeTap,
        controlsAfterTap,
        viewerStillOpenAfterBlankTap,
        dismissDetached: true,
      };
    } else {
      await page.keyboard.press("Escape");
      await page.waitForSelector(".image-viewer", { state: "detached" });
    }

    const result = {
      name: target.name,
      ...layout,
      viewerLayout,
      zoomedLayout,
      doubleClickZoom,
      wheelZoom,
      singleClickControls,
      counterBefore,
      counterAfter,
      touchChecks,
      browserErrors,
    };
    results.push(result);
    console.log(JSON.stringify(result));

    const expectedColumns = target.name === "desktop" ? 5 : 2;
    const viewerContained = viewerLayout.visible &&
      viewerLayout.frame[0] >= -1 &&
      viewerLayout.frame[1] >= -1 &&
      viewerLayout.frame[2] <= target.width + 1 &&
      viewerLayout.frame[3] <= target.height + 1;
    if (
      layout.horizontalOverflow ||
      layout.brokenVisibleImages ||
      layout.masonryColumns !== expectedColumns ||
      !viewerContained ||
      Number(viewerLayout.imageOpacity) < 0.98 ||
      viewerLayout.objectFit !== "contain" ||
      !viewerLayout.noLegacyLightbox ||
      !doubleClickZoom.includes("matrix") ||
      !wheelZoom.includes("matrix") ||
      zoomedLayout.scale <= 1.01 ||
      zoomedLayout.rasterScale <= 1.01 ||
      zoomedLayout.frame[2] <= (viewerLayout.frame[2] - viewerLayout.frame[0]) * 1.1 ||
      Math.abs(zoomedLayout.frame[2] / (viewerLayout.frame[2] - viewerLayout.frame[0]) - zoomedLayout.scale) > 0.08 ||
      singleClickControls !== "false" ||
      counterBefore === counterAfter ||
      (target.name === "mobile" && (
        !touchChecks ||
        touchChecks.pinchAfter <= touchChecks.pinchBefore + 0.2 ||
        touchChecks.touchCounterBefore === touchChecks.touchCounterAfter ||
        touchChecks.viewerStillOpenAfterBlankTap !== 1 ||
        touchChecks.controlsBeforeTap === touchChecks.controlsAfterTap ||
        !touchChecks.dismissDetached
      )) ||
      browserErrors.length
    ) {
      throw new Error(`visual check failed: ${JSON.stringify(result)}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
