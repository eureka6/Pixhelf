import assert from "node:assert/strict";

// Exercise actual browser pointer/touch sequences, including generated compatibility clicks.
export async function checkVideoGestures(page, width) {
  const viewer = page.locator(".video-viewer");
  const stage = viewer.locator(".video-viewer-stage");
  const picture = viewer.locator(".video-viewer-picture");
  const player = viewer.locator(".media-player-surface");
  const seek = async position => {
    await player.evaluate((video, position) => { video.pause(); video.currentTime = position; }, position);
    await page.waitForFunction(position => {
      const video = document.querySelector(".video-viewer video");
      return video.paused && !video.seeking && Math.abs(video.currentTime - position) < .1;
    }, position);
  };
  const transitions = async () => player.evaluate(video => {
    video.gestureTransitions = [];
    for (const type of ["play", "pause"]) video.addEventListener(type, () => video.gestureTransitions.push(type));
  });
  const unchanged = async () => {
    await page.waitForTimeout(550);
    assert.deepEqual(await player.evaluate(video => video.gestureTransitions), [], "double input must not briefly play or pause the video");
  };
  const initialRate = await player.evaluate(video => video.playbackRate);
  await seek(1);

  if (width > 720) {
    await transitions();
    await picture.dblclick({ position: { x: width * .25, y: 220 } });
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await unchanged();
    await picture.dblclick({ position: { x: width * .25, y: 220 } });
    await page.waitForFunction(() => !document.fullscreenElement);
    await unchanged();
    await page.mouse.click(width / 2 - 2, 220);
    await page.mouse.move(width / 2 + 2, 220);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await unchanged();
    await picture.dblclick({ position: { x: width * .25, y: 220 } });
    await page.waitForFunction(() => !document.fullscreenElement);
    // The large play button shares the same double-click arbitration.
    await viewer.locator(".video-viewer-resume-button").dblclick();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await unchanged();
    await picture.dblclick({ position: { x: width * .25, y: 220 } });
    await page.waitForFunction(() => !document.fullscreenElement);
    await picture.click({ position: { x: width * .25, y: 220 } });
    await page.waitForFunction(() => !document.querySelector(".video-viewer video").paused);
    await player.evaluate(video => { video.gestureTransitions = []; });
    await picture.dblclick({ position: { x: width * .75, y: 220 } });
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await unchanged();
    await picture.dblclick({ position: { x: width * .75, y: 220 } });
    await page.waitForFunction(() => !document.fullscreenElement);
    await unchanged();
    await seek(1);
  } else {
    const touch = await page.context().newCDPSession(page);
    const point = side => ({ x: width * (side === "left" ? .25 : .75), y: 250 });
    const start = point => touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    const end = () => touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const tap = async side => { await start(point(side)); await end(); };
    const double = async side => { await tap(side); await tap(side); };
    const beginHold = async side => { await tap(side); await start(point(side)); };
    const swipe = async (side, delta) => {
      const from = { ...point(side), y: 380 };
      await start(from);
      for (let step = 1; step <= 6; step++) await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ ...from, y: from.y + delta * step / 6 }],
      });
      await end();
    };
    try {
      await transitions();
      await double("right");
      await page.waitForFunction(() => Math.abs(document.querySelector(".video-viewer video").currentTime - 11) < .1);
      await unchanged();
      await double("left");
      await page.waitForFunction(() => Math.abs(document.querySelector(".video-viewer video").currentTime - 1) < .1);
      await unchanged();
      assert.equal(await page.evaluate(() => document.fullscreenElement), null, "touch double taps seek without fullscreen");
      await double("left");
      await page.waitForFunction(() => document.querySelector(".video-viewer video").currentTime === 0);
      await unchanged();

      await seek(1);
      await beginHold("right");
      await page.waitForFunction(() => document.querySelector(".video-viewer video").playbackRate === 2);
      await page.waitForTimeout(550);
      assert.equal(await viewer.locator(".photo-card-menu").count(), 0, "holding the second tap must not open the long-press menu");
      assert.equal(await viewer.locator(".video-gesture-feedback").textContent(), "2× 快进");
      await end();
      await page.waitForFunction(rate => {
        const video = document.querySelector(".video-viewer video");
        return video.playbackRate === rate && video.paused;
      }, initialRate);
      await page.waitForTimeout(550);
      assert.equal(await player.evaluate(video => video.paused), true, "release must restore the paused state without a trailing click");

      await seek(8);
      await beginHold("left");
      await page.waitForFunction(() => document.querySelector(".video-viewer video").currentTime < 7.5);
      await end();
      await page.waitForTimeout(100);
      const rewound = await player.evaluate(video => video.currentTime);
      await page.waitForTimeout(550);
      assert.equal(await player.evaluate(video => video.currentTime), rewound, "rewinding must stop on release");
      assert.equal(await player.evaluate(video => video.paused), true);

      await seek(3);
      await viewer.getByRole("button", { name: "播放视频", exact: true }).tap();
      await page.waitForFunction(() => !document.querySelector(".video-viewer video").paused);
      await beginHold("right");
      await page.waitForFunction(() => document.querySelector(".video-viewer video").playbackRate === 2);
      await end();
      await page.waitForFunction(rate => {
        const video = document.querySelector(".video-viewer video");
        return !video.paused && video.playbackRate === rate;
      }, initialRate);
      await beginHold("left");
      await page.waitForFunction(() => document.querySelector(".video-gesture-feedback")?.textContent === "2× 后退");
      await end();
      await page.waitForFunction(() => !document.querySelector(".video-viewer video").paused);
      await beginHold("right");
      await page.waitForFunction(() => document.querySelector(".video-viewer video").playbackRate === 2);
      await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await page.waitForFunction(rate => document.querySelector(".video-viewer video").playbackRate === rate, initialRate);
      await beginHold("right");
      await page.waitForFunction(() => document.querySelector(".video-viewer video").playbackRate === 2);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await end();
      assert.equal(await player.evaluate(video => video.playbackRate), initialRate, "focus loss must restore the speed");
      assert.equal(await player.evaluate(video => video.paused), true, "focus loss must leave playback paused");

      await seek(1);
      await player.evaluate(video => { video.gestureTransitions = []; });
      const scroll = await viewer.evaluate(viewer => viewer.scrollTop);
      await swipe("right", 140);
      if (process.env.PIXHELF_TEST_SCREENSHOTS) {
        await page.waitForTimeout(100);
        await page.screenshot({ path: `${process.env.PIXHELF_TEST_SCREENSHOTS}/video-volume-gesture-${width}.png` });
      }
      const volume = await player.evaluate(video => video.volume);
      assert.ok(volume > .5 && volume < .9, "swiping down on the right lowers volume");
      await swipe("right", -140);
      assert.ok(await player.evaluate(video => video.volume > .99));
      await swipe("right", 600);
      assert.equal(await player.evaluate(video => video.volume), 0);
      assert.equal(await player.evaluate(video => video.muted), true);
      await swipe("right", -300);
      assert.equal(await player.evaluate(video => video.muted), false, "raising volume must unmute");
      await swipe("left", 140);
      if (process.env.PIXHELF_TEST_SCREENSHOTS) {
        await page.waitForTimeout(100);
        await page.screenshot({ path: `${process.env.PIXHELF_TEST_SCREENSHOTS}/video-brightness-gesture-${width}.png` });
      }
      assert.ok(Number(await viewer.locator(".video-viewer-brightness").evaluate(layer => layer.style.opacity)) > .15,
        "swiping down on the left dims only the picture");
      assert.equal(await viewer.locator(".video-viewer-playback").evaluate(controls => getComputedStyle(controls).opacity), "1");
      await swipe("left", -140);
      assert.equal(Number(await viewer.locator(".video-viewer-brightness").evaluate(layer => layer.style.opacity)), 0);
      assert.equal(await viewer.evaluate(viewer => viewer.scrollTop), scroll, "side gestures must not scroll the details page");
      await unchanged();
      assert.equal(await player.evaluate(video => video.currentTime), 1, "adjusting levels must not seek");
      // A second finger cancels an unfinished tap instead of triggering playback.
      await start(point("left"));
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
        { ...point("left"), id: 0 }, { ...point("right"), id: 1 },
      ] });
      await end();
      await unchanged();
      // Clear the reduced volume for the existing mute-button checks.
      await viewer.locator(".video-viewer-volume").evaluate(slider => {
        slider.value = "1"; slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
    } finally { await touch.detach(); }
  }
  const oldVideo = await player.elementHandle();
  const firstId = await viewer.getAttribute("data-image-id");
  const contact = width < 720 ? await page.context().newCDPSession(page) : null;
  try {
    if (contact) {
      const point = { x: width * .75, y: 220 };
      await contact.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await contact.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await contact.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await page.waitForFunction(() => document.querySelector(".video-viewer video").playbackRate === 2);
    } else await picture.click({ position: { x: width * .25, y: 220 } });
    // Change the source without a new pointerdown: cleanup must cancel a pending click/held rate itself.
    await viewer.locator(".video-next").evaluate(button => button.click());
    if (contact) await contact.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(id => {
      const viewer = document.querySelector(".video-viewer");
      const video = viewer.querySelector("video");
      return viewer.dataset.imageId !== id && video && !video.paused && video.currentTime > .1;
    }, firstId);
    await page.waitForTimeout(600);
    assert.equal(await oldVideo.evaluate(video => !video.isConnected && video.paused && video.dataset.playerState === "destroyed"), true);
    assert.equal(await player.evaluate(video => video.playbackRate), 1, "changing videos must discard a held speed");
    assert.equal(await player.evaluate(video => video.paused), false, "a pending click from the old video must not pause the new one");
    assert.equal(await viewer.locator(".video-gesture-feedback").count(), 0);
    await viewer.locator(".video-previous").click();
    await page.waitForFunction(id => document.querySelector(".video-viewer")?.dataset.imageId === id
      && document.querySelector(".video-viewer")?.dataset.videoState === "ready", firstId);
    await seek(1);
    await viewer.getByRole("button", { name: "倍速", exact: true }).click();
    await viewer.locator('.video-rate-panel [role="menu"]').getByText(`${initialRate === 2 ? "2.0" : initialRate}×`, { exact: true }).click();
  } finally { await contact?.detach(); }
  await stage.focus();
  assert.equal(await player.evaluate(video => video.playbackRate), initialRate);
  console.log(`video-gestures-check: ${width}px double input isolation, seeking, hold restoration and level gestures passed`);
}
