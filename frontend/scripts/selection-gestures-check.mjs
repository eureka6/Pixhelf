import assert from "node:assert/strict";

const cards = page => page.locator(".justified-gallery .image-card");
const selected = page => page.locator('.image-card[data-selected="true"]').evaluateAll(elements => elements.map(element => element.dataset.imageId).sort());
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const pointAt = async (page, index, selector = false) => center(await (selector ? cards(page).nth(index).getByRole("checkbox") : cards(page).nth(index)).boundingBox());
const painted = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const top = async page => { await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" })); await painted(page); };
const exit = async page => {
  if (await page.locator(".gallery-selection-bar").count()) await page.keyboard.press("Escape");
  await page.locator(".gallery-selection-bar").waitFor({ state: "detached" });
  await top(page);
};
const expectSelection = async (page, ids, message) => {
  await page.waitForFunction(ids => {
    const actual = [...document.querySelectorAll('.image-card[data-selected="true"]')].map(element => element.dataset.imageId).sort();
    return JSON.stringify(actual) === JSON.stringify(ids);
  }, [...ids].sort(), { timeout: 4000 });
  assert.deepEqual(await selected(page), [...ids].sort(), message);
};
async function layout(page) {
  return cards(page).evaluateAll(elements => elements.map(element => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { id: element.dataset.imageId, left, top, right, bottom };
  }));
}
async function expectSelectionMode(page, active) {
  await page.waitForFunction(active => document.querySelector(".justified-gallery")?.dataset.selecting === String(active), active);
  assert.equal(await page.locator(".gallery-selection-bar").count(), Number(active), "the toolbar exists only when there is a selection");
  assert.equal(await page.locator(".selection-summary-toggle, .selection-exit").count(), 0, "selection toolbar omits the count menu and close button");
  if (active) {
    await page.waitForFunction(() => [...document.querySelectorAll(".photo-card-select")].every(element => getComputedStyle(element).opacity === "1"));
    assert(await page.locator(".photo-card-select").evaluateAll(elements => elements.every(element => getComputedStyle(element).opacity === "1")), "the first selection reveals every selector");
    assert.equal(await page.locator(".bottom-selection .gallery-selection-bar").count(), 1, "selection actions live at the bottom");
    const bar = await page.locator(".gallery-selection-bar").boundingBox();
    assert(bar.y >= 0 && bar.y + bar.height <= page.viewportSize().height
      && page.viewportSize().height - bar.y - bar.height <= 32, "selection actions stay near the bottom edge");
    assert(await page.locator(".topbar-actions").evaluate(element => getComputedStyle(element).display !== "none"), "topbar tools remain available during selection");
    assert(await page.locator(".selection-actions button").evaluateAll(buttons => buttons.every(button => {
      const rect = button.getBoundingClientRect(); return rect.width >= 40 && rect.right <= innerWidth;
    })), "selection actions fit the viewport");
  }
}
function intersects(items, a, b) {
  return items.filter(item => item.left < Math.max(a.x, b.x) && item.right > Math.min(a.x, b.x)
    && item.top < Math.max(a.y, b.y) && item.bottom > Math.min(a.y, b.y)).map(item => item.id);
}

export async function activateTouchCard(card) {
  const page = card.page();
  await card.scrollIntoViewIfNeeded();
  const point = center(await card.boundingBox());
  const session = await page.context().newCDPSession(page);
  try {
    // Sliding over a photo activates its existing floating feedback without tapping it open.
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x + 30, y: point.y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(element => element.dataset.cardActive === "true"
      && getComputedStyle(element.querySelector(".photo-card-select")).opacity === "1", await card.elementHandle());
    assert.equal(await page.locator(".image-viewer, .photo-card-menu").count(), 0, "activating a photo reveals the selector without opening it");
  } finally { await session.detach(); }
}

export async function selectFromViewer(card, video = false, selected = false) {
  const page = card.page();
  const original = await page.locator(".image-viewer, .video-viewer").getAttribute("data-image-id");
  const historyLength = await page.evaluate(() => history.length);
  const menu = page.locator(".photo-card-menu:popover-open");
  const label = selected ? video ? "取消选择视频" : "取消选择图片" : video ? "选择视频" : "选择图片";
  const bounds = await card.boundingBox();
  const position = video ? { x: bounds.width * .2, y: bounds.height * .35 } : undefined;
  if (page.viewportSize().width <= 720) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [position ? { x: bounds.x + position.x, y: bounds.y + position.y } : center(bounds)] });
      await menu.waitFor();
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await menu.getByRole("menuitem", { name: label, exact: true }).tap();
    } finally { await session.detach(); }
  } else {
    await card.click({ button: "right", position });
    await menu.getByRole("menuitem", { name: label, exact: true }).click();
  }
  await menu.waitFor({ state: "detached" });
  assert.equal(await page.locator(".image-viewer, .video-viewer").getAttribute("data-image-id"), original, "selection keeps the viewer on the same image");
  assert.equal(await page.evaluate(() => history.length), historyLength, "selection does not navigate");
}

export async function closeViewer(page) {
  await page.getByRole("button", { name: "关闭查看器", exact: true }).first().click();
  await page.locator(".image-viewer, .video-viewer").waitFor({ state: "detached" });
}

export async function checkViewerDiscoveredSelection(context, origin) {
  const page = await context.newPage();
  try {
    const source = await fetch(`${origin}/api/images?limit=100`).then(response => response.json());
    const subset = { items: source.items.slice(0, 2), total: 2, offset: 0, limit: 60, nextOffset: null };
    const discovered = source.items.find(image => !subset.items.some(item => item.id === image.id) && !image.video);
    assert(discovered, "fixture needs an image outside the gallery's current results");
    await page.route(`${origin}/`, async route => {
      const response = await route.fetch();
      const html = (await response.text()).replace(/(<script id="pixhelf-bootstrap"[^>]*>)([\s\S]*?)(<\/script>)/, (_match, start, json, end) => {
        const data = JSON.parse(json);
        data.images = subset;
        return start + JSON.stringify(data) + end;
      });
      await route.fulfill({ response, body: html });
    });
    await page.route("**/api/images?*", route => route.fulfill({ json: subset }));
    await page.goto(origin);
    await cards(page).first().waitFor();
    await page.route("**/api/images/*/similar?*", route => route.fulfill({ json: { items: [discovered], total: 1, offset: 0, limit: 30, nextOffset: null } }));
    await cards(page).nth(1).locator(".photo-card-open").click();
    await page.locator(".image-viewer").waitFor();
    await page.keyboard.press("PageDown");
    const similar = page.locator(`.viewer-similar-card[data-image-id="${discovered.id}"]`);
    await similar.waitFor();
    await similar.scrollIntoViewIfNeeded();
    await selectFromViewer(similar);
    const historyLength = await page.evaluate(() => history.length);
    await similar.locator(".photo-card-open").click({ button: "right" });
    await page.getByRole("menuitem", { name: "清空选择", exact: true }).click();
    await similar.locator(".photo-card-open").click({ button: "right" });
    await page.getByRole("menuitem", { name: "全选已加载", exact: true }).click();
    assert.equal(await page.evaluate(() => history.length), historyLength, "selecting a similar waterfall keeps the viewer's history");
    await closeViewer(page);
    await page.locator(".gallery-selection-bar").waitFor();
    const request = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/management/downloads");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载", exact: true }).click();
    assert.deepEqual((await request).postDataJSON().ids, [discovered.id], "a viewer discovery remains selected even outside the loaded gallery page");
    assert.equal(await (await download).failure(), null);
    await page.keyboard.press("Escape");
    await expectSelectionMode(page, false);
  } finally { await page.close(); }
}

export async function checkDesktopSelection(page) {
  await top(page);
  const first = cards(page).first();
  await first.locator(".photo-card-open").click({ button: "right" });
  const menu = page.locator(".photo-card-menu:popover-open");
  await menu.getByRole("menuitem", { name: "选择图片", exact: true }).click();
  const firstId = await first.getAttribute("data-image-id");
  await expectSelection(page, [firstId], "context menu selects the image");
  await expectSelectionMode(page, true);
  assert.equal(await page.locator(".image-viewer").count(), 0);
  await first.locator(".photo-card-open").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "取消选择图片", exact: true }).click();
  await expectSelection(page, [], "context menu can also deselect");
  await expectSelectionMode(page, false);
  const nextSelection = cards(page).nth(5);
  await nextSelection.hover();
  await nextSelection.getByRole("checkbox").click({ modifiers: ["Shift"] });
  await expectSelection(page, [await nextSelection.getAttribute("data-image-id")], "a new selection does not reuse the cleared range anchor");
  await exit(page);

  // Pointer focus left on the last unchecked button must not keep it visible.
  const selector = first.getByRole("checkbox");
  await first.hover();
  await selector.click();
  await expectSelectionMode(page, true);
  await selector.click();
  await expectSelectionMode(page, false);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => [...document.querySelectorAll(".photo-card-select")].every(button => getComputedStyle(button).opacity === "0"));

  // Genuine keyboard focus still reveals the controls after the last deselection.
  await page.keyboard.press("Shift+Tab");
  await first.locator(".photo-card-open").focus();
  await page.keyboard.press("Tab");
  assert(await selector.evaluate(element => element.matches(":focus-visible")));
  await page.keyboard.press("Space");
  await expectSelection(page, [firstId], "keyboard can select a photo");
  await page.keyboard.press("Space");
  await expectSelectionMode(page, false);
  assert.equal(await selector.evaluate(element => getComputedStyle(element).opacity), "1", "keyboard selection remains visible while focused");
  await page.mouse.click(0, 0);

  let items = await layout(page);
  const a = await pointAt(page, 0), b = await pointAt(page, 5), c = await pointAt(page, 1);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await expectSelection(page, intersects(items, a, b), "mouse rectangle hits the actual cards");
  await page.locator(".gallery-selection-marquee:visible").waitFor();
  await page.screenshot({ path: "/tmp/pixhelf-selection-box.png", animations: "disabled" });
  await page.mouse.move(c.x, c.y, { steps: 5 });
  await expectSelection(page, intersects(items, a, c), "shrinking a rectangle restores items outside it");
  await page.mouse.up();
  assert.equal(await page.locator(".gallery-selection-marquee:visible, .image-viewer").count(), 0, "release does not open a photo");

  const base = await selected(page);
  const d = await pointAt(page, 2), e = await pointAt(page, 5);
  await page.keyboard.down("Control");
  await page.mouse.move(d.x, d.y); await page.mouse.down();
  await page.mouse.move(e.x, e.y, { steps: 6 }); await page.mouse.up();
  await page.keyboard.up("Control");
  await expectSelection(page, new Set([...base, ...intersects(items, d, e)]), "Ctrl adds the rectangle to the existing selection");

  const beforeCancel = await selected(page);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(c.x, c.y, { steps: 6 });
  await expectSelection(page, intersects(items, a, c), "unmodified drag replaces the selection");
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expectSelection(page, beforeCancel, "Escape rolls back just the current drag");
  assert.equal(await page.locator(".image-viewer").count(), 0);
  await exit(page);

  // Begin between rows, where there is no card button to own the pointer.
  items = await layout(page);
  const gap = { x: items[0].left + 10, y: items[0].bottom + 3 };
  const end = await pointAt(page, 4);
  await page.mouse.move(gap.x, gap.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up();
  await expectSelection(page, intersects(items, gap, end), "drag can start in gallery gaps");
  await exit(page);

  // A small hand movement must remain a normal click.
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(a.x + 2, a.y + 1); await page.mouse.up();
  await page.locator(".image-viewer").waitFor();
  await page.locator(".viewer-media:not(.viewer-swipe-outgoing)").click({ button: "right" });
  assert.equal(await menu.getByRole("menuitem", { name: "查看大图", exact: true }).count(), 0);
  await menu.getByRole("menuitem", { name: "选择图片", exact: true }).click();
  assert.equal(await page.locator(".image-viewer").count(), 1, "right-click selection keeps the viewer open");
  await page.locator(".viewer-media:not(.viewer-swipe-outgoing)").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "取消选择图片", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await closeViewer(page);
  await page.locator(".gallery-selection-bar").waitFor();
  await expectSelection(page, [firstId], "viewer selection is retained when closing");
  await expectSelectionMode(page, true);
  await first.getByRole("checkbox").click();
  await expectSelectionMode(page, false);
  await first.locator(".photo-card-open").click();
  await page.locator(".image-viewer").waitFor();
  await page.getByRole("button", { name: "关闭查看器" }).first().click();
  await page.locator(".image-viewer").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.viewerReturning === "false");
  await top(page);

  const start = await pointAt(page, 0);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 20, page.viewportSize().height - 20, { steps: 8 });
  await page.waitForFunction(() => scrollY > 180, null, { timeout: 4000 });
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.waitForFunction(before => scrollY > before + 120, scrollBefore, { timeout: 4000 });
  await page.mouse.up();
  assert((await selected(page)).length > 4, "holding near the bottom selects offscreen rows");
  assert.equal(await page.locator(".image-viewer").count(), 0);
  await exit(page);
}

export async function checkSelectionLimit(context, origin, photo) {
  const page = await context.newPage();
  const images = Array.from({ length: 520 }, (_, index) => ({ id: `limit-${index}`, name: `${index}.jpg`, width: 640, height: 480 }));
  await page.route(`${origin}/`, async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace(/(<script id="pixhelf-bootstrap"[^>]*>)([\s\S]*?)(<\/script>)/, (_match, start, json, end) => {
      const data = JSON.parse(json);
      data.summary.total = images.length;
      data.images = { items: images.slice(0, 60), total: images.length, offset: 0, limit: 60, nextOffset: 60 };
      return start + JSON.stringify(data) + end;
    });
    await route.fulfill({ response, body: html });
  });
  await page.route("**/api/images?**", route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    return route.fulfill({ json: { items: images.slice(offset), total: images.length, offset, limit: 500, nextOffset: null } });
  });
  await page.route("**/api/images/limit-*/thumbnail*", route => route.fulfill({ contentType: "image/jpeg", body: photo }));
  try {
    await page.goto(origin);
    await cards(page).first().waitFor();
    const rect = await cards(page).first().boundingBox();
    const a = { x: rect.x + 2, y: rect.y + 2 };
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(a.x + 15, page.viewportSize().height / 2, { steps: 3 });
    await page.locator("[data-selection-dragging]").waitFor();
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
    await page.waitForFunction(() => document.querySelectorAll(".image-card").length === 520);
    assert.equal(await page.locator("[data-selection-dragging]").count(), 1, "pagination must not end the gesture");
    await cards(page).last().scrollIntoViewIfNeeded();
    const end = await cards(page).last().boundingBox();
    await page.mouse.move(end.x + end.width - 2, end.y + end.height - 2, { steps: 6 });
    await page.waitForFunction(() => document.querySelectorAll('.image-card[data-selected="true"]').length === 500);
    await page.getByText("已达 500 项上限，其余项目可分批操作", { exact: true }).waitFor();
    await top(page);
    await page.mouse.move(a.x + 15, a.y + 15, { steps: 3 });
    await expectSelection(page, [images[0].id], "backtracking from the selection limit still shrinks the rectangle");
    await page.mouse.up();
  } finally { await page.close(); }
}

export async function checkTouchSelection(page) {
  const session = await page.context().newCDPSession(page);
  const touch = (type, points = []) => session.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((point, id) => ({ ...point, id })) });
  const slide = async (a, b) => {
    for (let step = 1; step <= 8; step++) {
      await touch("touchMove", [{ x: a.x + (b.x - a.x) * step / 8, y: a.y + (b.y - a.y) * step / 8 }]);
      await page.waitForTimeout(18);
    }
  };
  const scrollNormally = async () => {
    const card = cards(page).nth(4);
    const point = center(await card.boundingBox());
    const before = await page.evaluate(() => scrollY);
    await touch("touchStart", [point]);
    await slide(point, { x: point.x, y: point.y - 150 });
    await touch("touchEnd");
    await page.waitForFunction(before => scrollY > before + 30, before);
    // Wait for native momentum to settle before starting another gesture.
    await page.evaluate(async () => {
      let previous = scrollY, stable = 0;
      for (let frame = 0; frame < 180; frame++) {
        await new Promise(requestAnimationFrame);
        if (scrollY === previous) stable++; else stable = 0;
        previous = scrollY;
        if (stable > 8) return;
      }
      throw new Error("Touch scroll did not settle");
    });
    assert.equal(await page.locator(".photo-card-menu, .image-viewer").count(), 0);
    await top(page);
  };
  try {
    await top(page);
    assert(await page.locator(".photo-card-select").evaluateAll(elements => elements.every(element => getComputedStyle(element).opacity === "0" && getComputedStyle(element).pointerEvents === "none")), "mobile starts with every selector hidden and unable to intercept touches");
    await page.screenshot({ path: `/tmp/pixhelf-selection-idle-${page.viewportSize().width}.png`, animations: "disabled" });
    await scrollNormally();
    assert.equal(await page.locator(".gallery-selection-bar").count(), 0, "normal browsing does not enter selection mode");
    const ids = (await layout(page)).map(item => item.id);
    await activateTouchCard(cards(page).first());
    assert.equal(await cards(page).nth(1).getByRole("checkbox").evaluate(element => getComputedStyle(element).opacity), "0", "activating one photo keeps other selectors hidden");
    await page.screenshot({ path: `/tmp/pixhelf-selection-active-${page.viewportSize().width}.png`, animations: "disabled" });
    const corner = await cards(page).first().evaluate(card => {
      const rect = card.getBoundingClientRect(), circle = card.querySelector(".photo-card-select > span").getBoundingClientRect();
      return { top: circle.top - rect.top, right: rect.right - circle.right };
    });
    assert(corner.top >= 4 && corner.top <= 7 && corner.right >= 4 && corner.right <= 7, "mobile circle stays close to the corner");
    await cards(page).first().getByRole("checkbox").tap();
    await expectSelectionMode(page, true);
    await cards(page).nth(1).locator(".photo-card-open").tap();
    await page.locator(".image-viewer").waitFor();
    await expectSelection(page, [ids[0]], "touching the photo browses without changing the selection");
    await closeViewer(page);
    await cards(page).first().getByRole("checkbox").tap();
    await expectSelectionMode(page, false);
    await page.waitForFunction(element => getComputedStyle(element).opacity === "0", await cards(page).nth(1).getByRole("checkbox").elementHandle());
    assert.equal(await cards(page).nth(1).getByRole("checkbox").evaluate(element => getComputedStyle(element).opacity), "0", "deselecting the last item hides inactive selectors again");
    await activateTouchCard(cards(page).first());
    const a = await pointAt(page, 0, true), b = await pointAt(page, 5), c = await pointAt(page, 2);
    await touch("touchStart", [a]);
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".photo-card-menu").count(), 0, "holding the selector does not open a long-press menu");
    await slide(a, b);
    await expectSelection(page, ids.slice(0, 6), "touch range includes skipped cards between rows");
    assert.equal(await page.evaluate(() => scrollY), 0, "selector dragging does not pan the page away from an edge");
    await slide(b, c);
    await expectSelection(page, ids.slice(0, 3), "backtracking restores the previous range");
    await touch("touchEnd");
    await expectSelection(page, ids.slice(0, 3), "touch release does not toggle the final photo again");
    await expectSelectionMode(page, true);
    assert.equal(await page.locator(".image-viewer, .photo-card-menu, .media-preview[data-playing=\"true\"]").count(), 0);
    await page.screenshot({ path: `/tmp/pixhelf-selection-touch-${page.viewportSize().width}.png`, animations: "disabled" });

    await touch("touchStart", [a]); await slide(a, c); await touch("touchEnd");
    await expectSelection(page, [], "starting on a checked selector removes the range");
    await expectSelectionMode(page, false);
    await activateTouchCard(cards(page).nth(5));
    await cards(page).nth(5).getByRole("checkbox").tap();
    await activateTouchCard(cards(page).first());
    await touch("touchStart", [a]); await slide(a, c); await touch("touchEnd");
    const base = [...ids.slice(0, 3), ids[5]];
    await expectSelection(page, base, "touch range retains unrelated selections");

    await activateTouchCard(cards(page).nth(3));
    const d = await pointAt(page, 3, true), e = await pointAt(page, 4);
    await touch("touchStart", [d]); await slide(d, e);
    await expectSelection(page, ids.slice(0, 6));
    await touch("touchCancel");
    await expectSelection(page, base, "interrupted touch restores the selection snapshot");
    await activateTouchCard(cards(page).nth(3));
    await touch("touchStart", [d]); await slide(d, e);
    await touch("touchStart", [e, { x: e.x + 35, y: e.y + 35 }]);
    await touch("touchEnd");
    await expectSelection(page, base, "a second finger cancels range selection");
    assert.equal(await page.locator("[data-selection-dragging]").count(), 0);
    await scrollNormally();
    await expectSelection(page, base, "selection mode keeps normal vertical scrolling");

    await page.keyboard.press("Escape");
    await expectSelectionMode(page, false);
    await activateTouchCard(cards(page).first());
    const edge = { x: a.x, y: page.viewportSize().height - 20 };
    await touch("touchStart", [a]); await slide(a, edge);
    await page.waitForFunction(() => scrollY > 140, null, { timeout: 4000 });
    const extended = (await selected(page)).length;
    await slide(edge, { x: a.x, y: 64 });
    await page.waitForFunction(() => scrollY < 5, null, { timeout: 4000 });
    await touch("touchEnd");
    assert((await selected(page)).length < extended, "scrolling back up shrinks the range");
    assert.equal(await page.locator(".image-viewer, .photo-card-menu").count(), 0);
    await exit(page);
    const photo = cards(page).nth(1);
    const id = await photo.getAttribute("data-image-id");
    await photo.locator(".photo-card-open").tap();
    await page.locator(".image-viewer").waitFor();
    await selectFromViewer(page.locator(".viewer-media:not(.viewer-swipe-outgoing)"));
    await closeViewer(page);
    await expectSelection(page, [id], "viewer selection is retained when closing on touch");
    await expectSelectionMode(page, true);
    await photo.getByRole("checkbox").tap();
    await expectSelectionMode(page, false);
    await top(page);
  } finally { await session.detach(); }
}
