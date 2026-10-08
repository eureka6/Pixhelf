import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function traceNavigation(page, toggles) {
  return page.evaluate(async (times) => {
    const menu = document.querySelector(".gallery-sidebar-toggle");
    const toolbar = document.querySelector(".topbar");
    const sidebar = () => document.querySelector(innerWidth <= 720 ? ".mobile-sidebar" : ".desktop-sidebar");
    const right = () => sidebar()?.getBoundingClientRect().right ?? 0;
    const controls = [...toolbar.querySelectorAll("button")].filter(control => !control.closest("[inert]"));
    const menuRect = menu.getBoundingClientRect();
    let brandOffset;
    const result = { frames: 0, reversals: [], leaks: [], coveredSidebar: 0, coveredControls: 0, menuDrift: 0, brandDrift: 0, hiddenBrandFrames: 0, partialFrames: 0 };
    const started = performance.now();
    let index = 0;
    while (performance.now() - started < times.at(-1) + 440) {
      await new Promise(requestAnimationFrame);
      if (index < times.length && performance.now() - started >= times[index]) {
        const before = right();
        menu.click();
        // Flush the component update without advancing the animation timeline.
        await Promise.resolve();
        await Promise.resolve();
        result.reversals.push(Math.abs(right() - before));
        index++;
      }
      result.frames++;
      const panel = sidebar();
      const panelRect = panel?.getBoundingClientRect();
      const topbarRect = toolbar.getBoundingClientRect();
      const rect = menu.getBoundingClientRect();
      result.menuDrift = Math.max(result.menuDrift, Math.hypot(rect.x - menuRect.x, rect.y - menuRect.y));
      const brand = panel?.querySelector('.brand');
      if (brand) {
        const bounds = brand.getBoundingClientRect();
        const offset = { x: bounds.x - panelRect.x, y: bounds.y - panelRect.y };
        brandOffset ??= offset;
        result.brandDrift = Math.max(result.brandDrift, Math.hypot(offset.x - brandOffset.x, offset.y - brandOffset.y));
        if (getComputedStyle(brand).visibility !== 'visible' || !bounds.width) result.hiddenBrandFrames++;
      }
      if (panelRect && panelRect.right > 1 && panelRect.right < panelRect.width - 1) result.partialFrames++;
      for (const control of controls) {
        const box = control.getBoundingClientRect();
        if (!control.closest("a, button").contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))) result.coveredControls++;
      }
      for (const y of [topbarRect.top + 1, topbarRect.top + topbarRect.height / 2, topbarRect.bottom - 1]) {
        // The browser's reserved scrollbar gutter is outside the header's hit-test area.
        for (let x = 2; x < Math.min(innerWidth, topbarRect.right); x += 16) {
          const hit = document.elementFromPoint(x, y);
          if ((!hit || hit.closest(".content")) && result.leaks.length < 6) result.leaks.push({ x, y,
            hidden: toolbar.dataset.hidden, surface: document.querySelector('.topbar-surface').getBoundingClientRect().toJSON(),
            scroll: scrollY, elapsed: performance.now() - started, resizing: document.querySelector('.justified-gallery')?.dataset.resizing,
            animations: panel?.getAnimations().map(animation => ({ time: animation.currentTime, state: animation.playState })) });
          if (
            panelRect && x < panelRect.right - 1 && !panel.closest("[inert]")
            && !panel.contains(hit) && !toolbar.contains(hit)
          ) result.coveredSidebar++;
        }
      }
    }
    result.open = menu.getAttribute("aria-expanded");
    result.drawerMounted = Boolean(document.querySelector(".mobile-nav-layer"));
    result.bodyLocked = document.body.style.overflow === "hidden";
    result.overflow = document.documentElement.scrollWidth > innerWidth;
    return result;
  }, toggles);
}

function checkTrace(trace, reduced = false) {
  assert.deepEqual(trace.leaks, [], "the header lets clicks reach gallery cards during a transition");
  assert.equal(trace.coveredSidebar, 0, "the header surface covers the visible sidebar");
  assert.equal(trace.coveredControls, 0, "navigation covers a toolbar control");
  assert.ok(trace.menuDrift < 1, `the menu button moved during navigation: ${trace.menuDrift}px`);
  assert.ok(trace.brandDrift < 1, `the logo moved within the sidebar: ${trace.brandDrift}px`);
  assert.equal(trace.hiddenBrandFrames, 0, "the logo disappeared during navigation");
  assert.equal(trace.overflow, false);
  if (!reduced) {
    assert.ok(trace.partialFrames > 1, "the sidebar did not animate");
    assert.ok(Math.max(...trace.reversals) < 2, `navigation jumped when reversed: ${trace.reversals}`);
  }
}

async function homeThroughBrand(page, selector, keyboard = false) {
  const toggle = page.locator('.gallery-sidebar-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const shell = await page.locator(".app-shell").elementHandle();
  const homeResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/images" && url.searchParams.get("offset") === "0"
      && url.searchParams.get("sort") === "default"
      && ["album", "search", "kind", "orientation", "seed"].every(key => !url.searchParams.has(key));
  });
  const link = page.locator(`${page.viewportSize().width <= 720 ? '.mobile-sidebar' : '.desktop-sidebar'} ${selector}`);
  if (keyboard) await link.press("Enter");
  else await link.click();
  const response = await homeResponse;
  assert.ok(response.ok());
  assert.equal(response.request().isNavigationRequest(), false);
  await page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false"
    && document.querySelector(".app-shell").dataset.gallerySection === "library");
  assert.equal(await shell.evaluate(element => element.isConnected), true, "the logo reloaded the whole application");
  await shell.dispose();
  assert.equal(await page.locator(".search-popover-panel input").inputValue(), "");
  assert.equal(await page.locator(".search-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".gallery-filter-summary").count(), 0);
  await page.locator(".mobile-nav-layer").waitFor({ state: "detached" });
}

try {
  for (const width of [1440, 1000, 721, 720, 390, 320]) {
    if (process.env.PIXHELF_NAVIGATION_WIDTH && width !== Number(process.env.PIXHELF_NAVIGATION_WIDTH)) continue;
    const mobile = width <= 720;
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: mobile });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pixhelf.sidebar-collapsed", "true"));
    await page.goto(process.env.PIXHELF_URL ?? "http://127.0.0.1:3002");
    await page.locator(".image-card").nth(24).waitFor();
    assert.equal(await page.locator('.topbar .brand, .brand-version').count(), 0);
    assert.equal(await page.getByRole("button", { name: "主页", exact: true }).count(), 0);
    const buttonBeforeScroll = await page.locator('.gallery-sidebar-toggle').boundingBox();
    // Put real, clickable cards behind the header, including its left edge.
    await page.evaluate(() => window.scrollTo(0, 320));
    await page.waitForFunction(() => document.querySelector('.topbar').dataset.hidden === 'true');
    await page.waitForTimeout(250);
    assert((await page.locator('.search-toggle').boundingBox()).y < 0, 'scrolling down hides the toolbar');
    assert(await page.locator('.gallery-sidebar-toggle').evaluate(button => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), 'collapsed navigation remains accessible while the topbar is hidden');
    await page.evaluate(() => window.scrollTo(0, 280));
    await page.waitForFunction(() => document.querySelector('.topbar').dataset.hidden === 'false');
    await page.waitForTimeout(250);
    assert.deepEqual(await page.locator('.gallery-sidebar-toggle').boundingBox(), buttonBeforeScroll, 'scrolling leaves navigation in place');
    const opened = await traceNavigation(page, [0]);
    checkTrace(opened);
    assert.equal(opened.open, "true");
    const panel = mobile ? ".mobile-sidebar" : ".desktop-sidebar";
    const brandClickable = await page.locator(`${panel} .brand`).evaluate(brand =>
      [...brand.querySelectorAll(".brand-mark, .brand-name")].every(element => {
        const rect = element.getBoundingClientRect();
        return element.closest("a").contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }),
    );
    assert.equal(brandClickable, true, "the logo is obscured by navigation");
    await page.screenshot({ path: `/tmp/pixhelf-navigation-${width}.png` });
    const closed = await traceNavigation(page, [0]);
    checkTrace(closed);
    assert.equal(closed.open, "false");
    assert.equal(closed.drawerMounted || closed.bodyLocked, false);
    const rapid = await traceNavigation(page, [0, 70, 140, 210, 280, 350]);
    checkTrace(rapid);
    assert.equal(rapid.drawerMounted || rapid.bodyLocked, false);
    await page.screenshot({ path: `/tmp/pixhelf-navigation-closed-${width}.png` });
    // A genuine pointer click in the blank header must not open the card below it.
    const blankHeaderX = await page.evaluate(() => (document.querySelector('.gallery-sidebar-toggle').getBoundingClientRect().right
      + document.querySelector(".search-toggle").getBoundingClientRect().left) / 2);
    await page.mouse.click(blankHeaderX, 25);
    assert.equal(await page.locator(".image-viewer").count(), 0);
    await page.locator(".search-toggle").click();
    await page.locator(".search-popover-panel input").fill("navigation-check");
    await page.getByRole("button", { name: "展开筛选", exact: true }).click();
    await page.getByLabel("媒体类型", { exact: true }).selectOption("photo");
    const filtered = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/images" && url.searchParams.get("search") === "navigation-check"
        && url.searchParams.get("kind") === "photo" && url.searchParams.get("sort") === "explore";
    });
    await page.getByLabel("排序方式", { exact: true }).selectOption("explore");
    await filtered;
    await homeThroughBrand(page, ".brand-mark");
    if (await page.locator('.gallery-sidebar-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('.gallery-sidebar-toggle').click();
    await page.locator(`${panel} .album-link[title="相册"]`).click();
    await page.waitForFunction(() => document.querySelector(".app-shell").dataset.gallerySection === "albums");
    if (mobile) await page.locator(".gallery-sidebar-toggle").click();
    await homeThroughBrand(page, ".brand-name");
    await homeThroughBrand(page, ".brand", true);
    if (await page.locator(".gallery-sidebar-toggle").getAttribute("aria-expanded") === "true") await page.locator(".gallery-sidebar-toggle").click();
    await page.waitForTimeout(360);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await traceNavigation(page, [0, 90]);
    checkTrace(reduced, true);
    assert.equal(reduced.drawerMounted || reduced.bodyLocked, false);
    assert.equal(reduced.partialFrames, 0, "reduced motion still animates the sidebar");
    if (width === 390) {
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 320); });
      await page.waitForFunction(() => document.querySelector('.topbar').dataset.hidden === 'true');
      await page.evaluate(() => window.scrollTo(0, 280));
      await page.waitForFunction(() => document.querySelector('.topbar').dataset.hidden === 'false');
      await page.waitForTimeout(200);
      // Simulate the viewport itself so scroll events cannot overwrite a CSS-only offset.
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 24 });
        visualViewport.dispatchEvent(new Event("scroll"));
      });
      // Reduced-motion transitions still take one frame; settle the simulated viewport before tracing navigation.
      await page.waitForFunction(() => document.querySelector(".topbar").getBoundingClientRect().top === 24);
      const offset = await traceNavigation(page, [0, 90]);
      checkTrace(offset, true);
      await page.evaluate(() => {
        delete visualViewport.offsetTop;
        visualViewport.dispatchEvent(new Event("scroll"));
      });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.locator(".gallery-sidebar-toggle").click();
      await page.locator(".mobile-sidebar .album-nav").waitFor();
      await page.setViewportSize({ width: 1000, height: 844 });
      await page.waitForFunction(() => !document.querySelector(".mobile-nav-layer") && document.body.style.overflow !== "hidden");
      assert.equal(await page.locator(".gallery-sidebar-toggle").getAttribute("aria-controls"), "desktop-album-navigation");
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(() => document.querySelector(".gallery-sidebar-toggle").getAttribute("aria-controls") === "mobile-album-navigation");
      assert.equal(await page.locator(".gallery-sidebar-toggle").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator('.topbar .brand').count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, frames: opened.frames + closed.frames + rapid.frames, maxReversalJump: Math.max(...rapid.reversals), maxBrandDrift: Math.max(opened.brandDrift, closed.brandDrift, rapid.brandDrift), brandClickable, logoHome: true, reducedMotion: true }));
    await page.close();
  }
} finally {
  await browser.close();
}
