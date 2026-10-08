import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Use Vite's bundler dependency to exercise the real component without a server.
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const frontend = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({
  stdin: {
    resolveDir: frontend, loader: "tsx", contents: `
      import { render } from "preact";
      import { useState } from "preact/hooks";
      import { ImageViewer } from "./src/ImageViewer";
      window.navigationEvents = [];
      function Fixture() {
        const [session, setSession] = useState(0);
        const [index, setIndex] = useState(4);
        const [closed, setClosed] = useState(false);
        window.resetViewer = () => {
          window.navigationEvents = [];
          setIndex(4); setClosed(false); setSession(s => s + 1);
          return session + 1;
        };
        const images = Array.from({ length: 32 }, (_, i) => ({
          id: "fixture-" + session + "-" + i, name: "photo-" + i + ".jpg", width: 1200, height: 900,
        }));
        return closed ? null : <ImageViewer key={session} images={images} activeIndex={index}
          hasMore={false} loadingMore={false} onLoadMoreImages={async () => []}
          onNavigate={direction => { window.navigationEvents.push(direction); setIndex(i => i + direction); }}
          onClose={() => setClosed(true)} similarActive={false} similarImages={[]} similarTotal={0}
          similarHasMore={false} similarLoading={false} similarLoadingMore={false} similarError={null}
          onSearchSimilar={() => {}} onSearchVideoFrame={() => {}} onLoadMoreSimilar={() => {}} onOpenImage={() => {}} />;
      }
      render(<Fixture />, document.getElementById("root"));
    `,
  },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", jsxImportSource: "preact",
  define: { "import.meta.env.DEV": "true", "import.meta.url": '"https://viewer.test/assets/app.js"' },
});
const css = ["base.css", "styles.css", "photoCardActions.css", "selection.css", "PhotoInformation.css", "video.css"]
  .map(file => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).join("\n");
const photo = readFileSync(new URL("./fixtures/live-photo.jpg", import.meta.url));
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const failures = [];
let checks = 0;
try {
  for (const touch of process.argv.includes("--mouse") ? [false] : [false, true]) {
    const width = touch ? 390 : 1440;
    const page = await browser.newPage({ viewport: { width, height: touch ? 844 : 900 }, hasTouch: touch, isMobile: touch });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <script id="pixhelf-auth" type="application/json">{"enabled":false,"authenticated":false}</script><div id="root"></div>` });
      if (/\/thumbnail$|\/api\/images\/[^/]+\.jpg$/.test(path)) return route.fulfill({ contentType: "image/jpeg", body: photo });
      return route.fulfill({ json: { fileSize: photo.length, modifiedMs: 0, exif: [], histogram: null } });
    });
    await page.goto("https://viewer.test/");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const cdp = touch ? await page.context().newCDPSession(page) : null;
    let touching = false;
    const dispatchTouch = async (type, points = []) => {
      if (type === "touchCancel" && !touching) return;
      await cdp.send("Input.dispatchTouchEvent", {
        type, touchPoints: points.map((point, i) => ({ id: i + 1, radiusX: 1, radiusY: 1, force: 1, ...point })),
      });
      touching = type !== "touchCancel" && points.length > 0;
    };
    const center = { x: width / 2, y: touch ? 422 : 450 };
    const begin = async (point = center) => {
      if (touch) await dispatchTouch("touchStart", [point]);
      else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
    };
    const move = async point => {
      if (touch) await dispatchTouch("touchMove", [point]);
      else await page.mouse.move(point.x, point.y);
    };
    const end = async () => { if (touch) { if (touching) await dispatchTouch("touchEnd"); } else await page.mouse.up(); };
    const tap = async (point = center) => { await begin(point); await end(); };
    const state = () => page.evaluate(() => {
      const viewer = document.querySelector(".image-viewer"), media = document.querySelector(".viewer-media");
      const style = getComputedStyle(media), matrix = new DOMMatrix(style.transform);
      return { scale: matrix.a, x: matrix.e, y: matrix.f, dragging: viewer.dataset.dragging,
        willChange: style.willChange, scroll: viewer.scrollTop, events: [...window.navigationEvents] };
    });
    const watch = () => page.evaluate(() => {
      window.viewerControlFrames = [];
      const sample = () => {
        const elements = [".viewer-header", ".viewer-close", ".viewer-previous", ".viewer-next"];
        window.viewerControlFrames.push(elements.map(selector => {
          const el = document.querySelector(selector), bounds = el.getBoundingClientRect();
          return { opacity: Number(getComputedStyle(el).opacity), x: bounds.x, y: bounds.y, width: bounds.width };
        }));
        window.viewerControlFrame = requestAnimationFrame(sample);
      };
      sample();
    });
    const stableControls = async () => {
      const frames = await page.evaluate(() => {
        cancelAnimationFrame(window.viewerControlFrame);
        return window.viewerControlFrames;
      });
      assert(frames.length > 2, "controls were sampled throughout the gesture");
      assert(frames.flat().every(frame => frame.opacity > .99), "image gestures must not fade viewer controls");
      for (const frame of frames) frame.forEach((control, i) => {
        assert(Math.abs(control.x - frames[0][i].x) <= 1 && Math.abs(control.y - frames[0][i].y) <= 1,
          "image gestures must not move viewer controls");
      });
    };
    const check = async (name, action) => {
      try {
        if (touch) await dispatchTouch("touchCancel"); else await page.mouse.up();
        await page.evaluate(() => cancelAnimationFrame(window.viewerControlFrame));
        const session = await page.evaluate(() => window.resetViewer());
        await page.waitForSelector(`.image-viewer[data-image-id="fixture-${session}-4"][data-full-loaded="true"]`);
        await page.waitForTimeout(240);
        await action();
        assert.deepEqual(errors, []);
        checks++;
        console.log(`${touch ? "touch" : "mouse"}: ${name} passed`);
      } catch (error) {
        const message = `${touch ? "touch" : "mouse"}: ${name}: ${error.message}`;
        failures.push(message); console.error(message);
      }
    };

    await check("toolbar changes center the image on the next frame", async () => {
      // Headless browsers have no toolbar: keep the small viewport fixed while
      // the visible viewport changes, including a height below the image frame.
      const style = await page.addStyleTag({ content: `
        @media (hover: none) and (pointer: coarse) {
          .viewer-image-frame { height: calc(100svh - 64px); }
        }
      ` });
      try {
        await page.waitForTimeout(240);
        const samples = await page.evaluate(async () => {
          const viewport = visualViewport;
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          const viewer = document.querySelector(".image-viewer");
          const media = document.querySelector(".viewer-media");
          const canvas = document.querySelector(".viewer-original-canvas");
          const source = canvas?.dataset.renderedSource;
          const dimensions = canvas && [canvas.width, canvas.height];
          const fullHeight = viewport.height;
          let height = fullHeight, top = 0;
          Object.defineProperties(viewport, {
            height: { configurable: true, get: () => height },
            offsetTop: { configurable: true, get: () => top },
          });
          const samples = [];
          try {
            for (const hidden of [16, 48, 64, 96, 128, 96, 64, 32, 0]) {
              height = fullHeight - hidden;
              viewport.dispatchEvent(new Event("resize"));
              await frame();
              const bounds = media.getBoundingClientRect();
              samples.push({ event: "resize", height, error: (bounds.top + bounds.bottom) / 2 - height / 2 });
            }
            height = fullHeight - 128;
            viewport.dispatchEvent(new Event("resize"));
            await frame();
            for (top of [24, 48, 0]) {
              viewport.dispatchEvent(new Event("scroll"));
              await frame();
              const bounds = media.getBoundingClientRect();
              samples.push({ event: "scroll", top, error: (bounds.top + bounds.bottom) / 2 - (top + height / 2) });
            }
            if (canvas && (canvas !== document.querySelector(".viewer-original-canvas")
              || canvas.dataset.renderedSource !== source
              || canvas.width !== dimensions[0] || canvas.height !== dimensions[1])) {
              throw new Error("toolbar changes replaced or resized the bitmap");
            }
            if (viewer.scrollTop !== 0) throw new Error("toolbar changes scrolled into details");
            return samples;
          } finally {
            delete viewport.height;
            delete viewport.offsetTop;
            viewport.dispatchEvent(new Event("resize"));
            await frame();
          }
        });
        for (const sample of samples) assert(Math.abs(sample.error) < 1, JSON.stringify(sample));
      } finally {
        await style.evaluate(element => element.remove());
      }
    });

    await check("rotation and fullscreen changes keep the image centered", async () => {
      const initialViewport = page.viewportSize();
      const style = await page.addStyleTag({ content: `
        @media (hover: none) and (pointer: coarse) {
          .viewer-image-frame { height: calc(100svh - 64px); }
        }
      ` });
      const centered = async () => {
        const error = await page.evaluate(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const bounds = document.querySelector(".viewer-media").getBoundingClientRect();
          return (bounds.top + bounds.bottom) / 2 - (visualViewport.offsetTop + visualViewport.height / 2);
        });
        assert(Math.abs(error) < 1, `image center is off by ${error}px`);
      };
      try {
        for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          await centered();
          await page.locator(".image-viewer").evaluate(viewer => viewer.requestFullscreen());
          await centered();
          await page.evaluate(() => document.exitFullscreen());
          await centered();
        }
      } finally {
        await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
        await style.evaluate(element => element.remove());
        await page.setViewportSize(initialViewport);
      }
    });

    await check("viewport changes during contact recenter immediately on release", async () => {
      const before = await page.locator(".viewer-media").boundingBox();
      try {
        await begin();
        await page.evaluate(async () => {
          const height = visualViewport.height - 100;
          Object.defineProperty(visualViewport, "height", { configurable: true, get: () => height });
          visualViewport.dispatchEvent(new Event("resize"));
          await new Promise(resolve => requestAnimationFrame(resolve));
        });
        const held = await page.locator(".viewer-media").boundingBox();
        assert.equal(held.y, before.y, "viewport changes must not move the image under the pointer");
        await end();
        const error = await page.evaluate(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const bounds = document.querySelector(".viewer-media").getBoundingClientRect();
          return (bounds.top + bounds.bottom) / 2 - visualViewport.height / 2;
        });
        assert(Math.abs(error) < 1, `image did not recenter on release: ${error}px`);
      } finally {
        await end();
        await page.evaluate(() => {
          delete visualViewport.height;
          visualViewport.dispatchEvent(new Event("resize"));
        });
      }
    });

    await check("double zoom keeps controls steady", async () => {
      await page.keyboard.press("="); await page.waitForTimeout(240);
      await watch();
      await begin(); await page.waitForTimeout(100);
      assert.equal((await state()).willChange, "auto", "stationary contact is not a drag");
      await end();
      if (touch) { await begin(); await page.waitForTimeout(70); await end(); }
      else await page.mouse.dblclick(center.x, center.y, { delay: 70 });
      await page.waitForTimeout(250);
      // Chromium may start the CSS transition a frame later than the input.
      // Keep the exact final-scale assertion, but wait for the animation to settle.
      await page.waitForFunction(() => {
        const media = document.querySelector(".viewer-media");
        return media && new DOMMatrix(getComputedStyle(media).transform).a === 1;
      });
      await stableControls();
      assert.equal((await state()).scale, 1);
    });

    await check("zoomed pan keeps controls steady", async () => {
      await page.keyboard.press("="); await page.keyboard.press("="); await page.waitForTimeout(240);
      await watch(); await begin(); await move({ x: center.x - 90, y: center.y + 25 });
      await page.waitForTimeout(120);
      assert((await state()).x < -50, "zoomed image follows the pointer");
      assert.equal((await state()).willChange, "transform");
      await end(); await page.waitForTimeout(160); await stableControls();
      assert.deepEqual((await state()).events, []);
    });

    await check("window blur cancels gestures", async () => {
      await begin(); await move({ x: center.x - 90, y: center.y }); await page.waitForTimeout(40);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.waitForTimeout(250);
      const cancelled = await state();
      assert.equal(cancelled.dragging, "false"); assert(Math.abs(cancelled.x) < 1);
      await end(); assert.deepEqual((await state()).events, []);
    });

    await check("side taps are immediate and moving into the center does not drag the image", async () => {
      const next = await page.locator(".viewer-next").boundingBox();
      const point = { x: next.x + next.width - 20, y: center.y };
      await tap(point);
      assert.deepEqual((await state()).events, [1]);
      await begin(point); await move({ x: point.x - 230, y: point.y }); await page.waitForTimeout(40);
      assert.equal((await state()).x, 0); assert.equal((await state()).dragging, "false");
      await end(); await page.waitForTimeout(250);
      assert.deepEqual((await state()).events, [1, 1], "the starting zone owns the entire contact");
    });

    await check("interrupted close press recovers", async () => {
      const close = await page.locator(".viewer-close").boundingBox();
      await begin({ x: close.x + close.width / 2, y: close.y + close.height / 2 });
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      assert.equal(await page.locator('.viewer-close[data-pressed="true"]').count(), 0);
      if (touch) await dispatchTouch("touchCancel");
      else { await page.mouse.move(center.x, center.y); await page.mouse.up(); }
      await page.locator(".viewer-close").click();
      assert.equal(await page.locator(".image-viewer").count(), 0);
    });

    await check("edge hold repeats across image changes and stops on release", async () => {
      const point = { x: width - 20, y: center.y };
      await begin(point); await page.waitForTimeout(1550);
      const steps = (await state()).events;
      assert(steps.length >= 6 && steps.length <= 8, "the hold should match quick repeated taps without a slow ramp");
      assert.equal(await page.locator(".photo-card-menu:popover-open").count(), 0);
      await end(); await page.waitForTimeout(700);
      assert.deepEqual((await state()).events, steps, "release must not add a click or retain a timer");
    });
    await check("holding while moving across zones keeps the original direction until release", async () => {
      await begin({ x: width - 20, y: center.y });
      await move(center); await page.waitForTimeout(600);
      const first = (await state()).events;
      assert.equal(first.length, 1, "movement before the hold threshold must not cancel the hold");
      await move({ x: 20, y: center.y }); await page.waitForTimeout(400);
      const middle = (await state()).events;
      assert(middle.length >= 3);
      await move({ x: center.x, y: 100 }); await page.waitForTimeout(340);
      const result = await state();
      assert(result.events.length >= middle.length + 1);
      assert(result.events.every(direction => direction === 1), "crossing the opposite zone must not reverse the hold");
      assert.equal(result.scale, 1); assert.equal(result.x, 0); assert.equal(result.scroll, 0);
      assert.equal(await page.locator('.viewer-next[data-pressed="true"]').count(), 1);
      await end(); await page.waitForTimeout(500);
      assert.deepEqual((await state()).events, result.events);
      assert.equal(await page.locator('.viewer-nav[data-pressed="true"]').count(), 0);
    });
    for (const interruption of ["cancel", "blur", "capture", "hidden"]) {
      await check(`${interruption} stops an edge hold without a release click`, async () => {
        await page.locator('.viewer-next').evaluate(button => button.addEventListener('pointerdown', event => {
          window.viewerPointerId = event.pointerId;
        }, { once: true }));
        const point = { x: width - 20, y: center.y };
        await begin(point); await page.waitForTimeout(600);
        const steps = (await state()).events;
        assert.equal(steps.length, 1);
        if (interruption === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        else if (interruption === "hidden") await page.evaluate(() => {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        else if (interruption === "capture") await page.locator('.viewer-next').evaluate(button => {
          button.releasePointerCapture(window.viewerPointerId);
        });
        else if (touch) await dispatchTouch("touchCancel");
        else await page.locator('.viewer-next').evaluate(button => {
          button.dispatchEvent(new PointerEvent("pointercancel", { pointerId: window.viewerPointerId, pointerType: "mouse", bubbles: true }));
        });
        await end(); await page.waitForTimeout(800);
        assert.deepEqual((await state()).events, steps);
        assert.equal(await page.locator('.viewer-nav[data-pressed="true"]').count(), 0);
        if (interruption === "hidden") await page.evaluate(() => { delete document.hidden; });
      });
    }
    if (touch) {
      await check("edge double tap advances twice without zooming", async () => {
        const point = { x: width - 20, y: center.y };
        await tap(point); await page.waitForTimeout(60); await tap(point);
        await page.waitForTimeout(240);
        assert.deepEqual((await state()).events, [1, 1]);
        assert.equal((await state()).scale, 1);
      });
      for (const side of ["previous", "next"]) {
        await check(`${side} zone hides its arrow and navigates when zoomed`, async () => {
          const edge = await page.locator(`.viewer-${side}`).boundingBox();
          assert(edge.height > 250 && edge.width >= 44);
          assert.equal(await page.locator(`.viewer-${side} .viewer-nav-glyph`).isVisible(), false);
          await page.keyboard.press("="); await page.waitForTimeout(240);
          const point = { x: edge.x + edge.width / 2, y: center.y };
          await tap(point);
          assert.deepEqual((await state()).events, [side === "next" ? 1 : -1]);
          await page.waitForTimeout(250);
          assert.equal((await state()).scale, 1);
        });
      }
      await check("image long press still opens the menu without navigating", async () => {
        await begin();
        await page.locator(".viewer-media .photo-card-menu:popover-open").waitFor();
        await end(); await page.waitForTimeout(340);
        assert.deepEqual((await state()).events, []);
        assert.equal(await page.locator(".viewer-media .photo-card-menu:popover-open").count(), 1);
      });
      await check("a second finger cancels an edge hold without a phantom release", async () => {
        const edge = { x: width - 20, y: center.y };
        await begin(edge); await page.waitForTimeout(600);
        const steps = (await state()).events;
        assert.equal(steps.length, 1);
        await dispatchTouch("touchStart", [edge, center]);
        await dispatchTouch("touchEnd"); await page.waitForTimeout(700);
        assert.equal((await state()).scale, 1); assert.deepEqual((await state()).events, steps);
      });
      await check("center upward swipe scrolls to details", async () => {
        const point = center;
        await begin(point);
        for (const distance of [20, 50, 100, 170, 240]) {
          await move({ x: point.x, y: point.y - distance }); await page.waitForTimeout(25);
        }
        await end(); await page.waitForTimeout(340);
        assert((await state()).scroll > 100); assert.deepEqual((await state()).events, []);
      });
      await check("center downward swipe dismisses the viewer", async () => {
        const point = center;
        await begin(point); await move({ x: point.x, y: point.y + 20 });
        await move({ x: point.x, y: point.y + 180 }); await end();
        await page.locator(".image-viewer").waitFor({ state: "detached" });
        assert.deepEqual(await page.evaluate(() => window.navigationEvents), []);
      });
      await check("an immediate side tap and a center swipe each navigate once", async () => {
        await tap({ x: width - 20, y: center.y });
        await begin(center); await move({ x: 20, y: center.y }); await end();
        await page.waitForTimeout(340);
        assert.deepEqual((await state()).events, [1, 1]);
      });
      await check("cancelled tap does not seed a double tap", async () => {
        await tap(); await begin(); await dispatchTouch("touchCancel"); await tap();
        await page.waitForTimeout(250); assert.equal((await state()).scale, 1);
      });
      await check("drag interrupts the double-tap sequence", async () => {
        await tap(); await begin(); await move({ x: center.x - 18, y: center.y });
        await move(center); await end(); await tap();
        await page.waitForTimeout(250); assert.equal((await state()).scale, 1);
      });
      await check("center pinch can cross side zones without navigation", async () => {
        await watch();
        await dispatchTouch("touchStart", [{ x: 155, y: 422 }, { x: 235, y: 422 }]);
        await dispatchTouch("touchMove", [{ x: 20, y: 422 }, { x: 370, y: 422 }]);
        await page.waitForTimeout(80);
        await dispatchTouch("touchEnd", [{ x: 20, y: 422 }]);
        await dispatchTouch("touchMove", [{ x: 60, y: 422 }]);
        await dispatchTouch("touchEnd"); await page.waitForTimeout(250);
        await stableControls(); const result = await state();
        assert(result.scale > 1.8); assert.deepEqual(result.events, []);
      });
    } else {
      await check("unrelated pointer release does not end a drag", async () => {
        await begin(); await move({ x: center.x - 90, y: center.y });
        await page.locator(".viewer-gesture-surface").dispatchEvent("pointerup", {
          pointerType: "pen", pointerId: 99, button: 0, clientX: center.x, clientY: center.y,
        });
        await move({ x: center.x - 230, y: center.y }); await page.waitForTimeout(40);
        assert((await state()).x < -180, "the tracked pointer remains in charge");
        await end(); assert.deepEqual((await state()).events, [1]);
      });
      await check("lost pointer capture cancels the gesture", async () => {
        await page.evaluate(() => document.querySelector(".viewer-gesture-surface").addEventListener("pointerdown", e => {
          window.viewerPointerId = e.pointerId;
        }, { once: true }));
        await begin(); await move({ x: center.x - 90, y: center.y });
        await page.evaluate(() => document.querySelector(".viewer-gesture-surface").releasePointerCapture(window.viewerPointerId));
        await move({ x: center.x - 100, y: center.y }); await page.waitForTimeout(250);
        assert.equal((await state()).dragging, "false"); assert(Math.abs((await state()).x) < 1);
        await end(); assert.deepEqual((await state()).events, []);
      });
      await check("zoomed edge clicks still navigate on desktop", async () => {
        await page.keyboard.press("="); await page.waitForTimeout(240);
        await page.locator(".viewer-next").click();
        assert.deepEqual((await state()).events, [1]);
      });
      await check("double clicking navigation does not zoom", async () => {
        await page.locator(".viewer-next").dblclick(); await page.waitForTimeout(250);
        const result = await state(); assert.equal(result.scale, 1); assert.deepEqual(result.events, [1, 1]);
      });
    }
    await page.close();
  }
} finally { await browser.close(); }
assert.deepEqual(failures, [], `${failures.length} viewer interaction checks failed`);
console.log(`${checks} viewer interaction checks passed without starting a server.`);
