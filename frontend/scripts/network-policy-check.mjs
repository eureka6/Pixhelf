import assert from "node:assert/strict";
import { build } from "esbuild";

const output = await build({ entryPoints: [new URL("../src/app/visiblePolling.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
const { startVisiblePolling } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const timers = new Map();
let serial = 0;
globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window = Object.assign(new EventTarget(), {
  setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
});
Object.defineProperty(navigator, "onLine", { configurable: true, writable: true, value: true });
const tick = () => {
  assert.equal(timers.size, 1, "at most one poll is scheduled");
  const [id, timer] = timers.entries().next().value;
  timers.delete(id);
  timer.callback();
  return timer.delay;
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const requests = [];
const stop = startVisiblePolling(signal => new Promise(resolve => requests.push({ signal, resolve })), 10_000);
window.dispatchEvent(new Event("pageshow"));
assert.equal(tick(), 10_000, "initial pageshow must preserve the bootstrap polling delay");
assert.equal(requests.length, 1);
assert.equal(timers.size, 0, "pending requests never overlap on an interval");
document.visibilityState = "hidden";
document.dispatchEvent(new Event("visibilitychange"));
assert(requests[0].signal.aborted, "hidden tabs cancel pending polls");
requests[0].resolve(10_000);
await settle();
assert.equal(timers.size, 0);
document.visibilityState = "visible";
document.dispatchEvent(new Event("visibilitychange"));
assert.equal(tick(), 0, "returning refreshes promptly");
window.dispatchEvent(new Event("pagehide"));
assert(requests[1].signal.aborted);
window.dispatchEvent(new Event("pageshow"));
tick();
requests[1].resolve(10_000);
await settle();
assert.equal(timers.size, 0, "a late cancelled result must not schedule an overlapping request");
requests[2].resolve(1500);
await settle();
assert.equal(tick(), 1500, "background job cadence follows the last response");
navigator.onLine = false;
window.dispatchEvent(new Event("offline"));
assert(requests[3].signal.aborted);
document.dispatchEvent(new Event("visibilitychange"));
assert.equal(timers.size, 0, "offline tabs do not retry in a loop");
navigator.onLine = true;
window.dispatchEvent(new Event("online"));
tick();
stop();
assert(requests[4].signal.aborted);
for (const request of requests) request.resolve(10_000);
window.dispatchEvent(new Event("online"));
window.dispatchEvent(new Event("pageshow"));
document.dispatchEvent(new Event("visibilitychange"));
await settle();
assert.equal(timers.size, 0, "cleanup removes listeners and delayed continuations");
console.log("Background polling: bootstrap delay, visibility, offline recovery, cancellation and stale results passed.");
