import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const appVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const baseUrl = process.env.PIXHELF_URL ?? "http://127.0.0.1:3002";
const requestedTarget = process.env.PIXHELF_VISUAL_TARGET;
const viewerReturnOnly = process.env.PIXHELF_VIEWER_RETURN_ONLY === "1";

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const results = [];

async function closeNavigation(page) {
  const motion = await page.evaluate(async () => {
    const menu = document.querySelector(".gallery-sidebar-toggle");
    const panel = document.querySelector(".mobile-sidebar") ?? document.querySelector(".desktop-sidebar");
    const brand = panel.querySelector(".brand-lockup");
    const home = document.querySelector(".topbar-home");
    const homeBounds = home.getBoundingClientRect();
    const result = { samples: 0, minimumBrandMenuGap: null, homeStable: true };
    menu.click();
    const start = performance.now();
    while (performance.now() - start < 380) {
      await new Promise(requestAnimationFrame);
      const homeRect = home.getBoundingClientRect();
      const homeStyle = getComputedStyle(home);
      result.homeStable &&= homeStyle.visibility === "visible" && homeStyle.opacity === "1"
        && homeRect.x === homeBounds.x && homeRect.y === homeBounds.y
        && homeRect.width === homeBounds.width && homeRect.height === homeBounds.height
        && home.getAnimations({ subtree: true }).length === 0;
      const rect = brand.getBoundingClientRect();
      const style = getComputedStyle(brand);
      if (
        !brand.isConnected || style.visibility !== "visible" || Number(style.opacity) < .02
        || panel.getBoundingClientRect().right <= rect.left
      ) continue;
      const gap = rect.left - menu.getBoundingClientRect().right;
      result.samples++;
      result.minimumBrandMenuGap = Math.min(result.minimumBrandMenuGap ?? gap, gap);
    }
    return result;
  });
  if (!motion.samples || motion.minimumBrandMenuGap < 8 || !motion.homeStable) {
    throw new Error(`sidebar toggle disrupts the header: ${JSON.stringify(motion)}`);
  }
  return motion;
}

async function checkHomeNavigation(page, target, selector) {
  const sidebar = target.name === "mobile" ? ".mobile-sidebar" : ".desktop-sidebar";
  const toolbarButton = selector === ".topbar-home";
  if (target.name === "mobile" && !toolbarButton) {
    await page.locator(".gallery-sidebar-toggle").click();
    await page.locator(`${sidebar} .brand`).waitFor({ state: "visible" });
  }
  const shell = await page.locator(".app-shell").elementHandle();
  const homeRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/images" && url.searchParams.get("offset") === "0";
  });
  await page.locator(toolbarButton ? selector : `${sidebar} ${selector}`).click();
  const request = await homeRequest;
  const response = await request.response();
  const url = new URL(request.url());
  if (
    !response?.ok() || request.isNavigationRequest()
    || url.searchParams.get("sort") !== "name-asc"
    || url.searchParams.has("album") || url.searchParams.has("search")
  ) throw new Error(`${selector} did not load the homepage: ${request.url()}`);
  await response.finished();
  await page.waitForFunction(() =>
    document.querySelector(".content")?.getAttribute("aria-busy") === "false"
    && !document.querySelector(".skeleton-grid")
    && document.querySelector("[data-image-id]")
  );
  const shellPreserved = await shell.evaluate((element) => element.isConnected);
  await shell.dispose();
  if (!shellPreserved) throw new Error(`${selector} navigation replaced the application shell`);
  if (target.name === "mobile") {
    await page.locator(".mobile-nav-layer").waitFor({ state: "detached" });
  }
  return { selector, shellPreserved, status: response.status(), request: url.pathname + url.search };
}

async function revealSimilarToolbar(page) {
  const informationToolbar = await page.locator(".viewer-details-header").evaluate((header) => ({
    inert: header.inert,
    visible: header.dataset.visible,
  }));
  if (!informationToolbar.inert || informationToolbar.visible !== "false") {
    throw new Error(`details toolbar appeared over image information: ${JSON.stringify(informationToolbar)}`);
  }
  await page.locator(".viewer-similar-heading").waitFor({ state: "visible" });
  await page.locator(".viewer-similar-section").evaluate((section) => {
    section.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await page.waitForFunction(() => {
    const header = document.querySelector(".viewer-details-header");
    return header && !header.inert && header.dataset.visible === "true";
  });
}

try {
  const targets = [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ].filter((target) => !requestedTarget || target.name === requestedTarget);
  for (const target of targets) {
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
    const minimumVisibleImages = target.name === "mobile" ? 4 : 8;
    await page.waitForFunction((minimumVisible) => {
      const visible = [...document.querySelectorAll("[data-image-id] img")].filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      });
      return visible.length >= minimumVisible &&
        visible.every((image) => image.complete && image.naturalWidth > 0);
    }, minimumVisibleImages, { timeout: 60_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/tmp/pixhelf-${target.name}.png` });

    const layout = await page.evaluate(() => {
      const search = document.querySelector(".topbar-search");
      const topbar = document.querySelector(".topbar");
      const sidebarFooter = document.querySelector(".desktop-sidebar .sidebar-footer");
      const searchRect = search?.getBoundingClientRect();
      const exploreRect = document.querySelector(".topbar .explore-toggle")?.getBoundingClientRect();
      const home = document.querySelector(".topbar-home");
      const homeRect = home?.getBoundingClientRect();
      const topbarRect = topbar?.getBoundingClientRect();
      const footerRect = sidebarFooter?.getBoundingClientRect();
      const galleryToggle = document.querySelector(".gallery-sidebar-toggle");
      const toggleRect = galleryToggle?.getBoundingClientRect();
      const brandRect = document.querySelector(".brand-lockup")?.getBoundingClientRect();
      const brandImage = document.querySelector("img.brand-mark");
      return {
        viewport: [innerWidth, innerHeight],
        bodyWidth: document.documentElement.scrollWidth,
        cards: document.querySelectorAll("[data-image-id]").length,
        cardTags: [...document.querySelectorAll("[data-image-id]")]
          .map((element) => element.tagName),
        galleryLayout: document.querySelector(".justified-gallery")?.dataset.layout,
        galleryRows: Number(document.querySelector(".justified-gallery")?.dataset.rows ?? 0),
        loadedCards: document.querySelectorAll("[data-image-id] img.loaded").length,
        brokenVisibleImages: [...document.images].filter((image) => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight && image.naturalWidth === 0;
        }).length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        topbarPosition: topbar ? getComputedStyle(topbar).position : "",
        topbarTop: topbarRect?.top ?? -1,
        topbarHeight: topbarRect?.height ?? -1,
        topbarSurfaceLeft: document.querySelector(".topbar-surface")?.getBoundingClientRect().left ?? -1,
        sidebarTop: document.querySelector(".desktop-sidebar")?.getBoundingClientRect().top ?? -1,
        topbarSearches: document.querySelectorAll(
          ".topbar-actions > .topbar-search",
        ).length,
        brandMarks: document.querySelectorAll(".brand-mark").length,
        brandHomeLinks: document.querySelectorAll('a.brand[href="/"]').length,
        brandText: document.querySelector(".brand")?.textContent?.trim() ?? "",
        brandTitle: document.querySelector(".brand")?.getAttribute("title"),
        brandLabel: document.querySelector(".brand")?.getAttribute("aria-label"),
        brandName: document.querySelector(".brand-name")?.textContent,
        brandNameHref: document.querySelector(".brand-name")?.closest("a")?.getAttribute("href"),
        brandVersion: document.querySelector(".brand-version")?.textContent,
        brandVersionSize: Number.parseFloat(getComputedStyle(document.querySelector(".brand-version")).fontSize),
        brandRepository: document.querySelector(".brand-version")?.getAttribute("href"),
        sidebarBrands: document.querySelectorAll(".sidebar .brand-lockup").length,
        topbarBrands: document.querySelectorAll(".topbar .brand-lockup").length,
        brandDisplayed: Boolean(brandRect?.width),
        topbarHomeButtons: document.querySelectorAll(".topbar-actions > button.topbar-home").length,
        leadingHomeButtons: document.querySelectorAll(".topbar-leading .topbar-home, .topbar-home-slot").length,
        homeLabel: home?.getAttribute("aria-label"),
        homeExploreGap: homeRect && exploreRect ? exploreRect.left - homeRect.right : -1,
        exploreSearchGap: exploreRect && searchRect ? searchRect.left - exploreRect.right : -1,
        homeStatic: home ? getComputedStyle(home).transitionProperty === "none" : false,
        brandLoaded: Boolean(brandImage?.complete && brandImage.naturalWidth > 0),
        brandMenuGap: brandRect && toggleRect ? brandRect.left - toggleRect.right : -1,
        sidebarControlSlots: document.querySelectorAll(".sidebar-control-slot").length,
        gallerySidebarToggles: document.querySelectorAll(".gallery-sidebar-toggle").length,
        galleryToggleOpacity: galleryToggle
          ? Number.parseFloat(getComputedStyle(galleryToggle).opacity)
          : -1,
        topbarSidebarToggles: document.querySelectorAll(
          ".topbar .sidebar-toggle-button",
        ).length,
        contentSearches: document.querySelectorAll(".content .search-field").length,
        topbarSearchRightGap: searchRect && topbarRect ? topbarRect.right - searchRect.right : -1,
        topbarExploreButtons: document.querySelectorAll(".topbar-actions > .explore-toggle").length,
        sidebarExploreButtons: document.querySelectorAll(".desktop-sidebar .album-nav > .explore-toggle").length,
        sidebarStatuses: document.querySelectorAll(".sidebar-status").length,
        sidebarGalleryMetas: document.querySelectorAll(".sidebar-gallery-meta").length,
        contentInfoRows: document.querySelectorAll(
          ".content-heading, .content .sidebar-gallery-meta",
        ).length,
        sortControls: document.querySelectorAll(".sort-control").length,
        nativeCardTitles: document.querySelectorAll('.image-card[title], .image-card [title]').length,
        legacyCardNames: document.querySelectorAll('.image-name').length,
        cardActions: document.querySelectorAll('.image-card .photo-card-more').length,
        sidebarFooterBottomGap: footerRect ? innerHeight - footerRect.bottom : null,
      };
    });

    let resizeStability = null;
    if (target.name === "desktop") {
      await page.evaluate(() => {
        globalThis.__pixhelfResizeLoadedIds = [
          ...document.querySelectorAll('[data-image-id][data-loaded="true"]'),
        ].map((card) => card.getAttribute("data-image-id"));
        for (const card of document.querySelectorAll("[data-image-id]")) {
          card.setAttribute(
            "data-resize-probe",
            card.getAttribute("data-image-id") ?? "",
          );
        }
        globalThis.__pixhelfResizeSkeletonSeen = false;
        globalThis.__pixhelfResizeObserver = new MutationObserver(() => {
          if (document.querySelector(".skeleton-grid")) {
            globalThis.__pixhelfResizeSkeletonSeen = true;
          }
        });
        globalThis.__pixhelfResizeObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
        globalThis.__pixhelfImageRequestsBeforeResize = performance
          .getEntriesByType("resource")
          .filter((entry) => new URL(entry.name).pathname === "/api/images")
          .length;
      });

      const resizeAnchor = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".justified-gallery .image-card")];
        const card = cards[Math.min(24, cards.length - 1)];
        if (!(card instanceof HTMLElement)) return null;
        card.scrollIntoView({ block: "center", behavior: "instant" });
        card.focus({ preventScroll: true });
        const rect = card.getBoundingClientRect();
        const viewportTop = visualViewport?.offsetTop ?? 0;
        const viewportHeight = visualViewport?.height ?? innerHeight;
        const viewportBottom = viewportTop + viewportHeight;
        const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
          ?? viewportTop;
        const safeTop = Math.min(viewportBottom, Math.max(viewportTop, topbarBottom + 8));
        const safeBottom = Math.max(safeTop, viewportBottom - 8);
        const visibleTop = Math.max(safeTop, rect.top);
        const visibleBottom = Math.min(safeBottom, rect.bottom);
        const anchorY = (visibleTop + visibleBottom) / 2;
        return {
          imageId: card.dataset.imageId ?? "",
          cardRatio: (anchorY - rect.top) / Math.max(1, rect.height),
          viewportRatio: (anchorY - viewportTop) / Math.max(1, viewportHeight),
        };
      });
      if (!resizeAnchor) throw new Error("gallery resize anchor could not be captured");
      const resizeAnchorDeltas = [];

      for (const size of [
        { width: 680 },
        { width: 520 },
        { width: 1000 },
        { width: target.width },
      ]) {
        await page.setViewportSize({ width: size.width, height: target.height });
        await page.waitForFunction(() => {
          const gallery = document.querySelector(".justified-gallery");
          return gallery && Math.abs(Number(gallery.dataset.layoutWidth) - gallery.getBoundingClientRect().width) < 1;
        });
        try {
          await page.waitForFunction((anchor) => {
            const card = document.querySelector(
              `.justified-gallery .image-card[data-image-id="${CSS.escape(anchor.imageId)}"]`,
            );
            if (!(card instanceof HTMLElement)) return false;
            const rect = card.getBoundingClientRect();
            const viewportTop = visualViewport?.offsetTop ?? 0;
            const viewportHeight = visualViewport?.height ?? innerHeight;
            const viewportBottom = viewportTop + viewportHeight;
            const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
              ?? viewportTop;
            const safeTop = Math.min(viewportBottom, Math.max(viewportTop, topbarBottom + 8));
            const safeBottom = Math.max(safeTop, viewportBottom - 8);
            const expectedY = Math.min(
              safeBottom,
              Math.max(safeTop, viewportTop + anchor.viewportRatio * viewportHeight),
            );
            const actualY = rect.top + rect.height * anchor.cardRatio;
            return Math.abs(actualY - expectedY) <= 2;
          }, resizeAnchor, { timeout: 4000 });
        } catch (error) {
          const actual = await page.evaluate((anchor) => {
            const card = document.querySelector(
              `.justified-gallery .image-card[data-image-id="${CSS.escape(anchor.imageId)}"]`,
            );
            if (!(card instanceof HTMLElement)) return { missing: true };
            const rect = card.getBoundingClientRect();
            const viewportTop = visualViewport?.offsetTop ?? 0;
            const viewportHeight = visualViewport?.height ?? innerHeight;
            const viewportBottom = viewportTop + viewportHeight;
            const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
              ?? viewportTop;
            const safeTop = Math.min(viewportBottom, Math.max(viewportTop, topbarBottom + 8));
            const safeBottom = Math.max(safeTop, viewportBottom - 8);
            const expectedY = Math.min(
              safeBottom,
              Math.max(safeTop, viewportTop + anchor.viewportRatio * viewportHeight),
            );
            const actualY = rect.top + rect.height * anchor.cardRatio;
            return {
              actualY,
              rows: document.querySelector(".justified-gallery")?.dataset.rows,
              delta: Math.abs(actualY - expectedY),
              expectedY,
              scrollY,
            };
          }, resizeAnchor);
          throw new Error(
            `gallery resize anchor drifted at ${size.width}px: ${JSON.stringify(actual)}`,
            { cause: error },
          );
        }
        resizeAnchorDeltas.push(await page.evaluate((anchor) => {
          const card = document.querySelector(
            `.justified-gallery .image-card[data-image-id="${CSS.escape(anchor.imageId)}"]`,
          );
          if (!(card instanceof HTMLElement)) return Infinity;
          const rect = card.getBoundingClientRect();
          const viewportTop = visualViewport?.offsetTop ?? 0;
          const viewportHeight = visualViewport?.height ?? innerHeight;
          const viewportBottom = viewportTop + viewportHeight;
          const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
            ?? viewportTop;
          const safeTop = Math.min(viewportBottom, Math.max(viewportTop, topbarBottom + 8));
          const safeBottom = Math.max(safeTop, viewportBottom - 8);
          const expectedY = Math.min(
            safeBottom,
            Math.max(safeTop, viewportTop + anchor.viewportRatio * viewportHeight),
          );
          return Math.abs(rect.top + rect.height * anchor.cardRatio - expectedY);
        }, resizeAnchor));
      }

      await page.waitForFunction(() => {
        const loadedIds = globalThis.__pixhelfResizeLoadedIds ?? [];
        return loadedIds.every((id) => {
          const card = document.querySelector(`[data-image-id="${CSS.escape(id)}"]`);
          const image = card?.querySelector("img");
          return card?.getAttribute("data-loaded") === "true"
            && image?.complete
            && image.naturalWidth > 0;
        });
      });
      resizeStability = await page.evaluate(() => {
        globalThis.__pixhelfResizeObserver?.disconnect();
        const cards = [...document.querySelectorAll("[data-image-id]")];
        const imageRequestsAfter = performance
          .getEntriesByType("resource")
          .filter((entry) => new URL(entry.name).pathname === "/api/images")
          .length;
        const visibleImages = cards
          .map((card) => card.querySelector("img"))
          .filter((image) => {
            if (!image) return false;
            const rect = image.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < innerHeight;
          });
        return {
          cardsPreserved: cards.every((card) =>
            card.getAttribute("data-resize-probe") === card.getAttribute("data-image-id")
          ),
          loadedCardsPreserved: (globalThis.__pixhelfResizeLoadedIds ?? []).every((id) =>
            document.querySelector(`[data-image-id="${CSS.escape(id)}"]`)
              ?.getAttribute("data-loaded") === "true"
          ),
          skeletonSeen: globalThis.__pixhelfResizeSkeletonSeen,
          imagePageRequests: imageRequestsAfter
            - globalThis.__pixhelfImageRequestsBeforeResize,
          brokenVisibleImages: visibleImages.filter((image) =>
            !image.complete || image.naturalWidth <= 0
          ).length,
          galleryLayout: document.querySelector(".justified-gallery")?.dataset.layout,
        };
      });
      Object.assign(resizeStability, {
        anchorId: resizeAnchor.imageId,
        anchorDeltas: resizeAnchorDeltas,
        anchorFocused: await page.evaluate((imageId) =>
          document.activeElement?.getAttribute("data-image-id") === imageId
        , resizeAnchor.imageId),
      });
    }

    const firstViewerTitle = await page.locator("[data-image-id]").first().getAttribute("data-image-name");
    await page.locator("[data-image-id]").first().click();
    await page.waitForSelector(".image-viewer");
    const viewerChrome = await page.evaluate(() => ({
      fullscreenButtons: document.querySelectorAll(".viewer-fullscreen").length,
      detailsPages: document.querySelectorAll(".viewer-details-page").length,
      detailsToolbars: document.querySelectorAll(".viewer-details-toolbar").length,
      detailsToolbarControls: document.querySelectorAll(
        ".viewer-details-toolbar > .viewer-control",
      ).length,
      detailsToolbarUnified: document.querySelector(".viewer-details-toolbar")
        ?.classList.contains("viewer-header-actions") ?? false,
      detailsInlineActions: document.querySelectorAll(".viewer-details-quick-actions").length,
      scrollCues: document.querySelectorAll(".viewer-scroll-cue").length,
      zoomControls: document.querySelectorAll(
        ".viewer-zoom-controls, .viewer-zoom-value",
      ).length,
      navigationGlass: [...document.querySelectorAll(".viewer-nav")].every((control) => {
        const style = getComputedStyle(control);
        return Number.parseFloat(style.borderTopWidth) === 0
          && !style.boxShadow.includes("inset")
          && (style.backgroundImage !== "none" || style.backgroundColor !== "rgba(0, 0, 0, 0)")
          && (style.backdropFilter !== "none" || style.webkitBackdropFilter !== "none");
      }),
      floatingToolbar: (() => {
        const viewer = document.querySelector(".image-viewer");
        const header = document.querySelector(".viewer-header");
        const actions = document.querySelector(".viewer-header-actions");
        if (!viewer || !header || !actions) return null;
        const headerStyle = getComputedStyle(header);
        const actionsStyle = getComputedStyle(actions);
        return {
          mode: viewer.getAttribute("data-ui-layout"),
          headerTransparent: headerStyle.backgroundImage === "none"
            && headerStyle.backgroundColor === "rgba(0, 0, 0, 0)",
          actionsSurfaced: actionsStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
            && Number.parseFloat(actionsStyle.borderTopWidth) > 0,
        };
      })(),
      headingModules: document.querySelectorAll(".viewer-heading").length,
      unifiedControls: document.querySelector(".image-viewer")
        ?.getAttribute("data-control-system") === "unified",
      drawerArtifacts: document.querySelectorAll(
        ".viewer-details-sheet, .viewer-details-scrim",
      ).length,
      gestureHelp: document.querySelectorAll(".viewer-gesture-help").length,
      loadingStatus: document.querySelectorAll(".viewer-load-status").length,
      loadingCopyVisible: document.body.textContent?.includes("正在加载原图") ?? false,
    }));
    await page.waitForFunction(() =>
      document.querySelector(".image-viewer")?.getAttribute("data-full-loaded") === "true"
    , undefined, { timeout: 60_000 });
    await page.waitForFunction(() => {
      const originalPaths = performance.getEntriesByType("resource")
        .map((entry) => new URL(entry.name).pathname)
        .filter((path) => path.endsWith("/original"));
      return new Set(originalPaths).size >= 2;
    }, undefined, { timeout: 60_000 });
    await page.waitForTimeout(260);
    const dialogsAfterImageClick = await page.locator('[role="dialog"]').count();
    await page.screenshot({ path: `/tmp/pixhelf-viewer-${target.name}.png` });
    const viewer = await page.evaluate(() => {
      const overlay = document.querySelector(".image-viewer");
      const thumbnail = document.querySelector(".viewer-thumbnail");
      const original = document.querySelector(".viewer-original");
      const nativeOriginal = document.querySelector(".viewer-native-original");
      const mediaElement = document.querySelector(".viewer-media");
      const media = mediaElement?.getBoundingClientRect();
      const stage = document.querySelector(".viewer-stage")?.getBoundingClientRect();
      const details = document.querySelector(".viewer-details-page")?.getBoundingClientRect();
      const thumbnailStyle = thumbnail ? getComputedStyle(thumbnail) : null;
      const originalStyle = original ? getComputedStyle(original) : null;
      const resourcePaths = performance.getEntriesByType("resource")
        .map((entry) => new URL(entry.name).pathname);
      const originalSource = original instanceof HTMLImageElement
        ? original.currentSrc || original.src
        : original?.getAttribute("data-original-url") ?? "";
      return {
        title: overlay?.getAttribute("data-image-name") ?? "",
        fullLoaded: overlay?.getAttribute("data-full-loaded"),
        displaySource: overlay?.getAttribute("data-display-source") ?? "",
        nativeOriginalLoaded: overlay?.getAttribute("data-native-original-loaded") ?? "false",
        nativeOriginalActive: overlay?.getAttribute("data-native-original-active") ?? "false",
        nativeOriginalCount: document.querySelectorAll(".viewer-native-original").length,
        nativeOriginalPath: nativeOriginal instanceof HTMLImageElement
          ? new URL(nativeOriginal.currentSrc || nativeOriginal.src, location.href).pathname
          : "",
        nativeOriginalPixels: nativeOriginal instanceof HTMLImageElement
          ? [nativeOriginal.naturalWidth, nativeOriginal.naturalHeight]
          : [0, 0],
        nativeOriginalVisible: nativeOriginal
          ? Number.parseFloat(getComputedStyle(nativeOriginal).opacity)
          : 0,
        mediaWillChange: mediaElement ? getComputedStyle(mediaElement).willChange : "",
        originalPath: originalSource ? new URL(originalSource, location.href).pathname : "",
        renderer: overlay?.getAttribute("data-renderer"),
        sourceStrategy: overlay?.getAttribute("data-source-strategy") ?? "",
        sourcePresentation: overlay?.getAttribute("data-source-presentation") ?? "",
        thumbnailFilter: thumbnailStyle?.filter ?? "",
        thumbnailTransform: thumbnailStyle?.transform ?? "",
        thumbnailTransitionDelay: thumbnailStyle?.transitionDelay ?? "",
        originalTransitionDuration: originalStyle?.transitionDuration ?? "",
        gestureRenderer: overlay?.getAttribute("data-mobile-gesture-renderer") ?? "",
        originalPolicy: overlay?.getAttribute("data-mobile-original-policy") ?? "",
        scrollMode: overlay?.getAttribute("data-scroll-mode"),
        renderedPixels: original instanceof HTMLCanvasElement
          ? [original.width, original.height]
          : [original?.clientWidth ?? 0, original?.clientHeight ?? 0],
        prefetchedOriginals: new Set(
          resourcePaths.filter((path) => path.endsWith("/original")),
        ).size,
        previewRequests: resourcePaths.filter((path) => path.endsWith("/preview")).length,
        rootInert: document.querySelector("#root")?.inert ?? false,
        viewerFocused: document.activeElement === overlay,
        mediaContained: media
          ? media.left >= -1 && media.top >= -1 && media.right <= innerWidth + 1 &&
            media.bottom <= innerHeight + 1
          : false,
        continuousLayout: overlay && stage && details
          ? Math.abs(stage.top) < 1 && Math.abs(stage.height - innerHeight) < 1 &&
            Math.abs(details.top - stage.bottom) < 1 &&
            details.height >= innerHeight - 1 &&
            overlay.scrollHeight >= innerHeight * 2 - 1
          : false,
      };
    });
    Object.assign(viewer, viewerChrome);
    await page.keyboard.press("Shift");
    const initialFocus = await page.locator(".image-viewer").evaluate((overlay) => ({
      onViewer: document.activeElement === overlay,
      visibleControlFocusRings: overlay.querySelectorAll(".viewer-control:focus-visible").length,
    }));
    if (!initialFocus.onViewer || initialFocus.visibleControlFocusRings !== 0) {
      throw new Error(`viewer opening selected a control: ${JSON.stringify(initialFocus)}`);
    }
    const sideButtonStart = await page.evaluate(() => {
      const activeId = document.querySelector(".image-viewer")?.getAttribute("data-image-id") ?? "";
      const ids = [...document.querySelectorAll(".justified-gallery .image-card")]
        .map((card) => card.getAttribute("data-image-id") ?? "");
      const index = ids.indexOf(activeId);
      return {
        activeId,
        nextId: ids[index + 1] ?? "",
        historyLength: history.length,
        href: location.href,
      };
    });
    const dispatchViewerSideButton = (button) => page.locator(".image-viewer").evaluate(
      (viewerElement, sideButton) => {
        const mask = sideButton === 3 ? 8 : 16;
        const downPrevented = !viewerElement.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: sideButton,
          buttons: mask,
          pointerId: 71,
          pointerType: "mouse",
        }));
        const upPrevented = !viewerElement.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          button: sideButton,
          buttons: 0,
          pointerId: 71,
          pointerType: "mouse",
        }));
        const auxiliaryPrevented = !viewerElement.dispatchEvent(new MouseEvent("auxclick", {
          bubbles: true,
          cancelable: true,
          button: sideButton,
        }));
        return { downPrevented, upPrevented, auxiliaryPrevented };
      },
      button,
    );
    const sideForwardEvents = await dispatchViewerSideButton(4);
    await page.waitForFunction((imageId) =>
      document.querySelector(".image-viewer")?.getAttribute("data-image-id") === imageId
    , sideButtonStart.nextId);
    const sideBackEvents = await dispatchViewerSideButton(3);
    await page.waitForFunction((imageId) =>
      document.querySelector(".image-viewer")?.getAttribute("data-image-id") === imageId
    , sideButtonStart.activeId);
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    ));
    const sideButtonNavigation = await page.evaluate(({ start, forward, back }) => {
      const overlay = document.querySelector(".image-viewer");
      return {
        forward,
        back,
        returnedId: overlay?.getAttribute("data-image-id") ?? "",
        returnedSource: overlay?.getAttribute("data-display-source") ?? "",
        returnedPresentation: overlay?.getAttribute("data-source-presentation") ?? "",
        returnedLoaded: overlay?.getAttribute("data-full-loaded") ?? "false",
        enabled: overlay?.getAttribute("data-mouse-side-navigation") === "true",
        historyPreserved: history.length === start.historyLength && location.href === start.href,
      };
    }, { start: sideButtonStart, forward: sideForwardEvents, back: sideBackEvents });
    if (
      !sideButtonStart.nextId ||
      sideButtonNavigation.returnedId !== sideButtonStart.activeId ||
      sideButtonNavigation.returnedPresentation !== "direct" ||
      sideButtonNavigation.returnedLoaded !== "true" ||
      !["original", "viewport-bitmap"].includes(sideButtonNavigation.returnedSource) ||
      !sideButtonNavigation.enabled ||
      !sideButtonNavigation.historyPreserved ||
      !Object.values(sideButtonNavigation.forward).every(Boolean) ||
      !Object.values(sideButtonNavigation.back).every(Boolean)
    ) {
      throw new Error(`viewer side-button navigation failed: ${JSON.stringify(sideButtonNavigation)}`);
    }
    Object.assign(viewer, { sideButtonNavigation });
    if (target.name === "desktop") {
      await page.locator(".viewer-next").click();
    } else {
      await page.keyboard.press("ArrowRight");
    }
    await page.waitForFunction((imageId) =>
      document.querySelector(".image-viewer")?.getAttribute("data-image-id") === imageId
    , sideButtonStart.nextId);
    const switchPerformance = await page.evaluate(async (expectedId) => {
      const start = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      }));
      const dispatchDuration = performance.now() - start;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const firstFrameDuration = performance.now() - start;
      const overlay = document.querySelector(".image-viewer");
      const media = document.querySelector(".viewer-media");
      return {
        currentId: overlay?.getAttribute("data-image-id") ?? "",
        dispatchDuration,
        firstFrameDuration,
        firstFrameSource: overlay?.getAttribute("data-display-source") ?? "",
        focusedOnViewer: document.activeElement === overlay,
        visibleControlFocusRings: document.querySelectorAll(
          ".image-viewer .viewer-control:focus-visible, "
          + ".image-viewer .viewer-nav:focus-visible",
        ).length,
        mediaAnimations: media?.getAnimations().length ?? -1,
        expectedId,
      };
    }, sideButtonStart.activeId);
    if (
      switchPerformance.currentId !== switchPerformance.expectedId ||
      switchPerformance.dispatchDuration > 80 ||
      switchPerformance.firstFrameDuration > 100 ||
      (target.name === "mobile"
        ? !["thumbnail", "viewport-bitmap"].includes(switchPerformance.firstFrameSource)
        : switchPerformance.firstFrameSource !== "original") ||
      !switchPerformance.focusedOnViewer ||
      switchPerformance.visibleControlFocusRings !== 0 ||
      switchPerformance.mediaAnimations !== 0
    ) {
      throw new Error(`viewer switch responsiveness failed: ${JSON.stringify(switchPerformance)}`);
    }
    Object.assign(viewer, { switchPerformance });
    const rapidSwitch = await page.evaluate(async () => {
      const overlay = document.querySelector(".image-viewer");
      const ids = [...document.querySelectorAll(".justified-gallery .image-card")]
        .map((card) => card.getAttribute("data-image-id") ?? "");
      const startId = overlay?.getAttribute("data-image-id") ?? "";
      const startIndex = ids.indexOf(startId);
      const steps = Math.min(6, Math.max(0, ids.length - startIndex - 1));
      const expectedId = ids[startIndex + steps] ?? startId;
      const previousMedia = document.querySelector(".viewer-media");
      for (let index = 0; index < steps; index += 1) {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const currentOverlay = document.querySelector(".image-viewer");
      const currentId = currentOverlay?.getAttribute("data-image-id") ?? "";
      const thumbnail = document.querySelector(".viewer-thumbnail");
      const original = document.querySelector(".viewer-original");
      const thumbnailPath = thumbnail instanceof HTMLImageElement
        ? new URL(thumbnail.currentSrc || thumbnail.src, location.href).pathname
        : "";
      const originalSource = original instanceof HTMLImageElement
        ? original.currentSrc || original.src
        : original?.getAttribute("data-original-url") ?? "";
      const originalPath = originalSource
        ? new URL(originalSource, location.href).pathname
        : "";
      return {
        steps,
        startId,
        expectedId,
        currentId,
        mediaReplaced: previousMedia !== document.querySelector(".viewer-media"),
        mediaCount: document.querySelectorAll(".viewer-media").length,
        thumbnailMatches: thumbnailPath.includes(`/api/images/${encodeURIComponent(currentId)}/thumbnail`),
        originalMatches: originalPath.includes(`/api/images/${encodeURIComponent(currentId)}/original`),
        immediateSource: currentOverlay?.getAttribute("data-display-source") ?? "",
        mediaAnimations: document.querySelector(".viewer-media")?.getAnimations().length ?? -1,
      };
    });
    await page.waitForFunction(() =>
      document.querySelector(".image-viewer")?.getAttribute("data-display-source") !== "placeholder"
    , undefined, { timeout: 10_000 });
    rapidSwitch.readySource = await page.locator(".image-viewer").getAttribute("data-display-source");
    await page.waitForFunction(() =>
      document.querySelector(".image-viewer")?.getAttribute("data-full-loaded") === "true"
    , undefined, { timeout: 60_000 });
    rapidSwitch.upgradedSource = await page.locator(".image-viewer").getAttribute("data-display-source");
    Object.assign(viewer, { rapidSwitch });
    if (
      rapidSwitch.steps !== 6 ||
      rapidSwitch.currentId !== rapidSwitch.expectedId ||
      !rapidSwitch.mediaReplaced ||
      rapidSwitch.mediaCount !== 1 ||
      !rapidSwitch.thumbnailMatches ||
      !rapidSwitch.originalMatches ||
      rapidSwitch.mediaAnimations !== 0 ||
      rapidSwitch.readySource === "placeholder" ||
      rapidSwitch.upgradedSource !== (
        target.name === "mobile" ? "viewport-bitmap" : "original"
      )
    ) {
      throw new Error(`viewer rapid-switch pipeline failed: ${JSON.stringify(rapidSwitch)}`);
    }
    await page.locator(".viewer-fullscreen").click();
    await page.waitForFunction(() =>
      document.fullscreenElement?.classList.contains("image-viewer")
    );
    await page.waitForFunction(() =>
      document.querySelector(".viewer-fullscreen")?.getAttribute("aria-label") === "退出全屏"
    );
    viewer.fullscreenEntered = true;
    viewer.fullscreenLabel = await page.locator(".viewer-fullscreen").getAttribute("aria-label");
    await page.locator(".viewer-fullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    viewer.fullscreenExited = true;
    await page.keyboard.press("=");
    await page.waitForFunction(() =>
      document.querySelector(".image-viewer")?.getAttribute("data-zoomed") === "true"
    );
    viewer.zoomed = await page.locator(".image-viewer").getAttribute("data-zoomed");
    await page.waitForTimeout(260);
    viewer.zoomScale = await page.locator(".viewer-media").evaluate((media) =>
      new DOMMatrix(getComputedStyle(media).transform).a
    );
    Object.assign(viewer, await page.locator(".image-viewer").evaluate((overlay) => ({
      zoomKeptImagePage: overlay.scrollTop < 1 && overlay.dataset.page === "image",
      zoomLockedPageScroll: getComputedStyle(overlay).overflowY === "hidden",
    })));
    if (target.name === "desktop") {
      await page.mouse.move(target.width / 2, target.height / 2);
      await page.mouse.wheel(0, 1_000);
      await page.mouse.wheel(0, 1_000);
      await page.waitForFunction(() =>
        document.querySelector(".image-viewer")?.getAttribute("data-zoomed") === "false"
      );
      await page.mouse.wheel(0, 1_000);
      await page.waitForTimeout(80);
      viewer.zoomWheelHandoffLocked = await page.locator(".image-viewer").evaluate((overlay) =>
        overlay.scrollTop < 1 && overlay.dataset.page === "image"
      );
    }
    const keyboardStartName = await page.locator(".image-viewer").getAttribute("data-image-name");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((title) =>
      document.querySelector(".image-viewer")?.getAttribute("data-image-name") !== title
    , keyboardStartName);
    viewer.keyboardNavigation = await page.locator(".image-viewer").getAttribute("data-image-name");
    const keyboardFocus = await page.evaluate(() => {
      const overlay = document.querySelector(".image-viewer");
      return {
        parkedOnViewer: document.activeElement === overlay,
        visibleControlFocusRings: document.querySelectorAll(
          ".image-viewer .viewer-control:focus-visible, "
          + ".image-viewer .viewer-nav:focus-visible",
        ).length,
      };
    });
    if (!keyboardFocus.parkedOnViewer || keyboardFocus.visibleControlFocusRings !== 0) {
      throw new Error(`viewer keyboard focus was not parked: ${JSON.stringify(keyboardFocus)}`);
    }
    Object.assign(viewer, { keyboardFocus });
    if (target.name === "desktop") {
      await page.waitForFunction(() =>
        document.querySelector(".image-viewer")?.getAttribute("data-zoomed") === "false"
      );
      await page.mouse.move(target.width / 2, target.height / 2);
      await page.mouse.wheel(0, target.height * 1.15);
      await page.waitForFunction(() =>
        (document.querySelector(".image-viewer")?.scrollTop ?? 0) > innerHeight * 0.5
      );
      await page.waitForTimeout(320);
      await page.screenshot({ path: "/tmp/pixhelf-viewer-details-desktop.png" });
      Object.assign(viewer, await page.evaluate(() => {
        const overlay = document.querySelector(".image-viewer");
        const stage = document.querySelector(".viewer-stage")?.getBoundingClientRect();
        const details = document.querySelector(".viewer-details-page");
        const detailsRect = details?.getBoundingClientRect();
        return {
          detailsReachedByWheel: (overlay?.scrollTop ?? 0) > innerHeight * 0.5,
          pageAfterDetails: overlay?.getAttribute("data-page") ?? "",
          detailsName: details?.getAttribute("data-details-image-name") ?? "",
          detailsLabel: details?.getAttribute("aria-label") ?? "",
          stageScrolledAway: stage ? stage.top < -innerHeight * 0.5 : false,
          detailsVisible: detailsRect
            ? detailsRect.top < innerHeight * 0.5 && detailsRect.bottom > innerHeight * 0.5
            : false,
          drawerArtifactsAfterScroll: document.querySelectorAll(
            ".viewer-details-sheet, .viewer-details-scrim",
          ).length,
        };
      }));
      await revealSimilarToolbar(page);
      await page.locator(".viewer-details-return").click();
      await page.waitForFunction(() =>
        (document.querySelector(".image-viewer")?.scrollTop ?? 1) < 1
      );
      viewer.returnedToImage = true;
      await page.mouse.wheel(0, -target.height);
      await page.waitForTimeout(80);
      Object.assign(viewer, await page.locator(".image-viewer").evaluate((overlay) => ({
        pageAfterReturn: overlay.dataset.page ?? "",
        returnFocusOnViewer: document.activeElement === overlay,
        returnWheelHandoffLocked:
          overlay.scrollTop < 1 && overlay.getAttribute("data-zoomed") === "false",
      })));
    }
    if (target.name === "mobile") {
      const cdp = await page.context().newCDPSession(page);
      const dispatchTouch = (type, touchPoints) => cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: touchPoints.map((point) => ({
          ...point,
          radiusX: 2,
          radiusY: 2,
          force: 1,
        })),
      });

      await page.waitForFunction(() =>
        document.querySelector(".image-viewer")?.getAttribute("data-zoomed") === "false"
      );
      await dispatchTouch("touchStart", [
        { id: 11, x: 145, y: 420 },
        { id: 12, x: 245, y: 420 },
      ]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchMove", [
        { id: 11, x: 95, y: 420 },
        { id: 12, x: 295, y: 420 },
      ]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchEnd", []);
      await page.waitForFunction(() =>
        document.querySelector(".image-viewer")?.getAttribute("data-zoomed") === "true"
      );
      viewer.pinchZoomed = true;
      await page.waitForFunction(() => {
        const overlay = document.querySelector(".image-viewer");
        const original = document.querySelector(".viewer-native-original");
        return overlay?.getAttribute("data-native-original-active") === "true"
          && overlay.getAttribute("data-display-source") === "original"
          && original
          && Number.parseFloat(getComputedStyle(original).opacity) >= .99;
      }, undefined, { timeout: 60_000 });
      await page.waitForTimeout(40);
      viewer.pinchScale = await page.locator(".viewer-media").evaluate((media) =>
        new DOMMatrix(getComputedStyle(media).transform).a
      );
      viewer.pinchNativeOriginal = await page.evaluate(() => {
        const overlay = document.querySelector(".image-viewer");
        const media = document.querySelector(".viewer-media");
        const original = document.querySelector(".viewer-native-original");
        return {
          active: overlay?.getAttribute("data-native-original-active") ?? "false",
          displaySource: overlay?.getAttribute("data-display-source") ?? "",
          visible: original ? Number.parseFloat(getComputedStyle(original).opacity) : 0,
          settledWillChange: media ? getComputedStyle(media).willChange : "",
        };
      });
      await page.screenshot({ path: "/tmp/pixhelf-viewer-zoom-mobile.png" });

      await page.touchscreen.tap(195, 420);
      await page.waitForTimeout(70);
      await page.touchscreen.tap(195, 420);
      await page.waitForFunction(() =>
        document.querySelector(".image-viewer")?.getAttribute("data-zoomed") === "false"
      );
      viewer.doubleTapReset = true;
      await page.waitForTimeout(260);
      viewer.doubleTapScale = await page.locator(".viewer-media").evaluate((media) =>
        new DOMMatrix(getComputedStyle(media).transform).a
      );
      viewer.nativeOriginalAfterReset = await page.evaluate(() => {
        const overlay = document.querySelector(".image-viewer");
        const media = document.querySelector(".viewer-media");
        const original = document.querySelector(".viewer-native-original");
        return {
          active: overlay?.getAttribute("data-native-original-active") ?? "false",
          displaySource: overlay?.getAttribute("data-display-source") ?? "",
          visible: original ? Number.parseFloat(getComputedStyle(original).opacity) : 0,
          settledWillChange: media ? getComputedStyle(media).willChange : "",
        };
      });

      const titleBeforeSwipe = await page.locator(".image-viewer").getAttribute("data-image-name");
      await dispatchTouch("touchStart", [{ id: 31, x: 320, y: 420 }]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchMove", [{ id: 31, x: 90, y: 420 }]);
      await page.waitForTimeout(32);
      viewer.swipeDragTracking = await page.locator(".viewer-media").evaluate((media) =>
        new DOMMatrix(getComputedStyle(media).transform).e
      );
      viewer.swipeDragWillChange = await page.locator(".viewer-media").evaluate((media) =>
        getComputedStyle(media).willChange
      );
      await dispatchTouch("touchEnd", []);
      viewer.swipeMotion = await page.evaluate(() => {
        const overlay = document.querySelector(".image-viewer");
        const media = document.querySelector(".viewer-media");
        const outgoing = document.querySelector(".viewer-swipe-outgoing");
        return {
          mode: overlay?.getAttribute("data-mobile-swipe-motion") ?? "",
          direction: overlay?.getAttribute("data-swipe-direction") ?? "",
          snapshot: overlay?.getAttribute("data-swipe-snapshot") ?? "",
          releaseCostMs: Number.parseFloat(
            overlay?.getAttribute("data-swipe-release-cost-ms") ?? "Infinity",
          ),
          incomingAnimations: media?.getAnimations().length ?? 0,
          outgoingAnimations: outgoing?.getAnimations().length ?? 0,
          outgoingIgnoresInput: outgoing
            ? getComputedStyle(outgoing).pointerEvents === "none"
            : false,
        };
      });
      await page.waitForFunction((title) =>
        document.querySelector(".image-viewer")?.getAttribute("data-image-name") !== title
      , titleBeforeSwipe);
      viewer.swipeNavigation = await page.locator(".image-viewer").getAttribute("data-image-name");
      await page.waitForFunction(() =>
        !document.querySelector(".viewer-swipe-outgoing")
          && !document.querySelector(".image-viewer")?.hasAttribute("data-swipe-direction")
      );
      viewer.swipeMotionCleaned = true;

      const shortSwipeStartName = await page.locator(".image-viewer")
        .getAttribute("data-image-name");
      await dispatchTouch("touchStart", [{ id: 32, x: 240, y: 420 }]);
      await page.waitForTimeout(100);
      await dispatchTouch("touchMove", [{ id: 32, x: 200, y: 420 }]);
      await page.waitForTimeout(100);
      await dispatchTouch("touchEnd", []);
      await page.waitForFunction((title) =>
        document.querySelector(".image-viewer")?.getAttribute("data-image-name") !== title
      , shortSwipeStartName);
      const shortSwipeEndName = await page.locator(".image-viewer")
        .getAttribute("data-image-name");
      viewer.shortSwipeNavigation = {
        distance: 40,
        changed: shortSwipeEndName !== shortSwipeStartName,
        imageName: shortSwipeEndName,
      };
      await page.waitForFunction(() =>
        !document.querySelector(".viewer-swipe-outgoing")
          && !document.querySelector(".image-viewer")?.hasAttribute("data-swipe-direction")
      );

      await dispatchTouch("touchStart", [{ id: 35, x: 195, y: 500 }]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchMove", [{ id: 35, x: 195, y: 350 }]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchMove", [{ id: 35, x: 195, y: 630 }]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchEnd", []);
      await page.waitForFunction(() =>
        (document.querySelector(".image-viewer")?.scrollTop ?? 1) < 1
      );
      viewer.reversedPageGestureStayedOpen = await page.locator(".image-viewer").evaluate(
        (overlay) => overlay.isConnected && overlay.dataset.page === "image",
      );

      const readViewerScroll = () => page.locator(".image-viewer").evaluate((overlay) => overlay.scrollTop);
      const returnToImage = async () => {
        await page.keyboard.press("PageUp");
        await page.waitForFunction(() => document.querySelector(".image-viewer")?.scrollTop < 1);
      };
      viewer.freeScrollStops = [];
      for (const [distance, endEvent] of [[60, "touchEnd"], [240, "touchEnd"], [240, "touchCancel"]]) {
        await dispatchTouch("touchStart", [{ id: 37, x: 195, y: 640 }]);
        await page.waitForTimeout(32);
        await dispatchTouch("touchMove", [{ id: 37, x: 195, y: 640 - distance }]);
        await page.waitForTimeout(180);
        const beforeRelease = await readViewerScroll();
        await dispatchTouch(endEvent, []);
        await page.waitForTimeout(420);
        const afterRelease = await readViewerScroll();
        const result = { distance, endEvent, beforeRelease, afterRelease };
        viewer.freeScrollStops.push(result);
        if (
          beforeRelease < distance * 0.6 || beforeRelease > distance + 2
          || Math.abs(afterRelease - beforeRelease) > 2
        ) {
          throw new Error(`viewer snapped after a paused drag: ${JSON.stringify(result)}`);
        }
        if (endEvent === "touchCancel") {
          await dispatchTouch("touchStart", [{ id: 38, x: 145, y: 200 }, { id: 39, x: 245, y: 200 }]);
          await page.waitForTimeout(32);
          await dispatchTouch("touchMove", [{ id: 38, x: 120, y: 200 }, { id: 39, x: 270, y: 200 }]);
          await dispatchTouch("touchEnd", []);
          await page.waitForTimeout(420);
          if (Math.abs(await readViewerScroll() - afterRelease) > 2) {
            throw new Error("viewer snapped after a pinch between the image and details");
          }
        }
        await returnToImage();
      }

      await dispatchTouch("touchStart", [{ id: 36, x: 195, y: 690 }]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchMove", [{ id: 36, x: 195, y: 510 }]);
      await page.waitForTimeout(32);
      viewer.detailsFollowedTouch = await page.locator(".image-viewer").evaluate((overlay) =>
        overlay.scrollTop > 100 &&
          overlay.scrollTop < overlay.clientHeight * 0.5 &&
          overlay.dataset.page === "transition"
      );
      const titleDuringPageGesture = await page.locator(".image-viewer")
        .getAttribute("data-image-name");
      await dispatchTouch("touchMove", [{ id: 36, x: 60, y: 510 }]);
      await page.waitForTimeout(32);
      viewer.pageGestureIgnoredHorizontal =
        await page.locator(".image-viewer").getAttribute("data-image-name")
          === titleDuringPageGesture;
      await dispatchTouch("touchMove", [{ id: 36, x: 195, y: 130 }]);
      await page.waitForTimeout(180);
      await dispatchTouch("touchEnd", []);
      await page.waitForFunction(() =>
        (document.querySelector(".image-viewer")?.scrollTop ?? 0) > innerHeight * 0.5
      );
      await page.waitForTimeout(320);
      await page.screenshot({ path: "/tmp/pixhelf-viewer-details-mobile.png" });
      Object.assign(viewer, await page.evaluate(() => {
        const overlay = document.querySelector(".image-viewer");
        const stage = document.querySelector(".viewer-stage")?.getBoundingClientRect();
        const details = document.querySelector(".viewer-details-page");
        const detailsRect = details?.getBoundingClientRect();
        return {
          detailsReachedBySwipe: (overlay?.scrollTop ?? 0) > innerHeight * 0.5,
          pageAfterDetails: overlay?.getAttribute("data-page") ?? "",
          detailsName: details?.getAttribute("data-details-image-name") ?? "",
          detailsLabel: details?.getAttribute("aria-label") ?? "",
          stageScrolledAway: stage ? stage.top < -innerHeight * 0.5 : false,
          detailsVisible: detailsRect
            ? detailsRect.top < innerHeight * 0.5 && detailsRect.bottom > innerHeight * 0.5
            : false,
          drawerArtifactsAfterScroll: document.querySelectorAll(
            ".viewer-details-sheet, .viewer-details-scrim",
          ).length,
        };
      }));
      await revealSimilarToolbar(page);
      await page.locator(".viewer-details-return").click();
      await page.waitForFunction(() =>
        (document.querySelector(".image-viewer")?.scrollTop ?? 1) < 1
      );
      viewer.returnedToImage = true;
      Object.assign(viewer, await page.locator(".image-viewer").evaluate((overlay) => ({
        pageAfterReturn: overlay.dataset.page ?? "",
        returnFocusOnViewer: document.activeElement === overlay,
      })));

      await dispatchTouch("touchStart", [{ id: 41, x: 195, y: 210 }]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchMove", [{ id: 41, x: 195, y: 510 }]);
      await page.waitForTimeout(32);
      await dispatchTouch("touchEnd", []);
      viewer.closedByGesture = true;
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForSelector(".viewer-return-layer", { timeout: 5_000 });
    viewer.returnAnimationCreated = await page.locator(".viewer-return-layer").evaluate((layer) => ({
      imageId: layer.getAttribute("data-image-id") ?? "",
      phase: layer.getAttribute("data-phase") ?? "",
      mediaCount: layer.querySelectorAll(".viewer-return-media").length,
      canvasHasPixels: [...layer.querySelectorAll("canvas")]
        .every((canvas) => canvas.width > 0 && canvas.height > 0),
      maxCanvasEdge: Math.max(0, ...[...layer.querySelectorAll("canvas")]
        .flatMap((canvas) => [canvas.width, canvas.height])),
      visualReady: [...layer.querySelectorAll(".viewer-return-visual")]
        .some((visual) => visual.complete && visual.naturalWidth > 0),
    }));
    await page.waitForSelector(".image-viewer", { state: "detached" });
    await page.waitForFunction(() =>
      document.querySelector(".viewer-return-layer")?.getAttribute("data-phase") === "flying"
    , undefined, { timeout: 5_000 });
    viewer.returnAnimationFlying = await page.locator(".viewer-return-layer").evaluate((layer) => {
      const media = layer.querySelector(".viewer-return-media");
      const target = document.querySelector('[data-viewer-return-target="true"]');
      const animation = media?.getAnimations()[0];
      const keyframes = animation?.effect instanceof KeyframeEffect
        ? animation.effect.getKeyframes()
        : [];
      const animatedProperties = [...new Set(keyframes.flatMap((keyframe) =>
        Object.keys(keyframe).filter((property) =>
          !["offset", "computedOffset", "easing", "composite"].includes(property)
        )
      ))].sort();
      return {
        animations: media?.getAnimations().length ?? 0,
        targetId: target?.getAttribute("data-image-id") ?? "",
        startLatency: Number(layer.getAttribute("data-flying-at") ?? 0)
          - Number(layer.getAttribute("data-created-at") ?? 0),
        duration: Number(layer.getAttribute("data-duration") ?? 0),
        animatedProperties,
      };
    });
    const animationViewport = page.viewportSize();
    if (animationViewport) {
      await page.setViewportSize({
        width: animationViewport.width + (target.name === "desktop" ? -18 : 10),
        height: animationViewport.height,
      });
      await page.waitForFunction(() =>
        Number(document.querySelector(".viewer-return-layer")?.getAttribute("data-retargets") ?? 0) > 0
      );
      await page.waitForFunction(() =>
        document.querySelector(".viewer-return-layer")?.getAttribute("data-phase") === "flying"
      );
      viewer.returnAnimationRetargeted = await page.locator(".viewer-return-layer").evaluate(
        (layer) => ({
          count: Number(layer.getAttribute("data-retargets") ?? 0),
          animations: layer.querySelector(".viewer-return-media")?.getAnimations().length ?? 0,
        }),
      );
    }
    await page.waitForTimeout(90);
    await page.screenshot({ path: `/tmp/pixhelf-viewer-return-${target.name}.png` });
    viewer.closed = await page.locator(".image-viewer").count();
    viewer.rootRestored = await page.locator("#root").evaluate((root) => !root.inert);
    await page.waitForFunction(() =>
      document.querySelector(".app-shell")?.getAttribute("data-viewer-returning") === "false"
    );
    viewer.returnAnchorSettled = true;
    viewer.returnAnimationCleared = await page.locator(".viewer-return-layer").count() === 0;
    if (
      viewer.returnAnimationCreated.mediaCount !== 1 ||
      !viewer.returnAnimationCreated.canvasHasPixels ||
      viewer.returnAnimationCreated.maxCanvasEdge > 1_440 ||
      !viewer.returnAnimationCreated.visualReady ||
      viewer.returnAnimationFlying.animations < 1 ||
      viewer.returnAnimationFlying.targetId !== viewer.returnAnimationCreated.imageId ||
      viewer.returnAnimationFlying.startLatency > 180 ||
      viewer.returnAnimationFlying.duration > 280 ||
      viewer.returnAnimationFlying.animatedProperties.join(",") !== "transform" ||
      viewer.returnAnimationRetargeted?.count < 1 ||
      viewer.returnAnimationRetargeted?.animations < 1 ||
      !viewer.returnAnimationCleared
    ) {
      throw new Error(`viewer return animation failed: ${JSON.stringify({
        created: viewer.returnAnimationCreated,
        flying: viewer.returnAnimationFlying,
        cleared: viewer.returnAnimationCleared,
      })}`);
    }

    const returnProbeStart = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".justified-gallery .image-card")];
      const card = cards.at(-1);
      if (!(card instanceof HTMLElement)) return null;
      card.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = card.getBoundingClientRect();
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportHeight = visualViewport?.height ?? innerHeight;
      const viewportBottom = viewportTop + viewportHeight;
      const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
        ?? viewportTop;
      const visibleTop = Math.max(rect.top, viewportTop, topbarBottom);
      const visibleBottom = Math.min(rect.bottom, viewportBottom);
      const anchorY = visibleBottom > visibleTop
        ? (visibleTop + visibleBottom) / 2
        : Math.min(viewportBottom, Math.max(viewportTop, rect.top + rect.height / 2));
      const result = {
        imageId: card.dataset.imageId ?? "",
        beforeCount: cards.length,
        beforeGalleryWidth: document.querySelector(".justified-gallery")?.getBoundingClientRect().width ?? 0,
        cardRatio: rect.height > 0 ? (anchorY - rect.top) / rect.height : 0.5,
        viewportRatio: (anchorY - viewportTop) / Math.max(1, viewportHeight),
      };
      card.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: rect.left + rect.width / 2,
        clientY: anchorY,
        view: window,
      }));
      return result;
    });
    if (!returnProbeStart) throw new Error("viewer return probe could not find a card");
    await page.waitForSelector(".image-viewer");
    const returnViewerStartId = await page.locator(".image-viewer").getAttribute("data-image-id");
    await page.keyboard.press("ArrowRight");
    const resizedWidth = target.name === "desktop" ? 920 : 430;
    await page.setViewportSize({ width: resizedWidth, height: target.height });
    await page.waitForFunction((previousWidth) => {
      const width = document.querySelector(".justified-gallery")?.getBoundingClientRect().width ?? 0;
      return Math.abs(width - previousWidth) > 20;
    }, returnProbeStart.beforeGalleryWidth);
    await page.waitForFunction(([startId, beforeCount]) =>
      document.querySelector(".image-viewer")?.getAttribute("data-image-id") !== startId &&
      document.querySelectorAll(".justified-gallery .image-card").length > beforeCount
    , [returnViewerStartId, returnProbeStart.beforeCount], { timeout: 60_000 });
    const returnTargetId = await page.locator(".image-viewer").getAttribute("data-image-id");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".image-viewer", { state: "detached" });
    await page.waitForFunction((imageId) => {
      const shell = document.querySelector(".app-shell");
      const active = document.activeElement;
      return shell?.getAttribute("data-viewer-returning") === "false" &&
        active instanceof HTMLElement && active.dataset.imageId === imageId;
    }, returnTargetId);
    const returnRestoration = await page.evaluate(({ start, targetId }) => {
      const card = document.querySelector(
        `.justified-gallery .image-card[data-image-id="${CSS.escape(targetId)}"]`,
      );
      if (!(card instanceof HTMLElement)) return null;
      const rect = card.getBoundingClientRect();
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportHeight = visualViewport?.height ?? innerHeight;
      const viewportBottom = viewportTop + viewportHeight;
      const topbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom
        ?? viewportTop;
      const safeTop = Math.min(viewportBottom, Math.max(viewportTop, topbarBottom + 8));
      const safeBottom = Math.max(safeTop, viewportBottom - 8);
      const expectedAnchorY = Math.min(
        safeBottom,
        Math.max(safeTop, viewportTop + start.viewportRatio * viewportHeight),
      );
      const actualAnchorY = rect.top + rect.height * start.cardRatio;
      return {
        openedId: start.imageId,
        targetId,
        cardsBefore: start.beforeCount,
        cardsAfter: document.querySelectorAll(".justified-gallery .image-card").length,
        currentId: document.activeElement?.getAttribute("data-image-id") ?? "",
        visible: rect.bottom > topbarBottom && rect.top < viewportBottom,
        anchorDelta: Math.abs(actualAnchorY - expectedAnchorY),
        returning: document.querySelector(".app-shell")
          ?.getAttribute("data-viewer-returning"),
      };
    }, { start: returnProbeStart, targetId: returnTargetId });
    if (
      !returnRestoration ||
      returnRestoration.openedId === returnRestoration.targetId ||
      returnRestoration.targetId !== returnRestoration.currentId ||
      returnRestoration.cardsAfter <= returnRestoration.cardsBefore ||
      !returnRestoration.visible ||
      returnRestoration.anchorDelta > 2 ||
      returnRestoration.returning !== "false"
    ) {
      throw new Error(`viewer return restoration failed: ${JSON.stringify(returnRestoration)}`);
    }
    if (viewerReturnOnly) {
      const result = {
        name: target.name,
        resizeStability,
        sideButtonNavigation: viewer.sideButtonNavigation,
        switchPerformance: viewer.switchPerformance,
        rapidSwitch: viewer.rapidSwitch,
        returnAnimation: {
          created: viewer.returnAnimationCreated,
          flying: viewer.returnAnimationFlying,
          retargeted: viewer.returnAnimationRetargeted,
          cleared: viewer.returnAnimationCleared,
        },
        returnRestoration,
        browserErrors,
      };
      if (browserErrors.length) {
        throw new Error(`viewer return browser errors: ${JSON.stringify(browserErrors)}`);
      }
      results.push(result);
      console.log(JSON.stringify(result));
      await page.close();
      continue;
    }
    await page.setViewportSize({ width: target.width, height: target.height });
    await page.waitForTimeout(120);
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));

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
    await page.locator(".topbar .explore-toggle").click();
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
    await page.locator(".topbar .explore-toggle").click();
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

    const fromExplore = await checkHomeNavigation(page, target, ".topbar-home");
    await page.waitForFunction(() =>
      document.querySelector(".explore-toggle")?.getAttribute("aria-pressed") === "false" &&
      document.querySelector(".desktop-sidebar .album-link")?.classList.contains("active") &&
      document.querySelector("#gallery-search-field input")?.value === ""
    , undefined, { timeout: 60_000 });
    const homeNavigation = await page.evaluate(() => ({
      allImagesActive: document.querySelector(".desktop-sidebar .album-link")
        ?.classList.contains("active") ?? false,
      searchValue: document.querySelector("#gallery-search-field input")?.value,
    }));
    homeNavigation.fromExplore = fromExplore;
    homeNavigation.repeatedAtHome = [];
    for (const selector of [".brand-mark", ".brand-name", ".topbar-home", ".topbar-home"]) {
      homeNavigation.repeatedAtHome.push(await checkHomeNavigation(page, target, selector));
    }

    let mobileCardActions = null;
    if (target.name === "mobile") {
      const firstCard = page.locator(".image-card").first();
      const secondCard = page.locator(".image-card").nth(1);
      const more = firstCard.locator(".photo-card-more");
      const hiddenInitially = !await more.isVisible();
      await firstCard.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 });
      await page.locator(".photo-card-menu:popover-open").waitFor({ timeout: 2000 });
      await firstCard.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "touch", isPrimary: true, buttons: 0 });
      await firstCard.dispatchEvent("click", { detail: 1, pointerType: "touch" });
      const moreVisible = await more.isVisible();
      if (moreVisible) throw new Error("Mobile cards must not show a more button");
      await page.locator(".photo-card-menu:popover-open").waitFor();
      const viewerAfterMenu = await page.locator(".image-viewer").count();
      const menuItemCount = await page.getByRole("menuitem").count();
      await page.keyboard.press("Escape");
      await page.locator(".photo-card-menu").waitFor({ state: "detached" });
      const focusReturned = await firstCard.locator(".photo-card-open").evaluate(button => document.activeElement === button);
      await secondCard.evaluate((card) => {
        globalThis.__pixhelfCardClickCount = 0;
        card.addEventListener("click", () => {
          globalThis.__pixhelfCardClickCount += 1;
        }, { once: true });
      });
      await secondCard.locator(".photo-card-open").tap();
      await page.waitForSelector(".image-viewer");
      const clickCount = await page.evaluate(() => globalThis.__pixhelfCardClickCount ?? 0);
      const viewerOpenedFromTouch = await page.locator(".image-viewer").count();
      await page.locator(".viewer-close").click();
      await page.waitForSelector(".image-viewer", { state: "detached" });
      mobileCardActions = { hiddenInitially, moreVisible, viewerAfterMenu, menuItemCount, focusReturned, clickCount, viewerOpenedFromTouch };
    }

    let desktopSidebar = null;
    let mobileNavigation = null;
    if (target.name === "desktop") {
      const contentBefore = await page.locator(".content").boundingBox();
      const toggleBefore = await page.locator(".gallery-sidebar-toggle").boundingBox();
      const firstAlbumBefore = await page.locator(".desktop-sidebar .album-link").first()
        .boundingBox();
      const topbarBefore = await page.locator(".topbar").boundingBox();
      const galleryBefore = await page.locator(".justified-gallery").boundingBox();
      const collapseMotion = await closeNavigation(page);
      await page.waitForFunction(() =>
        document.querySelector(".app-shell")?.getAttribute("data-sidebar-collapsed") === "true"
      );
      await page.waitForTimeout(260);
      const contentCollapsed = await page.locator(".content").boundingBox();
      const toggleCollapsed = await page.locator(".gallery-sidebar-toggle").boundingBox();
      const sidebarCollapsedBox = await page.locator(".desktop-sidebar").boundingBox();
      const galleryCollapsed = await page.locator(".justified-gallery").boundingBox();
      desktopSidebar = await page.evaluate(() => ({
        expanded: document.querySelector(".gallery-sidebar-toggle")?.getAttribute("aria-expanded"),
        visibility: getComputedStyle(document.querySelector(".desktop-sidebar")).visibility,
        navigationVisibility: getComputedStyle(
          document.querySelector(".desktop-sidebar .album-nav"),
        ).visibility,
        footerVisibility: [...document.querySelectorAll(".desktop-sidebar .sidebar-footer")]
          .map(element => getComputedStyle(element).visibility),
        ariaHidden: document.querySelector(".desktop-sidebar")?.getAttribute("aria-hidden"),
        stored: localStorage.getItem("pixhelf.sidebar-collapsed"),
        galleryLayout: document.querySelector(".justified-gallery")?.dataset.layout,
        redundantHeadings: document.querySelectorAll(".sidebar-heading").length,
        pathDetails: document.querySelectorAll(".album-copy small").length,
        progressPanels: document.querySelectorAll(".sidebar-progress").length,
        inlineToggles: document.querySelectorAll(".desktop-sidebar-inline-toggle").length,
        galleryToggles: document.querySelectorAll(".gallery-sidebar-toggle").length,
        topbarSurfaceLeft: document.querySelector(".topbar-surface")?.getBoundingClientRect().left ?? -1,
        brandVisibility: getComputedStyle(document.querySelector(".desktop-sidebar .brand-lockup")).visibility,
        brandInert: Boolean(document.querySelector(".desktop-sidebar .brand")?.closest("[inert]")),
      }));
      desktopSidebar.collapseMotion = collapseMotion;
      desktopSidebar.contentBefore = contentBefore?.x ?? -1;
      desktopSidebar.contentCollapsed = contentCollapsed?.x ?? -1;
      desktopSidebar.expandedToggleWidth = toggleBefore?.width ?? -1;
      desktopSidebar.expandedToggleHeight = toggleBefore?.height ?? -1;
      desktopSidebar.collapsedToggleWidth = toggleCollapsed?.width ?? -1;
      desktopSidebar.collapsedToggleHeight = toggleCollapsed?.height ?? -1;
      desktopSidebar.albumClearance = topbarBefore && firstAlbumBefore
        ? firstAlbumBefore.y - (topbarBefore.y + topbarBefore.height)
        : -1;
      desktopSidebar.toggleHeaderInsetX = toggleBefore && topbarBefore
        ? toggleBefore.x - topbarBefore.x
        : -1;
      desktopSidebar.toggleHeaderInsetY = toggleBefore && topbarBefore
        ? toggleBefore.y - topbarBefore.y
        : -1;
      desktopSidebar.stationaryToggleDelta = toggleBefore && toggleCollapsed
        ? Math.hypot(toggleBefore.x - toggleCollapsed.x, toggleBefore.y - toggleCollapsed.y)
        : -1;
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
      desktopSidebar.restoredBrandRight = await page.locator(".desktop-sidebar .brand-lockup")
        .evaluate((brand) => brand.getBoundingClientRect().right);
    } else {
      await page.evaluate(() => window.scrollTo({ top: 320, behavior: "auto" }));
      await page.waitForTimeout(100);
      const fixedTop = await page.locator(".topbar").boundingBox();
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
      const navigationToggleBefore = await page.locator(".gallery-sidebar-toggle").boundingBox();
      const galleryBefore = await page.locator(".justified-gallery").boundingBox();
      await page.locator(".gallery-sidebar-toggle").click();
      await page.waitForSelector(".mobile-nav-layer");
      await page.waitForTimeout(240);
      const navigationToggleOpen = await page.locator(".gallery-sidebar-toggle").boundingBox();
      const navigationLayer = await page.locator(".mobile-nav-layer").boundingBox();
      const navigationDrawer = await page.locator(".mobile-sidebar").boundingBox();
      const firstAlbum = await page.locator(".mobile-sidebar .album-link").first().boundingBox();
      const footer = page.locator(".mobile-sidebar .sidebar-footer");
      const mobileFooter = await footer.count() ? await footer.boundingBox() : null;
      const topbar = await page.locator(".topbar").boundingBox();
      mobileNavigation = {
        opened: await page.locator(".mobile-nav-layer").count(),
        brandVisible: await page.locator(".mobile-sidebar .brand").isVisible(),
        fixedTop: fixedTop?.y ?? -1,
        expanded: await page.locator(".gallery-sidebar-toggle").getAttribute("aria-expanded"),
        internalToggles: await page.locator(".mobile-sidebar .sidebar-toggle-button").count(),
        metaRows: await page.locator(".mobile-sidebar .sidebar-gallery-meta").count(),
        layerTopGap: navigationLayer && topbar
          ? navigationLayer.y - topbar.y
          : -1,
        topbarSurfaceLeft: await page.locator(".topbar-surface").evaluate((surface) =>
          surface.getBoundingClientRect().left),
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
        toggleHeaderInsetX: navigationToggleOpen && topbar
          ? navigationToggleOpen.x - topbar.x
          : -1,
        toggleHeaderInsetY: navigationToggleOpen && topbar
          ? navigationToggleOpen.y - topbar.y
          : -1,
        albumClearance: firstAlbum && topbar
          ? firstAlbum.y - (topbar.y + topbar.height)
          : -1,
        footerBottomGap: mobileFooter ? target.height - (mobileFooter.y + mobileFooter.height) : null,
        drawerWidth: navigationDrawer?.width ?? -1,
      };
      mobileNavigation.narrowLayouts = [];
      for (const width of [320, 360, 375, target.width]) {
        await page.setViewportSize({ width, height: target.height });
        await page.waitForFunction(() => {
          const drawer = document.querySelector(".mobile-sidebar").getBoundingClientRect();
          // The gallery's ResizeObserver commits on the next animation frame.
          return Math.abs(drawer.left) < 1 && document.documentElement.scrollWidth <= innerWidth;
        });
        const dimensions = await page.evaluate(() => {
          const drawer = document.querySelector(".mobile-sidebar").getBoundingClientRect();
          const tools = document.querySelector(".topbar-actions").getBoundingClientRect();
          const brand = document.querySelector(".mobile-sidebar .brand-lockup").getBoundingClientRect();
          return {
            width: innerWidth,
            drawerWidth: drawer.width,
            toolsClearance: tools.left - drawer.right,
            brandClearance: drawer.right - brand.right,
            toolsClickable: [...document.querySelectorAll(".topbar-actions button")].filter((button) => {
              const rect = button.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && !button.closest("[inert]");
            }).every((button) => {
              const rect = button.getBoundingClientRect();
              return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
            }),
            brandClickable: [...document.querySelectorAll(".mobile-sidebar .brand-mark, .mobile-sidebar .brand-name, .mobile-sidebar .brand-version")].every((element) => {
              const link = element.closest("a");
              const rect = element.getBoundingClientRect();
              return link.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
            }),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        mobileNavigation.narrowLayouts.push(dimensions);
        if (
          dimensions.toolsClearance < 5 || dimensions.brandClearance < 8
          || !dimensions.toolsClickable || !dimensions.brandClickable
          || dimensions.overflow
        ) {
          throw new Error(`mobile drawer overlaps the header: ${JSON.stringify(dimensions)}`);
        }
        await page.screenshot({ path: `/tmp/pixhelf-drawer-${width}.png` });
      }
      mobileNavigation.collapseMotion = await closeNavigation(page);
      await page.waitForSelector(".mobile-nav-layer", { state: "detached" });
      mobileNavigation.closed = await page.locator(".mobile-nav-layer").count();
      mobileNavigation.restored = await page.locator(".gallery-sidebar-toggle")
        .getAttribute("aria-expanded");
      mobileNavigation.closedBrandVisible = await page.locator(".desktop-sidebar .brand").isVisible();
    }

    const result = {
      name: target.name,
      ...layout,
      resizeStability,
      dialogsAfterImageClick,
      viewer,
      returnRestoration,
      searchDisclosure,
      exploration,
      homeNavigation,
      mobileCardActions,
      desktopSidebar,
      mobileNavigation,
      browserErrors,
    };
    results.push(result);
    console.log(JSON.stringify(result));

    if (
      layout.horizontalOverflow ||
      layout.brokenVisibleImages ||
      layout.galleryLayout !== "justified" ||
      layout.galleryRows < 1 ||
      layout.cardTags.some((tag) => tag !== "FIGURE") ||
      layout.dialogs !== 0 ||
      dialogsAfterImageClick !== 1 ||
      viewer.title !== firstViewerTitle ||
      viewer.fullLoaded !== "true" ||
      !viewer.originalPath.endsWith("/original") ||
      !["native", "safe-canvas", "viewport-bitmap"].includes(viewer.renderer) ||
      viewer.sourceStrategy !== (
        target.name === "mobile" ? "viewport-upgrade" : "direct-original"
      ) ||
      viewer.thumbnailFilter !== "none" ||
      viewer.thumbnailTransform !== "none" ||
      (viewer.sourcePresentation === "upgrade" && (
        Number.parseFloat(viewer.thumbnailTransitionDelay) < .15 ||
        Number.parseFloat(viewer.originalTransitionDuration) < .15
      )) ||
      viewer.renderedPixels.some((size) => size <= 0) ||
      (viewer.renderer === "safe-canvas" && viewer.renderedPixels.some((size) => size > 4096)) ||
      (viewer.renderer === "viewport-bitmap" && viewer.renderedPixels.some((size) => size > 2048)) ||
      (target.name === "mobile" && viewer.renderer !== "viewport-bitmap") ||
      viewer.prefetchedOriginals < 2 ||
      viewer.previewRequests !== 0 ||
      viewer.fullscreenButtons !== 1 ||
      viewer.detailsPages !== 1 ||
      viewer.detailsToolbars !== 1 ||
      viewer.detailsToolbarControls !== 5 ||
      !viewer.detailsToolbarUnified ||
      viewer.detailsInlineActions !== 0 ||
      viewer.scrollCues !== 0 ||
      viewer.headingModules !== 0 ||
      !viewer.unifiedControls ||
      viewer.zoomControls !== 0 ||
      viewer.drawerArtifacts !== 0 ||
      viewer.scrollMode !== "continuous" ||
      !viewer.continuousLayout ||
      viewer.gestureHelp !== 0 ||
      viewer.loadingStatus !== 0 ||
      viewer.loadingCopyVisible ||
      !viewer.fullscreenEntered ||
      viewer.fullscreenLabel !== "退出全屏" ||
      !viewer.fullscreenExited ||
      !viewer.rootInert ||
      !viewer.viewerFocused ||
      !viewer.returnFocusOnViewer ||
      !viewer.mediaContained ||
      viewer.zoomed !== "true" ||
      Math.abs(viewer.zoomScale - 1.5) > 0.02 ||
      !viewer.zoomKeptImagePage ||
      !viewer.zoomLockedPageScroll ||
      !viewer.keyboardNavigation ||
      viewer.keyboardNavigation === firstViewerTitle ||
      !viewer.keyboardFocus?.parkedOnViewer ||
      viewer.keyboardFocus.visibleControlFocusRings !== 0 ||
      !viewer.switchPerformance?.focusedOnViewer ||
      viewer.switchPerformance.visibleControlFocusRings !== 0 ||
      (target.name === "mobile"
        ? !["thumbnail", "viewport-bitmap"].includes(viewer.switchPerformance.firstFrameSource)
        : viewer.switchPerformance.firstFrameSource !== "original") ||
      viewer.switchPerformance.mediaAnimations !== 0 ||
      viewer.switchPerformance.dispatchDuration > 80 ||
      viewer.switchPerformance.firstFrameDuration > 100 ||
      !viewerChrome.navigationGlass ||
      viewerChrome.floatingToolbar?.mode !== "floating" ||
      !viewerChrome.floatingToolbar?.headerTransparent ||
      !viewerChrome.floatingToolbar?.actionsSurfaced ||
      (target.name === "desktop" && (
        !viewer.detailsReachedByWheel ||
        viewer.detailsName !== viewer.keyboardNavigation ||
        !viewer.zoomWheelHandoffLocked ||
        viewer.pageAfterDetails !== "details" ||
        viewer.detailsLabel !== "图片详情" ||
        !viewer.stageScrolledAway ||
        !viewer.detailsVisible ||
        viewer.drawerArtifactsAfterScroll !== 0 ||
        !viewer.returnedToImage ||
        viewer.pageAfterReturn !== "image" ||
        !viewer.returnWheelHandoffLocked
      )) ||
      (target.name === "mobile" && (
        viewer.nativeOriginalLoaded !== "false" ||
        viewer.nativeOriginalActive !== "false" ||
        viewer.nativeOriginalCount !== 0 ||
        viewer.nativeOriginalPath !== "" ||
        viewer.nativeOriginalVisible > .01 ||
        viewer.nativeOriginalPixels.some((size) => size !== 0) ||
        viewer.displaySource !== "viewport-bitmap" ||
        viewer.gestureRenderer !== "raf-dom" ||
        viewer.originalPolicy !== "zoom-only" ||
        viewer.mediaWillChange !== "auto" ||
        !viewer.pinchZoomed ||
        viewer.pinchScale < 1.5 ||
        viewer.pinchNativeOriginal?.active !== "true" ||
        viewer.pinchNativeOriginal.displaySource !== "original" ||
        viewer.pinchNativeOriginal.visible < .99 ||
        viewer.pinchNativeOriginal.settledWillChange !== "auto" ||
        !viewer.doubleTapReset ||
        Math.abs(viewer.doubleTapScale - 1) > 0.02 ||
        viewer.nativeOriginalAfterReset?.active !== "false" ||
        viewer.nativeOriginalAfterReset.displaySource !== "viewport-bitmap" ||
        viewer.nativeOriginalAfterReset.visible > .01 ||
        viewer.nativeOriginalAfterReset.settledWillChange !== "auto" ||
        !viewer.swipeNavigation ||
        viewer.swipeNavigation === viewer.keyboardNavigation ||
        !viewer.shortSwipeNavigation?.changed ||
        viewer.shortSwipeNavigation.distance !== 40 ||
        viewer.swipeDragTracking > -190 ||
        viewer.swipeDragTracking < -225 ||
        viewer.swipeDragWillChange !== "transform" ||
        viewer.swipeMotion?.mode !== "interruptible" ||
        viewer.swipeMotion.direction !== "next" ||
        viewer.swipeMotion.snapshot !== "prepared" ||
        viewer.swipeMotion.releaseCostMs > 12 ||
        viewer.swipeMotion.incomingAnimations < 1 ||
        viewer.swipeMotion.outgoingAnimations < 1 ||
        !viewer.swipeMotion.outgoingIgnoresInput ||
        !viewer.swipeMotionCleaned ||
        !viewer.reversedPageGestureStayedOpen ||
        !viewer.pageGestureIgnoredHorizontal ||
        !viewer.detailsFollowedTouch ||
        !viewer.detailsReachedBySwipe ||
        viewer.pageAfterDetails !== "transition" ||
        viewer.detailsName !== viewer.shortSwipeNavigation.imageName ||
        viewer.detailsLabel !== "图片详情" ||
        !viewer.stageScrolledAway ||
        !viewer.detailsVisible ||
        viewer.drawerArtifactsAfterScroll !== 0 ||
        !viewer.returnedToImage ||
        viewer.pageAfterReturn !== "image" ||
        !viewer.closedByGesture
      )) ||
      viewer.closed !== 0 ||
      !viewer.rootRestored ||
      !viewer.returnAnchorSettled ||
      !returnRestoration ||
      returnRestoration.openedId === returnRestoration.targetId ||
      returnRestoration.targetId !== returnRestoration.currentId ||
      returnRestoration.cardsAfter <= returnRestoration.cardsBefore ||
      !returnRestoration.visible ||
      returnRestoration.anchorDelta > 2 ||
      returnRestoration.returning !== "false" ||
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
      !homeNavigation.allImagesActive ||
      homeNavigation.searchValue !== "" ||
      layout.topbarSearches !== 1 ||
      Math.abs(layout.topbarHeight - (target.name === "mobile" ? 52 : 54)) > 1 ||
      layout.brandMarks !== 1 ||
      layout.brandHomeLinks !== 1 ||
      layout.brandText !== "Pixhelf" ||
      layout.brandTitle !== "主页" ||
      layout.brandLabel !== "主页" ||
      layout.brandName?.trim() !== "Pixhelf" ||
      layout.brandNameHref !== "/" ||
      layout.brandVersion !== `v${appVersion}` ||
      layout.brandVersionSize !== 11 ||
      layout.brandRepository !== "https://github.com/eureka6/Pixhelf" ||
      layout.sidebarBrands !== 1 ||
      layout.topbarBrands !== 0 ||
      layout.brandDisplayed !== (target.name === "desktop") ||
      layout.topbarHomeButtons !== 1 ||
      layout.leadingHomeButtons !== 0 ||
      layout.homeLabel !== "主页" ||
      layout.homeExploreGap < 4 ||
      layout.homeExploreGap > 8 ||
      layout.exploreSearchGap < 4 ||
      layout.exploreSearchGap > 8 ||
      !layout.homeStatic ||
      !layout.brandLoaded ||
      (target.name === "desktop" && (
        layout.brandMenuGap < 8 || layout.brandMenuGap > 12
      )) ||
      layout.sidebarControlSlots !== 0 ||
      layout.gallerySidebarToggles !== 1 ||
      layout.galleryToggleOpacity !== 1 ||
      layout.topbarSidebarToggles !== 1 ||
      layout.contentSearches !== 0 ||
      layout.contentInfoRows !== 0 ||
      layout.sortControls !== 0 ||
      layout.topbarSearchRightGap < 0 ||
      layout.topbarSearchRightGap > 20 ||
      layout.topbarExploreButtons !== 1 ||
      layout.sidebarExploreButtons !== 0 ||
      layout.sidebarStatuses !== 0 ||
      layout.sidebarGalleryMetas !== 0 ||
      (target.name === "desktop" && (
        !resizeStability ||
        !resizeStability.cardsPreserved ||
        !resizeStability.loadedCardsPreserved ||
        resizeStability.skeletonSeen ||
        resizeStability.imagePageRequests !== 0 ||
        resizeStability.brokenVisibleImages !== 0 ||
        resizeStability.galleryLayout !== "justified" ||
        !resizeStability.anchorFocused ||
        resizeStability.anchorDeltas.length !== 4 ||
        resizeStability.anchorDeltas.some((delta) => !Number.isFinite(delta) || delta > 2)
      )) ||
      (target.name === "desktop" && (
        !desktopSidebar ||
        desktopSidebar.expanded !== "false" ||
        desktopSidebar.brandVisibility !== "hidden" ||
        !desktopSidebar.brandInert ||
        desktopSidebar.restoredBrandRight <= 0 ||
        desktopSidebar.visibility !== "visible" ||
        desktopSidebar.navigationVisibility !== "hidden" ||
        desktopSidebar.footerVisibility.some(visibility => visibility !== "hidden") ||
        desktopSidebar.ariaHidden !== "true" ||
        desktopSidebar.stored !== "true" ||
        desktopSidebar.galleryLayout !== "justified" ||
        desktopSidebar.redundantHeadings !== 0 ||
        desktopSidebar.pathDetails !== 0 ||
        desktopSidebar.progressPanels !== 0 ||
        desktopSidebar.inlineToggles !== 0 ||
        desktopSidebar.galleryToggles !== 1 ||
        Math.abs(desktopSidebar.expandedToggleWidth - 40) > 1 ||
        Math.abs(desktopSidebar.expandedToggleHeight - 40) > 1 ||
        Math.abs(desktopSidebar.collapsedToggleWidth - 40) > 1 ||
        Math.abs(desktopSidebar.collapsedToggleHeight - 40) > 1 ||
        desktopSidebar.albumClearance < 8 ||
        desktopSidebar.albumClearance > 12 ||
        desktopSidebar.toggleHeaderInsetX < 16 ||
        desktopSidebar.toggleHeaderInsetX > 20 ||
        desktopSidebar.toggleHeaderInsetY < 5 ||
        desktopSidebar.toggleHeaderInsetY > 9 ||
        Math.abs(layout.sidebarTop) > 1 ||
        Math.abs(layout.topbarSurfaceLeft) > 1 ||
        Math.abs(desktopSidebar.topbarSurfaceLeft) > 1 ||
        desktopSidebar.stationaryToggleDelta < 0 ||
        desktopSidebar.stationaryToggleDelta > 1 ||
        desktopSidebar.expandedGalleryOverlap ||
        desktopSidebar.galleryOverlap ||
        Math.abs(desktopSidebar.sidebarRight) > 1 ||
        desktopSidebar.contentBefore < 200 ||
        Math.abs(desktopSidebar.contentCollapsed) > 1 ||
        desktopSidebar.restoredToggleDelta < 0 ||
        desktopSidebar.restoredToggleDelta > 1 ||
        (layout.sidebarFooterBottomGap !== null && (
          layout.sidebarFooterBottomGap < 0 || layout.sidebarFooterBottomGap > 1
        )) ||
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
        !mobileNavigation.brandVisible ||
        mobileNavigation.closedBrandVisible ||
        mobileNavigation.internalToggles !== 0 ||
        mobileNavigation.metaRows !== 0 ||
        Math.abs(mobileNavigation.layerTopGap) > 1 ||
        Math.abs(layout.topbarSurfaceLeft) > 1 ||
        Math.abs(mobileNavigation.topbarSurfaceLeft) > 1 ||
        Math.abs(mobileNavigation.toggleWidth - 42) > 1 ||
        Math.abs(mobileNavigation.toggleHeight - 42) > 1 ||
        Math.abs(mobileNavigation.expandedToggleWidth - 42) > 1 ||
        mobileNavigation.galleryOverlap ||
        mobileNavigation.stationaryToggleDelta < 0 ||
        mobileNavigation.stationaryToggleDelta > 1 ||
        mobileNavigation.toggleHeaderInsetX < 10 ||
        mobileNavigation.toggleHeaderInsetX > 14 ||
        mobileNavigation.toggleHeaderInsetY < 4 ||
        mobileNavigation.toggleHeaderInsetY > 8 ||
        mobileNavigation.albumClearance < 8 ||
        mobileNavigation.albumClearance > 12 ||
        (mobileNavigation.footerBottomGap !== null && (
          mobileNavigation.footerBottomGap < 0 || mobileNavigation.footerBottomGap > 1
        )) ||
        mobileNavigation.drawerWidth < 200 ||
        mobileNavigation.closed !== 0 ||
        mobileNavigation.restored !== "false" ||
        !mobileCardActions?.hiddenInitially || mobileCardActions.moreVisible ||
        mobileCardActions.viewerAfterMenu !== 0 ||
        mobileCardActions.menuItemCount !== 6 ||
        !mobileCardActions.focusReturned ||
        mobileCardActions.clickCount !== 1 ||
        mobileCardActions.viewerOpenedFromTouch !== 1
      )) ||
      (target.name === "desktop" && layout.topbarPosition !== "fixed") ||
      layout.nativeCardTitles !== 0 || layout.legacyCardNames !== 0 || layout.cardActions !== 0 ||
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
