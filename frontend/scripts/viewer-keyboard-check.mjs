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
const css = ["base.css", "styles.css", "photoCardActions.css", "selection.css", "PhotoInformation.css", "video.css"]
  .map(file => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).join("\n");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.route("**/*", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <script id="pixhelf-auth" type="application/json">{"enabled":false,"authenticated":false}</script><div id="root"></div>` });
    if (/\/thumbnail$|\/api\/images\/[^/]+\.jpg$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: photo });
    return route.fulfill({ json: { fileSize: photo.length, modifiedMs: 0, exif: [], histogram: null } });
  });
  await page.goto("https://viewer.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForSelector(".image-viewer");
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  const advance = milliseconds => page.clock.runFor(milliseconds);
  const events = () => page.evaluate(() => window.navigationEvents);
  const mouseSession = await page.context().newCDPSession(page);
  const sideButton = (type, button = "forward", buttons = type === "mousePressed" ? (button === "forward" ? 16 : 8) : 0) => mouseSession.send(
    "Input.dispatchMouseEvent", { type, x: 720, y: 450, button, buttons, clickCount: 1 },
  );
  const reset = async (options = {}) => {
    await page.keyboard.up("ArrowLeft"); await page.keyboard.up("ArrowRight");
    await page.evaluate(options => window.resetViewer(options), options);
    await advance(200);
    await page.locator(".image-viewer").focus();
  };
  const beginHold = async () => {
    await page.keyboard.down("ArrowRight");
    await advance(501);
  };
  const check = async (name, action) => {
    await reset();
    await action();
    assert.deepEqual(errors, [], "the real viewer must run without browser errors");
    checks++;
    console.log(`${name} passed`);
  };

  await check("taps and reversal respond immediately and release prevents repetition", async () => {
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    assert.deepEqual((await events()).map(event => event.direction), [1, 1, -1]);
    await advance(1000);
    assert.equal((await events()).length, 3, "released taps must never repeat");
    await page.keyboard.down("ArrowRight");
    await advance(399);
    assert.equal((await events()).length, 4, "the hold threshold must protect deliberate single steps");
    await advance(2);
    assert.equal((await events()).length, 5, "holding must work without an OS-generated repeat");
    await page.keyboard.up("ArrowRight");
  });

  await check("holding gradually accelerates to six per second despite dense OS repeats", async () => {
    await beginHold();
    for (let elapsed = 0; elapsed < 6000; elapsed += 20) {
      await page.keyboard.down("ArrowRight");
      await advance(20);
    }
    const steps = await events();
    const gaps = steps.slice(2).map((event, i) => event.time - steps[i + 1].time);
    assert(steps.length >= 32 && steps.length <= 37, `a hold should browse at a controlled speed, got ${steps.length}`);
    assert(gaps.every(gap => gap >= 169), `repetition must never exceed about six per second: ${gaps}`);
    assert(steps[1].time - steps[0].time >= 350, "the initial hold delay protects single steps");
    assert(gaps[0] > 250 && gaps[0] < 400, "repetition starts slower than its maximum speed");
    assert(gaps.slice(1).every((gap, i) => gap <= gaps[i]), "acceleration is gradual and never reverses");
    assert(gaps.slice(-10).every(gap => gap <= 171), "a sustained hold settles at about six per second");
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

  await check("pagination resumes at the same cadence only while the same key remains held", async () => {
    await reset({ count: 6, index: 3, more: true });
    await beginHold(); await advance(1500);
    await page.evaluate(() => window.finishPage());
    await advance(1600);
    const resumed = (await events()).filter(event => event.index >= 6);
    assert(resumed.length >= 5 && resumed.length <= 7, "continue browsing after the page arrives without catching up the wait");
    assert(resumed[1].time - resumed[0].time >= 250, "waiting for a page must not accelerate the hold");
    assert(resumed.slice(1).every((event, i) => event.time - resumed[i].time >= 169), "pagination never produces a catch-up burst");
    await page.keyboard.up("ArrowRight");
  });

  await check("a fully accelerated hold resumes after pagination without a burst", async () => {
    await reset({ count: 16, index: 3, more: true });
    await page.keyboard.down("ArrowRight"); await advance(4000);
    assert.equal((await events()).at(-1).index, 15);
    assert.equal(await page.evaluate(() => window.pageRequests), 1);
    await page.evaluate(() => window.finishPage());
    await advance(1500);
    const resumed = (await events()).filter(event => event.index >= 16);
    assert(resumed.length >= 8 && resumed.length <= 9);
    assert(resumed.slice(1).every((event, i) => event.time - resumed[i].time === 170));
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
    await beginHold(); await advance(800);
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
    await beginHold(); await advance(800);
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

  await check("edge holds and both mouse side buttons share keyboard acceleration without release clicks", async () => {
    await page.keyboard.down("ArrowRight"); await advance(4800); await page.keyboard.up("ArrowRight");
    const keyboard = (await events()).slice(1);
    await reset();
    const edge = await page.locator(".viewer-next").boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down(); await advance(4800);
    const pointer = await events();
    assert.equal(pointer.length, keyboard.length);
    assert.deepEqual(pointer.map(event => event.time - pointer[0].time), keyboard.map(event => event.time - keyboard[0].time));
    await page.mouse.up(); await advance(1500);
    assert.equal((await events()).length, pointer.length, "release must not add a final step");
    await reset();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 }] });
    await advance(4800);
    const touch = await events();
    assert.equal(touch.length, keyboard.length);
    assert.deepEqual(touch.map(event => event.time - touch[0].time), keyboard.map(event => event.time - keyboard[0].time));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await advance(1500);
    assert.equal((await events()).length, touch.length);
    await cdp.detach();
    for (const button of ["forward", "back"]) {
      await reset({ count: 120, index: 50 });
      await sideButton("mousePressed", button);
      assert.equal((await events()).length, 1, "side buttons respond immediately on press");
      const prevented = await page.evaluate(button => {
        const event = new MouseEvent("mousedown", {
          bubbles: true, cancelable: true, button: button === "forward" ? 4 : 3, buttons: button === "forward" ? 16 : 8,
        });
        document.querySelector(".viewer-media").dispatchEvent(event);
        return event.defaultPrevented;
      }, button);
      assert(prevented, "compatibility events cannot trigger browser history navigation");
      assert.equal((await events()).length, 1, "compatibility mousedown after a render must not turn twice");
      await advance(4800);
      const side = (await events()).slice(1);
      assert.equal(side.length, keyboard.length);
      assert.deepEqual(side.map(event => event.time - side[0].time), keyboard.map(event => event.time - keyboard[0].time));
      assert(side.every(event => event.direction === (button === "forward" ? 1 : -1)));
      await sideButton("mouseReleased", button); await advance(1500);
      assert.equal((await events()).length, side.length + 1);
    }
  });

  await check("opposite side buttons transfer ownership even with another button still pressed", async () => {
    await sideButton("mousePressed"); await advance(900);
    const before = (await events()).length;
    await sideButton("mousePressed", "back", 24);
    assert.equal((await events()).length, before + 1, "chorded side buttons work without a new pointerdown");
    await sideButton("mouseReleased", "forward", 8);
    await advance(1200);
    assert((await events()).length > before + 2, "releasing the old button must not cancel the new hold");
    assert((await events()).slice(before).every(event => event.direction === -1));
    await sideButton("mouseReleased", "back");
    const after = await events(); await advance(1000);
    assert.deepEqual(await events(), after);
  });

  await check("side buttons and keys cancel the previous input without stale release turns", async () => {
    await sideButton("mousePressed"); await advance(900);
    const before = (await events()).length;
    await page.keyboard.down("ArrowLeft");
    await sideButton("mouseReleased"); await advance(1000);
    assert((await events()).slice(before).every(event => event.direction === -1));
    assert((await events()).length > before + 2);
    const reversed = (await events()).length;
    await sideButton("mousePressed"); await page.keyboard.up("ArrowLeft"); await advance(1000);
    assert((await events()).slice(reversed).every(event => event.direction === 1));
    assert((await events()).length > reversed + 2);
    await sideButton("mouseReleased");
  });

  for (const hold of [false, true]) await check(`a side-button ${hold ? "hold cancels" : "tap completes"} a pending page turn on release`, async () => {
    await reset({ count: 6, index: 5, more: true });
    await sideButton("mousePressed");
    if (hold) await advance(1000);
    await sideButton("mouseReleased");
    await page.evaluate(() => window.finishPage()); await advance(1000);
    assert.deepEqual((await events()).map(event => event.index), hold ? [] : [6]);
    assert.equal(await page.evaluate(() => window.pageRequests), 1);
  });

  for (const reason of ["blur", "hidden", "pagehide", "pointercancel", "close"]) await check(`${reason} cancels a mouse side-button hold`, async () => {
    await sideButton("mousePressed"); await advance(1000);
    const before = await events();
    await page.evaluate(reason => {
      if (reason === "close") document.querySelector(".viewer-close").click();
      else if (reason === "hidden") {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      } else window.dispatchEvent(new Event(reason));
    }, reason);
    await advance(1000); await sideButton("mouseReleased"); await advance(1000);
    assert.deepEqual(await events(), before);
    if (reason === "hidden") await page.evaluate(() => { delete document.hidden; });
  });

  await check("releasing an edge hold during pagination cancels delayed navigation", async () => {
    await reset({ count: 6, index: 5, more: true });
    const edge = await page.locator(".viewer-next").boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.down(); await advance(600);
    assert.equal(await page.evaluate(() => window.pageRequests), 1);
    await page.mouse.up();
    await page.evaluate(() => window.finishPage()); await advance(1500);
    assert.deepEqual(await events(), []);
  });

  const edgePoint = async () => {
    const rect = await page.locator(".viewer-next").boundingBox();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  await check("touch edge turns immediately with no queued double-tap delay", async () => {
    const point = await edgePoint();
    await page.touchscreen.tap(point.x, point.y);
    assert.deepEqual((await events()).map(event => event.direction), [1], "release must turn before any timer advances");
    await advance(400);
    assert.equal((await events()).length, 1);
  });
  await check("two rapid edge taps turn twice without zooming", async () => {
    const point = await edgePoint();
    await page.touchscreen.tap(point.x, point.y); await advance(140);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, ...point }] });
    await advance(90);
    assert.equal((await events()).length, 1);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.deepEqual((await events()).map(event => event.direction), [1, 1]);
    await advance(300);
    assert.equal(await page.locator('.viewer-media').evaluate(element => new DOMMatrix(element.style.transform).a), 1);
    await cdp.detach();
  });
  await check("center double tap still zooms without navigation", async () => {
    await page.touchscreen.tap(720, 450); await advance(120);
    await page.touchscreen.tap(720, 450);
    assert.equal(await page.locator('.viewer-media').evaluate(element => new DOMMatrix(element.style.transform).a), 2.5);
    assert.deepEqual(await events(), []);
  });
  await check("disabled side zones absorb taps and are skipped by keyboard focus", async () => {
    await reset({ count: 1, index: 0 });
    for (const selector of [".viewer-previous", ".viewer-next"]) {
      const button = page.locator(selector);
      assert.equal(await button.getAttribute("aria-disabled"), "true");
      assert.equal(await button.getAttribute("tabindex"), "-1");
      const rect = await button.boundingBox();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      assert.equal(await page.evaluate(({ selector, point }) => document.querySelector(selector).contains(
        document.elementFromPoint(point.x, point.y)), { selector, point }), true);
      await page.touchscreen.tap(point.x, point.y); await advance(80);
      await page.touchscreen.tap(point.x, point.y);
    }
    await advance(600);
    assert.deepEqual(await events(), []);
    assert.equal(await page.locator('.viewer-media').evaluate(element => new DOMMatrix(element.style.transform).a), 1);
    await page.locator('.viewer-close').focus(); await page.keyboard.press("Tab");
    assert.equal(await page.locator('.viewer-media').evaluate(element => element === document.activeElement), true);
  });
  for (const reason of ["blur", "key", "close"]) {
    await check(`${reason} after an edge tap leaves no queued step`, async () => {
      const point = await edgePoint();
      await page.touchscreen.tap(point.x, point.y);
      assert.deepEqual((await events()).map(event => event.direction), [1]);
      if (reason === "key") await page.keyboard.press("ArrowLeft");
      else if (reason === "close") await page.locator('.viewer-close').click();
      else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await advance(300);
      assert.deepEqual((await events()).map(event => event.direction), reason === "key" ? [1, -1] : [1]);
    });
  }

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
