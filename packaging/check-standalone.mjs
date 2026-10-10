import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "target/x86_64-unknown-linux-musl/release/pixhelf");
const directory = await mkdtemp(join(tmpdir(), "pixhelf-standalone-"));
const gallery = join(directory, "gallery"), cache = join(directory, "cache");
let backend, log = "";
const fixtures = new URL("../frontend/scripts/fixtures/", import.meta.url);
async function waitFor(fn, description) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (backend?.exitCode != null) throw new Error(`Server exited: ${log}`);
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}\n${log}`);
}
try {
  await mkdir(gallery);
  for (const [from, to] of [
    ["live-photo.heic", "photo.heic"], ["live-photo.mp4", "photo.mov"],
    ["live-photo.mp4", "h264.mp4"], ["live-photo-hevc.mov", "hevc.mov"],
    ["av1.webm", "av1.webm"],
  ]) await copyFile(new URL(from, fixtures), join(gallery, to));
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  backend = spawn(binary, ["--gallery-dir", gallery, "--cache-dir", cache, "--listen", `127.0.0.1:${port}`, "--text-search-model", "false"], {
    cwd: directory,
    // Deliberately provide neither a command search path nor library locations.
    env: { PATH: "/nonexistent", LD_LIBRARY_PATH: "/nonexistent", PIXHELF_AUTH_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.on("error", error => { log += error.message; });
  for (const stream of [backend.stdout, backend.stderr]) stream.on("data", data => { log = (log + data).slice(-20_000); });
  await waitFor(() => fetch(`${origin}/api/health`).then(response => response.ok).catch(() => false), "startup");
  const listing = await waitFor(async () => {
    const response = await fetch(`${origin}/api/images`);
    if (!response.ok) return false;
    const result = await response.json();
    return result.total === 4 && result;
  }, "HEIC, H.264, HEVC and AV1 indexing");
  for (const item of listing.items) {
    await waitFor(async () => {
      const response = await fetch(`${origin}/api/images/${item.id}/thumbnail`);
      return response.ok && (await response.arrayBuffer()).byteLength > 100;
    }, `${item.name} thumbnail`);
    if (item.video) {
      for (const url of [item.preview, item.playback]) {
        assert.ok(url);
        const data = await waitFor(async () => {
          const response = await fetch(origin + url);
          return response.status === 200 && Buffer.from(await response.arrayBuffer());
        }, `${item.name} transcoding`);
        assert.equal(data.toString("ascii", 4, 8), "ftyp");
        assert.ok(data.length > 100);
      }
    } else {
      assert.deepEqual([item.width, item.height], [120, 90]);
      const display = await fetch(origin + item.display);
      assert.equal(display.status, 200);
      assert.equal(display.headers.get("content-type"), "image/jpeg");
      assert.ok((await display.arrayBuffer()).byteLength > 100);
      const original = await fetch(`${origin}/api/images/${item.id}.heic`);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), await readFile(new URL("live-photo.heic", fixtures)));
      const motion = await fetch(origin + item.motion);
      assert.deepEqual(Buffer.from(await motion.arrayBuffer()), await readFile(new URL("live-photo.mp4", fixtures)));
    }
  }
  console.log("Standalone passed: empty PATH, HEIC/live originals, H.264/HEVC/AV1 thumbnails, previews and playback");
} finally {
  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await new Promise(resolve => {
      const timer = setTimeout(() => backend.kill("SIGKILL"), 5000);
      backend.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await rm(directory, { recursive: true, force: true });
}
