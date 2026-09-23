// Compare displayed Live Photo pixels with FFmpeg's correctly oriented poster.
// Local generated samples and in-memory routes only; no HTTP/app server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { launchBrowser, serveLibmediaAsset, serveMotion } from "./live-photo-fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "pixhelf-orientation-"));
const forceFallback = process.argv.includes("--fallback");
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 60000, stdio: "pipe" });
let browser;
async function difference(page, actual, sample, mime = "image/png") {
  return page.evaluate(async ({ actual, expected, portrait, mime }) => {
    const pixels = async source => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = portrait ? 64 : 96; canvas.height = portrait ? 96 : 64;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const [a, b] = await Promise.all([pixels(`data:${mime};base64,${actual}`), pixels(`data:image/png;base64,${expected}`)]);
    // Ignore the gallery card's rounded corners and border; compare the actual
    // scene, whose asymmetric markers expose rotation, mirroring and distortion.
    const width = portrait ? 64 : 96, height = portrait ? 96 : 64;
    let difference = 0, count = 0;
    for (let y = 5; y < height - 5; y++) for (let x = 5; x < width - 5; x++) {
      const offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) { difference += Math.abs(a[offset + c] - b[offset + c]); count++; }
    }
    return difference / count;
  }, { actual: actual.toString("base64"), expected: sample.poster.toString("base64"), portrait: sample.height > sample.width, mime });
}

async function playing(page) {
  await page.waitForFunction(() => Number(document.querySelector(".media-player-surface")?.dataset.currentTime) > .05
    && document.querySelector(".media-player-surface")?.dataset.playerState === "playing");
}

try {
  const width = 480, height = 320, rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    rgb[offset] = Math.round(35 + x / width * 190);
    rgb[offset + 1] = Math.round(25 + y / height * 200);
    rgb[offset + 2] = x > 40 && x < 100 && y > 30 && y < 260 ? 240 : 40;
    if (x > 190 && x < 290 && y > 120 && y < 200) rgb.fill(245, offset, offset + 3);
  }
  const ppm = join(directory, "pattern.ppm");
  await writeFile(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
  const samples = [];
  for (const codec of ["h264", "hevc"]) {
    const base = join(directory, `${codec}.mov`);
    ffmpeg("-loop", "1", "-i", ppm, "-t", "3", "-r", "12", "-an", "-pix_fmt", "yuv420p",
      "-c:v", codec === "hevc" ? "libx265" : "libx264", "-preset", "ultrafast", "-crf", "18", "-threads", "2",
      ...(codec === "hevc" ? ["-x265-params", "pools=1:frame-threads=1:log-level=error", "-tag:v", "hvc1"] : []), base);
    for (const [rotation, flip] of [0, 90, -90, 180].flatMap(rotation => [[rotation, false], [rotation, true]])) {
      const id = `${codec}-${rotation}-${flip}`, path = join(directory, `${id}.mov`), posterPath = join(directory, `${id}.png`);
      ffmpeg("-display_rotation", String(rotation), ...(flip ? ["-display_hflip"] : []), "-i", base, "-c", "copy", path);
      ffmpeg("-i", path, "-frames:v", "1", posterPath);
      samples.push({ id, codec, rotation, flip, width: Math.abs(rotation) === 90 ? height : width,
        height: Math.abs(rotation) === 90 ? width : height, clip: await readFile(path), poster: await readFile(posterPath) });
    }
  }
  const fixture = await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx", contents: `
    import { render } from "preact";
    import { MediaPreview } from "./src/MediaPreview";
    import { MediaPlayer } from "./src/mediaPlayer";
    const root = document.getElementById("root");
    window.show = (photo, viewer = true) => { root.style.cssText = ""; render(<div className={viewer ? "viewer-media" : "image-card"}
      style={{ position: "relative", width: 280 * photo.width / Math.max(photo.width, photo.height),
        height: 280 * photo.height / Math.max(photo.width, photo.height) }}>
      <MediaPreview key={photo.id} image={photo} autoPlay={viewer} />
    </div>, root); };
    window.prepareCapture = photo => {
      render(null, root);
      const host = window.captureHost = document.createElement("div");
      host.style.width = 280 * photo.width / Math.max(photo.width, photo.height) + "px";
      host.style.height = 280 * photo.height / Math.max(photo.width, photo.height) + "px";
      root.appendChild(host);
      window.capturePlayer = new MediaPlayer(host, photo.motion, "motion.mov", true, {}, true,
        { sourceResolution: true, retainBytes: true });
      window.capturePlayer.play();
    };
  ` }, bundle: true, write: false, format: "esm", target: "es2022", jsx: "automatic", jsxImportSource: "preact",
    define: { "import.meta.env.DEV": "true" } });
  const css = (await Promise.all(["styles.css", "video.css"].map(name => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")))).join("\n");
  browser = await launchBrowser();
  const results = [], errors = [];
  for (const viewportWidth of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 844 }, deviceScaleFactor: viewportWidth < 720 ? 3 : 2 });
    const requests = [];
    await page.addInitScript(forceFallback => {
      window.nativeAttempts = 0;
      window.motionBlobs = new Set();
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = blob => { const url = create(blob); if (blob.type.startsWith("video/")) window.motionBlobs.add(url); return url; };
      URL.revokeObjectURL = url => { window.motionBlobs.delete(url); revoke(url); };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.nativeAttempts++;
        if (forceFallback) return Promise.reject(new DOMException("Unsupported native codec", "NotSupportedError"));
        if (window.blockNextPlay) { window.blockNextPlay = false; return Promise.reject(new DOMException("Gesture required", "NotAllowedError")); }
        return play.call(this);
      };
    }, forceFallback);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://pixhelf.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script id="pixhelf-auth" type="application/json">{"enabled":false,"authenticated":false}</script>' });
      if (path.startsWith("/assets/libmedia/")) return serveLibmediaAsset(route);
      const sample = samples.find(sample => path === `/motion/${sample.id}`);
      if (sample) { requests.push(path); return serveMotion(route, { ...sample, contentType: "video/quicktime" }); }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("https://pixhelf.test/");
    await page.addStyleTag({ content: css + "\nbody { padding: 40px; } .media-preview-player { transition: none; } .live-photo-badge { display: none; }" });
    await page.addScriptTag({ type: "module", content: fixture.outputFiles[0].text });
    await page.waitForFunction(() => typeof window.show === "function");
    for (const sample of samples) {
      const photo = { id: sample.id, name: `${sample.id}.jpg`, width: sample.width, height: sample.height, motion: `/motion/${sample.id}` };
      const retryGesture = !forceFallback && sample.id === "h264-0-false";
      if (retryGesture) await page.evaluate(() => { window.blockNextPlay = true; });
      await page.evaluate(photo => window.show(photo), photo);
      const viewport = page.locator(".media-preview-viewport");
      if (retryGesture) {
        await page.waitForFunction(() => document.querySelector(".media-player-surface")?.dataset.playerState === "paused");
        assert.equal(await page.locator(".media-player-surface").getAttribute("data-player"), "native-live", "a blocked gesture is not an unsupported codec");
        await page.locator(".viewer-media").dispatchEvent("pixhelf:media-preview-play");
      }
      await playing(page);
      const player = await page.locator(".media-player-surface").getAttribute("data-player");
      if (forceFallback) assert.equal(player, "libmedia");
      else if (sample.codec === "h264") assert.equal(player, "native-live");
      const record = async phase => {
        const actual = await viewport.screenshot(), error = await difference(page, actual, sample);
        if (error > 8) await writeFile(`/tmp/pixhelf-orientation-${sample.id}-${viewportWidth}-${phase}.png`, actual);
        results.push({ viewportWidth, id: sample.id, player, phase, difference: Number(error.toFixed(2)) });
      };
      await record("first");
      if (sample.rotation === 90 && sample.flip) {
        await page.locator(".viewer-media").evaluate(media => {
          media.style.width = parseFloat(media.style.width) * .8 + "px";
          media.style.height = parseFloat(media.style.height) * .8 + "px";
          media.style.transform = "scale(1.15)";
        });
        await record("resize-and-zoom");
        await page.waitForFunction(() => !document.querySelector(".media-player-surface"));
        const beforeReplay = requests.length;
        const attemptsBeforeReplay = await page.evaluate(() => window.nativeAttempts);
        await page.locator(".viewer-media").dispatchEvent("pixhelf:media-preview-play");
        await playing(page);
        await record("replay");
        assert.equal(requests.length, beforeReplay, "direction metadata must survive replay from cached original bytes");
        await page.evaluate(photo => window.show(photo, false), photo);
        await page.locator(".image-card").dispatchEvent("pointerenter", { pointerType: "mouse" });
        await playing(page);
        await record("card");
        if (forceFallback) assert.equal(await page.evaluate(() => window.nativeAttempts), attemptsBeforeReplay,
          "replay and card handoff must not retry a known unsupported native codec");
        await page.evaluate(photo => window.prepareCapture(photo), photo);
        await playing(page);
        const frame = await page.evaluate(async () => {
          const frame = await window.capturePlayer.captureFrame();
          window.capturePlayer.destroy();
          window.captureHost.remove();
          return { bytes: [...frame.bytes], type: frame.file.type, time: frame.time };
        });
        assert.equal(frame.type, "image/jpeg");
        assert(frame.time > 0);
        await writeFile(`/tmp/pixhelf-orientation-${sample.id}-${viewportWidth}-snapshot.jpg`, Buffer.from(frame.bytes));
        results.push({ viewportWidth, id: sample.id, phase: "snapshot", difference:
          Number((await difference(page, Buffer.from(frame.bytes), sample, frame.type)).toFixed(2)) });
      }
      await page.evaluate(() => window.show({ id: "none", name: "none", width: 480, height: 320 }));
      assert.equal(await page.evaluate(() => window.motionBlobs.size), 0, "ending, replacing and closing playback must release every native blob URL");
    }
    await page.close();
  }
  console.log(JSON.stringify({ noServer: true, forceFallback, results, errors }, null, 2));
  assert.deepEqual(errors, []);
  assert(results.every(result => result.difference < 8), "motion pixels must match the poster's rotation, proportions and mirroring");
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
