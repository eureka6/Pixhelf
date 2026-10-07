import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./live-photo-fixture.mjs";

const project = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp("/tmp/pixhelf-heif-check-");
const gallery = join(directory, "gallery");
const sample = process.env.PIXHELF_HEIF_SAMPLE;
const photo = sample ? `${sample}.heic` : join(project, "frontend/scripts/fixtures/live-photo.heic");
const motion = sample ? `${sample}.mov` : join(project, "frontend/scripts/fixtures/live-photo.mp4");
let backend, browser, log = "";

async function waitFor(predicate, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (backend?.exitCode !== null) throw new Error(`Backend exited: ${log}`);
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${description}\n${log}`);
}

async function playing(card) {
  await card.page().waitForFunction(element => {
    const preview = element.querySelector(".media-preview");
    const player = element.querySelector(".media-player-surface");
    return preview?.dataset.playing === "true" && preview.dataset.loading === "false"
      && player?.querySelector("canvas")?.width > 0
      && Number(player.dataset.currentTime) > .05 && player.dataset.playerState === "playing";
  }, await card.elementHandle(), { timeout: 20_000 });
}

try {
  await mkdir(gallery);
  await copyFile(photo, join(gallery, "IMG_0011.heic"));
  await copyFile(motion, join(gallery, "IMG_0011.mov"));
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  backend = spawn(process.env.PIXHELF_TEST_BINARY ?? join(project, "target/debug/pixhelf"), [
    "--gallery-dir", gallery, "--cache-dir", join(directory, "cache"),
    "--listen", `127.0.0.1:${port}`, "--text-search-model", "false",
  ], {
    cwd: directory,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PIXHELF_"))), PIXHELF_AUTH_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.on("error", error => { log += error.message; });
  for (const stream of [backend.stdout, backend.stderr]) stream.on("data", data => { log = (log + data).slice(-12000); });
  await waitFor(() => fetch(`${origin}/api/health`).then(response => response.ok).catch(() => false), "backend starts");
  const listing = await fetch(`${origin}/api/images`).then(response => response.json());
  assert.equal(listing.total, 1, "the same-name MOV must not appear as a separate video");
  const image = listing.items[0];
  assert.equal(image.name, "IMG_0011.heic");
  assert.ok(image.motion?.includes("/motion/original/"));
  assert.equal(image.display, `/api/images/${image.id}/display`);
  assert.equal(image.video, undefined);
  assert.equal(image.playback, undefined);
  if (!sample) assert.deepEqual([image.width, image.height], [120, 90]);
  const status = await fetch(`${origin}/api/status`).then(response => response.json());
  assert.equal(status.videos.playback.total, 0);
  assert.equal(status.videos.preview.total, 0);
  for (const [url, source] of [[`/api/images/${image.id}.${image.name.split(".").pop().toLowerCase()}`, photo], [image.motion, motion]]) {
    const response = await fetch(origin + url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(source), "original downloads must preserve source bytes");
  }

  browser = await launchBrowser();
  for (const width of [1440, 390]) {
    const touch = width <= 720;
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on("pageerror", error => {
      errors.push(error.message);
      if (process.env.PIXHELF_TEST_DEBUG) console.error(error.stack);
    });
    if (process.env.PIXHELF_TEST_DEBUG) {
      page.on("console", message => console.log(message.type(), message.text()));
    }
    page.on("request", request => requests.push(new URL(request.url()).pathname));
    try {
      await page.goto(origin);
      const card = page.locator('.image-card[data-image-name="IMG_0011.heic"]');
      await page.waitForFunction(element => element.dataset.loaded === "true", await card.elementHandle());
      assert.equal(await page.locator(".image-card").count(), 1);
      assert.equal(await card.getAttribute("data-media-type"), "image");
      if (touch) await card.locator(".photo-card-open").tap();
      else await card.hover();
      await playing(card);
      assert.equal(await page.locator(".image-viewer, .video-viewer").count(), 0, "hover/first tap plays in the photo card");
      if (touch) await card.locator(".photo-card-open").tap();
      else await card.locator(".photo-card-open").click();
      const viewer = page.locator(".image-viewer");
      await viewer.waitFor();
      await page.waitForFunction(element => element.dataset.fullLoaded === "true", await viewer.elementHandle());
      assert.equal(await viewer.getAttribute("data-full-failed"), "false");
      assert.equal(await page.locator(".video-viewer").count(), 0);
      assert.ok(requests.includes(image.display), "the viewer loads the browser-compatible full image");
      assert.ok(!requests.some(path => path.includes("/video/")), "live photos bypass standalone video preparation");
      await playing(page.locator(".viewer-media:not(.viewer-swipe-outgoing)"));
      const dimensions = await page.evaluate(async url => {
        const photo = new Image();
        photo.src = url;
        await photo.decode();
        return [photo.naturalWidth, photo.naturalHeight];
      }, image.display);
      assert.deepEqual(dimensions, [image.width, image.height], "the cover must include the complete primary image");
      if (!touch) {
        await page.locator(".viewer-media:not(.viewer-swipe-outgoing)").click({ button: "right" });
        const download = page.getByRole("menuitem", { name: "下载原图", exact: true });
        await download.waitFor();
        assert.equal(await download.getAttribute("href"), `/api/images/${image.id}.${image.name.split(".").pop().toLowerCase()}`);
        await page.keyboard.press("Escape");
      }
      await page.screenshot({ path: `/tmp/pixhelf-heif-${sample ? "sample" : "fixture"}-${width}.png` });
      await page.locator(".viewer-close").click();
      await viewer.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
      console.log(`HEIF live photo passed: ${width}px, ${image.width}×${image.height}, one photo, original motion and downloads`);
    } finally { await context.close(); }
  }
} catch (error) {
  console.error(log);
  throw error;
} finally {
  await browser?.close();
  if (backend?.exitCode === null) {
    const stopped = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM");
    const force = setTimeout(() => backend.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(force);
  }
  await rm(directory, { recursive: true, force: true });
}
