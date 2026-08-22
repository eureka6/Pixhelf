import { chromium } from "playwright-core";

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const baseUrl = process.env.PIXHELF_URL ?? "http://127.0.0.1:3002";

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const results = [];

try {
  for (const target of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({
      viewport: { width: target.width, height: target.height },
      deviceScaleFactor: target.name === "mobile" ? 3 : 1,
      hasTouch: target.name === "mobile",
    });
    const browserErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("[data-image-id]", { timeout: 60_000 });
    await page.waitForFunction(() => {
      const visible = [...document.querySelectorAll("[data-image-id] img")].filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      });
      return visible.length >= 8 &&
        visible.every((image) => image.complete && image.naturalWidth > 0);
    }, undefined, { timeout: 60_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/tmp/pixhelf-${target.name}.png` });

    const layout = await page.evaluate(() => {
      const path = document.querySelector(".desktop-sidebar .sidebar-gallery-path");
      const count = document.querySelector(".desktop-sidebar .sidebar-gallery-count");
      const search = document.querySelector(".topbar-search");
      const topbar = document.querySelector(".topbar");
      const sidebarStatus = document.querySelector(".desktop-sidebar .sidebar-status");
      const sidebarMeta = document.querySelector(".desktop-sidebar .sidebar-gallery-meta");
      const pathRect = path?.getBoundingClientRect();
      const countRect = count?.getBoundingClientRect();
      const searchRect = search?.getBoundingClientRect();
      const exploreRect = document.querySelector(".explore-toggle")?.getBoundingClientRect();
      const topbarRect = topbar?.getBoundingClientRect();
      const statusRect = sidebarStatus?.getBoundingClientRect();
      const metaRect = sidebarMeta?.getBoundingClientRect();
      const galleryToggle = document.querySelector(".gallery-sidebar-toggle");
      return {
        viewport: [innerWidth, innerHeight],
        bodyWidth: document.documentElement.scrollWidth,
        cards: document.querySelectorAll("[data-image-id]").length,
        cardTags: [...document.querySelectorAll("[data-image-id]")]
          .map((element) => element.tagName),
        masonryColumns: document.querySelectorAll(".masonry-column").length,
        loadedCards: document.querySelectorAll("[data-image-id] img.loaded").length,
        brokenVisibleImages: [...document.images].filter((image) => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight && image.naturalWidth === 0;
        }).length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        topbarPosition: topbar ? getComputedStyle(topbar).position : "",
        topbarTop: topbarRect?.top ?? -1,
        topbarSearches: document.querySelectorAll(
          ".topbar-actions > .topbar-search",
        ).length,
        brandHomeLinks: document.querySelectorAll('a.brand[href="/"]').length,
        gallerySidebarToggles: document.querySelectorAll(".gallery-sidebar-toggle").length,
        galleryToggleOpacity: galleryToggle
          ? Number.parseFloat(getComputedStyle(galleryToggle).opacity)
          : -1,
        topbarSidebarToggles: document.querySelectorAll(
          ".topbar .sidebar-toggle-button",
        ).length,
        contentSearches: document.querySelectorAll(".content .search-field").length,
        topbarSearchRightGap: searchRect ? innerWidth - searchRect.right : -1,
        exploreButtons: document.querySelectorAll(".topbar-actions > .explore-toggle").length,
        exploreSearchGap: exploreRect && searchRect ? searchRect.left - exploreRect.right : -1,
        sidebarStatuses: document.querySelectorAll(
          ".desktop-sidebar > .sidebar-status",
        ).length,
        sidebarGalleryMetas: document.querySelectorAll(".sidebar-gallery-meta").length,
        contentInfoRows: document.querySelectorAll(
          ".content-heading, .content .sidebar-gallery-meta",
        ).length,
        sortControls: document.querySelectorAll(".sort-control").length,
        cardNameDisplay: getComputedStyle(document.querySelector(".image-name")).display,
        cardNameOpacity: Number.parseFloat(
          getComputedStyle(document.querySelector(".image-name")).opacity,
        ),
        cardNameWhiteSpace: getComputedStyle(
          document.querySelector(".image-name"),
        ).whiteSpace,
        sidebarMetaBottomGap: metaRect ? innerHeight - metaRect.bottom : -1,
        sidebarMetaStatusGap: statusRect && metaRect ? metaRect.top - statusRect.bottom : -1,
        galleryPath: path?.textContent ?? "",
        galleryCount: count?.textContent ?? "",
        galleryMetaRowDelta: pathRect && countRect
          ? Math.abs(pathRect.top - countRect.top)
          : -1,
      };
    });

    await page.locator("[data-image-id]").first().click();
    await page.waitForTimeout(200);
    const dialogsAfterImageClick = await page.locator('[role="dialog"]').count();

    const searchToggleBefore = await page.locator(".search-toggle").boundingBox();
    await page.locator(".search-toggle").click();
    await page.waitForFunction(() =>
      document.querySelector(".search-toggle")?.getAttribute("aria-expanded") === "true"
    );
    await page.waitForTimeout(220);
    const searchToggleOpen = await page.locator(".search-toggle").boundingBox();
    const searchPanelOpen = await page.locator("#gallery-search-field").boundingBox();
    const searchDisclosure = await page.evaluate(() => {
      const leading = document.querySelector(".topbar-leading")?.getBoundingClientRect();
      const panel = document.querySelector("#gallery-search-field")?.getBoundingClientRect();
      const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
      return {
        expanded: document.querySelector(".search-toggle")?.getAttribute("aria-expanded"),
        focused: document.activeElement?.matches("#gallery-search-field input") ?? false,
        panelRole: document.querySelector("#gallery-search-field")?.getAttribute("role"),
        panelInert: document.querySelector("#gallery-search-field")?.inert ?? true,
        leadingGap: leading && panel ? panel.left - leading.right : -1,
        panelTop: panel?.top ?? -1,
        topbarTop: topbar?.top ?? -1,
        topbarBottom: topbar?.bottom ?? -1,
      };
    });
    searchDisclosure.panelWidth = searchPanelOpen?.width ?? -1;
    searchDisclosure.stationaryToggleDelta = searchToggleBefore && searchToggleOpen
      ? Math.hypot(
        searchToggleBefore.x - searchToggleOpen.x,
        searchToggleBefore.y - searchToggleOpen.y,
      )
      : -1;
    await page.locator("#gallery-search-field input").fill("x");
    await page.waitForFunction(() =>
      document.querySelector(".topbar-search")?.classList.contains("has-query")
    );
    searchDisclosure.hasQueryClass = true;
    await page.locator("#gallery-search-field input").fill("");
    await page.waitForFunction(() =>
      !document.querySelector(".topbar-search")?.classList.contains("has-query")
    );
    searchDisclosure.queryClassCleared = true;
    if (target.name === "mobile") {
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--visual-viewport-top", "24px");
      });
      await page.waitForTimeout(50);
      const compensatedTopbar = await page.locator(".topbar").boundingBox();
      const compensatedPanel = await page.locator("#gallery-search-field").boundingBox();
      searchDisclosure.compensatedTopbarDelta = compensatedTopbar
        ? compensatedTopbar.y - searchDisclosure.topbarTop
        : -1;
      searchDisclosure.compensatedPanelDelta = compensatedPanel
        ? compensatedPanel.y - searchDisclosure.panelTop
        : -1;
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--visual-viewport-top", "0px");
      });
      await page.waitForTimeout(50);
    }
    await page.locator(".search-toggle").click();
    await page.waitForFunction(() =>
      document.querySelector(".search-toggle")?.getAttribute("aria-expanded") === "false"
    );
    searchDisclosure.restored = await page.locator(".search-toggle")
      .getAttribute("aria-expanded");
    searchDisclosure.panelInertClosed = await page.locator("#gallery-search-field")
      .evaluate((panel) => panel.inert);

    const firstExploreRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/images" &&
        url.searchParams.get("sort") === "explore" &&
        url.searchParams.get("offset") === "0";
    });
    await page.locator(".explore-toggle").click();
    const firstExplore = await firstExploreRequest;
    const firstExploreUrl = new URL(firstExplore.url());
    const firstExploreResponse = await firstExplore.response();
    await firstExploreResponse?.finished();
    await page.waitForFunction(() => !document.querySelector(".skeleton-grid"));

    const secondExploreRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/images" &&
        url.searchParams.get("sort") === "explore" &&
        url.searchParams.get("offset") === "0";
    });
    await page.locator(".explore-toggle").click();
    const secondExplore = await secondExploreRequest;
    const secondExploreUrl = new URL(secondExplore.url());
    const secondExploreResponse = await secondExplore.response();
    await secondExploreResponse?.finished();
    await page.waitForFunction(() => !document.querySelector(".skeleton-grid"));

    const exploration = await page.evaluate(([firstSeed, secondSeed]) => ({
      firstSeed,
      secondSeed,
      exploreMarker: getComputedStyle(
        document.querySelector(".explore-toggle"),
        "::after",
      ).content,
      searchMarker: getComputedStyle(
        document.querySelector(".search-toggle"),
        "::after",
      ).content,
    }), [
      firstExploreUrl.searchParams.get("seed") ?? "",
      secondExploreUrl.searchParams.get("seed") ?? "",
    ]);

    const homeRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/images" &&
        url.searchParams.get("sort") === "name-asc" &&
        url.searchParams.get("offset") === "0";
    });
    await page.locator("a.brand").click();
    const homeResponse = await (await homeRequest).response();
    await homeResponse?.finished();
    await page.waitForFunction(() => !document.querySelector(".skeleton-grid"));
    const homeNavigation = await page.evaluate(() => ({
      href: document.querySelector("a.brand")?.getAttribute("href"),
      galleryPath: document.querySelector(
        ".desktop-sidebar .sidebar-gallery-path",
      )?.textContent,
      allImagesActive: document.querySelector(".desktop-sidebar .album-link")
        ?.classList.contains("active") ?? false,
      searchValue: document.querySelector("#gallery-search-field input")?.value,
    }));

    let mobileCardNames = null;
    if (target.name === "mobile") {
      const firstCard = page.locator("[data-image-id]").first();
      const secondCard = page.locator("[data-image-id]").nth(1);
      await firstCard.dispatchEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
      });
      await page.waitForFunction(() =>
        document.querySelector("[data-image-id]")?.getAttribute("data-name-visible") === "true"
      );
      const shownOnContact = await firstCard.getAttribute("data-name-visible");
      await firstCard.dispatchEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
      });
      const retainedOnRelease = await firstCard.getAttribute("data-name-visible");
      await page.waitForTimeout(1_900);
      const retainedWithoutTimeout = await firstCard.getAttribute("data-name-visible");

      await secondCard.dispatchEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 2,
        pointerType: "touch",
        isPrimary: true,
      });
      await page.waitForFunction(() =>
        document.querySelectorAll('[data-name-visible="true"]').length === 1 &&
        document.querySelectorAll("[data-image-id]")[1]
          ?.getAttribute("data-name-visible") === "true"
      );
      await page.waitForTimeout(180);
      const switchedToSecond = await secondCard.getAttribute("data-name-visible");
      const firstHidden = await firstCard.getAttribute("data-name-visible");
      const activeCount = await page.locator('[data-name-visible="true"]').count();
      const displayedCount = await page.locator('[data-name-visible="true"] .image-name')
        .evaluateAll((names) => names.filter((name) =>
          Number.parseFloat(getComputedStyle(name).opacity) > 0.99
        ).length);

      await secondCard.dispatchEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 2,
        pointerType: "touch",
        isPrimary: true,
      });
      await secondCard.evaluate((card) => {
        globalThis.__pixhelfCardClickCount = 0;
        card.addEventListener("click", () => {
          globalThis.__pixhelfCardClickCount += 1;
        }, { once: true });
      });
      const secondCardBox = await secondCard.boundingBox();
      if (secondCardBox) {
        await page.touchscreen.tap(
          secondCardBox.x + secondCardBox.width / 2,
          secondCardBox.y + secondCardBox.height / 2,
        );
      }
      const clickCount = await page.evaluate(() => globalThis.__pixhelfCardClickCount ?? 0);
      mobileCardNames = {
        shownOnContact,
        retainedOnRelease,
        retainedWithoutTimeout,
        switchedToSecond,
        firstHidden,
        activeCount,
        displayedCount,
        clickCount,
      };
    }

    let desktopSidebar = null;
    let mobileNavigation = null;
    if (target.name === "desktop") {
      const contentBefore = await page.locator(".content").boundingBox();
      const toggleBefore = await page.locator(".gallery-sidebar-toggle").boundingBox();
      const firstAlbumBefore = await page.locator(".desktop-sidebar .album-link").first()
        .boundingBox();
      const controlSlotBefore = await page.locator(".desktop-sidebar .sidebar-control-slot")
        .boundingBox();
      const metaBefore = await page.locator(".desktop-sidebar .sidebar-gallery-meta")
        .boundingBox();
      const galleryBefore = await page.locator(".masonry").boundingBox();
      await page.locator(".gallery-sidebar-toggle").click();
      await page.waitForFunction(() =>
        document.querySelector(".app-shell")?.getAttribute("data-sidebar-collapsed") === "true"
      );
      await page.waitForTimeout(260);
      const contentCollapsed = await page.locator(".content").boundingBox();
      const toggleCollapsed = await page.locator(".gallery-sidebar-toggle").boundingBox();
      const sidebarCollapsedBox = await page.locator(".desktop-sidebar").boundingBox();
      const galleryCollapsed = await page.locator(".masonry").boundingBox();
      desktopSidebar = await page.evaluate(() => ({
        expanded: document.querySelector(".gallery-sidebar-toggle")?.getAttribute("aria-expanded"),
        visibility: getComputedStyle(document.querySelector(".desktop-sidebar")).visibility,
        navigationVisibility: getComputedStyle(
          document.querySelector(".desktop-sidebar .album-nav"),
        ).visibility,
        statusVisibility: getComputedStyle(
          document.querySelector(".desktop-sidebar .sidebar-status"),
        ).visibility,
        metaVisibility: getComputedStyle(
          document.querySelector(".desktop-sidebar .sidebar-gallery-meta"),
        ).visibility,
        ariaHidden: document.querySelector(".desktop-sidebar")?.getAttribute("aria-hidden"),
        stored: localStorage.getItem("pixhelf.sidebar-collapsed"),
        columns: document.querySelectorAll(".masonry-column").length,
        redundantHeadings: document.querySelectorAll(".sidebar-heading").length,
        pathDetails: document.querySelectorAll(".album-copy small").length,
        progressPanels: document.querySelectorAll(".sidebar-progress").length,
        inlineToggles: document.querySelectorAll(".desktop-sidebar-inline-toggle").length,
        galleryToggles: document.querySelectorAll(".gallery-sidebar-toggle").length,
      }));
      desktopSidebar.contentBefore = contentBefore?.x ?? -1;
      desktopSidebar.contentCollapsed = contentCollapsed?.x ?? -1;
      desktopSidebar.expandedToggleWidth = toggleBefore?.width ?? -1;
      desktopSidebar.expandedToggleHeight = toggleBefore?.height ?? -1;
      desktopSidebar.collapsedToggleWidth = toggleCollapsed?.width ?? -1;
      desktopSidebar.collapsedToggleHeight = toggleCollapsed?.height ?? -1;
      desktopSidebar.albumClearance = controlSlotBefore && firstAlbumBefore
        ? firstAlbumBefore.y - (controlSlotBefore.y + controlSlotBefore.height)
        : -1;
      desktopSidebar.toggleControlInsetX = toggleBefore && controlSlotBefore
        ? toggleBefore.x - controlSlotBefore.x
        : -1;
      desktopSidebar.toggleControlInsetY = toggleBefore && controlSlotBefore
        ? toggleBefore.y - controlSlotBefore.y
        : -1;
      desktopSidebar.stationaryToggleDelta = toggleBefore && toggleCollapsed
        ? Math.hypot(toggleBefore.x - toggleCollapsed.x, toggleBefore.y - toggleCollapsed.y)
        : -1;
      desktopSidebar.metaIsBelowAlbums = metaBefore && firstAlbumBefore
        ? metaBefore.y > firstAlbumBefore.y + firstAlbumBefore.height
        : false;
      desktopSidebar.expandedGalleryInsetX = toggleBefore && galleryBefore
        ? toggleBefore.x - galleryBefore.x
        : -1;
      desktopSidebar.expandedGalleryInsetY = toggleBefore && galleryBefore
        ? toggleBefore.y - galleryBefore.y
        : -1;
      desktopSidebar.collapsedGalleryInsetX = toggleCollapsed && galleryCollapsed
        ? toggleCollapsed.x - galleryCollapsed.x
        : -1;
      desktopSidebar.collapsedGalleryInsetY = toggleCollapsed && galleryCollapsed
        ? toggleCollapsed.y - galleryCollapsed.y
        : -1;
      desktopSidebar.expandedGalleryOverlap = toggleBefore && galleryBefore
        ? !(
          toggleBefore.x + toggleBefore.width <= galleryBefore.x ||
          galleryBefore.x + galleryBefore.width <= toggleBefore.x ||
          toggleBefore.y + toggleBefore.height <= galleryBefore.y ||
          galleryBefore.y + galleryBefore.height <= toggleBefore.y
        )
        : false;
      desktopSidebar.galleryOverlap = toggleCollapsed && galleryCollapsed
        ? !(
          toggleCollapsed.x + toggleCollapsed.width <= galleryCollapsed.x ||
          galleryCollapsed.x + galleryCollapsed.width <= toggleCollapsed.x ||
          toggleCollapsed.y + toggleCollapsed.height <= galleryCollapsed.y ||
          galleryCollapsed.y + galleryCollapsed.height <= toggleCollapsed.y
        )
        : true;
      desktopSidebar.sidebarRight = sidebarCollapsedBox
        ? sidebarCollapsedBox.x + sidebarCollapsedBox.width
        : -1;

      await page.locator(".gallery-sidebar-toggle").click();
      await page.waitForFunction(() =>
        document.querySelector(".app-shell")?.getAttribute("data-sidebar-collapsed") === "false"
      );
      await page.waitForTimeout(260);
      const toggleRestored = await page.locator(".gallery-sidebar-toggle").boundingBox();
      desktopSidebar.restoredToggleDelta = toggleBefore && toggleRestored
        ? Math.hypot(toggleBefore.x - toggleRestored.x, toggleBefore.y - toggleRestored.y)
        : -1;
      desktopSidebar.restored = await page.locator(".gallery-sidebar-toggle")
        .getAttribute("aria-expanded");
    } else {
      await page.evaluate(() => window.scrollTo({ top: 320, behavior: "auto" }));
      await page.waitForTimeout(100);
      const fixedTop = await page.locator(".topbar").boundingBox();
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
      const navigationToggleBefore = await page.locator(".gallery-sidebar-toggle").boundingBox();
      const galleryBefore = await page.locator(".masonry").boundingBox();
      await page.locator(".gallery-sidebar-toggle").click();
      await page.waitForSelector(".mobile-nav-layer");
      await page.waitForTimeout(240);
      const navigationToggleOpen = await page.locator(".gallery-sidebar-toggle").boundingBox();
      const navigationLayer = await page.locator(".mobile-nav-layer").boundingBox();
      const navigationDrawer = await page.locator(".mobile-sidebar").boundingBox();
      const controlSlot = await page.locator(".mobile-sidebar .sidebar-control-slot").boundingBox();
      const mobileMeta = await page.locator(".mobile-sidebar .sidebar-gallery-meta").boundingBox();
      const mobileStatus = await page.locator(".mobile-sidebar .sidebar-status").boundingBox();
      const topbar = await page.locator(".topbar").boundingBox();
      mobileNavigation = {
        opened: await page.locator(".mobile-nav-layer").count(),
        fixedTop: fixedTop?.y ?? -1,
        expanded: await page.locator(".gallery-sidebar-toggle").getAttribute("aria-expanded"),
        internalToggles: await page.locator(".mobile-sidebar .sidebar-toggle-button").count(),
        metaRows: await page.locator(".mobile-sidebar .sidebar-gallery-meta").count(),
        galleryPath: await page.locator(".mobile-sidebar .sidebar-gallery-path").textContent(),
        galleryCount: await page.locator(".mobile-sidebar .sidebar-gallery-count").textContent(),
        layerTopGap: navigationLayer && topbar
          ? navigationLayer.y - (topbar.y + topbar.height)
          : -1,
        toggleWidth: navigationToggleBefore?.width ?? -1,
        toggleHeight: navigationToggleBefore?.height ?? -1,
        expandedToggleWidth: navigationToggleOpen?.width ?? -1,
        galleryInsetX: navigationToggleBefore && galleryBefore
          ? navigationToggleBefore.x - galleryBefore.x
          : -1,
        galleryInsetY: navigationToggleBefore && galleryBefore
          ? navigationToggleBefore.y - galleryBefore.y
          : -1,
        galleryOverlap: navigationToggleBefore && galleryBefore
          ? !(
            navigationToggleBefore.x + navigationToggleBefore.width <= galleryBefore.x ||
            galleryBefore.x + galleryBefore.width <= navigationToggleBefore.x ||
            navigationToggleBefore.y + navigationToggleBefore.height <= galleryBefore.y ||
            galleryBefore.y + galleryBefore.height <= navigationToggleBefore.y
          )
          : -1,
        stationaryToggleDelta: navigationToggleBefore && navigationToggleOpen
          ? Math.hypot(
            navigationToggleBefore.x - navigationToggleOpen.x,
            navigationToggleBefore.y - navigationToggleOpen.y,
          )
          : -1,
        toggleControlInsetX: navigationToggleOpen && controlSlot
          ? navigationToggleOpen.x - controlSlot.x
          : -1,
        toggleControlInsetY: navigationToggleOpen && controlSlot
          ? navigationToggleOpen.y - controlSlot.y
          : -1,
        metaBottomGap: mobileMeta ? target.height - (mobileMeta.y + mobileMeta.height) : -1,
        metaStatusGap: mobileMeta && mobileStatus
          ? mobileMeta.y - (mobileStatus.y + mobileStatus.height)
          : -1,
        drawerWidth: navigationDrawer?.width ?? -1,
      };
      await page.locator(".gallery-sidebar-toggle").click();
      await page.waitForSelector(".mobile-nav-layer", { state: "detached" });
      mobileNavigation.closed = await page.locator(".mobile-nav-layer").count();
      mobileNavigation.restored = await page.locator(".gallery-sidebar-toggle")
        .getAttribute("aria-expanded");
    }

    const result = {
      name: target.name,
      ...layout,
      dialogsAfterImageClick,
      searchDisclosure,
      exploration,
      homeNavigation,
      mobileCardNames,
      desktopSidebar,
      mobileNavigation,
      browserErrors,
    };
    results.push(result);
    console.log(JSON.stringify(result));

    const expectedColumns = target.name === "desktop" ? 5 : 2;
    if (
      layout.horizontalOverflow ||
      layout.brokenVisibleImages ||
      layout.masonryColumns !== expectedColumns ||
      layout.cardTags.some((tag) => tag !== "FIGURE") ||
      layout.dialogs !== 0 ||
      dialogsAfterImageClick !== 0 ||
      searchDisclosure.expanded !== "true" ||
      !searchDisclosure.focused ||
      searchDisclosure.panelRole !== "group" ||
      searchDisclosure.panelInert ||
      (target.name === "desktop" && searchDisclosure.leadingGap < 6) ||
      searchDisclosure.panelWidth < (target.name === "desktop" ? 250 : 200) ||
      searchDisclosure.stationaryToggleDelta < 0 ||
      searchDisclosure.stationaryToggleDelta > 0.5 ||
      searchDisclosure.restored !== "false" ||
      !searchDisclosure.panelInertClosed ||
      !searchDisclosure.hasQueryClass ||
      !searchDisclosure.queryClassCleared ||
      searchDisclosure.panelTop - searchDisclosure.topbarBottom < 6 ||
      exploration.firstSeed.length !== 32 ||
      exploration.secondSeed.length !== 32 ||
      exploration.firstSeed === exploration.secondSeed ||
      exploration.exploreMarker !== "none" ||
      exploration.searchMarker !== "none" ||
      homeNavigation.href !== "/" ||
      homeNavigation.galleryPath !== "/" ||
      !homeNavigation.allImagesActive ||
      homeNavigation.searchValue !== "" ||
      layout.topbarSearches !== 1 ||
      layout.brandHomeLinks !== 1 ||
      layout.gallerySidebarToggles !== 1 ||
      layout.galleryToggleOpacity < 0.4 ||
      layout.galleryToggleOpacity > 0.75 ||
      layout.topbarSidebarToggles !== 0 ||
      layout.contentSearches !== 0 ||
      layout.contentInfoRows !== 0 ||
      layout.sortControls !== 0 ||
      layout.topbarSearchRightGap < 0 ||
      layout.topbarSearchRightGap > 20 ||
      layout.exploreButtons !== 1 ||
      layout.exploreSearchGap < 4 ||
      layout.exploreSearchGap > 8 ||
      layout.sidebarStatuses !== 1 ||
      layout.sidebarGalleryMetas !== 1 ||
      !layout.galleryPath.startsWith("/") ||
      !layout.galleryCount.endsWith("张图片") ||
      layout.galleryMetaRowDelta < 0 ||
      layout.galleryMetaRowDelta > 2 ||
      (target.name === "desktop" && (
        !desktopSidebar ||
        desktopSidebar.expanded !== "false" ||
        desktopSidebar.visibility !== "visible" ||
        desktopSidebar.navigationVisibility !== "hidden" ||
        desktopSidebar.statusVisibility !== "hidden" ||
        desktopSidebar.metaVisibility !== "hidden" ||
        desktopSidebar.ariaHidden !== "true" ||
        desktopSidebar.stored !== "true" ||
        desktopSidebar.columns !== 6 ||
        desktopSidebar.redundantHeadings !== 0 ||
        desktopSidebar.pathDetails !== 0 ||
        desktopSidebar.progressPanels !== 0 ||
        desktopSidebar.inlineToggles !== 0 ||
        desktopSidebar.galleryToggles !== 1 ||
        Math.abs(desktopSidebar.expandedToggleWidth - (desktopSidebar.contentBefore - 20)) > 1 ||
        Math.abs(desktopSidebar.expandedToggleHeight - 36) > 1 ||
        Math.abs(desktopSidebar.collapsedToggleWidth - 40) > 1 ||
        Math.abs(desktopSidebar.collapsedToggleHeight - 36) > 1 ||
        desktopSidebar.albumClearance < 8 ||
        desktopSidebar.toggleControlInsetX < 8 ||
        desktopSidebar.toggleControlInsetX > 12 ||
        desktopSidebar.toggleControlInsetY < 4 ||
        desktopSidebar.toggleControlInsetY > 8 ||
        desktopSidebar.stationaryToggleDelta < 0 ||
        desktopSidebar.stationaryToggleDelta > 1 ||
        !desktopSidebar.metaIsBelowAlbums ||
        desktopSidebar.expandedGalleryOverlap ||
        !desktopSidebar.galleryOverlap ||
        Math.abs(desktopSidebar.sidebarRight) > 1 ||
        desktopSidebar.contentBefore < 200 ||
        Math.abs(desktopSidebar.contentCollapsed) > 1 ||
        desktopSidebar.restoredToggleDelta < 0 ||
        desktopSidebar.restoredToggleDelta > 1 ||
        layout.sidebarMetaBottomGap < 0 ||
        layout.sidebarMetaBottomGap > 1 ||
        Math.abs(layout.sidebarMetaStatusGap) > 1 ||
        desktopSidebar.restored !== "true"
      )) ||
      (target.name === "mobile" && (
        layout.topbarPosition !== "fixed" ||
        Math.abs(layout.topbarTop) > 1 ||
        Math.abs(searchDisclosure.compensatedTopbarDelta - 24) > 1 ||
        Math.abs(searchDisclosure.compensatedPanelDelta - 24) > 1 ||
        mobileNavigation?.opened !== 1 ||
        Math.abs(mobileNavigation.fixedTop) > 1 ||
        mobileNavigation.expanded !== "true" ||
        mobileNavigation.internalToggles !== 0 ||
        mobileNavigation.metaRows !== 1 ||
        !mobileNavigation.galleryPath?.startsWith("/") ||
        !mobileNavigation.galleryCount?.endsWith("张图片") ||
        Math.abs(mobileNavigation.layerTopGap) > 1 ||
        Math.abs(mobileNavigation.toggleWidth - 40) > 1 ||
        Math.abs(mobileNavigation.toggleHeight - 36) > 1 ||
        Math.abs(mobileNavigation.expandedToggleWidth - (mobileNavigation.drawerWidth - 20)) > 1 ||
        !mobileNavigation.galleryOverlap ||
        mobileNavigation.stationaryToggleDelta < 0 ||
        mobileNavigation.stationaryToggleDelta > 1 ||
        mobileNavigation.toggleControlInsetX < 8 ||
        mobileNavigation.toggleControlInsetX > 12 ||
        mobileNavigation.toggleControlInsetY < 4 ||
        mobileNavigation.toggleControlInsetY > 8 ||
        mobileNavigation.metaBottomGap < 0 ||
        mobileNavigation.metaBottomGap > 1 ||
        Math.abs(mobileNavigation.metaStatusGap) > 1 ||
        mobileNavigation.drawerWidth < 200 ||
        mobileNavigation.closed !== 0 ||
        mobileNavigation.restored !== "false" ||
        mobileCardNames?.shownOnContact !== "true" ||
        mobileCardNames.retainedOnRelease !== "true" ||
        mobileCardNames.retainedWithoutTimeout !== "true" ||
        mobileCardNames.switchedToSecond !== "true" ||
        mobileCardNames.firstHidden !== "false" ||
        mobileCardNames.activeCount !== 1 ||
        mobileCardNames.displayedCount !== 1 ||
        mobileCardNames.clickCount !== 1 ||
        layout.cardNameDisplay === "none" ||
        layout.cardNameOpacity > 0.01 ||
        layout.cardNameWhiteSpace !== "nowrap"
      )) ||
      (target.name === "desktop" && layout.topbarPosition !== "fixed") ||
      browserErrors.length
    ) {
      throw new Error(`visual check failed: ${JSON.stringify(result)}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
