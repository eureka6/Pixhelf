import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./live-photo-fixture.mjs";
import { activateTouchCard, closeViewer, checkDesktopSelection, checkSelectionLimit, checkTouchSelection, checkViewerDiscoveredSelection } from "./selection-gestures-check.mjs";

import { checkViewerHistory } from "./viewer-history-check.mjs";
import { checkAlbumManagement } from "./album-management-check.mjs";
import { checkSelectionNavigation } from "./selection-navigation-check.mjs";

const project = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp("/tmp/pixhelf-management-check-");
const gallery = join(directory, "gallery");
let backend, browser, log = "", origin;
const errors = [];
const binary = process.env.PIXHELF_TEST_BINARY ?? join(project, "target/debug/pixhelf");
const photo = join(project, "frontend/scripts/fixtures/live-photo.jpg");

async function waitFor(predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${description}\n${log.slice(-1500)}`);
}
async function start() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  backend = spawn(binary, ["--gallery-dir", gallery, "--cache-dir", join(directory, "cache"), "--listen", `127.0.0.1:${port}`, "--text-search-model", "false", "--scan-interval", "2"], {
    cwd: directory, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PIXHELF_"))), PIXHELF_AUTH_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [backend.stdout, backend.stderr]) stream.on("data", data => { log = (log + data).slice(-12000); });
  await waitFor(() => fetch(`${origin}/api/health`).then(response => response.ok).catch(() => false), "backend starts");
}
async function stop() {
  if (backend?.exitCode === null) {
    const done = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM"); await done;
  }
}
const state = () => fetch(`${origin}/api/management`).then(response => response.json());
const countSelected = page => page.locator('.image-card[data-selected="true"]').count();
async function select(card, touch = false) {
  await card.scrollIntoViewIfNeeded();
  if (touch) await activateTouchCard(card);
  else await card.hover();
  if (touch) await card.getByRole("checkbox").tap();
  else await card.getByRole("checkbox").click();
}
async function navigate(page, label) {
  const mobile = page.viewportSize().width <= 720;
  const toggle = page.locator(".gallery-sidebar-toggle");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.locator(mobile ? ".mobile-sidebar" : ".desktop-sidebar").getByText(label, { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".mobile-nav-layer"));
}
async function cards(page) { await page.locator('.image-card[data-loaded="true"]').first().waitFor(); }

try {
  await mkdir(join(gallery, "目标相册"), { recursive: true });
  await mkdir(join(gallery, "冲突相册"));
  for (let index = 0; index < 70; index++) await copyFile(photo, join(gallery, `photo-${String(index).padStart(2, "0")}.jpg`));
  await copyFile(photo, join(gallery, "冲突相册/photo-00.jpg"));
  await copyFile(photo, join(gallery, "live.jpg"));
  await copyFile(join(project, "frontend/scripts/fixtures/live-photo.mp4"), join(gallery, "live.mp4"));
  await start();
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await cards(page);
  await checkDesktopSelection(page);
  await checkSelectionLimit(context, origin, await readFile(photo));
  await checkViewerDiscoveredSelection(context, origin);
  await checkViewerHistory(context, origin);
  const first = page.locator('.image-card[data-image-name="photo-00.jpg"]').first();
  const second = page.locator('.image-card[data-image-name="photo-01.jpg"]');
  await page.mouse.move(0, 0);
  assert.equal(await first.getByRole("checkbox").evaluate(element => getComputedStyle(element).opacity), "0", "desktop selector is quiet until hover/focus");
  await select(first);
  const selectionBeforeCountClick = await countSelected(page);
  await page.locator('.selection-count').click();
  assert.equal(await countSelected(page), selectionBeforeCountClick, 'the selected-count area does not dismiss the selection');
  assert.equal(await countSelected(page), 1);
  await page.waitForFunction(element => getComputedStyle(element).opacity === "1", await second.getByRole("checkbox").elementHandle());
  assert.equal(await second.getByRole("checkbox").evaluate(element => getComputedStyle(element).opacity), "1", "the first selection reveals the other selectors");
  assert.equal(await page.locator(".image-viewer").count(), 0);
  await second.locator(".photo-card-open").click();
  await page.locator(".image-viewer").waitFor();
  assert.equal(await countSelected(page), 1, "clicking the image browses without changing selection");
  await closeViewer(page);
  await select(second);
  assert.equal(await countSelected(page), 2);
  const rangeEnd = page.locator('.image-card[data-image-name="photo-04.jpg"]');
  await rangeEnd.hover();
  await rangeEnd.getByRole("checkbox").click({ modifiers: ["Shift"] });
  assert.equal(await countSelected(page), 5, "Shift selects a contiguous range");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".gallery-selection-bar").count(), 0, "clearing the selection exits selection mode");
  await select(first); await select(second);
  await page.getByRole("button", { name: "收藏所选项目", exact: true }).click();
  await waitFor(async () => (await state()).favoriteIds.length === 2, "favorites persisted");
  await page.getByRole("button", { name: "取消收藏所选项目" }).waitFor();
  await page.screenshot({ path: "/tmp/pixhelf-management-desktop.png", animations: "disabled" });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).click();
  const download = await downloaded;
  const archivePath = join(directory, "selected.zip");
  await download.saveAs(archivePath);
  assert.equal((await readFile(archivePath)).subarray(0, 2).toString(), "PK");
  assert.equal(await download.failure(), null);
  await page.waitForFunction(() => document.querySelector(".gallery-selection-bar")?.getAttribute("aria-busy") === "false");
  await page.keyboard.press("Escape");
  await page.locator(".gallery-selection-bar").waitFor({ state: "detached" });
  await first.locator(".photo-card-open").focus();
  await page.waitForFunction(element => getComputedStyle(element).opacity === "1", await first.getByRole("checkbox").elementHandle());
  assert.equal(await first.getByRole("checkbox").evaluate(element => getComputedStyle(element).opacity), "1", "keyboard focus reveals the selection control");
  await page.keyboard.press("Enter");
  await page.locator(".image-viewer").waitFor();
  await page.getByRole("button", { name: "关闭查看器" }).first().click();
  await page.locator(".image-viewer").waitFor({ state: "detached" });
  await first.locator(".photo-card-open").click({ button: "right" });
  await page.locator(".photo-card-menu:popover-open").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".photo-card-menu").waitFor({ state: "detached" });
  await select(first);
  await page.locator(".load-sentinel").scrollIntoViewIfNeeded();
  await waitFor(async () => await page.locator(".image-card").count() > 60, "pagination appends cards");
  assert.equal(await countSelected(page), 1, "selection survives pagination");
  await page.keyboard.press("Control+a");
  assert.equal(await countSelected(page), await page.locator(".image-card").count());
  await page.keyboard.press("Escape");
  await select(first);
  await page.getByRole("button", { name: "移动", exact: true }).click();
  await page.locator('.selection-dialog [role="treeitem"][data-path="冲突相册"]').click();
  await page.locator(".selection-dialog").getByRole("button", { name: "移动", exact: true }).click();
  await page.locator('.management-notice[data-error="true"]').waitFor();
  assert.deepEqual(await readFile(join(gallery, "photo-00.jpg")), await readFile(photo));
  await page.getByRole("button", { name: "关闭操作提示" }).click();
  await cards(page);
  await select(page.locator('.image-card[data-image-name="photo-01.jpg"]'));
  await page.getByRole("button", { name: "移动", exact: true }).click();
  await page.locator('.selection-dialog [role="treeitem"][data-path="目标相册"]').click();
  await page.locator(".selection-dialog").getByRole("button", { name: "移动", exact: true }).click();
  await waitFor(() => readFile(join(gallery, "目标相册/photo-01.jpg")).then(() => true).catch(() => false), "move writes destination");
  await navigate(page, "收藏");
  await waitFor(async () => await page.locator(".image-card").count() === 2, "favorites view has both images after move");
  await select(page.locator('.image-card[data-image-name="photo-00.jpg"]'));
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal((await state()).trashCount, 0, "cancelling never touches originals");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await waitFor(async () => (await state()).trashCount === 1, "trash contains selected image");
  await navigate(page, "回收站");
  await page.getByRole('checkbox', { name: '选择 photo-00.jpg', exact: true }).check();
  const trashSelection = page.getByRole('region', { name: '所选回收站项目操作', exact: true });
  assert.equal(await trashSelection.getAttribute('data-selected-count'), '1');
  await trashSelection.getByRole('button', { name: '取消全部选择', exact: true }).click();
  assert.equal(await trashSelection.count(), 0);
  assert.equal((await state()).trashCount, 1);
  await page.getByRole('checkbox', { name: '选择 photo-00.jpg', exact: true }).check();
  await trashSelection.getByRole('button', { name: '恢复所选', exact: true }).click();
  await waitFor(async () => (await state()).trashCount === 0, "restore empties trash");
  assert.equal((await state()).favoriteIds.length, 2, "restoring also restores favorite state");
  await stop(); await start();
  await page.goto(`${origin}/?view=favorites`); await cards(page);
  assert.equal(await page.locator(".image-card").count(), 2, "favorites survive a backend restart");
  await context.close();

  for (const width of [390, 320]) {
    const mobile = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, reducedMotion: "reduce" });
    const page = await mobile.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin); await cards(page);
    const live = page.locator('.image-card[data-image-name="live.jpg"]');
    await checkTouchSelection(page);
    if (width === 390) await checkViewerHistory(mobile, origin);
    await select(live, true);
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".image-viewer, .photo-card-menu").count(), 0, "touching a selector never opens a viewer or long-press menu");
    assert.equal(await live.locator('.media-preview[data-playing="true"]').count(), 0);
    const bar = await page.locator(".gallery-selection-bar").boundingBox();
    assert(bar.x >= 0 && bar.x + bar.width <= width && bar.y + bar.height <= 844, "mobile actions fit the viewport");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/pixhelf-management-mobile-${width}.png`, animations: "disabled" });
    await page.getByRole("button", { name: "移动", exact: true }).click();
    await page.locator('.selection-dialog [role="treeitem"][data-path="目标相册"]').waitFor();
    const dialog = await page.locator(".selection-dialog").boundingBox();
    assert(dialog.x >= 0 && dialog.x + dialog.width <= width);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.keyboard.press("Escape");
    await navigate(page, "收藏"); await cards(page);
    assert.equal(await page.locator(".image-card").count(), 2);
    await mobile.close();
  }
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width <= 720, hasTouch: width <= 720, reducedMotion: "reduce", acceptDownloads: true });
    await checkAlbumManagement(context, origin, gallery, photo);
    await checkSelectionNavigation(context, origin);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ desktop: 1440, mobile: [390, 320], selection: true, contextSelection: true, mouseBoxSelection: true, touchRangeSelection: true, selectionBacktracking: true, selectionCancellation: true, selectionLimit: 500, paginationDuringDrag: true, edgeScrolling: true, nativeTouchScrolling: true, rangeSelection: true, pagination: true, zipDownload: true, move: true, conflictsPreserveOriginals: true, trashRestore: true, favoritesPersist: true, browserErrors: errors }));
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.screenshot({ path: "/tmp/pixhelf-management-failure.png" }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await stop(); await rm(directory, { recursive: true, force: true });
}
