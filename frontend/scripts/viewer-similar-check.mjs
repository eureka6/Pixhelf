import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];
const exif = [
  { label: "相机", value: "Camera" },
  { label: "镜头", value: "Lens" },
  { label: "焦距", value: "50 mm" },
  { label: "光圈", value: "f/2.8" },
  { label: "快门", value: "1/125" },
  { label: "ISO", value: "100" },
  { label: "拍摄时间", value: "2026:09:06 12:00:00" },
];

async function position(page) {
  return page.evaluate(() => {
    const viewer = document.querySelector(".image-viewer");
    const section = document.querySelector(".viewer-similar-section");
    const toolbar = document.querySelector(".viewer-details-toolbar");
    return {
      top: section.getBoundingClientRect().top - viewer.getBoundingClientRect().top,
      margin: parseFloat(getComputedStyle(section).scrollMarginTop),
      toolbarBottom: toolbar.getBoundingClientRect().bottom - viewer.getBoundingClientRect().top,
      toolbarInert: toolbar.closest("header").inert,
      focused: document.activeElement === section,
      scrollTop: viewer.scrollTop,
      overflow: viewer.scrollWidth > viewer.clientWidth,
    };
  });
}

async function expectAligned(page) {
  await page.waitForFunction(() => {
    const section = document.querySelector(".viewer-similar-section");
    const viewer = document.querySelector(".image-viewer");
    return Math.abs(section.getBoundingClientRect().top - viewer.getBoundingClientRect().top
      - parseFloat(getComputedStyle(section).scrollMarginTop)) <= 1
      && !document.querySelector(".viewer-details-header").inert;
  });
  const current = await position(page);
  assert.ok(current.top >= current.toolbarBottom + 8, "toolbar obscures the destination");
  assert.equal(current.overflow, false);
  return current;
}

try {
  for (const target of [
    { name: "desktop", width: 1440, height: 900, mode: "results" },
    { name: "mobile", width: 390, height: 844, mode: "empty" },
    { name: "compact", width: 320, height: 740, mode: "error" },
  ]) {
    const touch = target.name !== "desktop";
    const page = await browser.newPage({
      viewport: { width: target.width, height: target.height },
      hasTouch: touch,
      isMobile: touch,
      reducedMotion: target.name === "compact" ? "reduce" : "no-preference",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const activate = (locator) => touch ? locator.tap() : locator.click();
    const rounds = [];
    const createRound = (mode) => {
      const next = { mode, details: Promise.withResolvers(), similar: Promise.withResolvers(), requests: 0 };
      rounds.push(next);
      return next;
    };
    let round = createRound(target.mode);
    await page.route(/\/api\/images\/[^/]+\/details$/, async (route) => {
      const current = round;
      const response = await route.fetch();
      const json = await response.json();
      await current.details.promise;
      await route.fulfill({ response, json: { ...json, exif } });
    });
    await page.route(/\/api\/images\/[^/]+\/similar(?:\?|$)/, async (route) => {
      const current = round;
      current.requests += 1;
      await current.similar.promise;
      if (current.mode === "error") {
        await route.fulfill({ status: 503, json: { error: "Similarity unavailable" } });
      } else if (current.mode === "empty") {
        await route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 24, nextOffset: null } });
      } else {
        const response = await route.fetch();
        const json = await response.json();
        const items = json.items.slice(0, current.mode === "one" ? 1 : 12);
        await route.fulfill({ response, json: { ...json, items, total: items.length, nextOffset: null } });
      }
    });
    try {
      await page.goto(process.env.PIXHELF_URL ?? "http://127.0.0.1:3002", { waitUntil: "domcontentloaded" });
      await activate(page.locator(".image-card").first());
      const trigger = page.locator(".viewer-header").getByRole("button", { name: "相似图片", exact: true });
      assert.equal(await trigger.getAttribute("title"), "相似图片");
      if (target.name === "compact") {
        await trigger.focus();
        await page.keyboard.press("Enter");
      } else {
        await activate(trigger);
      }
      await page.waitForSelector(".viewer-similar-skeleton");
      const loading = await expectAligned(page);
      assert.ok(loading.focused, "keyboard focus did not follow the destination");
      round.details.resolve();
      await page.waitForSelector(".viewer-image-information-exposure");
      const metadata = await expectAligned(page);
      round.similar.resolve();
      await page.waitForSelector(target.mode === "error"
        ? ".viewer-similar-error" : target.mode === "empty"
          ? ".viewer-similar-empty" : ".viewer-similar-card");
      const ready = await expectAligned(page);
      if (target.mode === "error") {
        round.mode = "one";
        await activate(page.locator(".viewer-details-toolbar").getByRole("button", { name: "相似图片", exact: true }));
        await page.waitForSelector(".viewer-similar-card");
        await expectAligned(page);
      }
      const requests = round.requests;
      await activate(page.locator(".viewer-details-return"));
      await page.waitForFunction(() => document.querySelector(".image-viewer").scrollTop < 1);
      await activate(trigger);
      await expectAligned(page);
      assert.equal(round.requests, requests, "cached results triggered another search");
      await activate(page.locator(".viewer-details-toolbar").getByRole("button", { name: "相似图片", exact: true }));
      await expectAligned(page);
      assert.equal(round.requests, requests);
      await page.screenshot({ path: `/tmp/pixhelf-similar-${target.name}.png` });
      await activate(page.locator(".viewer-details-close"));

      round = createRound("results");
      await activate(page.locator(".image-card").nth(1));
      await activate(trigger);
      if (target.name === "desktop") {
        await page.waitForFunction(() => {
          const viewer = document.querySelector(".image-viewer");
          return viewer.scrollTop > 80 && viewer.scrollTop < viewer.clientHeight;
        });
        await page.mouse.move(100, 280);
        await page.mouse.wheel(0, -200);
      } else {
        await expectAligned(page);
      }
      if (target.name === "mobile") {
        const session = await page.context().newCDPSession(page);
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 90, y: 280 }] });
        await page.waitForTimeout(60);
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 90, y: 350 }] });
        await page.waitForTimeout(60);
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 90, y: 440 }] });
        await page.waitForTimeout(180);
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await session.detach();
      } else if (target.name === "compact") {
        await page.keyboard.press("PageUp");
      }
      await page.waitForTimeout(300);
      const interrupted = await position(page);
      assert.ok(interrupted.top > interrupted.margin + 40, "manual navigation did not interrupt positioning");
      round.details.resolve();
      round.similar.resolve();
      await page.waitForSelector(".viewer-image-information-exposure");
      await page.waitForSelector(".viewer-similar-card", { state: "attached" });
      await page.waitForTimeout(900);
      const afterLoad = await position(page);
      assert.ok(afterLoad.top > afterLoad.margin + 40, "loading pulled the user back to the destination");
      assert.deepEqual(errors, []);
      results.push({ target: target.name, loading, metadata, ready, manualInterruption: true, cachedNavigation: true });
    } finally {
      for (const current of rounds) {
        current.details.resolve();
        current.similar.resolve();
      }
      await page.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
