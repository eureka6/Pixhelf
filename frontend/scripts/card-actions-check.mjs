import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const baseUrl = process.env.PIXHELF_URL ?? "http://127.0.0.1:3002";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];

async function clickVisible(button) {
  const rect = await button.boundingBox();
  assert(rect && await button.isVisible());
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  assert(await button.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point));
  if (button.page().viewportSize().width <= 720) await button.page().touchscreen.tap(point.x, point.y);
  else await button.page().mouse.click(point.x, point.y);
}

async function centerCard(card) {
  await card.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await card.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const rect = await card.boundingBox();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function longPress(card) {
  const point = await centerCard(card);
  const page = card.page();
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await page.locator(".photo-card-menu:popover-open").waitFor({ timeout: 2000 });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".photo-card-menu:popover-open").count(), 1, "releasing a long press must leave the menu open");
  assert.equal(await card.locator(".photo-card-more").isVisible(), false, "touch must never show a more button");
}

async function openMenu(card) {
  if (card.page().viewportSize().width > 720) {
    const point = await centerCard(card);
    await card.page().mouse.click(point.x, point.y, { button: "right" });
    const menu = await expectMenu(card.page());
    const bounds = await menu.boundingBox();
    assert(Math.min(Math.abs(bounds.x - point.x - 6), Math.abs(bounds.x + bounds.width - point.x + 6)) < 2, `menu should open beside the pointer: ${JSON.stringify({ point, bounds, card: await card.boundingBox() })}`);
  } else await longPress(card);
}

async function dismissTouchMenu(page) {
  await page.touchscreen.tap(100, 5);
  await page.locator(".photo-card-menu").waitFor({ state: "detached" });
}

async function checkTouchMenu(page, selector) {
  const first = page.locator(selector).first();
  const second = page.locator(selector).nth(1);
  const controls = page.locator(`${selector} .photo-card-more:visible`);
  assert.equal(await controls.count(), 0, "mobile cards must not show more buttons");
  const point = await centerCard(first);
  const pointer = { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: point.x, clientY: point.y };
  for (const gesture of ["short", "move", "cancel", "multitouch"]) {
    await first.dispatchEvent("pointerdown", { ...pointer, buttons: 1 });
    if (gesture === "move") await first.dispatchEvent("pointermove", { ...pointer, buttons: 1, clientY: point.y - 30 });
    if (gesture === "multitouch") await first.dispatchEvent("pointerdown", { ...pointer, pointerId: 2, isPrimary: false, buttons: 1 });
    if (gesture !== "multitouch") await first.dispatchEvent(gesture === "cancel" ? "pointercancel" : "pointerup", { ...pointer, buttons: 0 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".photo-card-menu").count(), 0, `${gesture} must cancel long-press activation`);
    assert.equal(await controls.count(), 0);
  }

  // Exercise native scrolling so normal browsing never turns into a long press.
  const scrollTop = () => page.evaluate(() => document.querySelector(".image-viewer")?.scrollTop ?? scrollY);
  const before = await scrollTop();
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  for (let step = 1; step <= 5; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - step * 22 }] });
    await page.waitForTimeout(20);
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(top => (document.querySelector(".image-viewer")?.scrollTop ?? scrollY) > top + 20, before);
  await page.evaluate(async () => {
    const scroller = document.querySelector(".image-viewer") ?? document.documentElement;
    let last = scroller.scrollTop;
    let stableSince = performance.now();
    const deadline = stableSince + 3000;
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame);
      if (scroller.scrollTop !== last) {
        last = scroller.scrollTop;
        stableSince = performance.now();
      } else if (performance.now() - stableSince > 100) return;
    }
    throw new Error("Native scrolling did not settle");
  });
  await session.detach();
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".photo-card-menu").count(), 0, "scrolling must not open a menu");

  await longPress(first);
  let menu = await expectMenu(page);
  const originalMenu = await menu.elementHandle();
  const viewerId = await page.evaluate(() => document.querySelector(".image-viewer")?.getAttribute("data-image-id") ?? null);
  // Native contextmenu can follow the timer, then cancel/up and a compatibility click.
  // This exact sequence previously closed the menu immediately.
  await first.dispatchEvent("contextmenu", { ...pointer, button: 2 });
  await first.dispatchEvent("pointercancel", { ...pointer, buttons: 0 });
  await first.dispatchEvent("pointerup", { ...pointer, buttons: 0 });
  await first.dispatchEvent("click", { ...pointer, detail: 1 });
  await page.waitForTimeout(300);
  assert(await originalMenu.evaluate(element => element.isConnected && element.matches(":popover-open")), "duplicate contextmenu and gesture completion must not replace or dismiss the menu");
  assert.equal(await page.evaluate(() => document.querySelector(".image-viewer")?.getAttribute("data-image-id") ?? null), viewerId, "a long press must not open or switch the viewer");
  assert.equal(await controls.count(), 0);
  await page.screenshot({ path: `/tmp/pixhelf-long-press-${selector === ".image-card" ? "gallery" : "similar"}-${page.viewportSize().width}.png`, animations: "disabled" });
  await clickVisible(menu.getByRole("menuitem", { name: "复制文件名", exact: true }));
  await menu.getByRole("menuitem", { name: "已复制文件名", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await first.getAttribute("data-image-name"));
  await dismissTouchMenu(page);
  await longPress(second);
  menu = await expectMenu(page);
  assert.equal(await menu.locator(".photo-card-menu-heading strong").textContent(), await second.getAttribute("data-image-name"));
  assert.equal(await page.locator(".photo-card-menu:popover-open").count(), 1);
  await dismissTouchMenu(page);
}

async function expectMenu(page) {
  const menu = page.locator(".photo-card-menu:popover-open");
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem").count(), 6);
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  assert(bounds && bounds.x >= 10 && bounds.y >= 10);
  assert(bounds.x + bounds.width <= viewport.width - 10);
  assert(bounds.y + bounds.height <= viewport.height - 10);
  return menu;
}

async function expectDetails(page, imageId) {
  await page.waitForFunction(id => document.querySelector(".photo-info-dialog[open]")?.dataset.imageId === id, imageId);
  await page.locator(".photo-info-dialog .viewer-image-information-list").first().waitFor();
  const theme = await page.locator(".photo-info-dialog").evaluate(dialog => ({
    background: getComputedStyle(dialog).backgroundColor,
    color: getComputedStyle(dialog.querySelector(".viewer-image-information-list dd")).color,
    scheme: getComputedStyle(dialog).colorScheme,
  }));
  assert.equal(theme.scheme, "light");
  assert(theme.background.match(/\d+/g).slice(0, 3).every(value => Number(value) > 230));
  assert(theme.color.match(/\d+/g).slice(0, 3).every(value => Number(value) < 90));
}

async function checkViewerMenu(page) {
  const media = page.locator(".viewer-media:not(.viewer-swipe-outgoing)");
  const viewer = page.locator(".image-viewer");
  const imageId = await viewer.getAttribute("data-image-id");
  const filename = await viewer.getAttribute("data-image-name");
  await openMenu(media);
  let menu = await expectMenu(page);
  assert.equal(await viewer.getAttribute("data-dragging"), "false");
  assert.equal(await viewer.getAttribute("data-image-id"), imageId);
  if (page.viewportSize().width <= 720) {
    const backgrounds = await menu.getByRole("menuitem").evaluateAll(items => items.map(item => getComputedStyle(item).backgroundColor));
    assert(backgrounds.every(color => color === "rgba(0, 0, 0, 0)"), "touch menu items should not be highlighted on opening");
  }
  await clickVisible(menu.getByRole("menuitem", { name: "复制文件名", exact: true }));
  await menu.getByRole("menuitem", { name: "已复制文件名", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), filename);
  await page.screenshot({ path: `/tmp/pixhelf-viewer-menu-${page.viewportSize().width}.png`, animations: "disabled" });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await viewer.count(), 1);
  await page.keyboard.press("+");
  await page.locator('.image-viewer[data-zoomed="true"]').waitFor();
  await openMenu(media);
  menu = await expectMenu(page);
  await clickVisible(menu.getByRole("menuitem", { name: "图片信息", exact: true }));
  await expectDetails(page, imageId);
  await page.keyboard.press("Escape");
  await page.locator(".photo-info-dialog").waitFor({ state: "detached" });
  assert.equal(await viewer.getAttribute("data-zoomed"), "true", "the info dialog must preserve the image transform");
  assert(await media.evaluate(element => document.activeElement === element), "closing details should return focus to the current image");
  await page.keyboard.press("0");
  await page.locator('.image-viewer[data-zoomed="false"]').waitFor();
  if (page.viewportSize().width <= 720) {
    const point = await centerCard(media);
    await page.touchscreen.tap(point.x, point.y);
    await page.touchscreen.tap(point.x, point.y);
    await page.locator('.image-viewer[data-zoomed="true"]').waitFor();
    assert.equal(await page.locator(".photo-card-menu").count(), 0, "double tap still zooms without opening a menu");
    await page.keyboard.press("0");
    await page.locator('.image-viewer[data-zoomed="false"]').waitFor();
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      // Hold after movement: panning/swiping must cancel the long-press timer.
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x - 24, y: point.y }] });
      await page.waitForTimeout(600);
      assert.equal(await page.locator(".photo-card-menu").count(), 0);
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x - 120, y: point.y }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(id => document.querySelector(".image-viewer")?.dataset.imageId !== id, imageId);
    } finally { await session.detach(); }
    await openMenu(media);
    menu = await expectMenu(page);
    assert.equal(await menu.locator(".photo-card-menu-heading strong").textContent(), await viewer.getAttribute("data-image-name"));
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(id => document.querySelector(".image-viewer")?.dataset.imageId === id, imageId);
    const vertical = await page.context().newCDPSession(page);
    const start = await centerCard(media);
    try {
      await vertical.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
      for (let step = 1; step <= 5; step++) {
        await vertical.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y - step * 35 }] });
        await page.waitForTimeout(20);
      }
      await vertical.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(() => document.querySelector(".image-viewer").scrollTop > 80);
      assert.equal(await page.locator(".photo-card-menu").count(), 0, "vertical browsing should not open the image menu");
      await page.keyboard.press("ArrowUp");
      await page.waitForFunction(() => document.querySelector(".image-viewer").scrollTop < 2);
    } finally { await vertical.detach(); }
  }
}

async function expectSimilar(page, imageId) {
  await page.waitForFunction(id => new URLSearchParams(location.search).get("source") === id && document.querySelector(".app-shell")?.dataset.gallerySection === "similar", imageId);
  assert.equal(await page.locator(".image-viewer").count(), 0);
  await page.locator(".similar-search-page .image-card").first().waitFor();
}

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 }, hasTouch: width <= 720,
      permissions: ["clipboard-read", "clipboard-write"],
      storageState: process.env.PIXHELF_BROWSER_STORAGE_STATE,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(baseUrl);
    const card = page.locator(".image-card").first();
    await card.waitFor();
    const imageId = await card.getAttribute("data-image-id");
    const filename = await card.getAttribute("data-image-name");
    const originalPath = `/api/images/${encodeURIComponent(imageId)}/original`;
    assert.equal(await page.locator(".image-card[title], .image-card [title], .image-name").count(), 0);
    assert.equal(await page.locator(".photo-card-download").count(), 0);
    const more = card.locator(".photo-card-more");
    if (width > 720) {
      assert.equal(await more.isVisible(), false);
      await page.keyboard.press("Tab");
      await card.locator(".photo-card-open").focus();
      assert.equal(await more.count(), 0);
    } else {
      await checkTouchMenu(page, ".image-card");
      assert.equal(await page.locator(".image-viewer").count(), 0);
    }
    await openMenu(card);
    let menu = await expectMenu(page);
    assert.equal(await page.locator(".image-viewer").count(), 0);
    if (width > 720) await page.mouse.click(100, 5);
    else await dismissTouchMenu(page);
    await menu.waitFor({ state: "detached" });
    await openMenu(card);
    menu = await expectMenu(page);
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "图片信息");
    await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "复制文件名");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert(await card.locator(".photo-card-open").evaluate(element => document.activeElement === element));
    if (width > 720) await card.locator(".photo-card-open").press("Shift+F10");
    else await openMenu(card);
    menu = await expectMenu(page);
    await clickVisible(menu.getByRole("menuitem", { name: "复制文件名", exact: true }));
    await menu.getByRole("menuitem", { name: "已复制文件名", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), filename);
    await page.screenshot({ path: `/tmp/pixhelf-card-menu-${width}.png`, animations: "disabled" });
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert(await card.locator(".photo-card-open").evaluate(element => document.activeElement === element));
    await openMenu(card);
    menu = await expectMenu(page);
    const downloadEvent = page.waitForEvent("download");
    const downloadItem = menu.getByRole("menuitem", { name: "下载原图", exact: true });
    if (width <= 720) await clickVisible(downloadItem);
    else await downloadItem.click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), filename);
    assert.equal(new URL(download.url()).pathname, originalPath);
    assert.equal(await download.failure(), null);
    await page.locator(".photo-card-menu").waitFor({ state: "detached" });
    assert.equal(await page.locator(".image-viewer").count(), 0);
    if (width <= 720) {
      assert.equal(await more.isVisible(), false);
      await openMenu(card);
      await expectMenu(page);
      await dismissTouchMenu(page);
    }
    if (width > 720) {
      await page.mouse.move(100, 5);
      await more.waitFor({ state: "hidden" });
      const next = page.locator(".image-card").nth(1);
      await next.hover();
      assert.equal(await next.locator(".photo-card-more").count(), 0);
      assert.equal(await more.isVisible(), false, "mouse focus must not keep the previous card visible");
      await openMenu(card);
      await expectMenu(page);
      await page.mouse.move(100, 5);
      await page.locator(".photo-card-menu").waitFor({ state: "detached" });
      await more.waitFor({ state: "hidden" });
    }
    await openMenu(card);
    menu = await expectMenu(page);
    const popupEvent = page.waitForEvent("popup");
    await clickVisible(menu.getByRole("menuitem", { name: "在新标签页打开原图", exact: true }));
    const popup = await popupEvent;
    await popup.waitForLoadState();
    assert.equal(new URL(popup.url()).pathname, originalPath);
    assert.equal(await popup.evaluate(() => window.opener), null);
    await popup.close();
    await card.click({ button: "right" });
    await expectMenu(page);
    await page.mouse.click(100, 5);
    await page.locator(".photo-card-menu").waitFor({ state: "detached" });
    await openMenu(card);
    menu = await expectMenu(page);
    await clickVisible(menu.getByRole("menuitem", { name: "图片信息", exact: true }));
    await expectDetails(page, imageId);
    assert.equal(await page.locator(".image-viewer").count(), 0);
    assert.equal(new URL(page.url()).search, "");
    await page.screenshot({ path: `/tmp/pixhelf-photo-info-${width}.png`, animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.locator(".photo-info-dialog").waitFor({ state: "detached" });
    // The viewer keeps its own similarity toolbar; its cards use the same actions.
    await centerCard(card);
    await clickVisible(card.locator(".photo-card-open"));
    await page.locator(".image-viewer").waitFor();
    await checkViewerMenu(page);
    await page.locator(".viewer-similar-trigger").first().click();
    await page.locator(".viewer-similar-card").first().waitFor();
    assert.equal(await page.locator(".viewer-similar-card[title], .viewer-similar-card [title], .image-name").count(), 0);
    let similar = page.locator(".viewer-similar-card").first();
    if (width <= 720) await checkTouchMenu(page, ".viewer-similar-card");
    const candidateId = await similar.getAttribute("data-image-id");
    await openMenu(similar);
    menu = await expectMenu(page);
    await page.screenshot({ path: `/tmp/pixhelf-similar-card-menu-${width}.png`, animations: "disabled" });
    const candidateName = await similar.getAttribute("data-image-name");
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: () => Promise.reject(new Error("Clipboard API unavailable")),
      });
    });
    await clickVisible(menu.getByRole("menuitem", { name: "复制文件名", exact: true }));
    await menu.getByRole("menuitem", { name: "已复制文件名", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), candidateName);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await page.locator(".image-viewer").getAttribute("data-image-id"), imageId);
    await openMenu(similar);
    menu = await expectMenu(page);
    await page.keyboard.press("Tab");
    await menu.waitFor({ state: "detached" });
    assert(await page.evaluate(() => Boolean(document.activeElement.closest(".image-viewer"))));
    await openMenu(similar);
    menu = await expectMenu(page);
    await clickVisible(menu.getByRole("menuitem", { name: "图片信息", exact: true }));
    await expectDetails(page, candidateId);
    assert.equal(await page.locator(".image-viewer").getAttribute("data-image-id"), imageId);
    await page.keyboard.press("Escape");
    await page.locator(".photo-info-dialog").waitFor({ state: "detached" });
    assert.equal(await page.locator(".image-viewer").count(), 1);
    await page.locator(".viewer-similar-card").first().scrollIntoViewIfNeeded();
    similar = page.locator(".viewer-similar-card").first();
    const nestedId = await similar.getAttribute("data-image-id");
    await openMenu(similar);
    menu = await expectMenu(page);
    await clickVisible(menu.getByRole("menuitem", { name: "查找相似图片", exact: true }));
    await expectSimilar(page, nestedId);
    const result = page.locator(".similar-search-page .image-card").first();
    const resultId = await result.getAttribute("data-image-id");
    await centerCard(result);
    await clickVisible(result.locator(".photo-card-open"));
    await page.waitForFunction(id => document.querySelector(".image-viewer")?.dataset.imageId === id, resultId);
    await openMenu(page.locator(".viewer-media:not(.viewer-swipe-outgoing)"));
    menu = await expectMenu(page);
    await clickVisible(menu.getByRole("menuitem", { name: "查找相似图片", exact: true }));
    await expectSimilar(page, resultId);
    await page.goBack();
    await expectSimilar(page, nestedId);
    assert.deepEqual(errors, []);
    results.push({ width, disclosure: width > 720 ? "context menu beside cursor; no more button" : "long press; no more button; survives release/cancel and remains actionable", download: true, clipboard: true, originalTab: true, keyboard: true, details: true, similarActions: true, viewerMenu: true, lightDetails: true });
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
