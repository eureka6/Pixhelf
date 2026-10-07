import assert from "node:assert/strict";

export async function checkViewerHistory(context, origin) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let releasePagination = () => {};
  try {
    const data = await fetch(`${origin}/api/images?limit=100`).then(response => response.json());
    const stills = data.items.filter(image => !image.video && !image.motion);
    assert(stills.length >= 55, "waterfall history fixture needs enough photos for scrolling and pagination");
    const source = stills[0];
    const order = stills.slice(4, 38).reverse();
    const nestedOrder = stills.slice(40, 55).reverse();
    // Several photos also exist in the library, deliberately in a different order.
    const subset = { items: [order[11], source, order[10], stills[1]], total: 4, offset: 0, limit: 60, nextOffset: null };
    await page.route(`${origin}/`, async route => {
      const response = await route.fetch();
      const html = (await response.text()).replace(/(<script id="pixhelf-bootstrap"[^>]*>)([\s\S]*?)(<\/script>)/, (_match, start, json, end) => {
        const bootstrap = JSON.parse(json);
        bootstrap.images = subset;
        return start + JSON.stringify(bootstrap) + end;
      });
      await route.fulfill({ response, body: html });
    });
    await page.route("**/api/images?*", route => route.fulfill({ json: subset }));
    let paginated = false;
    let paginationGate = Promise.resolve();
    const searches = [];
    await page.route("**/api/images/*/similar?*", async route => {
      const url = new URL(route.request().url());
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      const offset = Number(url.searchParams.get("offset"));
      searches.push({ id, offset });
      const items = id === source.id ? order : nestedOrder;
      if (offset) await paginationGate;
      await route.fulfill({ json: { items: items.slice(offset, paginated && !offset ? 30 : undefined), total: items.length,
        offset, limit: 30, nextOffset: paginated && !offset && items.length > 30 ? 30 : null } }).catch(() => {});
    });
    const viewer = page.locator(".image-viewer");
    const card = image => page.locator(`.viewer-similar-card[data-image-id="${image.id}"]`);
    const expectImage = async image => {
      await page.waitForFunction(id => document.querySelector(".image-viewer")?.dataset.imageId === id, image.id);
    };
    const openRoot = async () => {
      await page.locator(`.image-card[data-image-id="${source.id}"] .photo-card-open`).click();
      await expectImage(source);
    };
    const showSimilar = async () => {
      await page.keyboard.press("PageDown");
      await page.locator(".viewer-similar-card").first().waitFor();
    };
    const openCard = async image => {
      await card(image).evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
      // Metadata and Playwright's actionability scroll can move the card between
      // locating it and clicking. Measure the position at the actual contact.
      await card(image).evaluate(element => element.addEventListener("click", event => {
        const bounds = element.getBoundingClientRect();
        window.waterfallOpenPosition = { y: bounds.top + bounds.height / 2,
          top: bounds.top, height: bounds.height, clickY: event.clientY,
          viewport: { top: visualViewport.offsetTop, height: visualViewport.height },
          scroll: element.closest(".image-viewer").scrollTop, windowScroll: scrollY };
      }, { once: true, capture: true }));
      await card(image).locator(".photo-card-open").click();
      const position = await page.evaluate(() => {
        const value = window.waterfallOpenPosition;
        delete window.waterfallOpenPosition;
        return { ...value, saved: history.state?.__pixhelfViewer?.branch?.parent?.returnAnchor };
      });
      await expectImage(image);
      await page.waitForFunction(() => document.querySelector(".image-viewer").scrollTop < 1);
      return position;
    };
    const navigate = async (direction, image) => {
      if (page.viewportSize().width <= 720) await page.keyboard.press(direction < 0 ? "ArrowLeft" : "ArrowRight");
      else await page.locator(direction < 0 ? ".viewer-previous" : ".viewer-next").click();
      await expectImage(image);
    };
    const returned = async (parent, target, expectedOrder, anchor, focusTarget = true) => {
      await expectImage(parent);
      await page.waitForFunction(({ id, focusTarget }) => {
        const viewer = document.querySelector(".image-viewer");
        return viewer?.dataset.page === "details" && document.querySelector(".app-shell")?.dataset.viewerReturning === "false" && !document.querySelector(".viewer-return-layer")
          && (!focusTarget || (document.activeElement?.classList.contains("viewer-similar-card") && document.activeElement.dataset.imageId === id));
      }, { id: target.id, focusTarget });
      assert.deepEqual(await page.locator(".viewer-similar-card").evaluateAll(cards => cards.map(card => card.dataset.imageId)), expectedOrder.map(image => image.id), "return preserves the source waterfall and its order");
      const current = await card(target).evaluate(element => {
        const rect = element.getBoundingClientRect();
        const root = element.closest(".image-viewer");
        return { y: rect.top + rect.height / 2, top: rect.top, bottom: rect.bottom,
          scroll: root.scrollTop, height: root.clientHeight, windowScroll: scrollY,
          viewport: { top: visualViewport.offsetTop, height: visualViewport.height },
          saved: history.state?.__pixhelfViewer?.returnAnchor };
      });
      assert(current.top < current.height && current.bottom > 55, "the active photo returns to a visible card in its own waterfall");
      assert.equal(await page.locator(".image-viewer").count(), 1);
      if (anchor) {
        assert(Math.abs(current.y - anchor.y) < 4, `card returns to its viewport anchor: ${JSON.stringify({ current, anchor })}`);
        assert.equal(current.windowScroll, anchor.windowScroll, "nested return must not scroll the library");
      }
    };
    const closeLayer = async () => {
      const buttons = page.getByRole("button", { name: "关闭查看器", exact: true });
      const inDetails = await viewer.getAttribute("data-page") === "details";
      if (inDetails) await page.keyboard.press("Escape");
      else await buttons.first().click();
    };
    await page.goto(origin);
    await openRoot();
    await showSimilar();
    const firstSearches = searches.length;
    const anchor = await openCard(order[10]);
    const childHistoryLength = await page.evaluate(() => history.length);
    if (page.viewportSize().width <= 720) {
      const session = await page.context().newCDPSession(page);
      const { width, height } = page.viewportSize();
      try {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: width * .2, y: height * .5 }] });
        await page.waitForTimeout(30);
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: width * .8, y: height * .5 }] });
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expectImage(order[9]);
      } finally { await session.detach(); }
    } else await navigate(-1, order[9]);
    for (let index = 10; index <= 16; index++) await navigate(1, order[index]);
    assert.equal(await page.evaluate(() => history.length), childHistoryLength, "switching within a waterfall does not add browser pages");
    await page.goBack();
    await returned(source, order[16], order, anchor);
    assert.equal(searches.length, firstSearches, "return reuses the original similarity result instead of querying again");
    await page.goForward(); await expectImage(order[16]);
    await navigate(-1, order[15]);
    await page.reload(); await expectImage(order[15]);
    await page.goBack(); await returned(source, order[15], order, anchor);

    // Closing without switching restores the exact previous waterfall position.
    const sameAnchor = await openCard(order[10]);
    await closeLayer();
    await returned(source, order[10], order, sameAnchor);
    assert(Math.abs(await viewer.evaluate(element => element.scrollTop) - sameAnchor.scroll) < 4);
    await openCard(order[0]);
    assert.equal(await page.locator(".viewer-previous").isDisabled(), true, "the first result cannot navigate into the library or parent image");
    await page.keyboard.press("ArrowLeft"); await expectImage(order[0]);
    await page.goBack(); await returned(source, order[0], order);

    // Another waterfall creates another level. Each Back returns to its own list.
    await openCard(order[10]);
    await showSimilar();
    const nestedAnchor = await openCard(nestedOrder[4]);
    await navigate(1, nestedOrder[5]);
    await page.goBack(); await returned(order[10], nestedOrder[5], nestedOrder, nestedAnchor);
    await page.goBack(); await returned(source, order[10], order);
    await closeLayer(); await viewer.waitFor({ state: "detached" });

    // Pagination belongs to the opened list and must be present when it returns.
    paginated = true;
    paginationGate = new Promise(resolve => { releasePagination = resolve; });
    await openRoot(); await showSimilar();
    const paginationAnchor = await openCard(order[29]);
    releasePagination();
    await navigate(1, order[30]);
    await navigate(1, order[31]);
    await navigate(1, order[32]);
    await navigate(1, order[33]);
    assert.equal(await page.locator(".viewer-next").isDisabled(), true, "the last result is the end of this waterfall");
    await page.goBack(); await returned(source, order[33], order);
    assert(searches.filter(search => search.offset).every(search => search.id === source.id));

    // Use real motion here to verify the existing return flight targets the
    // similar card, even when the same photo also has a library card behind it.
    {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await openCard(order[10]);
      await page.goBack();
      const holdLanding = () => page.waitForFunction(id => {
        const layer = document.querySelector('.viewer-return-layer[data-phase="flying"]');
        const target = document.querySelector('.viewer-similar-card[data-viewer-return-target="true"]');
        const media = layer?.querySelector('.viewer-return-media');
        const animation = media?.getAnimations()[0];
        if (!animation || layer.dataset.imageId !== id || target?.dataset.imageId !== id) return false;
        animation.pause(); animation.currentTime = animation.effect.getTiming().duration - 1;
        const image = media.getBoundingClientRect(), card = target.getBoundingClientRect();
        return { distance: Math.hypot(image.x - card.x, image.y - card.y), top: document.querySelector('.image-viewer').scrollTop, windowScroll: scrollY };
      }, order[10].id);
      await holdLanding();
      assert.equal(await page.locator('.justified-gallery [data-viewer-return-target="true"]').count(), 0);
      const windowScroll = await page.evaluate(() => {
        document.querySelector('.image-viewer').scrollBy({ top: 120, behavior: 'instant' });
        return scrollY;
      });
      await page.waitForTimeout(50);
      const landing = await (await holdLanding()).jsonValue();
      assert(landing.distance < 2, `nested return follows its scrolling waterfall: ${JSON.stringify(landing)}`);
      assert.equal(landing.windowScroll, windowScroll, 'nested scrolling must leave the library alone');
      const focused = await page.evaluateHandle(() => document.activeElement);
      await page.evaluate(() => { for (const animation of document.querySelector('.viewer-return-media').getAnimations()) animation.finish(); });
      await returned(source, order[10], order, undefined, false);
      assert(await focused.evaluate(element => element === document.activeElement), 'return must preserve focus after the user takes over scrolling');
      await focused.dispose();
      assert.equal(await page.locator('.image-viewer').evaluate(viewer => viewer.scrollTop), landing.top);
      await page.screenshot({ path: `/tmp/pixhelf-similar-return-${page.viewportSize().width > 720 ? 'desktop' : 'mobile'}.png`, animations: "disabled" });
    }
    await closeLayer(); await viewer.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    console.log(`${page.viewportSize().width}px viewer: waterfall order, layered back/forward, card return, scroll restoration, nested lists, reload and pagination passed`);
  } catch (error) {
    await page.screenshot({ path: `/tmp/pixhelf-waterfall-history-failure-${page.viewportSize().width}.png` }).catch(() => {});
    throw error;
  } finally {
    releasePagination();
    await page.close();
  }
}
