import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { build } from 'esbuild';

globalThis.document = { getElementById: () => ({ textContent: '{"enabled":false,"authenticated":false}', remove() {} }) };
const bundle = await build({ entryPoints: [new URL('../src/viewerOriginalCache.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022' });
const { getViewerOriginalBlob, getViewerOriginalSource, clearViewerOriginalCache } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const requests = [], files = new Map(), revoked = [];
const fetchBefore = globalThis.fetch, revokeBefore = URL.revokeObjectURL;
URL.revokeObjectURL = url => { revoked.push(url); revokeBefore(url); };
globalThis.fetch = async (url, options) => {
  requests.push(url);
  const file = files.get(url);
  assert(file, url);
  file.started?.();
  if (file.ignoreAbort) await file.wait;
  else if (file.wait) await Promise.race([file.wait, new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })]);
  return new Response(new Uint8Array(file.size), { headers: { 'content-type': file.type ?? 'image/jpeg' } });
};
const load = url => getViewerOriginalBlob(url, new AbortController().signal);

try {
  let finish;
  files.set('/shared.jpg', { size: 1024, wait: new Promise(resolve => { finish = resolve; }) });
  const preload = new AbortController(), display = new AbortController(), zoom = new AbortController();
  const hidden = getViewerOriginalSource('/shared.jpg', preload.signal);
  const visible = getViewerOriginalSource('/shared.jpg', display.signal);
  const cancelled = assert.rejects(hidden, { name: 'AbortError' });
  preload.abort();
  finish();
  await cancelled;
  const visibleUrl = await visible;
  const zoomUrl = await getViewerOriginalSource('/shared.jpg', zoom.signal);
  assert.equal(visibleUrl, zoomUrl, 'display and zoom share both compressed bytes and a decoded-image URL');
  assert.equal(requests.length, 1, 'cancelling a preload does not restart an active display download');
  display.abort();
  assert(!revoked.includes(visibleUrl), 'another displayed image still owns the URL');
  zoom.abort();
  assert(revoked.includes(visibleUrl), 'the final image releases its object URL');
  const replay = new AbortController();
  await getViewerOriginalSource('/shared.jpg', replay.signal);
  replay.abort();
  assert.equal(requests.length, 1, 'recreating decoded images keeps the compressed original');

  clearViewerOriginalCache();
  for (let i = 0; i < 9; i++) { files.set(`/large-${i}.jpg`, { size: 8 * 1024 * 1024 }); await load(`/large-${i}.jpg`); }
  const beforeEviction = requests.length;
  await load('/large-8.jpg');
  assert.equal(requests.length, beforeEviction, 'recent large originals remain reusable');
  await load('/large-0.jpg');
  assert.equal(requests.length, beforeEviction + 1, 'compressed originals respect the 64 MiB budget');
  clearViewerOriginalCache();
  for (let i = 0; i < 65; i++) { files.set(`/small-${i}.jpg`, { size: 1 }); await load(`/small-${i}.jpg`); }
  const beforeCount = requests.length;
  await load('/small-64.jpg'); await load('/small-0.jpg');
  assert.equal(requests.length, beforeCount + 1, 'the source count is bounded as well as bytes');

  files.set('/failed.jpg', { size: 0 });
  await assert.rejects(load('/failed.jpg'));
  files.set('/failed.jpg', { size: 3 });
  assert.equal((await load('/failed.jpg')).size, 3, 'failed responses never poison replay');
  files.set('/wrong-type.jpg', { size: 3, type: 'text/html' });
  await assert.rejects(load('/wrong-type.jpg'));

  const pending = new AbortController();
  files.set('/pending.jpg', { size: 3, wait: new Promise(() => {}) });
  const pendingLoad = getViewerOriginalBlob('/pending.jpg', pending.signal);
  const stopped = assert.rejects(pendingLoad, { name: 'AbortError' });
  clearViewerOriginalCache();
  await stopped;
  assert.equal(getEventListeners(pending.signal, 'abort').length, 0, 'session cleanup releases pending owners');

  // A late response from a closed viewer must not populate the next session's
  // cache or remove the replacement download that now owns the same URL.
  let oldStarted, finishOld, newStarted, finishNew;
  const oldReady = new Promise(resolve => { oldStarted = resolve; });
  const newReady = new Promise(resolve => { newStarted = resolve; });
  files.set('/late.jpg', { size: 3, started: oldStarted, ignoreAbort: true, wait: new Promise(resolve => { finishOld = resolve; }) });
  const beforeLate = requests.length, oldOwner = new AbortController();
  const oldCancelled = assert.rejects(getViewerOriginalBlob('/late.jpg', oldOwner.signal), { name: 'AbortError' });
  await oldReady;
  clearViewerOriginalCache();
  await oldCancelled;
  assert.equal(getEventListeners(oldOwner.signal, 'abort').length, 0, 'closing releases owners even before a late response arrives');
  files.set('/late.jpg', { size: 5, started: newStarted, wait: new Promise(resolve => { finishNew = resolve; }) });
  const replacement = load('/late.jpg');
  await newReady;
  finishOld();
  await new Promise(resolve => setImmediate(resolve));
  const follower = load('/late.jpg');
  finishNew();
  assert.equal((await replacement).size, 5);
  assert.equal((await follower).size, 5);
  assert.equal(requests.length, beforeLate + 2, 'late completion preserves the shared replacement request');
  assert.equal((await load('/late.jpg')).size, 5, 'only the replacement can populate the cache');

  const cancelledOwner = new AbortController();
  const reason = new DOMException('Viewer closed', 'AbortError');
  cancelledOwner.abort(reason);
  await assert.rejects(getViewerOriginalBlob('/late.jpg', cancelledOwner.signal), error => error === reason);

  const beforeClose = requests.length;
  await load('/shared.jpg');
  assert.equal(requests.length, beforeClose + 1, 'closing the viewer releases its compressed originals');
  console.log('Original cache: shared downloads/URLs, decoder eviction, byte/count limits, invalid responses and session cleanup passed');
} finally { clearViewerOriginalCache(); globalThis.fetch = fetchBefore; URL.revokeObjectURL = revokeBefore; }
