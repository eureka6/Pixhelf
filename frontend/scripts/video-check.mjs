import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { checkVideoGestures } from "./video-gestures-check.mjs";
import { checkVideoControlOrder, checkVideoTimeJump } from "./video-controls-check.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "pixhelf-video-check-"));
const gallery = join(directory, "gallery");
const samples = process.env.PIXHELF_VIDEO_TESTSET ?? join(project, "pic/pixhelf-video-testset");
let backend, browser;
let backendLog = "";
let backendError;

async function eventually(callback, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (backendError) throw backendError;
    if (backend?.exitCode !== null && backend?.exitCode !== undefined) throw new Error(backendLog);
    if (await callback()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Video check timed out\n${backendLog}`);
}

try {
  await mkdir(gallery);
  if (process.env.PIXHELF_TEST_SCREENSHOTS) await mkdir(process.env.PIXHELF_TEST_SCREENSHOTS, { recursive: true });
  await copyFile(join(project, "frontend/scripts/fixtures/live-photo.jpg"), join(gallery, "00-still.jpg"));
  await copyFile(join(project, "frontend/scripts/fixtures/live-photo.jpg"), join(gallery, "01z-between.jpg"));
  for (let index = 0; index < 36; index++) await copyFile(join(project, "frontend/scripts/fixtures/live-photo.jpg"),
    join(gallery, `zz-related-${String(index).padStart(2, "0")}.jpg`));
  const manifest = process.argv.includes("--fixtures-only") ? null : await readFile(join(samples, "manifest.csv"), "utf8").catch(error => {
    if (error.code === "ENOENT" && !process.env.PIXHELF_VIDEO_TESTSET) return null;
    throw error;
  });
  if (manifest) {
    for (const line of manifest.trim().split(/\r?\n/).slice(1)) {
      const filename = line.split("|")[0];
      await copyFile(join(samples, filename), join(gallery, filename));
    }
  } else {
    if (process.env.PIXHELF_VIDEO_REVIEW_SAMPLE) await copyFile(process.env.PIXHELF_VIDEO_REVIEW_SAMPLE,
      join(gallery, `01-${basename(process.env.PIXHELF_VIDEO_REVIEW_SAMPLE)}`));
    else await run("ffmpeg", ["-v", "error", "-nostdin", "-stream_loop", "-1", "-i",
      join(project, "frontend/scripts/fixtures/live-photo.mp4"), "-t", "18", "-c", "copy", join(gallery, "01-clip.mp4")]);
    await copyFile(join(project, "frontend/scripts/fixtures/live-photo.mp4"), join(gallery, "02-clip.mp4"));
    await copyFile(join(project, "frontend/scripts/fixtures/live-photo-hevc.mov"), join(gallery, "03-hevc.mov"));
  }
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  backend = spawn(process.env.PIXHELF_TEST_BINARY ?? join(project, "target/debug/pixhelf"), [
    "--gallery-dir", gallery, "--cache-dir", join(directory, "cache"),
    "--listen", `127.0.0.1:${port}`, "--text-search-model", "false", "--workers", "2",
  ], { cwd: project, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PIXHELF_"))), PIXHELF_AUTH_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  backend.on("error", error => { backendError = error; });
  for (const stream of [backend.stdout, backend.stderr]) stream.on("data", data => { backendLog = (backendLog + data.toString()).slice(-32_000); });
  await eventually(async () => fetch(`${base}/api/status`).then(response => response.json())
    .then(status => status.backgroundComplete && status.videos.playback.backgroundComplete && status.videos.preview.backgroundComplete).catch(() => false), 120_000);
  const status = await fetch(`${base}/api/status`).then(response => response.json());
  assert.equal(status.failed, 0, backendLog);
  assert.equal(status.videos.playback.failed, 0, backendLog);
  assert.equal(status.videos.preview.failed, 0, backendLog);
  const { items } = await fetch(`${base}/api/images?limit=200`).then(response => response.json());
  const videos = items.filter(item => item.video);
  assert.equal(videos.length, manifest ? 18 : 3);
  const first = videos[0];
  const related = items.filter(item => item.name.startsWith("zz-related-"));
  const videoIds = new Set(videos.map(item => item.id));
  browser = await launchBrowser();
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 720, hasTouch: width < 720 });
    const errors = [], imageDecodeRequests = [], videoRequests = [], decoderRequests = [];
    const similarOffsets = [];
    const similarFrames = [];
    let failNextSimilar = false;
    let posterSearches = 0;
    await page.route(`**/api/images/${first.id}/similar?*`, route => { posterSearches++; return route.continue(); });
    await page.route("**/api/images/similar?*", route => {
      assert.equal(route.request().method(), "POST");
      assert.equal(new URL(route.request().url()).searchParams.get("exclude"), first.id);
      const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
      similarOffsets.push(offset);
      similarFrames.push(route.request().postDataBuffer());
      if (failNextSimilar) { failNextSimilar = false; return route.fulfill({ status: 503, json: { error: "暂时无法搜索，请重试" } }); }
      return route.fulfill({ json: { items: related.slice(offset, offset + 24), total: related.length,
        offset, limit: 24, nextOffset: offset + 24 < related.length ? offset + 24 : null } });
    });
    page.on("pageerror", error => errors.push(error.message));
    if (process.env.PIXHELF_TEST_DEBUG) {
      page.on("console", message => console.log(message.type(), message.text()));
      page.on("requestfailed", request => console.log("request failed", request.url(), request.failure()));
    }
    page.on("request", request => {
      if (request.url().includes("/libmedia/")) decoderRequests.push(request.url());
      const id = new URL(request.url()).pathname.match(/^\/api\/images\/([^/]+)\/original$/)?.[1];
      if (!videoIds.has(id)) return;
      videoRequests.push(request.url());
      if (request.resourceType() === "image") imageDecodeRequests.push(request.url());
    });
    await page.goto(base);
    await page.locator('.image-card[data-loaded="true"]').first().waitFor();
    assert.equal(await page.locator(".video-badge").count(), videos.length);
    assert.equal(videoRequests.length, 0, "opening the library must not download original videos");
    await page.locator('.image-card[data-image-name="00-still.jpg"] .photo-card-open').click();
    await page.locator('.image-viewer[data-full-loaded="true"]').waitFor();
    await page.locator(".viewer-close").click();
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    assert.deepEqual(imageDecodeRequests, [], "photo navigation must not decode neighboring videos as images");
    let pendingChecks = 0;
    await page.route(`**${first.playback}*`, route => {
      if (new URL(route.request().url()).searchParams.has("status") && ++pendingChecks === 1) {
        return route.fulfill({ status: 202, json: { state: "processing" } });
      }
      return route.continue();
    });
    await page.locator(`.image-card[data-image-id="${first.id}"] .photo-card-open`).click();
    const viewer = page.locator(".video-viewer");
    const player = viewer.locator(".media-player-surface");
    const stage = viewer.locator(".video-viewer-stage");
    const menu = viewer.getByRole("menu", { name: "视频操作", exact: true });
    const openMenu = async () => {
      if (width > 720) await viewer.locator(".video-viewer-picture").click({ button: "right", position: { x: width / 2, y: 220 } });
      else {
        const touch = await page.context().newCDPSession(page);
        try {
          await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: width / 2, y: 220 }] });
          await menu.waitFor({ state: "visible" });
          await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } finally { await touch.detach(); }
      }
      await menu.waitFor({ state: "visible" });
      assert.equal(await player.evaluate(video => video.paused), true, "opening a context menu must pause on the selected frame");
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 844,
        "context menus must fit the viewport, including after a long-press release");
    };
    const expectedFrame = async () => {
      await page.waitForFunction(() => {
        const video = document.querySelector(".video-viewer .media-player-surface");
        return video && !video.seeking && video.readyState >= 2;
      });
      return Buffer.from(await player.evaluate(video => {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", .9).split(",")[1];
      }), "base64");
    };
    const autoPlaying = () => page.waitForFunction(() => {
      const video = document.querySelector(".video-viewer video");
      return video && !video.paused && video.currentTime > .2;
    });
    await viewer.waitFor();
    await viewer.getByText("准备好后自动播放").waitFor();
    await page.waitForFunction(() => document.querySelector(".video-viewer")?.dataset.videoState === "ready");
    await page.unroute(`**${first.playback}*`);
    assert.equal(await player.getAttribute("data-player"), "native");
    assert.equal(await viewer.locator("video").count(), 1, "prepared videos use the browser decoder");
    const videoBounds = await player.boundingBox();
    assert.ok(videoBounds.width >= width - 1 && videoBounds.height >= 843, "the picture must use the full viewport");
    assert.ok((await viewer.locator(".video-viewer-playback").boundingBox()).height <= 72,
      "playback controls must fit in a slim edge strip on both desktop and mobile");
    assert.equal(await viewer.getAttribute("data-scroll-mode"), "continuous");
    assert.equal(await viewer.locator(".video-viewer-more, .video-details-toggle").count(), 0);
    assert.equal(await viewer.locator(".video-viewer-playback .video-viewer-navigation").count(), 1,
      "previous/next controls belong to the lower toolbar");
    assert.equal(await viewer.locator(".video-viewer-index").count(), 0, "the file counter is replaced by the episodes menu");
    const episodes = viewer.getByRole("button", { name: "剧集", exact: true });
    assert.equal(await episodes.textContent(), "", "the episodes trigger must contain only the list icon");
    assert.equal(await viewer.locator(".video-viewer-options .video-episodes-toggle").count(), 1);
    assert.equal(await viewer.locator(".video-previous").count(), 0, "the first episode must not show a previous button, even with photos before it");
    await checkVideoControlOrder(viewer);
    assert.ok(await viewer.locator(".video-viewer-toolbar").evaluate(toolbar => [...toolbar.querySelectorAll("button, input, .video-viewer-time")]
      .filter(element => element.getClientRects().length).every(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth;
      })), "transport controls must fit even a 320px phone");
    assert.ok(await viewer.evaluate(element => element.scrollHeight > element.clientHeight), "details must remain below the player on the same scroll surface");
    assert.equal(await page.evaluate(() => Boolean(document.elementFromPoint(innerWidth - 1, innerHeight / 2)?.closest(".video-viewer"))), true,
      "the player must cover the reserved scrollbar gutter as well");
    await autoPlaying();
    assert.equal(await player.evaluate(video => video.muted), false, "opening should attempt playback with sound");
    if (width > 720) await page.mouse.move(width / 2, 220);
    else {
      await viewer.locator(".video-viewer-picture").tap({ position: { x: 140, y: 220 } });
      assert.equal(await player.evaluate(video => video.paused), false, "a phone tap must toggle controls without pausing");
      await page.waitForFunction(() => document.querySelector(".video-viewer-stage")?.dataset.controlsVisible === "false", undefined, { timeout: 1000 });
      await viewer.locator(".video-viewer-picture").tap({ position: { x: 140, y: 220 } });
      await page.waitForFunction(() => document.querySelector(".video-viewer-stage")?.dataset.controlsVisible === "true", undefined, { timeout: 1000 });
    }
    await page.waitForFunction(() => document.querySelector(".video-viewer-stage")?.dataset.controlsVisible === "false");
    if (process.env.PIXHELF_TEST_SCREENSHOTS) {
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".video-viewer-playback")).opacity === "0");
      await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `video-immersive-${width}.png`) });
    }
    if (width > 720) await page.mouse.move(width / 2 + 10, 230);
    else await viewer.locator(".video-viewer-picture").tap({ position: { x: 140, y: 220 } });
    await page.waitForFunction(() => document.querySelector(".video-viewer-stage")?.dataset.controlsVisible === "true", undefined, { timeout: 1000 });
    assert.equal(await player.evaluate(video => video.paused), false, "revealing controls must preserve playback");
    const pause = viewer.getByRole("button", { name: "暂停视频", exact: true });
    if (width < 720) await pause.tap();
    else await pause.click();
    await viewer.getByRole("slider", { name: "播放进度", exact: true }).fill("1.5");
    await page.waitForFunction(() => {
      const video = document.querySelector(".video-viewer .media-player-surface");
      return video?.dataset.playerState === "paused" && Number(video.dataset.currentTime) > .5;
    });
    {
      const timeBeforeDrag = await player.evaluate(video => video.currentTime);
      const timeline = viewer.getByRole("slider", { name: "播放进度", exact: true });
      const bounds = await timeline.boundingBox();
      const start = { x: bounds.x + bounds.width * .2, y: bounds.y + bounds.height / 2 };
      const end = { x: bounds.x + bounds.width * .6, y: start.y };
      const touch = width < 720 ? await page.context().newCDPSession(page) : null;
      try {
        if (touch) {
          await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
          await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [end] });
        } else {
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(end.x, end.y, { steps: 5 });
        }
        await page.waitForFunction(() => document.querySelector(".video-timeline")?.dataset.scrubbing === "true");
        assert.equal(await player.evaluate(video => video.currentTime), timeBeforeDrag,
          "dragging should inspect frames without seeking the paused main video");
      } finally {
        if (touch) {
          await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await touch.detach();
        } else await page.mouse.up();
      }
      await page.waitForFunction(() => {
        const video = document.querySelector(".video-viewer .media-player-surface");
        return document.querySelector(".video-timeline")?.dataset.scrubbing === "false" && Math.abs(video.currentTime - video.duration * .6) < .5;
      });
    }
    await viewer.getByRole("group", { name: "视频播放控制", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await viewer.getAttribute("data-image-id"), first.id, "player seek keys must not navigate the gallery");
    if (width > 720) {
      const timeBeforePreview = await player.evaluate(video => video.currentTime);
      const timeline = viewer.getByRole("slider", { name: "播放进度", exact: true });
      const bounds = await timeline.boundingBox();
      await timeline.hover({ position: { x: bounds.width * .7, y: 14 } });
      await viewer.locator('.video-seek-frame[data-frame-ready="true"]').waitFor();
      assert.ok(await viewer.locator(".video-seek-frame video").evaluate(video => Math.abs(video.currentTime - video.duration * .7) < .3),
        "timeline previews must decode the requested moment");
      assert.equal(await player.evaluate(video => video.currentTime), timeBeforePreview, "previewing must not seek the main player");
      await page.mouse.move(width / 2, 220);
      await viewer.locator(".video-seek-frame video").waitFor({ state: "detached" });
    }
    await viewer.getByRole("slider", { name: "播放进度", exact: true }).fill("1");
    await checkVideoTimeJump(page, width);
    await viewer.getByRole("button", { name: "倍速", exact: true }).click();
    assert.deepEqual(await viewer.getByRole("menu", { name: "选择播放速度", exact: true }).locator("button > span").allTextContents(),
      ["0.5×", "0.75×", "1×", "1.25×", "1.5×", "2.0×"]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.equal(await player.evaluate(video => video.playbackRate), 1.25, "speed choices must work with keyboard navigation");
    await viewer.getByRole("button", { name: "倍速", exact: true }).click();
    await page.keyboard.press("Escape");
    await viewer.locator("#video-rate-menu").waitFor({ state: "hidden" });
    assert.equal(await viewer.count(), 1, "Escape should close the speed menu before the viewer");
    if (width > 720 && await page.evaluate(() => document.pictureInPictureEnabled)) {
      await viewer.getByRole("button", { name: "画中画", exact: true }).click();
      await page.waitForFunction(() => document.pictureInPictureElement === document.querySelector(".video-viewer .media-player-surface"));
      await viewer.getByRole("button", { name: "退出画中画", exact: true }).click();
      await page.waitForFunction(() => !document.pictureInPictureElement);
      await page.bringToFront();
    }
    await checkVideoGestures(page, width);
    const savedTime = await player.evaluate(video => video.currentTime);
    const firstFrame = await expectedFrame();
    const galleryScroll = await page.evaluate(() => window.scrollY);
    // Native wheel/touch input must allow stopping between playback and details.
    await stage.focus();
    if (width > 720) {
      await page.mouse.move(width / 2, 350);
      await page.mouse.wheel(0, 230);
    } else {
      const touch = await page.context().newCDPSession(page);
      const point = { x: width / 2, y: 540 };
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      for (let step = 1; step <= 12; step++) {
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y - step * 12 }] });
        await page.waitForTimeout(25);
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touch.detach();
    }
    await page.waitForFunction(() => {
      const element = document.querySelector(".video-viewer");
      return element.scrollTop > 30 && element.scrollTop < element.clientHeight / 2;
    });
    assert.equal(await page.evaluate(() => window.scrollY), galleryScroll, "viewer scrolling must not move the underlying library");
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => Math.abs(document.querySelector(".video-viewer").scrollTop - document.querySelector(".video-viewer-details").offsetTop) < 2);
    await viewer.locator(".viewer-similar-card").first().waitFor();
    assert.ok(await player.evaluate(video => video.paused), "leaving the video to browse details must pause playback");
    assert.ok(Math.abs(await player.evaluate(video => video.currentTime) - savedTime) < .2, "scrolling must preserve the playback position");
    await viewer.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
    await page.waitForFunction(() => document.querySelectorAll(".video-viewer .viewer-similar-card").length === 36);
    assert.deepEqual(similarOffsets, [0, 24], "continuous scrolling must load the next page of similar content once");
    assert.ok(similarFrames.every(frame => frame.equals(firstFrame)), "search and pagination must upload the paused video frame");
    assert.equal(posterSearches, 0, "video similarity must never query the cover image");
    await viewer.getByRole("button", { name: "返回播放", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".video-viewer").scrollTop < 1);
    await openMenu();
    if (process.env.PIXHELF_TEST_SCREENSHOTS) await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `video-context-${width}.png`) });
    await menu.getByRole("menuitem", { name: "视频信息", exact: true }).click();
    await page.waitForFunction(() => Math.abs(document.querySelector(".video-viewer").scrollTop - document.querySelector(".video-viewer-details").offsetTop) < 2);
    await viewer.locator('[data-info-kind="video-codec"]').waitFor();
    assert.equal(await viewer.locator('[data-info-kind="video-codec"] dd').textContent(), "H264");
    assert.equal(await viewer.locator(".viewer-histogram-card").count(), 0);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".video-viewer").scrollTop < 1);
    assert.equal(await viewer.locator(".video-viewer-details").count(), 1, "Escape returns to playback while retaining the continuous details page");
    assert.equal(await viewer.count(), 1);
    await viewer.getByRole("slider", { name: "播放进度", exact: true }).fill("2.5");
    const nextFrame = await expectedFrame();
    failNextSimilar = true;
    if (width > 720) {
      await stage.focus();
      await page.keyboard.press("Shift+F10");
      await menu.waitFor({ state: "visible" });
    } else await openMenu();
    await menu.getByRole("menuitem", { name: "查找相似画面", exact: true }).click();
    await viewer.locator(".viewer-similar-error").waitFor();
    assert.ok(similarFrames.at(-1).equals(nextFrame), "a new search must capture the new playback position");
    assert.notDeepEqual(nextFrame, firstFrame, "the fixture must exercise different video frames");
    await viewer.locator(".viewer-similar-error").getByRole("button", { name: "重试", exact: true }).click();
    await viewer.locator(".viewer-similar-card").first().waitFor();
    assert.ok(similarFrames.at(-1).equals(nextFrame), "retry must reuse the same frame even after the player has scrolled out of view");
    assert.equal(Number(await viewer.locator(".viewer-similar-section").getAttribute("data-frame-time")), 2.5);
    await viewer.getByRole("button", { name: "返回播放", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".video-viewer").scrollTop < 1);
    if (width > 720) {
      await viewer.getByRole("button", { name: "切换全屏", exact: true }).click();
      await page.waitForFunction(() => document.fullscreenElement?.classList.contains("video-viewer-stage"));
      assert.equal(await page.evaluate(() => document.fullscreenElement.contains(document.querySelector(".video-viewer-header"))), true,
        "fullscreen must retain the header, navigation and playback controls");
      await openMenu();
      assert.equal(await menu.evaluate(element => element.matches(":popover-open")), true, "context menus must remain visible in fullscreen");
      await menu.getByRole("menuitem", { name: "播放视频", exact: true }).click();
      assert.equal(await page.evaluate(() => document.fullscreenElement?.classList.contains("video-viewer-stage")), true);
    }
    const previous = await player.elementHandle();
    await episodes.click();
    const episodeList = viewer.getByRole("menu", { name: "选择剧集", exact: true });
    await episodeList.waitFor({ state: "visible" });
    assert.equal(await episodeList.getByRole("menuitemradio").count(), videos.length, "episodes should list videos in gallery order");
    await page.waitForFunction(() => {
      const image = document.querySelector('.video-episodes-list [aria-checked="true"] img');
      return image?.complete && image.naturalWidth > 0;
    });
    assert.equal(await episodeList.locator(".video-episode-cover > img").count(), videos.length, "each episode needs a thumbnail");
    assert.ok((await episodeList.locator('[aria-checked="true"]').textContent()).includes(first.name.replace(/\.[^.]+$/, "")));
    const episodeBounds = await viewer.locator(".video-episodes-panel").boundingBox();
    assert.ok(episodeBounds.x >= 0 && episodeBounds.x + episodeBounds.width <= width && episodeBounds.y >= 0,
      "the episodes panel must fit both desktop and phone viewports");
    if (process.env.PIXHELF_TEST_SCREENSHOTS) {
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".video-episodes-panel")).opacity === "1");
      await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `video-episodes-${width}.png`) });
    }
    await viewer.locator(".video-play-toggle").focus();
    await page.keyboard.press("Escape");
    await episodeList.waitFor({ state: "hidden" });
    assert.equal(await viewer.count(), 1, "Escape closes episodes before the viewer even after focus leaves the menu");
    await episodes.click();
    await page.keyboard.press("Escape");
    await episodeList.waitFor({ state: "hidden" });
    await episodes.click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(id => document.querySelector(".video-viewer")?.dataset.imageId !== id, first.id);
    await autoPlaying();
    assert.equal(await player.evaluate(video => video.playbackRate), 1, "changing videos resets the displayed speed");
    if (width > 720) {
      assert.equal(await page.evaluate(() => document.fullscreenElement?.classList.contains("video-viewer-stage")), true,
        "changing videos must preserve the fullscreen session");
      await viewer.getByRole("button", { name: "切换全屏", exact: true }).click();
      await page.waitForFunction(() => !document.fullscreenElement);
    }
    assert.equal(await previous.evaluate(video => video.dataset.playerState === "destroyed" && !video.isConnected), true, "navigation must release the previous video");
    await checkVideoControlOrder(viewer);
    await viewer.getByRole("button", { name: "上一集", exact: true }).click();
    await page.waitForFunction(id => document.querySelector(".video-viewer")?.dataset.imageId === id, first.id);
    assert.equal(await viewer.locator(".video-previous").count(), 0);
    await episodes.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.waitForFunction(id => document.querySelector(".video-viewer")?.dataset.imageId === id, videos.at(-1).id);
    assert.equal(await viewer.locator(".video-next").count(), 0, "the last episode must not show a next button, even with photos after it");
    await checkVideoControlOrder(viewer);
    await page.locator(".viewer-close").click();
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.getElementById("root").inert && document.documentElement.style.overflow !== "hidden" && document.body.style.overflow !== "hidden");

    for (const converted of videos.filter(item => item.video.codec !== "h264")) {
      await page.locator(`.image-card[data-image-id="${converted.id}"] .photo-card-open`).click();
      await page.waitForFunction(() => document.querySelector(".video-viewer")?.dataset.videoState === "ready");
      await autoPlaying();
      await viewer.getByRole("group", { name: "视频播放控制", exact: true }).focus();
      await page.keyboard.press("Escape");
      await viewer.waitFor({ state: "detached" });
    }

    // A failed background encode reports a useful error, keeps original
    // downloads available, and can be retried without reopening the viewer.
    const failureVideo = first;
    await page.route(`**${first.playback}*`, route => route.fulfill({ status: 422, json: { state: "failed" } }));
    await page.locator(`.image-card[data-image-id="${failureVideo.id}"] .photo-card-open`).click();
    await viewer.locator('[role="alert"]').waitFor();
    assert.match(await viewer.locator('[role="alert"]').textContent(), /准备失败/);
    assert.equal(await viewer.locator('[role="alert"] a').getAttribute("download"), failureVideo.name);
    assert.equal(await viewer.locator('[role="alert"] a').getAttribute("href"), `/api/images/${first.id}/original`);
    {
      await page.unroute(`**${first.playback}*`);
      await viewer.getByRole("button", { name: "重试", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".video-viewer")?.dataset.videoState === "ready");
      await autoPlaying();
    }
    await viewer.getByRole("button", { name: "关闭查看器", exact: true }).click();
    await viewer.waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.getElementById("root").inert);

    // Autoplay policy refusal must keep a working player and a one-tap recovery.
    await page.evaluate(() => {
      const play = HTMLMediaElement.prototype.play;
      let block = true;
      window.restoreVideoPlay = () => { HTMLMediaElement.prototype.play = play; };
      HTMLMediaElement.prototype.play = function(...args) {
        if (block && this.closest(".video-viewer")) {
          block = false;
          return Promise.reject(new DOMException("Autoplay requires a gesture", "NotAllowedError"));
        }
        return play.apply(this, args);
      };
    });
    await page.locator(`.image-card[data-image-id="${first.id}"] .photo-card-open`).click();
    await viewer.getByRole("button", { name: "开始播放", exact: true }).waitFor();
    assert.equal(await viewer.locator('[role="alert"]').count(), 0, "autoplay refusal is not a decoding error");
    await viewer.getByRole("button", { name: "开始播放", exact: true }).click();
    await autoPlaying();
    await page.evaluate(() => window.restoreVideoPlay());
    if (width > 720) {
      await viewer.getByRole("button", { name: "切换全屏", exact: true }).click();
      await page.waitForFunction(() => Boolean(document.fullscreenElement));
    }
    await openMenu();
    await menu.getByRole("menuitem", { name: "查找相似画面", exact: true }).click();
    await page.waitForFunction(() => {
      const viewer = document.querySelector(".video-viewer");
      const similar = viewer.querySelector(".viewer-similar-section");
      return similar.dataset.similarActive === "true" && !document.fullscreenElement
        && Math.abs(similar.getBoundingClientRect().top - viewer.getBoundingClientRect().top
          - parseFloat(getComputedStyle(similar).scrollMarginTop)) < 2;
    });
    assert.ok(await player.evaluate(video => video.paused), "opening similar content must pause the playing video");
    await viewer.getByRole("button", { name: "关闭视频查看器", exact: true }).click();
    await viewer.waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.getElementById("root").inert);

    if (width === 1440) {
      const card = page.locator(`.image-card[data-image-id="${first.id}"]`);
      // Let the library finish restoring its viewport and interaction handlers.
      await page.bringToFront();
      await page.waitForFunction(() => document.hasFocus() && document.querySelector(".app-shell")?.dataset.viewerReturning === "false");
      await card.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await card.click({ button: "right" });
      await page.getByRole("menuitem", { name: "视频信息", exact: true }).click();
      await page.locator('.photo-info-dialog [data-info-kind="duration"]').waitFor();
      await page.getByRole("button", { name: "关闭视频信息", exact: true }).click();
    }
    if (process.env.PIXHELF_TEST_SCREENSHOTS) {
      await mkdir(process.env.PIXHELF_TEST_SCREENSHOTS, { recursive: true });
      await page.locator(`.image-card[data-image-id="${first.id}"] .photo-card-open`).click();
      await page.waitForFunction(() => document.querySelector(".video-viewer")?.dataset.videoState === "ready");
      await autoPlaying();
      const reviewDuration = await player.evaluate(video => video.duration);
      await viewer.getByRole("slider", { name: "播放进度", exact: true }).fill((reviewDuration * .3).toFixed(1));
      await page.waitForFunction(() => document.querySelector(".video-viewer .media-player-surface")?.dataset.playerState === "playing");
      assert.equal(await viewer.locator(".video-timeline").getAttribute("data-scrubbing"), "false", "releasing the timeline must resume live progress updates");
      await viewer.getByRole("group", { name: "视频播放控制", exact: true }).focus();
      await page.mouse.move(width / 2, 220);
      await viewer.locator(".video-seek-preview").waitFor({ state: "detached" });
      await stage.dispatchEvent("pointermove", { pointerType: "mouse" });
      if (process.env.PIXHELF_TEST_DEBUG) console.log("viewport", await page.evaluate(() => ({
        width: innerWidth, clientWidth: document.documentElement.clientWidth,
        viewer: document.querySelector(".video-viewer").getBoundingClientRect().toJSON(),
        rightEdge: document.elementFromPoint(innerWidth - 1, innerHeight / 2)?.outerHTML.slice(0, 200),
      })));
      await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `video-${width}.png`) });
      if (width > 720) {
        const timeline = viewer.getByRole("slider", { name: "播放进度", exact: true });
        const bounds = await timeline.boundingBox();
        await timeline.hover({ position: { x: bounds.width * .6, y: 14 } });
        await viewer.locator('.video-seek-frame[data-frame-ready="true"]').waitFor();
        await page.waitForFunction(() => {
          const video = document.querySelector(".video-seek-frame video");
          return video && Math.abs(video.currentTime - video.duration * .6) < .3 && !video.seeking;
        });
        await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `video-timeline-${width}.png`) });
      }
      await viewer.getByRole("button", { name: "倍速", exact: true }).click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".video-rate-panel")).opacity === "1");
      await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `video-speed-${width}.png`) });
      await page.keyboard.press("Escape");
      await openMenu();
      await menu.getByRole("menuitem", { name: "视频信息", exact: true }).click();
      await page.waitForFunction(() => Math.abs(document.querySelector(".video-viewer").scrollTop - document.querySelector(".video-viewer-details").offsetTop) < 2);
      await viewer.locator('[data-info-kind="video-codec"]').waitFor();
      await viewer.locator(".viewer-image-information-loading").waitFor({ state: "detached" });
      await menu.waitFor({ state: "detached" });
      await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `video-details-${width}.png`) });
      if (width < 720) {
        await viewer.getByRole("button", { name: "返回播放", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".video-viewer").scrollTop < 1);
        await viewer.getByRole("button", { name: "播放视频", exact: true }).click();
        for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }]) {
          await page.setViewportSize(viewport);
          await stage.dispatchEvent("pointermove", { pointerType: "mouse" });
          const deck = await viewer.locator(".video-control-deck").boundingBox();
          assert.ok(deck.x >= 0 && deck.x + deck.width <= viewport.width && deck.y + deck.height <= viewport.height,
            "the control deck must fit narrow phones and landscape viewports");
          for (const label of ["暂停视频", "下一集", "剧集", "静音", "倍速", "切换全屏"]) {
            const button = await viewer.getByRole("button", { name: label, exact: true }).boundingBox();
            assert.ok(button.x >= deck.x && button.x + button.width <= deck.x + deck.width,
              `${label} must stay inside the control deck at ${viewport.width}px`);
          }
          await page.screenshot({ path: join(process.env.PIXHELF_TEST_SCREENSHOTS, `video-${viewport.width}.png`) });
        }
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(imageDecodeRequests, []);
    assert.deepEqual(videoRequests, [], "playback and previews must use prepared files");
    assert.deepEqual(decoderRequests, [], "prepared videos must not load browser Wasm decoders");
    console.log(`video-check: ${width}px autoplay, compact controls, timeline previews, speed, seeking, continuous wheel/touch scrolling, similar pagination and navigation passed`);
    await page.close();
  }
  assert.equal((await readdir(gallery)).length, videos.length + 38, "the original gallery must remain unchanged");
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    console.error(await page.evaluate(() => ({ stage: { ...document.querySelector(".video-viewer-stage")?.dataset },
      player: { ...document.querySelector(".video-viewer video")?.dataset }, focused: document.activeElement?.outerHTML.slice(0, 250) })));
    await page.screenshot({ path: "/tmp/pixhelf-video-check-failure.png" });
  }
  throw error;
} finally {
  await browser?.close();
  if (backend?.pid && backend.exitCode === null) {
    const stopped = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
