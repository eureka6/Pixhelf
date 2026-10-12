import assert from "node:assert/strict";
import { activateTouchCard, closeViewer, selectFromViewer } from "./selection-gestures-check.mjs";

export async function checkSelectionNavigation(context, origin) {
  const page = await context.newPage();
  const width = page.viewportSize().width, touch = width <= 720;
  const act = locator => touch ? locator.tap() : locator.click();
  const bar = page.locator(".gallery-selection-bar");
  const cards = page.locator(".justified-gallery .image-card");
  const first = page.locator(".justified-gallery .image-card:not(:has(.live-photo-badge, .gif-badge, .video-badge))").first();
  const select = async card => {
    if (touch) await activateTouchCard(card); else await card.hover();
    await act(card.getByRole("checkbox"));
    await bar.waitFor();
  };
  const none = async () => {
    await bar.waitFor({ state: "detached" });
    assert.equal(await page.locator('.image-card[data-selected="true"], .album-card[data-selected="true"]').count(), 0);
  };
  const gap = async () => first.evaluate(card => {
    const gallery = card.closest(".justified-gallery").getBoundingClientRect();
    return { x: gallery.left + 10, y: card.getBoundingClientRect().bottom + 3 };
  });
  const tapPoint = point => touch ? page.touchscreen.tap(point.x, point.y) : page.mouse.click(point.x, point.y);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    if (process.env.PIXHELF_TEST_DEBUG) await page.addInitScript(() => {
      window.selectionTrace = [];
      for (const type of ["pointerdown", "pointerup", "click", "touchstart"]) window.addEventListener(type, event => {
        window.selectionTrace.push({ type, target: event.target.className, x: event.clientX ?? event.touches?.[0]?.clientX, y: event.clientY ?? event.touches?.[0]?.clientY });
        window.selectionTrace = window.selectionTrace.slice(-12);
      }, true);
    });
    await page.goto(origin);
    await first.waitFor();
    await select(first);
    assert.equal(await page.locator(".selection-summary-toggle, .selection-exit").count(), 0);
    await first.locator(".photo-card-open").click({ button: "right" });
    await act(page.getByRole("menuitem", { name: "全选已加载", exact: true }));
    assert.equal(await page.locator('.image-card[data-selected="true"]').count(), await cards.count());
    await first.locator(".photo-card-open").click({ button: "right" });
    await act(page.getByRole("menuitem", { name: "清空选择", exact: true }));
    await none();

    await first.locator(".photo-card-open").click({ button: "right" });
    assert.equal(await page.getByRole("menuitem", { name: "清空选择", exact: true }).isDisabled(), true);
    await act(page.getByRole("menuitem", { name: "全选已加载", exact: true }));
    assert.equal(await page.locator('.image-card[data-selected="true"]').count(), await cards.count());
    await first.locator(".photo-card-open").click({ button: "right" });
    await act(page.getByRole("menuitem", { name: "清空选择", exact: true }));
    await none();
    const space = await gap();
    await page.mouse.click(space.x, space.y, { button: "right" });
    await act(page.getByRole("menuitem", { name: "全选已加载", exact: true }));
    if (process.env.PIXHELF_TEST_DEBUG) console.log({ width, space, currentGap: await gap() });
    await tapPoint(space);
    await none();
    await select(first);
    const margin = await first.evaluate(card => ({ x: card.closest(".justified-gallery").getBoundingClientRect().left - 6, y: card.getBoundingClientRect().top + 30 }));
    await tapPoint(margin);
    await none();

    // Back cancels the mode even on the first gallery page, without moving it.
    await select(first);
    const initialUrl = page.url();
    await page.evaluate(() => window.scrollTo({ top: 300, behavior: "instant" }));
    const scroll = await page.evaluate(() => scrollY);
    await page.goBack();
    await none();
    assert.equal(page.url(), initialUrl);
    // Popstate restores the reading position on the next animation frame.
    await page.waitForFunction(scroll => Math.abs(scrollY - scroll) < 2, scroll);
    assert(Math.abs(await page.evaluate(() => scrollY) - scroll) < 2, "canceling selection preserves scroll");
    await page.goForward();
    await first.waitFor();
    await none();
    await select(first);
    await page.goBack();
    await none();
    assert.equal(page.url(), initialUrl, "selection can be canceled again after Forward");

    if (!touch) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await select(first);
      const session = await context.newCDPSession(page);
      try {
        await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 8, y: 100, button: "back", buttons: 8, clickCount: 1 });
        await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 8, y: 100, button: "back", buttons: 0, clickCount: 1 });
      } finally { await session.detach(); }
      await none();
      assert.equal(page.url(), initialUrl, "mouse side Back cancels selection before leaving");
    }

    // Viewer selection retains the existing Back/Forward relationship.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await act(first.locator(".photo-card-open"));
    await page.locator(".image-viewer").waitFor();
    await selectFromViewer(page.locator(".viewer-media:not(.viewer-swipe-outgoing)"));
    await closeViewer(page);
    await bar.waitFor();
    await page.goForward();
    await page.locator(".image-viewer").waitFor();
    await closeViewer(page);
    await page.goBack();
    await none();
    assert.equal(page.url(), initialUrl);

    // A second Back leaves the album normally; clearing explicitly has no extra stop.
    await page.goto(`${origin}/?view=albums`);
    const folder = page.locator('.album-card[data-album-path="冲突相册"]');
    await act(folder.locator(".album-card-open"));
    await first.waitFor();
    const albumUrl = page.url();
    await select(first);
    await page.goBack();
    await none();
    assert.equal(page.url(), albumUrl);
    await page.goBack();
    await folder.waitFor();
    await page.goForward();
    await first.waitFor();
    await select(first);
    await page.keyboard.press("Escape");
    await page.goBack();
    await folder.waitFor();
    await select(folder);
    await page.goBack();
    await none();
    assert.equal(new URL(page.url()).searchParams.get("view"), "albums");
    await select(folder);
    await tapPoint({ x: 3, y: 200 });
    await none();
    assert.deepEqual(errors, []);
    console.log(`${width}px blank dismissal, Back, ${touch ? "touch" : "mouse side Back"}, compact options, context bulk selection and viewer Forward passed`);
  } catch (error) {
    if (process.env.PIXHELF_TEST_DEBUG) console.error(await page.evaluate(() => window.selectionTrace));
    await page.screenshot({ path: `/tmp/pixhelf-selection-navigation-failure-${width}.png` }).catch(() => {});
    throw error;
  } finally { await page.close(); }
}
