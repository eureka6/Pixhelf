import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright-core";

// Render the production bundle and fulfill every request in memory. No listener,
// application process or external network is used by this check.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const html = await readFile(join(dist, "index.html"), "utf8");
const photo = await readFile(new URL("./fixtures/live-photo.jpg", import.meta.url));
const output = process.env.PIXHELF_SCREENSHOTS ?? "/tmp/pixhelf-local-ui";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 720, isMobile: width < 720 });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], calls = [];
    page.on("pageerror", error => errors.push(error.message));
    if (process.env.PIXHELF_TEST_DEBUG) await page.addInitScript(() => {
      window.events = [];
      for (const type of ["scroll", "contextmenu", "toggle", "popstate"]) window.addEventListener(type, event => {
        window.events.push({ type, target: event.target.className, scroll: scrollY, open: event.newState, returning: document.querySelector(".app-shell")?.dataset.viewerReturning });
        window.events = window.events.slice(-20);
      }, true);
    });
    const longName = "晨雾与山川的长名称相册".repeat(5);
    const deepPath = `仅目录/归档/摄影/${longName}`;
    const paths = new Set(["旅行", "旅行/城市", "旅行/城市/夜景", "旅行/郊野", "目标", "空目录", `旅行/${longName}`, "仅目录", "仅目录/归档", "仅目录/归档/摄影", deepPath, ...Array.from({ length: 45 }, (_, i) => `归档-${String(i).padStart(2, "0")}`)]);
    const photos = ["旅行/城市/夜景", "旅行", "旅行/城市", `旅行/${longName}`, deepPath, ""].map((album, i) => ({ id: String(i + 1).padStart(32, "0"), name: `photo-${i}.jpg`, width: 1200, height: 900, album }));
    photos.push(...[100, 101].map(i => ({ id: String(i).padStart(32, "0"), name: `photo-${i}.jpg`, width: 1200, height: 900, album: "旅行/城市/夜景" })));
    let revision = 1, guest = false, invalidDirectoryPage = false, privateAlbums = new Set(), favoriteAlbums = new Set();
    const auth = () => guest ? { enabled: true, authenticated: false, guest: true } : { enabled: true, authenticated: true, guest: false, username: "admin", csrfToken: "1".repeat(64) };
    const visiblePhotos = () => photos.filter(image => !guest || !privateAlbums.has(image.album));
    const imagePage = (images = visiblePhotos(), offset = 0, limit = 60) => ({ items: images.slice(offset, offset + limit), total: images.length, offset, limit, nextOffset: offset + limit < images.length ? offset + limit : null });
    const summary = () => ({ total: visiblePhotos().length, revision: String(revision), albums: [...paths].filter(path => !guest || !privateAlbums.has(path)).map(path => ({ path, name: path.split("/").at(-1), count: photos.filter(image => image.album === path).length, cover: photos.find(image => image.album === path)?.id ?? null })).filter(album => album.count > 0) });
    const status = { total: photos.length, ready: photos.length, failed: 0, queued: 0, processing: 0, initialBatchReady: true, backgroundComplete: true, textSearch: { enabled: false, total: 0, ready: 0, queued: 0, processing: 0, failed: 0, backgroundComplete: true } };
    const within = (path, parent) => path === parent || path.startsWith(parent + "/");
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      const reply = (value, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(value) });
      if (url.hostname !== "pixhelf.test") return route.abort();
      if (path === "/") return route.fulfill({ contentType: "text/html", body: html.replace("__PIXHELF_AUTH__", JSON.stringify(auth())).replace("__PIXHELF_BOOTSTRAP__", JSON.stringify({ summary: summary(), status, images: imagePage() })) });
      if (path.startsWith("/assets/")) {
        try { return route.fulfill({ contentType: path.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(join(dist, path.slice(1))) }); }
        catch { return route.fulfill({ status: 404, body: "" }); }
      }
      calls.push({ path, query: Object.fromEntries(url.searchParams), body: request.postDataJSON() });
      if (path === "/api/auth/session") return reply(auth());
      if (path === "/api/auth/guest") return reply({ enabled: true });
      if (path === "/api/gallery") return reply(summary());
      if (path === "/api/status") return reply(status);
      if (path === "/api/images") {
        let items = visiblePhotos();
        if (url.searchParams.get("album")) items = items.filter(image => image.album === url.searchParams.get("album"));
        return reply(imagePage(items, Number(url.searchParams.get("offset") ?? 0)));
      }
      if (path.startsWith("/api/images/")) {
        const parts = path.split("/"), image = visiblePhotos().find(image => image.id === parts[3].split(".")[0]);
        if (!image) return reply({}, 404);
        if (parts[4] === "thumbnail" || parts[4] === "original" || path.endsWith(".jpg")) return route.fulfill({ contentType: "image/jpeg", body: photo });
        if (parts[4] === "similar") return reply(imagePage([]));
        return reply(image);
      }
      if (path.startsWith("/api/management")) {
        if (guest) return reply({ error: "仅限管理员" }, 403);
        if (path === "/api/management") return reply({ favoriteIds: [], favoriteAlbums: [...favoriteAlbums], privateAlbums: [...privateAlbums], trashCount: 0 });
        if (path === "/api/management/sharing") {
          const body = request.postDataJSON();
          if (body.shared) privateAlbums.delete(body.path); else privateAlbums.add(body.path);
          revision++; return reply({ ok: true });
        }
        if (path === "/api/management/batch") {
          const body = request.postDataJSON();
          if (body.kind === "albums" && body.action === "favorite") for (const path of body.ids) { if (body.favorite) favoriteAlbums.add(path); else favoriteAlbums.delete(path); }
          revision++; return reply({ results: body.ids.map(id => ({ id, ok: true, error: null })) });
        }
        if (path === "/api/management/directories" && request.method() === "POST") {
          const body = request.postDataJSON();
          const parent = body.path.split("/").slice(0, -1).join("/");
          const next = body.action === "create" ? [body.path, body.name].filter(Boolean).join("/") : body.action === "rename" ? [parent, body.name].filter(Boolean).join("/") : body.action === "move" ? [body.destination, body.path.split("/").at(-1)].filter(Boolean).join("/") : parent;
          if (body.action !== "trash" && paths.has(next)) return reply({ error: "目标位置存在同名目录" }, 409);
          if (body.action === "create") paths.add(next);
          else for (const old of [...paths].filter(path => within(path, body.path))) { paths.delete(old); if (body.action !== "trash") paths.add(next + old.slice(body.path.length)); }
          if (body.action === "rename" || body.action === "move") for (const image of photos) if (within(image.album, body.path)) image.album = next + image.album.slice(body.path.length);
          revision++; return reply({ path: next });
        }
        if (path === "/api/management/directories") {
          const current = url.searchParams.get("path") ?? "", search = url.searchParams.get("search")?.toLowerCase() ?? "", content = url.searchParams.get("content") === "true";
          if (content && invalidDirectoryPage) return reply({ path: current, items: [], images: [], total: 2, nextOffset: 0 });
          let items = [...paths].filter(path => search && !content ? path.toLowerCase().includes(search) : path.split("/").slice(0, -1).join("/") === current && path.split("/").at(-1).toLowerCase().includes(search)).map(path => ({ path, name: path.split("/").at(-1), directory: true, hasChildren: [...paths].some(child => child.startsWith(path + "/")), size: 0, imageId: null }));
          if (content) items.push(...photos.filter(image => image.album === current && image.name.toLowerCase().includes(search)).map(image => ({ path: `${current}/${image.name}`, name: image.name, directory: false, hasChildren: false, size: 1024, imageId: image.id })));
          if (content && current === "旅行/城市/夜景" && !search) items.splice(2, 0, ...["notes.txt", "notes2.txt"].map(name => ({ path: `${current}/${name}`, name, directory: false, hasChildren: false, size: 32, imageId: null })));
          const offset = Number(url.searchParams.get("offset") ?? 0), limit = content && current === "旅行/城市/夜景" ? 2 : 200;
          const visible = items.slice(offset, offset + limit);
          return reply({ path: current, items: visible, images: visible.flatMap(item => photos.filter(image => image.id === item.imageId)), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null });
        }
      }
      return reply({}, 404);
    });
    const act = async locator => {
      try { return await (width < 720 ? locator.tap() : locator.click()); }
      catch (error) {
        console.log(JSON.stringify(await page.evaluate(() => ({ events: window.events, menu: document.querySelector(".selection-menu")?.outerHTML, viewer: Boolean(document.querySelector(".image-viewer")), returning: document.querySelector(".app-shell")?.dataset.viewerReturning }))));
        await page.screenshot({ path: join(output, `failure-${width}.png`) });
        throw error;
      }
    };
    const card = path => page.locator(".album-card").filter({ has: page.locator(`a[href="/?view=albums&album=${encodeURIComponent(path)}"]`) });
    const treeRow = (path, container = page) => container.locator(`[role="treeitem"][data-path="${path}"]`);
    const menu = async path => {
      const target = card(path);
      if (width < 720) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.locator(".album-cover").boundingBox();
        const touch = await context.newCDPSession(page);
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
        await page.waitForTimeout(600);
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await touch.detach();
      }
      else await target.locator(".album-card-open").click({ button: "right" });
      try { await page.getByRole("menu", { name: "相册管理" }).waitFor(); }
      catch (error) {
        await page.screenshot({ path: join(output, `failure-${width}.png`) });
        console.log(await page.evaluate(() => ({ events: window.events, menu: document.querySelector(".selection-menu")?.outerHTML, viewer: Boolean(document.querySelector(".image-viewer")), returning: document.querySelector(".app-shell")?.dataset.viewerReturning })));
        throw error;
      }
    };
    const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: page width`);
    await page.goto("https://pixhelf.test/?view=albums");
    await page.waitForFunction(count => document.querySelectorAll(".album-card").length === count, summary().albums.length);
    assert.equal(await page.locator(".album-children, .album-heading, .album-menu-trigger").count(), 0);
    assert.equal(await card("空目录").count(), 0, "empty directories do not appear as albums");
    assert.equal(await page.locator(".album-cover h2, .album-cover .album-markers, .album-cover .album-size").count(), 0, "information must not cover the photo");
    assert.equal(await page.locator(".album-caption h2").count(), summary().albums.length);
    assert(await card("旅行").evaluate(card => card.querySelector(".album-caption").getBoundingClientRect().top >= card.querySelector(".album-cover").getBoundingClientRect().bottom));
    assert(await card("旅行").evaluate(card => card.querySelector(".album-path").getBoundingClientRect().top >= card.querySelector(".album-cover").getBoundingClientRect().bottom));
    await noOverflow();
    await page.screenshot({ path: join(output, `albums-${width}.png`) });
    await card("旅行/城市/夜景").locator(".album-select").evaluate(button => button.click());
    await card("旅行").locator(".album-select").evaluate(button => button.click());
    assert.equal(await page.locator('.album-select[aria-checked="true"]').count(), 2, "parent and child select independently");
    await menu("旅行/城市/夜景");
    assert.equal(await page.getByRole("menuitem", { name: "移动所选", exact: true }).count(), 1);
    await act(page.getByRole("menuitem", { name: "全选已显示相册", exact: true }));
    assert.equal(await page.locator('.album-select[aria-checked="true"]').count(), summary().albums.length, "every flat album is selected");
    await menu("旅行/城市/夜景");
    await act(page.getByRole("menuitem", { name: "收藏所选", exact: true }));
    await page.waitForFunction(count => document.querySelectorAll('[aria-label="已收藏相册"]').length === count, summary().albums.length);
    assert.equal(favoriteAlbums.size, summary().albums.length, "all paths reach the batch API");
    await menu("旅行/城市/夜景");
    await act(page.getByRole("menuitem", { name: "清空选择", exact: true }));
    await menu("旅行/城市/夜景");
    assert.equal(await page.getByRole("menuitemcheckbox", { name: "访客分享" }).getAttribute("aria-checked"), "true");
    await act(page.getByRole("menuitemcheckbox", { name: "访客分享" }));
    await card("旅行/城市/夜景").getByLabel("未分享").waitFor();
    await menu("旅行/城市/夜景");
    assert.equal(await page.getByRole("menuitemcheckbox", { name: "访客分享" }).getAttribute("aria-checked"), "false");
    await act(page.getByRole("menuitem", { name: "查看封面", exact: true }));
    await page.locator(".image-viewer").waitFor();
    await act(page.getByRole("button", { name: "关闭查看器", exact: true }));
    await page.locator(".image-viewer").waitFor({ state: "detached" });
    await menu("旅行/城市/夜景");
    await act(page.getByRole("menuitem", { name: "移动", exact: true }));
    const dialog = page.getByRole("dialog");
    await treeRow("旅行", dialog).waitFor();
    assert.equal(await treeRow("旅行/城市", dialog).count(), 0, "descendants start collapsed");
    if (width > 720) {
      await treeRow("", dialog).focus();
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.locator(":focus").getAttribute("data-path"), "旅行");
      assert.equal(await treeRow("旅行", dialog).getAttribute("aria-selected"), "false", "keyboard focus does not change destination");
    }
    await dialog.locator(".directory-tree-scroll").hover();
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(100);
    assert(await dialog.locator(".directory-tree-scroll").evaluate(element => element.scrollTop > 0), "wheel scrolls the directory tree");
    await dialog.locator(".directory-tree-scroll").evaluate(element => { element.scrollTop = 0; });
    await act(dialog.getByRole("button", { name: "展开旅行", exact: true }));
    await treeRow("旅行/城市", dialog).waitFor();
    await act(dialog.getByRole("button", { name: "展开城市", exact: true }));
    assert.equal(await treeRow("旅行/城市/夜景", dialog).count(), 0, "cannot move into itself");
    const scrollBefore = await page.evaluate(() => scrollY);
    await dialog.locator(".directory-tree-scroll").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await dialog.locator(".directory-tree-scroll").hover();
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => scrollY), scrollBefore, "tree boundary does not scroll page");
    await dialog.getByRole("searchbox", { name: "查找目录" }).fill("空目录");
    assert.deepEqual(await dialog.getByRole('searchbox', { name: '查找目录' }).evaluate(input => {
      const style = getComputedStyle(input), field = getComputedStyle(input.parentElement);
      return [style.outlineStyle, style.boxShadow, field.boxShadow];
    }), ['none', 'none', 'none'], 'directory search has no nested focus frame or glow');
    await treeRow("空目录", dialog).waitFor();
    await act(treeRow("空目录", dialog));
    await noOverflow();
    await page.screenshot({ path: join(output, `picker-${width}.png`) });
    await act(dialog.getByRole("button", { name: "取消", exact: true }));
    await act(card("旅行/城市/夜景").locator(".album-path"));
    await page.getByRole("heading", { name: "本地存储", exact: true }).waitFor();
    await page.locator(".local-entry").first().waitFor();
    assert.equal(new URL(page.url()).searchParams.get("path"), "旅行/城市/夜景");
    await noOverflow();
    await page.screenshot({ path: join(output, `local-${width}.png`) });
    const beforeSingleReads = calls.filter(call => /^\/api\/images\/[a-f0-9]{32}$/.test(call.path)).length;
    await act(page.locator(".local-entry-open").first());
    const viewer = page.locator(".image-viewer");
    await viewer.waitFor();
    assert.equal(await viewer.getAttribute("data-image-name"), "photo-0.jpg");
    await act(page.getByRole("button", { name: "下一张图片", exact: true }));
    await page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.imageName === "photo-100.jpg");
    await act(page.getByRole("button", { name: "下一张图片", exact: true }));
    await page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.imageName === "photo-101.jpg");
    await act(page.getByRole("button", { name: "上一张图片", exact: true }));
    await page.waitForFunction(() => document.querySelector(".image-viewer")?.dataset.imageName === "photo-100.jpg");
    assert.equal(calls.filter(call => /^\/api\/images\/[a-f0-9]{32}$/.test(call.path)).length, beforeSingleReads, "directory listing supplies viewer metadata without one request per image");
    assert(calls.some(call => call.path === "/api/management/directories" && call.query.offset === "4"), "viewer skips a page containing only documents");
    await act(page.getByRole("button", { name: "关闭查看器", exact: true }));
    await viewer.waitFor({ state: "detached" });
    assert.equal(new URL(page.url()).searchParams.get("path"), "旅行/城市/夜景");
    // Right click the media row, then the directory footer's blank space.
    await page.locator(".local-entry").first().click({ button: "right" });
    await page.getByRole("menu", { name: "文件管理" }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "移动到", exact: true }).count(), 1);
    await act(page.getByRole("menuitem", { name: "复制到", exact: true }));
    await treeRow("目标", dialog).waitFor();
    assert.equal(calls.filter(call => /^\/api\/images\/[a-f0-9]{32}$/.test(call.path)).length, beforeSingleReads, "file actions reuse the directory's image metadata");
    await act(dialog.getByRole("button", { name: "取消", exact: true }));
    await page.locator(".local-directory-footer").click({ button: "right", position: { x: 5, y: 5 } });
    await page.getByRole("menu", { name: "目录管理" }).waitFor();
    await act(page.getByRole("menuitem", { name: "新建目录", exact: true }));
    await page.getByRole("textbox", { name: "目录名称" }).fill("新目录");
    await act(page.getByRole("button", { name: "保存", exact: true }));
    await page.waitForURL(url => url.searchParams.get("path") === "旅行/城市/夜景/新目录");
    await act(page.getByRole("button", { name: "管理当前目录" }));
    await act(page.getByRole("menuitem", { name: "重命名", exact: true }));
    await page.getByRole("textbox", { name: "目录名称" }).fill("已重命名");
    await act(page.getByRole("button", { name: "保存", exact: true }));
    await page.waitForURL(url => url.searchParams.get("path") === "旅行/城市/夜景/已重命名");
    await act(page.getByRole("button", { name: "管理当前目录" }));
    await act(page.getByRole("menuitem", { name: "移动", exact: true }));
    await treeRow("目标", dialog).waitFor();
    await act(treeRow("目标", dialog));
    await act(dialog.getByRole("button", { name: "移动", exact: true }));
    await page.waitForURL(url => url.searchParams.get("path") === "目标/已重命名");
    await act(page.getByRole("button", { name: "管理当前目录" }));
    await act(page.getByRole("menuitem", { name: "移入回收站", exact: true }));
    await act(dialog.getByRole("button", { name: "移入回收站", exact: true }));
    await page.waitForURL(url => url.searchParams.get("path") === "目标");
    assert(!paths.has("目标/已重命名"));
    await page.goto("https://pixhelf.test/?view=local");
    await page.locator(".local-entry").first().waitFor();
    await page.locator(".local-directory-list").hover({ position: { x: 40, y: 90 } });
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => scrollY > 100);
    assert.equal(await page.locator(".local-directory-list").evaluate(element => element.scrollTop), 0, "content uses page scrolling, with no nested scroll trap");
    await page.evaluate(() => scrollTo(0, 0));
    if (width < 720) await act(page.getByRole("button", { name: "目录", exact: true }));
    await treeRow("旅行").waitFor();
    await treeRow("旅行").click({ button: "right" });
    await act(page.getByRole("menuitem", { name: "重命名", exact: true }));
    assert.equal(await page.getByRole("textbox", { name: "目录名称" }).inputValue(), "旅行", "tree menu targets the clicked directory");
    await act(dialog.getByRole("button", { name: "取消", exact: true }));
    await treeRow("").click({ button: "right" });
    assert.equal(await page.getByRole("menuitem", { name: "重命名", exact: true }).count(), 0, "root cannot be renamed or deleted");
    await page.keyboard.press("Escape");
    await act(page.getByRole("button", { name: "收起图库根目录", exact: true }));
    await page.locator(".local-directory-tree .directory-tree-scroll").hover();
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => scrollY > 100);
    await noOverflow();
    await page.goto("https://pixhelf.test/?view=local&path=" + encodeURIComponent(`旅行/${longName}`));
    await page.locator(".local-entry").first().waitFor();
    await noOverflow();
    assert.equal(await page.locator('.local-breadcrumbs [aria-current="location"]').getAttribute("title"), `旅行/${longName}`);
    await page.goto("https://pixhelf.test/?view=albums&album=" + encodeURIComponent(deepPath));
    const back = page.getByRole("link", { name: "返回相册", exact: true });
    await back.waitFor();
    assert.equal(await page.locator(".album-breadcrumbs, .album-path-actions, .album-heading").count(), 0, "album navigation has only a back link");
    assert.equal(await back.getAttribute("href"), "/?view=albums");
    await noOverflow();
    await page.screenshot({ path: join(output, `album-back-${width}.png`) });
    await act(back);
    await page.locator(".albums-grid").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("album"), null, "deep albums return directly to the flat catalog");
    await page.goto("https://pixhelf.test/?view=albums&album=" + encodeURIComponent("旅行/城市/夜景"));
    await page.locator(".image-card").first().waitFor();
    assert.equal(await page.locator(".album-children").count(), 0, "albums stay flat");
    // Image copy also uses the same folded picker.
    const first = page.locator(".image-card").first();
    if (width < 720) await first.tap(); else await first.hover();
    if (await page.locator(".image-viewer").count()) await act(page.getByRole("button", { name: "关闭查看器", exact: true }));
    await first.locator(".photo-card-select").evaluate(button => button.click());
    await act(page.locator(".gallery-selection-bar .selection-copy"));
    await treeRow("目标", dialog).waitFor();
    await act(treeRow("目标", dialog));
    await act(dialog.getByRole("button", { name: "复制", exact: true }));
    await dialog.waitFor({ state: "detached" });
    assert(calls.some(call => call.path === "/api/management/batch" && call.body?.action === "copy" && call.body.destination === "目标"));
    invalidDirectoryPage = true;
    await page.goto("https://pixhelf.test/?view=local");
    await page.getByRole("alert").filter({ hasText: "目录数据无效，请重试" }).waitFor();
    assert.equal(await page.locator(".local-load-more").count(), 0, "a stalled cursor cannot trigger repeated pagination");
    invalidDirectoryPage = false;
    await act(page.getByRole("button", { name: "重试", exact: true }));
    await page.locator(".local-entry").first().waitFor();
    guest = true; calls.length = 0;
    await page.goto("https://pixhelf.test/?view=local&path=" + encodeURIComponent("旅行/城市/夜景"));
    await page.getByText("图库管理仅限管理员访问").waitFor();
    assert.equal(calls.filter(call => call.path.startsWith("/api/management")).length, 0);
    assert.equal(await page.locator(".album-link").filter({ hasText: "本地存储" }).count(), 0);
    await page.goto("https://pixhelf.test/?view=albums");
    await page.locator(".album-card").first().waitFor();
    assert.equal(await page.locator("a.album-path, .album-menu-trigger, .album-select").count(), 0);
    await act(card(deepPath).locator(".album-card-open"));
    await back.waitFor();
    await act(back);
    await page.locator(".albums-grid").waitFor();
    await noOverflow();
    assert.deepEqual(errors, []);
    results.push({ width, flatAlbums: true, albumBack: true, compactCover: true, localViewerNavigation: true, localViewerPagination: true, sharing: true, collapsedPicker: true, containedWheel: true, localPageWheel: true, localContextMenus: true, selectAll: true, localCrud: true, imageCopy: true, guestGuard: true });
    await context.close();
  }
  console.log(JSON.stringify({ noServer: true, results, screenshots: output }));
} finally { await browser.close(); }
