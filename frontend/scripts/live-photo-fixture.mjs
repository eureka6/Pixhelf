import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { chromium, webkit } from "playwright-core";

export const engine = process.argv.includes("--webkit") || process.env.PIXHELF_TEST_ENGINE === "webkit" ? webkit : chromium;
export const isChromium = engine === chromium;

export function launchBrowser() {
  return engine.launch(isChromium ? {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? chromium.executablePath(),
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  } : { headless: true });
}

export async function loadSample() {
  const source = process.env.PIXHELF_LIVE_SAMPLE;
  const [poster, pairedClip] = await Promise.all([
    readFile(source ? `${source}.jpg` : new URL("fixtures/live-photo.jpg", import.meta.url)),
    readFile(source ? `${source}.mov` : new URL("fixtures/live-photo.mp4", import.meta.url))
      .catch(error => { if (source && error.code === "ENOENT") return null; throw error; }),
  ]);
  return {
    name: source ? basename(source) : "fixture", poster,
    clip: pairedClip ?? samsungClip(poster),
    contentType: source && pairedClip ? "video/quicktime" : "video/mp4",
  };
}

function samsungClip(jpeg) {
  assert.equal(jpeg.subarray(-4).toString(), "SEFT", "sample needs a paired MOV or embedded Samsung clip");
  const index = jpeg.length - 8 - jpeg.readUInt32LE(jpeg.length - 8);
  assert.equal(jpeg.subarray(index, index + 4).toString(), "SEFH");
  const count = jpeg.readUInt32LE(index + 8);
  for (let i = 0; i < count; i++) {
    const entry = index + 12 + i * 12;
    if (jpeg.readUInt16LE(entry + 2) !== 0x0a30) continue;
    let start = index - jpeg.readUInt32LE(entry + 4) + 24;
    let length = jpeg.readUInt32LE(entry + 8) - 24;
    if (jpeg.subarray(start, start + 4).toString() === "mpv2") {
      [start, length] = [jpeg.readUInt32BE(start + 4), jpeg.readUInt32BE(start + 8)];
    }
    assert.ok(start > 0 && length > 0 && start + length <= index);
    return jpeg.subarray(start, start + length);
  }
  throw new Error("No Samsung motion clip found");
}

export function serveMotion(route, { clip, contentType }) {
  const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
  return route.fulfill({ status: range ? 206 : 200, body: clip.subarray(start, end + 1), headers: {
    "content-type": contentType, "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable", "etag": '"original-motion-v2-fixture"',
    ...(range ? { "content-range": `bytes ${start}-${end}/${clip.length}` } : {}),
  } });
}

export function imageDimensions(page, poster) {
  return page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, poster.toString("base64"));
}
