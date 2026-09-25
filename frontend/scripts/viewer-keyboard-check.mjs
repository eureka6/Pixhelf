import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx", contents: `
      import { render } from "preact";
      import { useMemo, useRef, useState } from "preact/hooks";
      import { ImageViewer } from "./src/ImageViewer";
      function Session({ session, count: initialCount = 64, index: initialIndex = 10, more = false }) {
        const [count, setCount] = useState(initialCount);
        const [index, setIndex] = useState(initialIndex);
        const [hasMore, setHasMore] = useState(more);
        const [loadingMore, setLoadingMore] = useState(false);
        const [closed, setClosed] = useState(false);
        const job = useRef(null);
        const currentIndex = useRef(index);
        currentIndex.current = index;
        const images = useMemo(() => Array.from({ length: count }, (_, i) => ({
          id: "keyboard-" + session + "-" + i, name: "photo-" + i + ".jpg", width: 1200, height: 900,
        })), [session, count]);
        const loadMore = () => {
          if (job.current) return job.current;
          window.pageRequests++;
          setLoadingMore(true);
          job.current = new Promise((resolve, reject) => {
            window.finishPage = (fail = false) => {
              job.current = null;
              setLoadingMore(false);
              if (fail) { reject(new Error("fixture pagination failed")); return; }
              setCount(count + 20); setHasMore(false);
              resolve(Array.from({ length: 20 }, (_, i) => ({ id: "incoming-" + i })));
            };
          });
          return job.current;
        };
        return closed ? null : <ImageViewer images={images} activeIndex={index}
          hasMore={hasMore} loadingMore={loadingMore} onLoadMoreImages={loadMore}
          onNavigate={(direction, signal) => {
            const show = next => {
              window.navigationEvents.push({ direction, index: next, time: performance.now() });
              currentIndex.current = next;
              setIndex(next);
            };
            const next = index + direction;
            if (next < 0 || next >= count) {
              window.unloadedNavigations++;
              if (direction > 0 && hasMore) void loadMore().then(incoming => {
                if (incoming.length && !signal?.aborted && currentIndex.current === index) show(next);
              }, () => {});
              return;
            }
            show(next);
          }}
          onClose={() => setClosed(true)} similarActive={false} similarImages={[]} similarTotal={0}
          similarHasMore={false} similarLoading={false} similarLoadingMore={false} similarError={null}
          onSearchSimilar={() => {}} onSearchVideoFrame={() => {}} onLoadMoreSimilar={() => {}} onOpenImage={() => {}} />;
      }
      function Fixture() {
        const [config, setConfig] = useState({ session: 0 });
        window.resetViewer = (options = {}) => {
          window.navigationEvents = []; window.pageRequests = 0; window.unloadedNavigations = 0;
          const session = config.session + 1;
          setConfig({ ...options, session });
          return session;
        };
        return <Session key={config.session} {...config} />;
      }
      window.navigationEvents = []; window.pageRequests = 0; window.unloadedNavigations = 0;
      render(<Fixture />, document.getElementById("root"));
    `,
  },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", jsxImportSource: "preact",
  define: { "import.meta.env.DEV": "true", "import.meta.url": '"https://viewer.test/assets/app.js"' },
});
const photo = readFileSync(new URL("./fixtures/live-photo.jpg", import.meta.url));
const css = ["styles.css", "photoCardActions.css", "selection.css", "PhotoInformation.css", "video.css"]
  .map(file => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).join("\n");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.route("**/*", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <script id="pixhelf-auth" type="application/json">{"enabled":false,"authenticated":false}</script><div id="root"></div>` });
    if (/\/(thumbnail|original)$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: photo });
    return route.fulfill({ json: { fileSize: photo.length, modifiedMs: 0, exif: [], histogram: null } });
  });
  await page.goto("https://viewer.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForSelector(".image-viewer");
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  const advance = milliseconds => page.clock.runFor(milliseconds);
  const events = () => page.evaluate(() => window.navigationEvents);
  const reset = async (options = {}) => {
    await page.keyboard.up("ArrowLeft"); await page.keyboard.up("ArrowRight");
    await page.evaluate(options => window.resetViewer(options), options);
    await advance(200);
    await page.locator(".image-viewer").focus();
  };
  const beginHold = async () => {
    await page.keyboard.down("ArrowRight");
    await advance(400);
    await page.keyboard.down("ArrowRight");
    await advance(1);
  };
  const check = async (name, action) => {
    await reset();
    await action();
    assert.deepEqual(errors, [], "the real viewer must run without browser errors");
    checks++;
    console.log(`${name} passed`);
  };

  await check("taps and reversal respond immediately without starting a repeat timer", async () => {
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    assert.deepEqual((await events()).map(event => event.direction), [1, 1, -1]);
    await advance(1000);
    assert.equal((await events()).length, 3, "released taps must never repeat");
    await page.keyboard.down("ArrowRight");
    await advance(800);
    assert.equal((await events()).length, 4, "respect the OS delay before its first repeated keydown");
    await page.keyboard.up("ArrowRight");
  });

  await check("holding accelerates smoothly with a bounded speed despite dense OS repeats", async () => {
    await beginHold();
    for (let elapsed = 0; elapsed < 2800; elapsed += 20) {
      await page.keyboard.down("ArrowRight");
      await advance(20);
    }
    const steps = await events();
    const gaps = steps.slice(2).map((event, i) => event.time - steps[i + 1].time);
    assert(steps.length >= 14 && steps.length <= 19, `a hold should browse at a controlled speed, got ${steps.length}`);
    assert(gaps.every(gap => gap >= 159 && gap <= 241), `repeat intervals stay bounded: ${gaps}`);
    assert(gaps[0] >= 230 && gaps.at(-1) <= 170, "the hold starts gently and reaches a faster cruise speed");
    assert(gaps.every((gap, i) => !i || gap <= gaps[i - 1] + 1), "acceleration must survive every component rerender");
    await page.keyboard.up("ArrowRight");
    await advance(800);
    assert.equal((await events()).length, steps.length, "release discards excess repeats instead of draining a queue");
    console.log(`  observed repeat gaps: ${gaps.map(Math.round).join(", ")} ms`);
  });

  await check("reversing a held arrow responds immediately and ignores the old key", async () => {
    await beginHold(); await advance(800);
    const before = (await events()).length;
    await page.keyboard.down("ArrowLeft");
    assert.equal((await events()).length, before + 1);
    assert.equal((await events()).at(-1).direction, -1);
    await page.keyboard.down("ArrowRight"); // Still held: this is an old-direction repeat.
    await page.keyboard.up("ArrowRight");
    await advance(400); await page.keyboard.down("ArrowLeft"); await advance(500);
    assert((await events()).slice(before).every(event => event.direction === -1));
    assert((await events()).length > before + 1, "releasing the old key must not cancel the new hold");
    await page.keyboard.up("ArrowLeft");
  });

  await check("pagination pauses a hold and release prevents a delayed jump", async () => {
    await reset({ count: 6, index: 3, more: true });
    await beginHold(); await advance(1000);
    assert.equal((await events()).at(-1).index, 5);
    assert.equal(await page.evaluate(() => window.pageRequests), 1);
    assert.equal(await page.evaluate(() => window.unloadedNavigations), 0, "repeats must not queue navigation into an unloaded page");
    await page.keyboard.up("ArrowRight");
    await page.evaluate(() => window.finishPage());
    await advance(1000);
    assert.equal((await events()).at(-1).index, 5, "finishing a page after release must not change the photo");
  });

  await check("pagination resumes gently only while the same key remains held", async () => {
    await reset({ count: 6, index: 3, more: true });
    await beginHold(); await advance(1500);
    await page.evaluate(() => window.finishPage());
    await advance(1000);
    const resumed = (await events()).filter(event => event.index >= 6);
    assert(resumed.length >= 3 && resumed.length <= 5, "continue browsing after the page arrives without catching up the wait");
    assert(resumed[1].time - resumed[0].time >= 220, "restart at a gentle pace after the network pause");
    await page.keyboard.up("ArrowRight");
  });

  await check("starting a hold at the page boundary cancels its pending turn on release", async () => {
    await reset({ count: 6, index: 5, more: true });
    await beginHold(); await advance(500);
    await page.keyboard.up("ArrowRight");
    await page.evaluate(() => window.finishPage());
    await advance(1000);
    assert.deepEqual(await events(), [], "even the initial page turn must be cancelled once the press becomes a hold");
    assert.equal(await page.evaluate(() => window.pageRequests), 1);
  });

  await check("a single tap at the page boundary still completes its requested turn", async () => {
    await reset({ count: 6, index: 5, more: true });
    await page.keyboard.press("ArrowRight");
    await page.evaluate(() => window.finishPage());
    await advance(1000);
    assert.deepEqual((await events()).map(event => event.index), [6]);
  });

  for (const reason of ["blur", "close", "reverse"]) {
    await check(`${reason} cancels a released tap still waiting for a page`, async () => {
      await reset({ count: 6, index: 5, more: true });
      await page.keyboard.press("ArrowRight");
      if (reason === "reverse") await page.keyboard.press("ArrowLeft");
      else await page.evaluate(reason => {
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        else document.querySelector(".viewer-close").click();
      }, reason);
      const before = await events();
      await page.evaluate(() => window.finishPage());
      await advance(1000);
      assert.deepEqual(await events(), before, "an interrupted tap must not navigate when its page finally arrives");
    });
  }

  await check("reversal during pagination cancels the previous direction's continuation", async () => {
    await reset({ count: 6, index: 3, more: true });
    await beginHold(); await advance(500);
    await page.keyboard.press("ArrowLeft");
    const before = await events();
    assert.equal(before.at(-1).index, 4);
    await page.evaluate(() => window.finishPage());
    await advance(1000);
    assert.deepEqual(await events(), before);
    await page.keyboard.up("ArrowRight");
  });

  await check("a failed page stops the hold without automatic retry floods", async () => {
    await reset({ count: 6, index: 3, more: true });
    await beginHold(); await advance(500);
    await page.evaluate(() => window.finishPage(true));
    await advance(2000);
    assert.equal(await page.evaluate(() => window.pageRequests), 1);
    assert.equal((await events()).at(-1).index, 5);
    await page.keyboard.up("ArrowRight");
  });

  await check("the actual list end stops repetition", async () => {
    await reset({ count: 6, index: 3 });
    await beginHold(); await advance(2000);
    assert.deepEqual((await events()).map(event => event.index), [4, 5]);
    assert.equal(await page.evaluate(() => window.unloadedNavigations), 0);
    await page.keyboard.up("ArrowRight");
  });

  for (const reason of ["blur", "hidden", "input", "pointer", "close"]) {
    await check(`${reason} cancels an active hold`, async () => {
      await beginHold(); await advance(300);
      const before = await events();
      await page.evaluate(reason => {
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        if (reason === "hidden") {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          document.dispatchEvent(new Event("visibilitychange"));
        }
        if (reason === "input") {
          const input = document.createElement("input");
          document.querySelector(".image-viewer").append(input); input.focus();
        }
        if (reason === "pointer") window.dispatchEvent(new PointerEvent("pointerdown"));
        if (reason === "close") document.querySelector(".viewer-close").click();
      }, reason);
      await page.keyboard.down("ArrowRight");
      await advance(1000);
      assert.deepEqual(await events(), before, "stale repeat events must not restart a cancelled hold");
      await page.keyboard.up("ArrowRight");
      if (reason === "hidden") await page.evaluate(() => { delete document.hidden; });
    });
  }
} finally { await browser.close(); }
console.log(`${checks} viewer keyboard checks passed without starting a server.`);
