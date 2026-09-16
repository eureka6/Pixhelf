import assert from "node:assert/strict";

export async function checkVideoTimeJump(page, width) {
  const viewer = page.locator(".video-viewer");
  const player = viewer.locator(".media-player-surface");
  const time = viewer.getByRole("button", { name: "跳转到指定时间", exact: true });
  const input = viewer.getByRole("textbox", { name: "跳转时间", exact: true });
  const panel = viewer.locator(".video-time-panel");
  const jump = async value => {
    await time.click();
    await input.fill(value);
    await input.press("Enter");
  };
  const at = seconds => page.waitForFunction(seconds => {
    const video = document.querySelector(".video-viewer video");
    return !video.seeking && Math.abs(video.currentTime - seconds) < .1;
  }, seconds);
  assert.equal(await viewer.locator(".video-skip").count(), 0, "the toolbar no longer needs ten-second skip buttons");
  const startingTime = await player.evaluate(video => video.currentTime);
  await time.click();
  for (const value of ["-1", "1:60", "0:99:00", "abc", "99999999"]) {
    await input.fill(value);
    await input.press("Enter");
    await panel.getByRole("alert").waitFor();
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    assert.equal(await player.evaluate(video => video.currentTime), startingTime, "invalid timestamps must not change playback position");
  }
  await input.fill("0:11");
  if (process.env.PIXHELF_TEST_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.PIXHELF_TEST_SCREENSHOTS}/video-time-jump-${width}.png` });
  }
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0, "time entry must fit the player");
  await input.press("Enter");
  await at(11);
  await panel.waitFor({ state: "hidden" });
  assert.equal(await player.evaluate(video => video.paused), true, "jumping while paused must not start playback");
  await jump("1.5");
  await at(1.5);
  await jump("0:00:01");
  await at(1);
  await time.click();
  await viewer.locator(".video-play-toggle").focus();
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  assert.equal(await viewer.count(), 1, "Escape dismisses the timestamp editor before the viewer");

  await viewer.getByRole("button", { name: "播放视频", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".video-viewer video").paused);
  await time.click();
  await input.fill("0:04");
  await page.waitForTimeout(350);
  assert.equal(await input.inputValue(), "0:04", "playback updates must not overwrite an edited timestamp");
  await input.press("Enter");
  await page.waitForFunction(() => {
    const video = document.querySelector(".video-viewer video");
    return !video.paused && video.currentTime >= 4 && video.currentTime < 5;
  });
  await viewer.getByRole("button", { name: "暂停视频", exact: true }).click();
  await jump("1");
  await at(1);
  console.log(`video-controls-check: ${width}px timestamp validation, keyboard submission and playback preservation passed`);
}

export async function checkVideoControlOrder(viewer) {
  const left = selector => viewer.locator(selector).evaluate(element => element.getBoundingClientRect().left);
  assert.ok(await left(".video-episodes-toggle") < await left(".video-rate-toggle"));
  assert.ok(await left(".video-rate-toggle") < await left(".video-volume-toggle"));
  assert.equal(await viewer.locator(".video-rate-toggle").textContent(), "倍速");
  if (await viewer.locator(".video-previous").count()) assert.ok(await left(".video-previous") < await left(".video-play-toggle"));
  if (await viewer.locator(".video-next").count()) assert.ok(await left(".video-next") > await left(".video-play-toggle"));
}
