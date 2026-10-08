import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./live-photo-fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "pixhelf-startup-check-"));
const binary = process.env.PIXHELF_TEST_BINARY ?? fileURLToPath(new URL("../../target/debug/pixhelf", import.meta.url));
const gallery = join(directory, "gallery"), cache = join(directory, "cache"), commands = join(directory, "bin");
const gate = join(directory, "scan"), password = "startup-regression-password";
let backend, browser;
let logs = "";

async function eventually(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Backend did not become responsive while scanning: ${logs}`);
}

async function exists(path) { return access(path).then(() => true, () => false); }

async function stop() {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise(resolve => backend.once("exit", resolve));
  backend.kill("SIGTERM");
  await exited;
}

try {
  await Promise.all([mkdir(gallery), mkdir(commands)]);
  await copyFile(new URL("fixtures/live-photo.jpg", import.meta.url), join(gallery, "photo.JPG"));
  await writeFile(join(gallery, "slow-scan.mp4"), "scanner fixture");
  // Hold a real scan at its video probe. The test controls completion, so login
  // must succeed before the scan can finish regardless of machine speed.
  await writeFile(join(commands, "ffprobe"), `#!/usr/bin/env python3
import os, pathlib, time
gate = pathlib.Path(os.environ["PIXHELF_SCAN_GATE"])
pathlib.Path(str(gate) + ".entered").touch()
deadline = time.monotonic() + 25
while not gate.exists() and time.monotonic() < deadline:
    time.sleep(0.05)
raise SystemExit(1)
`, { mode: 0o755 });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, PATH: `${commands}:${process.env.PATH}`, PIXHELF_SCAN_GATE: gate };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("PIXHELF_AUTH_") || ["PIXHELF_PUBLIC_URL", "PIXHELF_TRUSTED_PROXIES"].includes(key)) delete environment[key];
  }
  browser = await launchBrowser();
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push(new URL(request.url()).pathname));

  for (const mode of ["setup", "login"]) {
    await rm(gate, { force: true });
    await rm(`${gate}.entered`, { force: true });
    logs = "";
    backend = spawn(binary, ["--listen", `127.0.0.1:${port}`, "--gallery-dir", gallery, "--cache-dir", cache,
      "--text-search-model", "false", "--workers", "1", "--scan-interval", "3600"],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [backend.stdout, backend.stderr]) stream.on("data", bytes => { logs = (logs + bytes).slice(-16000); });
    await eventually(async () => {
      assert.equal(backend.exitCode, null, logs);
      if (!await exists(`${gate}.entered`)) return false;
      try { return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) })).ok; }
      catch { return false; }
    });
    requests.length = 0;
    const opened = performance.now();
    await page.goto(origin);
    await page.locator(`#${mode}-password`).waitFor();
    const loginReadyMs = Math.round(performance.now() - opened);
    assert.equal(new URL(page.url()).pathname, `/${mode}`);
    assert(!requests.some(path => path.includes("GalleryApp")), "login must not load gallery code or styles");
    assert.equal((await context.request.get(`${origin}/api/images`)).status(), 401);
    await page.locator(`#${mode}-username`).fill("admin");
    await page.locator(`#${mode}-password`).fill(password);
    await page.locator(".login-submit").click();
    await page.getByRole("heading", { name: "正在准备图库…", exact: true }).waitFor();
    assert.equal((await (await context.request.get(`${origin}/api/auth/session`)).json()).authenticated, true);
    assert.equal((await (await context.request.get(`${origin}/api/gallery`)).json()).initializing, true);
    assert.equal((await (await context.request.get(`${origin}/api/status`)).json()).backgroundComplete, false);
    const unavailable = await context.request.get(`${origin}/api/management`);
    assert.equal(unavailable.status(), 503);
    assert.equal(unavailable.headers()["retry-after"], "1");
    assert(!requests.some(path => path.includes("GalleryApp")), "pending scans must not mount gallery management");

    if (mode === "setup") await page.route("**/GalleryApp.js", route => route.abort(), { times: 1 });
    await writeFile(gate, "ready");
    if (mode === "setup") {
      await page.getByRole("heading", { name: "暂时无法打开图库", exact: true }).waitFor();
      await page.getByRole("button", { name: "重新加载", exact: true }).click();
    }
    const card = page.locator(".image-card").first();
    await card.waitFor();
    await page.locator(".startup-page").waitFor({ state: "detached" });
    assert(requests.some(path => path.endsWith("/GalleryApp.js")));
    assert(requests.some(path => path.endsWith("/GalleryApp.css")));
    await card.click({ button: "right" });
    const menu = page.locator(".photo-card-menu:popover-open");
    if (mode === "login") {
      await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("clipboard denied"); }; });
    }
    await menu.getByRole("menuitem", { name: "复制链接", exact: true }).click();
    await menu.getByRole("menuitem", { name: "已复制链接", exact: true }).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const id = await card.getAttribute("data-image-id");
    assert.equal(copied, `${origin}/api/images/${id}.jpg`);
    const original = await context.request.get(copied);
    assert.equal(original.status(), 200);
    assert.deepEqual(await original.body(), await readFile(join(gallery, "photo.JPG")));
    await menu.getByRole("menuitem", { name: "复制文件名", exact: true }).click();
    await menu.getByRole("menuitem", { name: "已复制文件名", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "photo.JPG");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode, loginReadyMs, authenticatedDuringScan: true, automaticGalleryEntry: true, copyImageLink: true, clipboardFallback: mode === "login", reloadAfterAssetFailure: mode === "setup" }));
    await stop();
  }
  await context.close();
} finally {
  await writeFile(gate, "release").catch(() => {});
  await browser?.close();
  await stop();
  await rm(directory, { recursive: true, force: true });
}
