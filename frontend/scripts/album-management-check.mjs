import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activateTouchCard, selectFromViewer } from "./selection-gestures-check.mjs";

export async function checkAlbumManagement(context, origin, gallery, fixture) {
  const page = await context.newPage();
  const width = page.viewportSize().width;
  const touch = width <= 720;
  const source = `管理测试-${width}`, destination = `收纳-${width}`;
  const child = `${source}/子相册`;
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const open = path => page.goto(`${origin}/?${new URLSearchParams({ view: "albums", ...(path ? { album: path } : {}) })}`);
  const album = path => page.locator(`.album-card[data-album-path="${path}"]`);
  const act = locator => touch ? locator.tap() : locator.click();
  const selectAlbum = async path => {
    const card = album(path);
    await card.scrollIntoViewIfNeeded();
    if (touch) await activateTouchCard(card); else await card.hover();
    await act(card.getByRole("checkbox"));
  };
  const settled = async () => {
    await page.locator(".selection-dialog").waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.querySelector('.gallery-selection-bar[aria-busy="true"]'));
  };
  const confirm = async label => { await act(page.locator(".selection-dialog").getByRole("button", { name: label, exact: true })); await settled(); };
  try {
    await mkdir(join(gallery, child, "空目录"), { recursive: true });
    await mkdir(join(gallery, destination));
    await copyFile(fixture, join(gallery, destination, "cover.jpg"));
    await copyFile(fixture, join(gallery, source, "a.jpg"));
    await copyFile(fixture, join(gallery, source, "c.jpg"));
    await copyFile(fixture, join(gallery, child, "b.jpg"));
    await writeFile(join(gallery, source, "说明.txt"), "album notes");
    const deadline = Date.now() + 15000;
    while (!(await fetch(`${origin}/api/gallery`).then(response => response.json())).albums.some(album => album.path === child)) {
      assert(Date.now() < deadline, "new album is indexed");
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Viewer menu selection keeps the photo and history open and follows navigation.
    await open(source);
    const photo = page.locator('.image-card[data-image-name="a.jpg"]');
    await photo.waitFor();
    assert.equal(await page.locator('.image-card[data-image-name="b.jpg"]').count(), 0, "parent album excludes child photos");
    assert.equal(await page.locator(".image-card").count(), 2);
    await act(photo.locator(".photo-card-open"));
    const viewer = page.locator(".image-viewer");
    await viewer.waitFor();
    const history = await page.evaluate(() => window.history.length);
    const firstId = await viewer.getAttribute("data-image-id");
    assert.equal(await viewer.locator(".viewer-header-actions, .viewer-selection-trigger").count(), 0);
    await page.screenshot({ path: `/tmp/pixhelf-viewer-selection-idle-${width}.png`, animations: "disabled" });
    await selectFromViewer(viewer.locator(".viewer-media"));
    assert.equal(await viewer.getAttribute("data-image-id"), firstId);
    assert.equal(await page.evaluate(() => window.history.length), history);
    await page.screenshot({ path: `/tmp/pixhelf-viewer-selection-${width}.png`, animations: "disabled" });
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(id => document.querySelector(".image-viewer")?.dataset.imageId !== id, firstId);
    await viewer.locator(".viewer-media").click({ button: "right" });
    await page.getByRole("menuitem", { name: "选择图片", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(id => document.querySelector(".image-viewer")?.dataset.imageId === id, firstId);
    await viewer.locator(".viewer-media").click({ button: "right" });
    await page.getByRole("menuitem", { name: "取消选择图片", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".viewer-media").click({ button: "right" });
    await act(page.getByRole("menuitem", { name: "取消选择图片", exact: true }));
    await selectFromViewer(viewer.locator(".viewer-media"));
    await act(page.locator(".viewer-header").getByRole("button", { name: "关闭查看器" }));
    await viewer.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector(".app-shell")?.dataset.viewerReturning === "false");
    assert.equal(await photo.getByRole("checkbox").getAttribute("aria-checked"), "true");
    assert(await page.locator(".gallery-selection-bar button").evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().width).every(button => {
      const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    })), "every image action including Copy fits in the bottom toolbar");
    await act(page.getByRole("button", { name: "复制", exact: true }));
    await act(page.locator(`.selection-dialog [role="treeitem"][data-path="${source}"]`));
    await confirm("复制");
    await page.locator('.image-card[data-image-name="a - 副本.jpg"]').waitFor();
    assert.deepEqual(await readFile(join(gallery, source, "a.jpg")), await readFile(join(gallery, source, "a - 副本.jpg")));

    // Nested directories are peers in the album catalog; selection clears on navigation.
    await open("");
    await selectAlbum(child);
    await selectAlbum(child);
    await page.locator(".gallery-selection-bar").waitFor({ state: "detached" });
    if (!touch) {
      await page.mouse.move(0, 0);
      await page.waitForFunction(element => getComputedStyle(element).opacity === "0", await album(child).getByRole("checkbox").elementHandle());
    }
    await selectAlbum(child);
    assert.equal(await page.getByRole("region", { name: "所选相册操作" }).count(), 1);
    await act(album(source).locator(".album-card-open"));
    await photo.waitFor();
    if (touch) await activateTouchCard(photo); else await photo.hover();
    await act(photo.getByRole("checkbox"));
    await page.getByRole("region", { name: "所选项目操作" }).waitFor();
    assert.equal(await page.locator(".gallery-selection-bar").count(), 1);
    assert.equal(await album(child).count(), 0);
    await page.keyboard.press("Escape");

    await open("");
    if (touch) assert.equal(await album(source).getByRole("checkbox").evaluate(element => getComputedStyle(element).opacity), "0", "mobile album selectors start hidden");
    await selectAlbum(source);
    await page.waitForFunction(() => [...document.querySelectorAll(".album-select")].every(button => getComputedStyle(button).opacity === "1"));
    await selectAlbum(destination);
    assert.equal(await page.locator('.album-card[data-selected="true"]').count(), 2);
    await selectAlbum(destination);
    await selectAlbum(source);
    await page.locator(".gallery-selection-bar").waitFor({ state: "detached" });
    if (!touch) {
      await page.mouse.move(0, 0);
      await page.waitForFunction(element => getComputedStyle(element).opacity === "0", await album(source).getByRole("checkbox").elementHandle());
    }
    if (touch) await activateTouchCard(album(source)); else await album(source).hover();
    const startBox = await album(source).getByRole("checkbox").boundingBox();
    const endBox = await album(destination).boundingBox();
    const start = { x: startBox.x + startBox.width / 2, y: startBox.y + startBox.height / 2 };
    const end = { x: endBox.x + endBox.width / 2, y: endBox.y + endBox.height / 2 };
    if (touch) {
      const session = await context.newCDPSession(page);
      try {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
        for (let step = 1; step <= 5; step++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + (end.x - start.x) * step / 5, y: start.y + (end.y - start.y) * step / 5 }] });
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } finally { await session.detach(); }
    } else {
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
    }
    await page.waitForFunction(() => document.querySelectorAll('.album-card[data-selected="true"]').length >= 2);
    assert.equal(await album(source).getByRole("checkbox").getAttribute("aria-checked"), "true");
    assert.equal(await album(destination).getByRole("checkbox").getAttribute("aria-checked"), "true");
    await page.keyboard.press("Escape");
    await selectAlbum(source);
    await page.screenshot({ path: `/tmp/pixhelf-album-selection-${width}.png`, animations: "disabled" });
    assert(await page.locator(".gallery-selection-bar button").evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().width).every(button => {
      const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    })), "every album action fits in the bottom toolbar");
    const download = page.waitForEvent("download");
    await act(page.getByRole("button", { name: "下载", exact: true }));
    assert.equal(await (await download).failure(), null);
    await settled();
    await act(page.getByRole("button", { name: "收藏所选相册", exact: true }));
    await page.getByRole("button", { name: "取消收藏所选相册", exact: true }).waitFor();
    await page.goto(`${origin}/?view=favorites`);
    await album(source).waitFor();
    await act(album(source).locator(".album-card-open"));
    await photo.waitFor();
    await open("");
    await selectAlbum(source);
    await act(page.getByRole("button", { name: "移动", exact: true }));
    assert.equal(await page.locator(`.selection-dialog [role="treeitem"][data-path="${child}"]`).count(), 0, "cannot move a folder inside itself");
    await act(page.locator(`.selection-dialog [role="treeitem"][data-path="${destination}"]`));
    await confirm("移动");
    await album(source).waitFor({ state: "detached" });
    const moved = `${destination}/${source}`;
    assert(await stat(join(gallery, moved, "子相册/空目录")).then(value => value.isDirectory()));
    await open("");
    await selectAlbum(moved);
    await act(page.getByRole("button", { name: "删除", exact: true }));
    await page.getByText(/包含全部内容/).waitFor();
    await confirm("移入回收站");
    await album(moved).waitFor({ state: "detached" });
    await page.goto(`${origin}/?view=trash`);
    await act(page.getByRole("button", { name: `恢复 ${source}`, exact: true }));
    await page.getByRole("button", { name: `恢复 ${source}`, exact: true }).waitFor({ state: "detached" });
    await page.goto(`${origin}/?view=favorites`);
    await album(moved).waitFor();
    assert.equal(await readFile(join(gallery, moved, "说明.txt"), "utf8"), "album notes");
    assert.deepEqual(await readFile(join(gallery, moved, "子相册/b.jpg")), await readFile(fixture), "whole-folder operations preserve child photos");
    assert(await stat(join(gallery, moved, "子相册/空目录")).then(value => value.isDirectory()));
    assert.deepEqual(errors, []);
    console.log(`${width}px album selection, nested folders, copy, viewer selection, downloads, favorites, move and whole-album recovery passed`);
  } catch (error) {
    await page.screenshot({ path: `/tmp/pixhelf-album-management-failure-${width}.png` }).catch(() => {});
    throw error;
  } finally { await page.close(); }
}
