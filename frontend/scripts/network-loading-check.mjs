// Exercise the embedded production build over a simulated intercontinental link.
// Run cargo build first; all media and settings belong to a disposable fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./live-photo-fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "pixhelf-network-"));
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let backend, browser;
let stderr = "";
try {
  const gallery = join(directory, "gallery");
  await mkdir(gallery);
  for (let i = 0; i < 90; i++) {
    await copyFile(new URL("fixtures/live-photo.jpg", import.meta.url), join(gallery, `photo-${String(i).padStart(3, "0")}.jpg`));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PIXHELF_")));
  backend = spawn(new URL("../../target/debug/pixhelf", import.meta.url).pathname,
    ["--listen", `127.0.0.1:${port}`, "--gallery-dir", gallery, "--cache-dir", join(directory, "cache"), "--text-search-model", "false"],
    { cwd: directory, env: { ...env, PIXHELF_AUTH_ENABLED: "false" }, stdio: ["ignore", "ignore", "pipe"] });
  backend.stderr.on("data", bytes => { stderr += bytes; });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try { ready = (await (await fetch(`${origin}/api/status`)).json()).backgroundComplete === true; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, stderr);
  browser = await launchBrowser();
  const measurements = [];
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 720, isMobile: width < 720 });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 250, downloadThroughput: 2 * 1024 * 1024 / 8,
      uploadThroughput: 1024 * 1024 / 8, connectionType: "cellular3g",
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector('.image-card[data-loaded="true"]'));
    const firstPhotoMs = await page.evaluate(() => Math.round(performance.now()));
    await page.waitForFunction(() => {
      const visible = [...document.querySelectorAll(".image-card")].filter(card => {
        const rect = card.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      });
      return visible.length > 0 && visible.every(card => card.dataset.loaded === "true");
    });
    const gallery = await page.evaluate(() => ({
      visiblePhotosMs: Math.round(performance.now()),
      scriptsBytes: performance.getEntriesByType("resource").filter(entry => entry.name.endsWith(".js")).reduce((sum, entry) => sum + entry.encodedBodySize, 0),
      thumbnailRequests: performance.getEntriesByType("resource").filter(entry => entry.name.endsWith("/thumbnail")).length,
    }));
    assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some(entry =>
      /\/(SettingsDialog|UploadDialog|LocalStorageView|ExternalStorageView|TrashView|DuplicateImages)\.js$/.test(entry.name))), false,
    "management features must not download with the first gallery screen");
    const opened = Date.now();
    await page.locator(".image-card").first().evaluate(card => card.click());
    await page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.fullLoaded === "true");
    measurements.push({ width, firstPhotoMs, ...gallery, viewerPhotoMs: Date.now() - opened });
    await page.keyboard.press("Escape");
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ latencyMs: 250, downloadMbps: 2, measurements }, null, 2));
  if (process.env.PIXHELF_NETWORK_REPORT) await writeFile(process.env.PIXHELF_NETWORK_REPORT, JSON.stringify(measurements, null, 2));
} finally {
  await browser?.close();
  if (backend && backend.exitCode === null) {
    const stopped = once(backend, "exit");
    backend.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
