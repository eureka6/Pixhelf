import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const baseline = process.env.PIXHELF_RESIZE_BASELINE === "1";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];

async function traceResize(page, toggles = [0]) {
  return page.evaluate(async (toggleTimes) => {
    const gallery = document.querySelector(".justified-gallery");
    const cards = [...gallery.querySelectorAll(".image-card")];
    const focused = document.activeElement?.closest(".image-card");
    const anchorY = focused ? focused.getBoundingClientRect().top + focused.getBoundingClientRect().height / 2 : null;
    const loaded = cards.filter((card) => card.dataset.loaded === "true");
    const rect = (card) => {
      const box = card.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const snapshot = (time) => ({
      time,
      width: cards[0].style.width,
      rows: gallery.dataset.rows,
      scrollY,
      anchorY: focused ? focused.getBoundingClientRect().top + focused.getBoundingClientRect().height / 2 : null,
      animated: cards.filter((card) => card.getAnimations().some((animation) => animation.playState === "running")).length,
      cards: cards.map(rect),
    });
    const frames = [snapshot(0)];
    let toggle = 0;
    const start = performance.now();
    while (performance.now() - start < toggleTimes.at(-1) + 440) {
      const elapsed = performance.now() - start;
      if (toggle < toggleTimes.length && elapsed >= toggleTimes[toggle]) {
        document.querySelector(".gallery-sidebar-toggle").click();
        toggle++;
      }
      await new Promise(requestAnimationFrame);
      frames.push(snapshot(performance.now() - start));
    }
    const first = frames[0];
    const last = frames.at(-1);
    const visible = (box) => box.y + box.height > 54 && box.y < innerHeight;
    let maxExcessTravel = 0;
    let maxFrameStep = 0;
    for (let index = 0; index < cards.length; index++) {
      if (!visible(first.cards[index]) && !visible(last.cards[index])) continue;
      const from = first.cards[index];
      const to = last.cards[index];
      const direct = Math.hypot(to.x - from.x, to.y - from.y);
      let travelled = 0;
      for (let frame = 1; frame < frames.length; frame++) {
        const previous = frames[frame - 1].cards[index];
        const current = frames[frame].cards[index];
        const step = Math.hypot(current.x - previous.x, current.y - previous.y);
        travelled += step;
        maxFrameStep = Math.max(maxFrameStep, step);
      }
      maxExcessTravel = Math.max(maxExcessTravel, travelled - direct);
    }
    return {
      viewport: innerWidth,
      toggles: toggleTimes.length,
      layoutCommits: frames.slice(1).filter((frame, index) => frame.width !== frames[index].width || frame.rows !== frames[index].rows).length,
      rowCounts: [...new Set(frames.map((frame) => frame.rows))],
      maxAnchorDrift: anchorY === null ? 0 : Math.max(...frames.map((frame) => Math.abs(frame.anchorY - anchorY))),
      maxExcessTravel,
      maxFrameStep,
      peakAnimated: Math.max(...frames.map((frame) => frame.animated)),
      remainingAnimations: cards.flatMap((card) => card.getAnimations()).filter((animation) => animation.playState === "running").length,
      cardsPreserved: cards.every((card) => card.isConnected),
      loadedPreserved: loaded.every((card) => card.dataset.loaded === "true"),
      skeletonSeen: Boolean(document.querySelector(".skeleton-grid")),
      frames,
    };
  }, toggles);
}

try {
  for (const width of [1440, 1280, 1000]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    let imageRequests = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/images" && url.searchParams.get("offset") === "0") imageRequests++;
    });
    await page.goto(process.env.PIXHELF_URL ?? "http://127.0.0.1:3002");
    await page.locator(".image-card").nth(24).waitFor();
    await page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
    for (const deep of [false, true]) {
      if (deep) {
        await page.locator(".image-card").nth(24).evaluate((card) => {
          card.scrollIntoView({ block: "center", behavior: "instant" });
          card.focus({ preventScroll: true });
        });
      }
      await page.waitForTimeout(200);
      const requestsBefore = imageRequests;
      for (const phase of ["collapse", "expand"]) {
        const trace = await traceResize(page);
        writeFileSync(`/tmp/pixhelf-sidebar-${width}-${deep ? "deep" : "top"}-${phase}.json`, JSON.stringify(trace));
        const { frames, ...result } = trace;
        Object.assign(result, { deep, phase });
        results.push(result);
        console.log(JSON.stringify(result));
        if (!baseline) {
          assert.ok(trace.layoutCommits <= 2, "sidebar animation repeatedly recalculates the layout");
          assert.ok(trace.maxAnchorDrift <= 2, "the reading position moved during the transition");
          assert.ok(trace.maxExcessTravel <= 4, "cards reverse direction or jump between rows");
          assert.ok(trace.peakAnimated > 0, "cards did not transition to the new layout");
          assert.equal(trace.remainingAnimations, 0);
          assert.equal(trace.cardsPreserved && trace.loadedPreserved && !trace.skeletonSeen, true);
        }
      }
      assert.equal(imageRequests, requestsBefore, "sidebar toggle reloaded the image list");
    }
    if (!baseline) {
      const rapid = await traceResize(page, [0, 70, 140, 210]);
      assert.ok(rapid.layoutCommits <= 4);
      assert.ok(rapid.maxAnchorDrift <= 2);
      assert.equal(rapid.remainingAnimations, 0);
      assert.equal(rapid.cardsPreserved && rapid.loadedPreserved, true);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const reduced = await traceResize(page);
      assert.ok(reduced.layoutCommits <= 2);
      assert.ok(reduced.maxAnchorDrift <= 2);
      assert.equal(reduced.peakAnimated, 0);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(JSON.stringify({ baseline, checked: results.length }));
} finally {
  await browser.close();
}
