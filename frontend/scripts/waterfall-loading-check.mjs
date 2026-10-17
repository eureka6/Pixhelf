import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { serveFrontendAsset } from "./frontend-fixture.mjs";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const photo = await readFile(new URL("fixtures/live-photo.jpg", import.meta.url));
const images = Array.from({ length: 180 }, (_, i) => ({ id: String(i).padStart(32, "0"), name: `photo-${i}.jpg`, width: 1200, height: 900 }));
const summary = { total: images.length, albums: [], revision: "waterfall" };
const status = { total: 180, ready: 180, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
  textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
const imagePage = (offset = 0) => ({ items: images.slice(offset, offset + 60), total: images.length, offset, limit: 60, nextOffset: offset + 60 < images.length ? offset + 60 : null });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const reportOnly = process.argv.includes("--report-only");
const browser = await launchBrowser();
const results = [];

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 720, isMobile: width < 720, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [], pages = [], thumbnails = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "connection", { configurable: true, value: { effectiveType: "4g", downlink: 8, rtt: 350 } });
    });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: html
        .replace("__PIXHELF_AUTH__", '{"enabled":false,"authenticated":false}')
        .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images: imagePage() })) });
      if (path.startsWith("/assets/")) return serveFrontendAsset(route);
      if (path.endsWith("/thumbnail")) {
        thumbnails.push(path);
        await delay(600);
        return route.fulfill({ contentType: "image/jpeg", body: photo }).catch(() => {});
      }
      if (path === "/api/images") {
        const offset = Number(url.searchParams.get("offset"));
        pages.push(offset);
        await delay(700);
        return route.fulfill({ json: imagePage(offset) }).catch(() => {});
      }
      if (path === "/api/gallery") return route.fulfill({ json: summary });
      if (path === "/api/status") return route.fulfill({ json: status });
      if (path === "/api/categories") return route.fulfill({ json: { categories: [] } });
      return route.fulfill({ json: { favoriteIds: [], favoriteAlbums: [], privateAlbums: [], trashCount: 0 } });
    });
    try {
      await page.goto("https://pixhelf.test/");
      await page.waitForFunction(() => {
        const visible = [...document.querySelectorAll(".image-card")].filter(card => {
          const rect = card.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight;
        });
        return visible.length > 0 && visible.every(card => card.dataset.loaded === "true");
      });
      await page.evaluate(() => { window.seenCards = new Set(); window.arrivals = []; });
      const sample = () => page.evaluate(() => {
        for (const card of document.querySelectorAll(".image-card")) {
          const rect = card.getBoundingClientRect();
          if (rect.bottom <= 54 || rect.top >= innerHeight || window.seenCards.has(card.dataset.imageId)) continue;
          window.seenCards.add(card.dataset.imageId);
          window.arrivals.push({ id: card.dataset.imageId, ready: card.dataset.loaded === "true" });
        }
      });
      await sample();
      await page.evaluate(() => { window.arrivals = []; });
      // 900 px/second: first-page images and the next page both need lead time.
      for (let step = 1; step <= (width < 720 ? 22 : 15); step++) {
        await page.evaluate(top => scrollTo({ top, behavior: "instant" }), step * 300);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await sample();
        await delay(333);
      }
      const arrivals = await page.evaluate(() => window.arrivals);
      const ready = arrivals.filter(image => image.ready).length;
      results.push({ width, imageDelayMs: 600, pageDelayMs: 700, newlyVisible: arrivals.length, readyOnEntry: ready,
        readyPercent: Math.round(ready / arrivals.length * 100), pages, thumbnailRequests: thumbnails.length });
      if (!reportOnly) {
        assert(arrivals.length > 30 && ready / arrivals.length >= .9, "photos should be ready before normal scrolling reveals them");
        assert(pages.includes(60), "next-page metadata must arrive ahead of scrolling");
        assert.equal(pages.length, new Set(pages).size, "pagination must not request a page twice");
        assert(thumbnails.length < images.length, "prefetch must stay within the nearby window");
        assert(await page.evaluate(() => [...document.querySelectorAll(".image-card")].filter(card => {
          const rect = card.getBoundingClientRect();
          return rect.bottom > 54 && rect.top < innerHeight;
        }).every(card => card.dataset.loaded === "true" || card.querySelector("img")?.fetchPriority === "high")), "pending visible thumbnails have high priority");

        // Hold a nearby request across a fast scroll to check actual promotion,
        // rather than only checking cards whose downloads already finished.
        const id = images.at(-1).id;
        const target = page.locator(`.image-card[data-image-id="${id}"]`);
        assert.equal(await target.locator("img").count(), 0, "distant thumbnails have not started loading");
        const gate = Promise.withResolvers();
        let promotedRequests = 0;
        await page.route(`**/api/images/${id}/thumbnail`, async route => {
          promotedRequests++;
          await gate.promise;
          await route.fulfill({ contentType: "image/jpeg", body: photo }).catch(() => {});
        });
        try {
          await target.evaluate(card => scrollTo({ top: card.getBoundingClientRect().top + scrollY - innerHeight - 400, behavior: "instant" }));
          await page.waitForFunction(id => document.querySelector(`.image-card[data-image-id="${id}"] img`)?.fetchPriority === "low", id);
          await target.evaluate(card => scrollTo({ top: card.getBoundingClientRect().top + scrollY - innerHeight + 100, behavior: "instant" }));
          await page.waitForFunction(id => document.querySelector(`.image-card[data-image-id="${id}"] img`)?.fetchPriority === "high", id);
          assert(!(await target.locator("img").evaluate(img => getComputedStyle(img).transitionProperty)).includes("opacity"),
            "visible images appear immediately without an extra fade");
          gate.resolve();
          await target.locator("img.loaded").waitFor();
          assert.equal(promotedRequests, 1, "promoting a thumbnail must reuse its pending download");
        } finally { gate.resolve(); }
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log(JSON.stringify(results, null, 2));
  if (process.env.PIXHELF_WATERFALL_REPORT) await writeFile(process.env.PIXHELF_WATERFALL_REPORT, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
