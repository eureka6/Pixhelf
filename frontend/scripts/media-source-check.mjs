// Byte-exact replay, seek and cancellation checks. Fetch is supplied in memory;
// no browser, listener, backend, or real gallery is required.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const output = await build({ entryPoints: [new URL("../src/mediaSource.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
const { createMediaSource, motionBlob, retainMotionSource } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const codecOutput = await build({ entryPoints: [new URL("../src/motionCodec.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
const { motionVideoCodec } = await import(`data:text/javascript;base64,${Buffer.from(codecOutput.outputFiles[0].text).toString("base64")}`);
for (const [name, codec] of [["live-photo.mp4", "avc1"], ["live-photo-hevc.mov", "hvc1"]]) {
  assert.equal(await motionVideoCodec(new Blob([await readFile(new URL(`fixtures/${name}`, import.meta.url))])), codec);
}
for (const hex of ["", "00000004", "000000046d6f6f76", "000000016d6f6f76ffffffffffffffff", "0000000c6d64617468766331"]) {
  assert.equal(await motionVideoCodec(new Blob([Buffer.from(hex, "hex")])), undefined,
    "invalid metadata and codec-like bytes inside media must keep the normal fallback path");
}
const Player = { IOLoader: { CustomIOLoader: class {} } };
const BLOCK = 256 * 1024, MiB = 1024 * 1024, IO_END = -1048576;
const requests = [], files = new Map();
let generation = 0;
function file(size, options = {}) {
  const url = `/motion/${++generation}/version`;
  files.set(url, { size, salt: generation, ...options });
  return url;
}
function bytes(url, start, length) {
  const salt = files.get(url).salt;
  const result = new Uint8Array(length);
  for (let i = 0; i < length; i++) result[i] = ((start + i) * 31 + ((start + i) >> 8) + salt) & 255;
  return result;
}
function loader(url, retain = true) {
  const abort = new AbortController();
  const input = createMediaSource(Player, url, "motion.mov", abort.signal, retain);
  return { input, abort };
}
async function read(input, url, start, length) {
  assert.equal(await input.seek(BigInt(start)), 0);
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const buffer = new Uint8Array(Math.min(19_127, length - offset));
    const count = await input.read(buffer);
    assert(count > 0, "requested bytes must exist");
    result.set(buffer.subarray(0, count), offset);
    offset += count;
  }
  assert.deepEqual(result, bytes(url, start, length), "seeking and replay must preserve every original byte");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, { method, headers, signal }) => {
  assert(!signal.aborted);
  requests.push({ url, method, range: headers?.Range });
  const entry = files.get(url);
  assert(entry, `unknown source: ${url}`);
  assert.equal(method, "GET", "metadata and media bytes share the first request");
  if (entry.pendingOpen) return entry.pendingOpen();
  const match = /^bytes=(\d+)-(\d*)$/.exec(headers.Range);
  assert(match, "request a valid single byte range");
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : entry.size - 1;
  assert(start >= 0 && end < entry.size && start <= end);
  const responseHeaders = { "content-range": `bytes ${start}-${end}/${entry.size}`, "content-length": String(end - start + 1) };
  if (entry.badRange) responseHeaders["content-range"] = `bytes 0-${end}/${entry.size}`;
  if (entry.noLength) delete responseHeaders["content-length"];
  if (entry.pending && !(entry.delayRead && headers.Range === "bytes=0-")) return entry.pending({ start, end, signal, responseHeaders });
  return new Response(bytes(url, start, end - start + 1 - (entry.truncated ? 1 : 0)), { status: 206, headers: responseHeaders });
};

try {
  // One successful GET must supply both metadata and the first playable bytes,
  // including a server returning the complete file without Range support.
  const fullUrl = file(71, { pendingOpen() {
    return new Response(bytes(fullUrl, 0, 71), { headers: { "content-length": "71" } });
  } });
  const full = loader(fullUrl, false), beforeFull = requests.length;
  await full.input.open();
  await read(full.input, fullUrl, 0, 71);
  assert.equal(requests.length, beforeFull + 1, "initial bytes must reuse the metadata response stream");
  await full.input.stop();
  for (const headers of [
    { "content-range": "bytes 0-70/*" }, { "content-range": "bytes 1-70/71" },
    { "content-range": "bytes 0-69/71" }, { "content-range": "bytes 0-70/0" },
  ]) {
    let released = false;
    const invalidUrl = file(71, { pendingOpen() {
      return new Response(new ReadableStream({ cancel() { released = true; } }), { status: 206, headers });
    } });
    const invalid = loader(invalidUrl);
    await assert.rejects(invalid.input.open(), /视频/);
    assert(released, "invalid metadata must release its response body");
    delete files.get(invalidUrl).pendingOpen;
    await invalid.input.open();
    await read(invalid.input, invalidUrl, 0, 71);
    await invalid.input.stop();
  }
  // Native and compatibility playback consume exactly the same cached original.
  const nativeUrl = file(BLOCK * 2 + 71);
  const native = await motionBlob(nativeUrl, new AbortController().signal);
  assert.deepEqual(new Uint8Array(await native.arrayBuffer()), bytes(nativeUrl, 0, files.get(nativeUrl).size));
  const afterNative = requests.length;
  const nativeFallback = loader(nativeUrl);
  await nativeFallback.input.open();
  await read(nativeFallback.input, nativeUrl, 0, files.get(nativeUrl).size);
  nativeFallback.abort.abort();
  await motionBlob(nativeUrl, new AbortController().signal);
  assert.equal(requests.length, afterNative, "native replay and decoder fallback must not download again");
  const cancelledNative = new AbortController();
  cancelledNative.abort();
  await assert.rejects(motionBlob(nativeUrl, cancelledNative.signal), { name: "AbortError" });
  const largeNativeUrl = file(32 * MiB + 1), beforeLargeNative = requests.length;
  assert.equal(await motionBlob(largeNativeUrl, new AbortController().signal), undefined);
  assert.equal(requests.length, beforeLargeNative + 1, "oversized originals must not be buffered into blobs");

  // Hovering during a speculative download joins that download. Cancelling the
  // speculative owner must not cancel the player that has just taken over.
  let finishShared, sharedStarted;
  const sharedReady = new Promise(resolve => { sharedStarted = resolve; });
  const sharedUrl = file(BLOCK + 23, { pending({ start, end, responseHeaders }) {
    return new Promise(resolve => {
      finishShared = () => resolve(new Response(bytes(sharedUrl, start, end - start + 1), { status: 206, headers: responseHeaders }));
      sharedStarted();
    });
  } });
  const speculative = new AbortController(), playback = new AbortController();
  const beforeShared = requests.length;
  const speculativeLoad = motionBlob(sharedUrl, speculative.signal);
  const cancelledPreload = assert.rejects(speculativeLoad, { name: "AbortError" });
  const sharedPlayback = motionBlob(sharedUrl, playback.signal);
  await sharedReady;
  speculative.abort();
  await cancelledPreload;
  finishShared();
  assert.deepEqual(new Uint8Array(await (await sharedPlayback).arrayBuffer()), bytes(sharedUrl, 0, files.get(sharedUrl).size));
  assert.equal(requests.length, beforeShared + 1, "preload handoff must share the single metadata/media GET");
  assert.equal(getEventListeners(playback.signal, "abort").length, 0, "completed owners release their listeners");

  // Component cleanup can release the preload before the player is mounted in
  // the same turn. This handoff must preserve the already-running GET as well.
  let finishHandoff, handoffStarted;
  const handoffReady = new Promise(resolve => { handoffStarted = resolve; });
  const handoffUrl = file(BLOCK + 13, { pending({ start, end, responseHeaders }) {
    return new Promise(resolve => {
      finishHandoff = () => resolve(new Response(bytes(handoffUrl, start, end - start + 1), { status: 206, headers: responseHeaders }));
      handoffStarted();
    });
  } });
  const leaving = new AbortController(), entering = new AbortController();
  const beforeHandoff = requests.length;
  const left = assert.rejects(motionBlob(handoffUrl, leaving.signal), { name: "AbortError" });
  await handoffReady;
  delete files.get(handoffUrl).pending;
  leaving.abort();
  const entered = motionBlob(handoffUrl, entering.signal);
  finishHandoff();
  await left;
  assert.deepEqual(new Uint8Array(await (await entered).arrayBuffer()), bytes(handoffUrl, 0, files.get(handoffUrl).size));
  assert.equal(requests.length, beforeHandoff + 1, "releasing then acquiring in one turn must not restart the download");
  assert.equal(getEventListeners(leaving.signal, "abort").length, 0);
  assert.equal(getEventListeners(entering.signal, "abort").length, 0);

  // A long-lived owner signal must not retain stopped readers or completed
  // native blob loads. Reopening a decoder reinstalls cancellation handling.
  const reusable = loader(nativeUrl);
  await reusable.input.open();
  assert.equal(getEventListeners(reusable.abort.signal, "abort").length, 1);
  await reusable.input.stop();
  assert.equal(getEventListeners(reusable.abort.signal, "abort").length, 0);
  await reusable.input.open();
  assert.equal(getEventListeners(reusable.abort.signal, "abort").length, 1);
  await reusable.input.stop();
  await motionBlob(nativeUrl, reusable.abort.signal);
  assert.equal(getEventListeners(reusable.abort.signal, "abort").length, 0);

  // A full playback includes non-linear demuxer reads. Recreating the decoder
  // and replaying needs no requests, even with no HTTP cache at all.
  const url = file(BLOCK * 3 + 71);
  const first = loader(url);
  await first.input.open();
  await read(first.input, url, BLOCK * 3, 71);
  await read(first.input, url, 0, files.get(url).size);
  assert.equal(await first.input.read(new Uint8Array(5)), IO_END);
  assert.equal(await first.input.seek(-1n), -10);
  assert.equal(await first.input.seek(BigInt(files.get(url).size + 1)), -10);
  first.abort.abort();
  const before = requests.length;
  const replay = loader(url);
  await replay.input.open();
  await read(replay.input, url, BLOCK - 3, 11);
  await read(replay.input, url, 0, files.get(url).size);
  replay.abort.abort();
  assert.equal(requests.length, before, "completed replay uses no requests");
  const ranges = requests.filter(request => request.url === url && request.method === "GET");
  assert.deepEqual(ranges.map(request => request.range), ["bytes=0-", `bytes=${BLOCK * 3}-${BLOCK * 3 + 70}`, `bytes=0-${BLOCK * 3 - 1}`],
    "stream consecutive missing blocks in one request without downloading the cached footer again");

  // Early pointer leave retains completed blocks and cancels the unread stream.
  // Returning requests only the missing blocks.
  const partialUrl = file(BLOCK * 2 + 33);
  const partial = loader(partialUrl);
  await partial.input.open();
  await read(partial.input, partialUrl, 0, 19);
  partial.abort.abort();
  const beforePartial = requests.length;
  const resume = loader(partialUrl);
  await resume.input.open();
  await read(resume.input, partialUrl, 0, BLOCK);
  assert.equal(requests.length, beforePartial);
  await read(resume.input, partialUrl, BLOCK, BLOCK + 33);
  assert.equal(requests.length, beforePartial + 1);
  resume.abort.abort();

  // URLs contain the source version; a replacement with identical length still
  // has its own metadata and bytes.
  const replacement = file(files.get(url).size);
  const newer = loader(replacement);
  const beforeReplacement = requests.length;
  await newer.input.open();
  await read(newer.input, replacement, 0, 23);
  assert.equal(requests.length, beforeReplacement + 1);
  newer.abort.abort();

  // Abort midway through a response body: unfinished bytes must not become a
  // successful cache entry or poison the next decoder's first read.
  let bodyReady;
  const started = new Promise(resolve => { bodyReady = resolve; });
  const slowUrl = file(BLOCK + 1, { pending({ start, signal, responseHeaders }) {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes(slowUrl, start, 17));
      signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      bodyReady();
    } }), { status: 206, headers: responseHeaders });
  } });
  const slow = loader(slowUrl);
  await slow.input.open();
  const pendingRead = assert.rejects(slow.input.read(new Uint8Array(5)), { name: "AbortError" });
  await started;
  slow.abort.abort();
  await pendingRead;
  delete files.get(slowUrl).pending;
  const retry = loader(slowUrl), beforeRetry = requests.length;
  await retry.input.open();
  await read(retry.input, slowUrl, 0, 29);
  assert.equal(requests.length, beforeRetry + 1, "retry downloads the incomplete block again, reusing valid length metadata");
  retry.abort.abort();

  // Cancelling during metadata loading must not start a fallback GET or cache
  // a stale length when the initial response has already been queued for delivery.
  let finishHead;
  const headUrl = file(71, { pendingOpen() { return new Promise(resolve => { finishHead = () => resolve(new Response(null)); }); } });
  const head = loader(headUrl), beforeHead = requests.length;
  const pendingHead = assert.rejects(head.input.open(), { name: "AbortError" });
  head.abort.abort();
  finishHead();
  await pendingHead;
  assert.equal(requests.length, beforeHead + 1);
  delete files.get(headUrl).pendingOpen;
  const nextHead = loader(headUrl);
  await nextHead.input.open();
  assert.equal(requests.length, beforeHead + 2, "aborted metadata is not cached");
  nextHead.abort.abort();

  // Simulate a response settling immediately after a seek cancels it. A stale
  // read must not move the new cursor or supply bytes from the old position.
  let finishStale;
  const staleUrl = file(BLOCK + 8, { delayRead: true, pending({ start, end, responseHeaders }) {
    return new Promise(resolve => { finishStale = () => resolve(new Response(bytes(staleUrl, start, end - start + 1), { status: 206, headers: responseHeaders })); });
  } });
  const stale = loader(staleUrl);
  await stale.input.open();
  await stale.input.stop();
  await stale.input.open();
  const staleRead = assert.rejects(stale.input.read(new Uint8Array(3)), { name: "AbortError" });
  assert.equal(await stale.input.seek(BigInt(BLOCK)), 0);
  finishStale();
  await staleRead;
  delete files.get(staleUrl).pending;
  await read(stale.input, staleUrl, BLOCK, 8);
  stale.abort.abort();

  // An error response may already be queued when playback is cancelled. Treat
  // it as cancellation and close its body rather than reporting a stale error.
  for (const status of [206, 500]) {
    let respond, released = false;
    const lateUrl = file(71, { delayRead: true, pending() { return new Promise(resolve => { respond = () => resolve(new Response(
      new ReadableStream({ cancel() { released = true; } }), { status },
    )); }); } });
    const late = loader(lateUrl);
    await late.input.open();
    await late.input.stop();
    await late.input.open();
    const reading = assert.rejects(late.input.read(new Uint8Array(3)), { name: "AbortError" });
    late.abort.abort();
    respond();
    await reading;
    assert(released, "the stale response body must be released");
  }

  // Network chunks need not align with cache blocks. Both IO paths must consume
  // split chunks exactly once and preserve bytes across short output buffers.
  for (const retain of [true, false]) {
    const splitUrl = file(BLOCK + 91, { pending({ start, end, responseHeaders }) {
      let position = start;
      return new Response(new ReadableStream({ pull(controller) {
        if (position > end) { controller.close(); return; }
        controller.enqueue(new Uint8Array(0));
        const count = Math.min(7919, end - position + 1);
        controller.enqueue(bytes(splitUrl, position, count));
        position += count;
      } }), { status: 206, headers: responseHeaders });
    } });
    const split = loader(splitUrl, retain);
    await split.input.open();
    await read(split.input, splitUrl, 0, files.get(splitUrl).size);
    assert.equal(await split.input.read(new Uint8Array(5)), IO_END);
    split.abort.abort();
  }

  // Reject malformed/truncated ranges rather than retaining corrupt bytes.
  for (const [fault, retain] of [["badRange", true], ["truncated", true], ["badRange", false], ["truncated", false]]) {
    const brokenUrl = file(BLOCK + 8, { [fault]: true });
    const broken = loader(brokenUrl, retain);
    await broken.input.open();
    await assert.rejects(read(broken.input, brokenUrl, BLOCK, 8), /视频分段/);
    delete files.get(brokenUrl)[fault];
    await read(broken.input, brokenUrl, BLOCK, 8);
    broken.abort.abort();
  }

  // A server ignoring a nonzero Range must release its body. Retrying the same
  // position works without a seek, and oversized bodies are rejected as well.
  for (const retain of [true, false]) {
    for (const ignoredRange of [true, false]) {
      let released = false;
      const malformedUrl = file(BLOCK + 8, { delayRead: true, pending({ start, end, responseHeaders }) {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(bytes(malformedUrl, start, end - start + 2));
        }, cancel() { released = true; } }), { status: ignoredRange ? 200 : 206, headers: responseHeaders });
      } });
      const malformed = loader(malformedUrl, retain);
      await malformed.input.open();
      await malformed.input.seek(BigInt(BLOCK));
      await assert.rejects(malformed.input.read(new Uint8Array(8)), /视频分段/);
      assert(released, "invalid response bodies must be cancelled");
      delete files.get(malformedUrl).pending;
      await read(malformed.input, malformedUrl, BLOCK, 8);
      await malformed.input.stop();
    }
  }

  // Content-Range without Content-Length, exact EOF and the ordinary-video streaming path survive.
  const fallbackUrl = file(71, { noLength: true });
  const fallback = loader(fallbackUrl);
  await fallback.input.open();
  assert.equal(await fallback.input.size(), 71n);
  await read(fallback.input, fallbackUrl, 0, 71);
  assert.equal(await fallback.input.read(new Uint8Array(5)), IO_END);
  fallback.abort.abort();
  for (const [size, retain] of [[32 * MiB + 1, true], [BLOCK + 8, false]]) {
    const streamUrl = file(size), stream = loader(streamUrl, retain);
    await stream.input.open();
    await read(stream.input, streamUrl, size - 8, 8);
    stream.abort.abort();
    assert.equal(requests.at(-1).range, `bytes=${size - 8}-`, "large clips and ordinary videos keep streaming without the replay cache");
    const reopened = loader(streamUrl, retain), previous = requests.length;
    await reopened.input.open();
    assert.equal(requests.length, previous + 1);
    reopened.abort.abort();
  }

  // Both total retained bytes and source count are bounded. Recently replayed
  // clips survive eviction before older ones, even if all have the same size.
  const largeUrls = [file(24 * MiB), file(24 * MiB), file(24 * MiB)];
  async function fill(url) {
    const active = loader(url);
    await active.input.open();
    const buffer = new Uint8Array(BLOCK);
    for (let start = 0; start < files.get(url).size; start += BLOCK) {
      assert.equal(await active.input.read(buffer), Math.min(BLOCK, files.get(url).size - start));
    }
    active.abort.abort();
  }
  await fill(largeUrls[0]);
  await fill(largeUrls[1]);
  const recent = loader(largeUrls[0]);
  await recent.input.open();
  await read(recent.input, largeUrls[0], 0, 1);
  recent.abort.abort();
  await fill(largeUrls[2]);
  const stillCached = loader(largeUrls[0]), beforeHit = requests.length;
  await stillCached.input.open();
  await read(stillCached.input, largeUrls[0], 0, 1);
  assert.equal(requests.length, beforeHit, "most recently replayed source survives the byte budget");
  stillCached.abort.abort();
  const evicted = loader(largeUrls[1]), beforeMiss = requests.length;
  await evicted.input.open();
  await read(evicted.input, largeUrls[1], 0, 1);
  assert.equal(requests.length, beforeMiss + 1, "least recently used source is evicted when exceeding 64 MiB");
  evicted.abort.abort();
  // Gallery speculation must not push out a retained replay or next slide.
  const retainedUrl = file(5 * MiB), releaseRetained = retainMotionSource(retainedUrl);
  await fill(retainedUrl);
  for (let i = 0; i < 3; i++) await fill(file(24 * MiB));
  const retained = loader(retainedUrl), beforeRetained = requests.length;
  await retained.input.open();
  await read(retained.input, retainedUrl, 0, files.get(retainedUrl).size);
  assert.equal(requests.length, beforeRetained, 'retained playback bytes survive more than 64 MiB of speculation');
  retained.abort.abort();
  releaseRetained();
  for (let i = 0; i < 3; i++) await fill(file(24 * MiB));
  const released = loader(retainedUrl), beforeReleased = requests.length;
  await released.input.open();
  assert.equal(requests.length, beforeReleased + 1, 'released sources become evictable again');
  released.abort.abort();
  const metadataUrl = file(1), metadata = loader(metadataUrl);
  await metadata.input.open();
  metadata.abort.abort();
  for (let i = 0; i < 32; i++) {
    const next = loader(file(1));
    await next.input.open();
    next.abort.abort();
  }
  const aged = loader(metadataUrl), beforeAged = requests.length;
  await aged.input.open();
  assert.equal(requests.length, beforeAged + 1, "even length-only entries obey the source count limit");
  aged.abort.abort();
  console.log("Original-motion cache: byte-exact replay, partial reuse, seeking, cancellation, versioning, validation, streaming fallback and bounded LRU passed (no server).");
} finally { globalThis.fetch = originalFetch; }
