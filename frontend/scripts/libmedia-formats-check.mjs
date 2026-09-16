import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchBrowser, serveLibmediaAsset, serveMotion } from "./live-photo-fixture.mjs";

const directory = resolve(process.env.PIXHELF_PINE_SAMPLES ?? "../pic/video");
const manifest = JSON.parse(await readFile(join(directory, "pine-and-birch-manifest.json"), "utf8"));
const [html, js, css, poster] = await Promise.all([
  readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
  readFile(new URL("../dist/assets/app.js", import.meta.url)),
  readFile(new URL("../dist/assets/app.css", import.meta.url)),
  readFile(new URL("fixtures/live-photo.jpg", import.meta.url)),
]);
const base = process.env.PIXHELF_TEST_ORIGIN ?? "https://pixhelf.test";
const browser = await launchBrowser();
const results = [];
try {
  for (const sample of manifest.files.filter(sample => !process.env.PIXHELF_TEST_FORMAT || sample.format === process.env.PIXHELF_TEST_FORMAT)) {
    const clip = await readFile(join(directory, sample.local_filename));
    const item = { id: "sample", name: sample.local_filename, width: sample.width, height: sample.height,
      video: { duration: sample.duration, codec: sample.codec, audioCodec: sample.audioCodec, frameRate: sample.fps, container: sample.format } };
    const summary = { total: 1, revision: "format-check", albums: [] };
    const status = { total: 1, ready: 1, queued: 0, processing: 0, failed: 0, initialBatchReady: true, backgroundComplete: true,
      textSearch: { enabled: false, total: 1, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
    const images = { items: [item], total: 1, offset: 0, limit: 60, nextOffset: null };
    const documentHtml = html.replace("__PIXHELF_AUTH__", JSON.stringify({ enabled: false, authenticated: false }))
      .replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary, status, images }));
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(`${base}/`)) external.push(request.url()); });
    if (process.env.PIXHELF_TEST_DEBUG) page.on("console", message => console.log(message.type(), message.text()));
    await page.route(`${base}/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: documentHtml });
      if (path.startsWith("/assets/libmedia/")) return serveLibmediaAsset(route);
      if (path === "/assets/app.js") return route.fulfill({ contentType: "text/javascript", body: js });
      if (path === "/assets/app.css") return route.fulfill({ contentType: "text/css", body: css });
      if (path === "/api/gallery") return route.fulfill({ json: summary });
      if (path === "/api/status") return route.fulfill({ json: status });
      if (path === "/api/images") return route.fulfill({ json: images });
      if (path === "/api/images/sample") return route.fulfill({ json: item });
      if (path.endsWith("/original")) return serveMotion(route, { clip, contentType: sample.mime_type });
      if (path.endsWith("/thumbnail")) return route.fulfill({ contentType: "image/jpeg", body: poster });
      return route.fulfill({ status: 404, json: {} });
    });
    try {
      await page.goto(`${base}/`);
      await page.locator(".photo-card-open").evaluate(button => button.click());
      const viewer = page.locator(".video-viewer");
      const settled = () => page.waitForFunction(() => ["ready", "failed"].includes(document.querySelector(".video-viewer")?.dataset.videoState));
      await settled();
      let result = { file: sample.local_filename, format: sample.format, codec: sample.codec, audioCodec: sample.audioCodec, video: false, audio: false };
      if (await viewer.getAttribute("data-video-state") !== "failed") {
        await viewer.getByRole("button", { name: "播放视频", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".video-viewer")?.dataset.videoState === "failed"
          || Number(document.querySelector(".media-player-surface")?.dataset.currentTime) >= .5);
        if (await viewer.getAttribute("data-video-state") !== "failed") {
          const playback = await page.evaluate(async () => {
            const { default: Player } = await import("/assets/libmedia/avplayer.js");
            const player = Player.Instances.at(-1);
            return { video: player.hasVideo(), audio: player.hasAudio(), audioRunning: Player.audioContext?.state === "running" };
          });
          result = { ...result, ...playback };
          assert.ok(await viewer.locator("canvas").evaluate(canvas => canvas.width > 0 && canvas.height > 0));
          if (sample.audioCodec && result.audio) assert.equal(result.audioRunning, true, `${sample.local_filename}: audio must run`);
          if (process.env.PIXHELF_TEST_SCREENSHOTS && ["avi", "mp4"].includes(sample.format)) {
            await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `${sample.local_filename}.png`) });
          }
        }
      }
      if (!result.video) result.error = await viewer.locator('[role="alert"]').innerText();
      results.push(result);
      console.log(`${result.video ? "PLAY" : "UNSUPPORTED"} ${sample.local_filename}${result.video && sample.audioCodec && !result.audio ? " (audio unsupported)" : ""}`);
      assert.deepEqual(errors, [], sample.local_filename);
      assert.deepEqual(external, [], "playback must use only self-hosted assets and originals");
      assert.equal(await page.locator("video").count(), 0, "playback must use libmedia canvas");
    } finally { await page.close(); }
  }
  await writeFile("/tmp/pixhelf-libmedia-formats.json", JSON.stringify(results, null, 2) + "\n");
  for (const result of results) {
    if (result.format !== "wmv") assert.equal(result.video, true, `${result.file}: supported format failed`);
  }
  console.log(`libmedia: ${results.filter(result => result.video).length}/${results.length} videos played; report: /tmp/pixhelf-libmedia-formats.json`);
} finally { await browser.close(); }
