import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

// Isolated real backends and browser tests for HTTPS and an ordinary, non-secure HTTP origin.
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.env.PIXHELF_TEST_BINARY ?? join(project, "target/debug/pixhelf");
async function checkAuthentication(protocol) {
  const directory = await mkdtemp(join(tmpdir(), "pixhelf-auth-check-"));
  const password = "browser-test-only-password";
  let backend;
  let browser;
  let proxy;
  const tunnels = new Set();
  let backendLog = "";

  function png(index) {
    const width = 96, height = 72;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = (index * 17 + x) % 256;
      raw[offset + 1] = (index * 31 + y) % 256;
      raw[offset + 2] = 120;
    }
    const chunk = (type, data) => {
      const contents = Buffer.concat([Buffer.from(type), data]);
      let crc = 0xffffffff;
      for (const byte of contents) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([length, contents, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  }

  async function listen(server) {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return server.address().port;
  }

  async function eventually(predicate, description, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}`);
  }

  try {
    await mkdir(join(directory, "gallery"));
    for (let index = 0; index < 32; index++) await writeFile(join(directory, "gallery", `fixture-${index}.png`), png(index));
    const hash = spawnSync(binary, ["--hash-password"], { input: `${password}\n`, encoding: "utf8" });
    assert.equal(hash.status, 0, hash.stderr);
    assert.match(hash.stdout.trim(), /^\$argon2id\$/);
    for (const args of [["--hash-password", "disallowed-argument"], ["--hash-password"]]) {
      const rejected = spawnSync(binary, args, { input: "short\n", encoding: "utf8" });
      assert.notEqual(rejected.status, 0, "unsafe password input accepted");
      assert.equal(rejected.stdout, "", "failed password generation printed a hash");
    }
    const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { encoding: "utf8" });
    assert.equal(certificate.status, 0, certificate.stderr);
    const reservation = net.createServer();
    const backendPort = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const forward = (request, response) => {
      const url = new URL(request.url, "http://pixhelf.test");
      const upstream = http.request({ hostname: "127.0.0.1", port: backendPort, path: url.pathname + url.search, method: request.method, headers: { ...request.headers, host: "pixhelf:3002", "x-forwarded-for": request.socket.remoteAddress, "x-forwarded-proto": "https" } }, result => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      });
      upstream.on("error", () => { response.writeHead(502); response.end(); });
      request.pipe(upstream);
    };
    proxy = protocol === "https"
      ? https.createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, forward)
      : http.createServer(forward);
    const proxyPort = await listen(proxy);
    proxy.on("connect", (request, downstream, head) => {
      if (protocol !== "http" || request.url !== `pixhelf.test:${proxyPort}`) { downstream.destroy(); return; }
      const upstream = net.connect({ host: "127.0.0.1", port: backendPort });
      tunnels.add(downstream);
      downstream.on("close", () => { tunnels.delete(downstream); upstream.destroy(); });
      downstream.on("error", () => upstream.destroy());
      upstream.on("error", () => downstream.destroy());
      upstream.on("close", () => downstream.destroy());
      upstream.once("connect", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
    });
    // A virtual host through the local HTTP proxy avoids localhost's secure-context exception.
    const contextOptions = protocol === "http" ? { proxy: { server: `http://127.0.0.1:${proxyPort}` } } : {};
    const origin = protocol === "https" ? `https://127.0.0.1:${proxyPort}` : `http://pixhelf.test:${proxyPort}`;
    const screenshotSuffix = protocol === "https" ? "" : "-http";
    const environment = { ...process.env, RUST_LOG: "warn" };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("PIXHELF_AUTH_") || ["PIXHELF_PUBLIC_URL", "PIXHELF_TRUSTED_PROXIES"].includes(key)) delete environment[key];
    }
    const startBackend = async () => {
      backendLog = "";
      backend = spawn(binary, ["--listen", `127.0.0.1:${backendPort}`, "--gallery-dir", join(directory, "gallery"), "--cache-dir", join(directory, "cache"), "--text-search-model", "false", "--workers", "1"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
      for (const stream of [backend.stdout, backend.stderr]) stream.on("data", chunk => { backendLog = (backendLog + chunk.toString()).slice(-16_000); });
      await eventually(async () => {
        assert.equal(backend.exitCode, null, backendLog);
        try { return (await fetch(`http://127.0.0.1:${backendPort}/api/health`)).ok; } catch { return false; }
      }, "backend startup");
    };
    await startBackend();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

    assert.equal(/setup code/i.test(backendLog), false, "startup still requires a setup code");
    const setupContext = await browser.newContext({ ...contextOptions, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 844 } });
    const setupPage = await setupContext.newPage();
    const setupErrors = [], setupPrivateRequests = [];
    let setupRequests = 0;
    setupPage.on("pageerror", error => setupErrors.push(error.message));
    setupPage.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/(gallery|images|status)/.test(path)) setupPrivateRequests.push(path);
      if (path === "/api/auth/setup") setupRequests++;
    });
    for (const width of [1440, 720, 390, 320]) {
      await setupPage.setViewportSize({ width, height: 844 });
      await setupPage.goto(origin);
      assert.equal(new URL(setupPage.url()).pathname, "/setup");
      await setupPage.getByRole("heading", { name: "创建管理员", exact: true }).waitFor();
      assert.equal(await setupPage.locator("#setup-username").inputValue(), "admin");
      assert.equal(await setupPage.locator("#setup-code").count(), 0);
      assert.equal(await setupPage.evaluate(() => isSecureContext), protocol === "https");
      assert.deepEqual(setupPrivateRequests, []);
      assert.equal(await setupPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await setupPage.waitForTimeout(250);
      await setupPage.screenshot({ path: join(tmpdir(), `pixhelf-setup${screenshotSuffix}-${width}.png`), fullPage: true });
    }
    await setupPage.locator("#setup-password").fill("short");
    await setupPage.locator(".login-submit").click();
    assert.equal(await setupPage.locator("#setup-password").evaluate(input => input.validity.tooShort), true);
    assert.equal(setupRequests, 0, "client submitted a password that is too short");
    await setupPage.locator("#setup-password").fill(password);
    await setupPage.getByRole("button", { name: "显示密码", exact: true }).click();
    assert.equal(await setupPage.locator("#setup-password").getAttribute("type"), "text");
    await setupPage.getByRole("button", { name: "隐藏密码", exact: true }).click();
    assert.equal((await setupContext.request.get(`${origin}/api/gallery`)).status(), 401);
    const beforeSetup = setupRequests;
    await setupPage.evaluate(() => { const form = document.querySelector("form"); form.requestSubmit(); form.requestSubmit(); });
    await setupPage.waitForURL(`${origin}/`);
    await setupPage.locator(".image-card").nth(24).waitFor();
    const setupCookie = (await setupContext.cookies()).find(cookie => cookie.name === "pixhelf-session");
    assert.ok(setupCookie?.httpOnly && setupCookie.sameSite === "Lax");
    assert.equal(setupCookie.secure, protocol === "https");
    assert.equal(setupRequests - beforeSetup, 1);
    const savedText = await readFile(join(directory, "cache/auth/account.json"), "utf8");
    const saved = JSON.parse(savedText);
    assert.equal(saved.publicOrigin, undefined);
    assert.equal(saved.username, "admin");
    assert.equal(savedText.includes(password), false);
    assert.match(saved.passwordHash, /^\$argon2id\$/);
    assert.equal((await setupContext.request.post(`${origin}/api/auth/setup`, { headers: { Origin: origin, "X-Pixhelf-Origin": origin }, data: { username: "attacker", password } })).status(), 409);
    assert.deepEqual(setupErrors, []);
    await setupContext.close();
    const exited = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM");
    await exited;
    // Simulate an existing installation initialized at a different domain, port and protocol.
    saved.publicOrigin = protocol === "https" ? "http://old-gallery.test:3002" : "https://old-gallery.test:8443";
    await writeFile(join(directory, "cache/auth/account.json"), JSON.stringify(saved));
    await startBackend();
    assert.equal((await (await fetch(`http://127.0.0.1:${backendPort}/api/auth/session`)).json()).setupRequired, undefined, "restart reopened initialization");
    console.log(JSON.stringify({ protocol, webSetup: true, noAuthEnvironment: true, noSetupCode: true, automaticAccessAddress: true, persistentAfterRestart: true }));

    const openSettings = async (page) => {
      const menu = page.locator(".gallery-sidebar-toggle");
      if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
      const panel = page.viewportSize().width <= 720 ? ".mobile-sidebar" : ".desktop-sidebar";
      await page.locator(`${panel} .sidebar-settings-button`).click();
      await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
    };

    for (const width of [1440, 720, 390, 320]) {
      const context = await browser.newContext({ ...contextOptions, ignoreHTTPSErrors: true, viewport: { width, height: 844 }, hasTouch: width <= 720 });
      const page = await context.newPage();
      const errors = [], privateRequests = [];
      let loginRequests = 0;
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error" && /Content Security Policy|violates.*directive/i.test(message.text())) errors.push(message.text()); });
      page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (/^\/api\/(gallery|images|status)/.test(path)) privateRequests.push(path);
        if (path === "/api/auth/login") loginRequests++;
      });
      await page.goto(origin);
      await page.getByRole("heading", { name: "登录 Pixhelf", exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/login");
      assert.equal(await page.locator(".image-card").count(), 0);
      assert.deepEqual(privateRequests, [], "login page fetched private data");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(tmpdir(), `pixhelf-login${screenshotSuffix}-${width}.png`) });
      await page.getByLabel("用户名", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "显示密码", exact: true }).click();
      assert.equal(await page.locator("#login-password").getAttribute("type"), "text");
      await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
      if (width === 1440) {
        await page.locator("#login-password").fill("wrong-password");
        await page.locator(".login-submit").click();
        await page.getByRole("alert").filter({ hasText: "用户名或密码不正确" }).waitFor();
        assert.equal(await page.locator("#login-password").inputValue(), "");
        assert.equal(await page.locator("#login-username").inputValue(), "admin");
        await page.locator("#login-password").fill(password);
        await page.route("**/api/auth/login", route => route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "1" }, body: JSON.stringify({ error: "尝试次数过多，请稍后再试" }) }), { times: 1 });
        await page.locator(".login-submit").click();
        await page.getByRole("button", { name: "1 秒后重试", exact: true }).waitFor();
        assert.equal(await page.locator(".login-submit").isDisabled(), true);
        await page.waitForFunction(() => !document.querySelector(".login-submit").disabled);
        await page.route("**/api/auth/login", route => route.fulfill({ status: 200, contentType: "text/html", body: "upstream error" }), { times: 1 });
        await page.locator(".login-submit").click();
        await page.getByRole("alert").filter({ hasText: "无效登录结果" }).waitFor();
        assert.equal(new URL(page.url()).pathname, "/login");
      }
      const beforeLogin = loginRequests;
      await page.evaluate(() => { const form = document.querySelector("form"); form.requestSubmit(); form.requestSubmit(); });
      await page.waitForURL(`${origin}/`);
      await page.locator(".image-card").nth(24).waitFor();
      assert.equal(loginRequests - beforeLogin, 1, "double submission sent multiple password checks");
      const cookie = (await context.cookies()).find(cookie => cookie.name === "pixhelf-session");
      assert.ok(cookie?.httpOnly && cookie.sameSite === "Lax" && cookie.path === "/");
      assert.equal(cookie.secure, protocol === "https");
      assert.equal(await page.evaluate(() => document.cookie.includes("pixhelf-session")), false);
      const session = await (await context.request.get(`${origin}/api/auth/session`)).json();
      assert.equal(session.authenticated, true);
      const images = await (await context.request.get(`${origin}/api/images`)).json();
      const original = `${origin}/api/images/${images.items[0].id}/original`;
      const media = await context.request.get(original, { headers: { Range: "bytes=0-7" } });
      assert.equal(media.status(), 206);
      assert.equal(media.headers()["cache-control"], "private, no-cache");

      assert.equal(session.canChangePassword, true);
      await openSettings(page);
      const dialog = page.getByRole("dialog", { name: "设置", exact: true });
      assert.equal(await dialog.evaluate(element => element.matches(":modal")), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await dialog.locator('[name="currentPassword"]').fill("wrong-current-password");
      assert.equal(await dialog.locator('[name="confirmPassword"]').count(), 0);
      assert.equal(await dialog.locator('[name="username"]').inputValue(), "admin");
      await dialog.locator('[name="newPassword"]').fill("short");
      await dialog.getByRole("button", { name: "保存账号", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "新密码至少需要 15 个字符" }).waitFor();
      await dialog.locator('[name="newPassword"]').fill("another-long-test-password");
      if (width === 1440) {
        await dialog.getByRole("button", { name: "保存账号", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "当前密码不正确" }).waitFor();
        assert.equal(await dialog.locator('[name="currentPassword"]').inputValue(), "");
        assert.equal((await context.request.get(original)).status(), 200);
      }
      await page.screenshot({ path: join(tmpdir(), `pixhelf-settings${screenshotSuffix}-${width}.png`) });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await openSettings(page);
      assert.equal(await page.locator('[name="newPassword"]').inputValue(), "", "closing settings retained password inputs");
      await dialog.locator(".settings-header h2").click();
      assert.equal(await dialog.isVisible(), true, "click inside settings closed the dialog");
      await page.mouse.click(2, 2);
      await dialog.waitFor({ state: "detached" });
      await openSettings(page);
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();

      // Leave an authenticated document in history to exercise back navigation after logout.
      await page.goto(`${origin}/?history-check=1`);
      await page.locator(".image-card").first().waitFor();

      const second = await context.newPage();
      await second.goto(origin);
      await second.locator(".image-card").first().waitFor();
      await page.bringToFront();
      const menu = page.locator(".gallery-sidebar-toggle");
      if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
      const panel = width <= 720 ? ".mobile-sidebar" : ".desktop-sidebar";
      const account = page.locator(`${panel} .sidebar-account-profile`);
      const settings = page.locator(`${panel} .sidebar-settings-button`);
      const signOut = page.locator(`${panel} .logout-button`);
      assert.equal(await signOut.count(), 0, "logout should appear only inside the account menu");
      assert.equal((await settings.textContent()).trim(), "", "settings should use only an icon");
      await account.click();
      await page.getByRole("menu", { name: "账号菜单", exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
      await page.keyboard.press("Escape");
      await signOut.waitFor({ state: "detached" });
      assert.equal(await menu.getAttribute("aria-expanded"), "true", "closing the account menu also closed navigation");
      assert.equal(await account.evaluate(element => document.activeElement === element), true);
      await account.press("ArrowDown");
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
      await page.keyboard.press("Tab");
      await signOut.waitFor({ state: "detached" });
      assert.equal(await settings.evaluate(element => document.activeElement === element), true);
      await account.click();
      await signOut.waitFor();
      await settings.click();
      await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
      assert.equal(await signOut.count(), 0, "opening settings left the account menu open");
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
      await account.click();
      await signOut.waitFor();
      await page.waitForTimeout(350);
      assert.equal(await signOut.evaluate(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), true, "logout is covered by navigation");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator(`${panel} .brand-lockup`).evaluate(brand => {
        const name = brand.querySelector(".brand-name");
        const box = name.getBoundingClientRect();
        return brand.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), true, "topbar covers the sidebar brand");
      await page.screenshot({ path: join(tmpdir(), `pixhelf-auth-sidebar${screenshotSuffix}-${width}.png`) });
      if (width === 1440) {
        const rejected = await context.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin, "X-Pixhelf-Origin": origin, "X-CSRF-Token": "forged" } });
        assert.equal(rejected.status(), 403);
        assert.equal((await context.request.get(original)).status(), 200);
        await page.route("**/api/auth/logout", route => route.fulfill({ status: 200, contentType: "text/html", body: "upstream error" }), { times: 1 });
        await signOut.click();
        await page.locator(`${panel} .sidebar-account-error`).filter({ hasText: "未能确认退出结果" }).waitFor();
        assert.equal((await context.request.get(original)).status(), 200, "a failed logout incorrectly invalidated the session");
      }
      await signOut.click();
      await page.waitForURL(`${origin}/login`);
      await second.waitForURL(`${origin}/login`);
      assert.equal((await context.cookies()).some(cookie => cookie.name === "pixhelf-session"), false, "browser retained the deleted session cookie");
      assert.equal((await context.request.get(original, { headers: { "If-None-Match": "*", Range: "bytes=0-7" } })).status(), 401);
      await page.goBack();
      await page.getByRole("heading", { name: "登录 Pixhelf", exact: true }).waitFor();
      assert.equal(await page.locator(".image-card").count(), 0);
      if (width === 320) {
        await page.locator("#login-username").fill("admin");
        await page.locator("#login-password").fill(password);
        await page.locator(".login-submit").click();
        await page.waitForURL(`${origin}/`);
        await page.locator(".image-card").first().waitFor();
        const activeSession = await (await context.request.get(`${origin}/api/auth/session`)).json();
        const revoked = await context.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin, "X-Pixhelf-Origin": origin, "X-CSRF-Token": activeSession.csrfToken } });
        assert.equal(revoked.status(), 204);
        // Revoke on the server without notifying the page, as on expiry. The image request must detect it.
        await page.locator(".image-card").first().click();
        await page.waitForURL(`${origin}/login?expired=1`);
        await page.getByRole("status").filter({ hasText: "登录已过期" }).waitFor();
      }
      assert.deepEqual(errors, []);
      await context.close();
      console.log(JSON.stringify({ protocol, width, login: true, cookieMatchesProtocol: true, protectedMedia: true, crossTabLogout: true, navigationAccessible: true }));
    }

    let currentPassword = password;
    let currentUsername = "admin";
    for (const width of [1440, 320]) {
      const stopped = new Promise(resolve => backend.once("exit", resolve));
      backend.kill("SIGTERM");
      await stopped;
      await startBackend();
      const context = await browser.newContext({ ...contextOptions, ignoreHTTPSErrors: true, viewport: { width, height: 844 }, hasTouch: width <= 720 });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin);
      await page.locator("#login-username").fill(currentUsername);
      await page.locator("#login-password").fill(currentPassword);
      await page.locator(".login-submit").click();
      await page.waitForURL(`${origin}/`);
      const second = await context.newPage();
      await second.goto(origin);
      const other = await browser.newContext({ ...contextOptions, ignoreHTTPSErrors: true });
      const otherLogin = await other.request.post(`${origin}/api/auth/login`, { headers: { Origin: origin, "X-Pixhelf-Origin": origin }, data: { username: currentUsername, password: currentPassword } });
      assert.equal(otherLogin.status(), 200);
      await page.bringToFront();
      await openSettings(page);
      const nextPassword = width === 1440 ? `${password}-${width}` : "";
      const nextUsername = `gallery-${width}`;
      await page.locator('[name="username"]').fill(nextUsername);
      await page.locator('[name="currentPassword"]').fill(currentPassword);
      await page.locator('[name="newPassword"]').fill(nextPassword);
      let submissions = 0;
      page.on("request", request => { if (new URL(request.url()).pathname === "/api/auth/password") submissions++; });
      await page.evaluate(() => { const form = document.querySelector(".password-settings-form"); form.requestSubmit(); form.requestSubmit(); });
      await page.waitForURL(`${origin}/login?accountChanged=1`);
      await page.getByRole("status").filter({ hasText: "账号信息已更新" }).waitFor();
      await second.waitForURL(url => url.pathname === "/login");
      assert.equal(submissions, 1, "double submission changed the password more than once");
      assert.equal((await context.cookies()).some(cookie => cookie.name === "pixhelf-session"), false);
      assert.equal((await other.request.get(`${origin}/api/gallery`)).status(), 401, "password change left another device logged in");
      const oldLogin = await other.request.post(`${origin}/api/auth/login`, { headers: { Origin: origin, "X-Pixhelf-Origin": origin }, data: { username: currentUsername, password: currentPassword } });
      assert.equal(oldLogin.status(), 401);
      currentPassword = nextPassword || currentPassword;
      currentUsername = nextUsername;
      assert.deepEqual(errors, []);
      await other.close();
      await context.close();
      console.log(JSON.stringify({ protocol, width, accountChanged: true, passwordKeptWhenBlank: width === 320, sessionsRevoked: true, doubleSubmissionPrevented: true }));
    }
    const stopped = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM");
    await stopped;
    await startBackend();
    const persisted = await browser.newContext({ ...contextOptions, ignoreHTTPSErrors: true });
    const result = await persisted.request.post(`${origin}/api/auth/login`, { headers: { Origin: origin, "X-Pixhelf-Origin": origin }, data: { username: currentUsername, password: currentPassword } });
    assert.equal(result.status(), 200, "changed password did not survive restart");
    const adminPage = await persisted.newPage();
    await adminPage.setViewportSize({ width: 1440, height: 844 });
    await adminPage.goto(origin);
    await openSettings(adminPage);
    await adminPage.route("**/api/auth/guest", route => route.fulfill({ status: 503, json: { error: "unavailable" } }), { times: 1 });
    await adminPage.getByRole("button", { name: "访客模式", exact: true }).click();
    await adminPage.getByRole("alert").filter({ hasText: "无法读取访客设置" }).waitFor();
    await adminPage.getByRole("button", { name: "重试", exact: true }).click();
    const guestSwitch = adminPage.getByRole("switch", { name: "免登录浏览", exact: true });
    await guestSwitch.waitFor();
    assert.equal(await guestSwitch.getAttribute("aria-checked"), "false");
    let captureSave;
    const receivedSave = new Promise(resolve => { captureSave = resolve; });
    await adminPage.route("**/api/auth/guest", captureSave, { times: 1 });
    await guestSwitch.click();
    const delayedSave = await receivedSave;
    assert(await guestSwitch.isDisabled());
    await adminPage.keyboard.press("Escape");
    await adminPage.mouse.click(2, 2);
    assert(await adminPage.locator(".settings-dialog").isVisible(), "saving guest settings must keep the dialog open");
    await delayedSave.fulfill({ status: 500, json: { error: "无法保存访客设置，请稍后重试" } });
    await adminPage.getByRole("alert").filter({ hasText: "无法保存访客设置" }).waitFor();
    assert.equal(await guestSwitch.getAttribute("aria-checked"), "false", "a failed save must not enable guest mode");
    assert.equal((await (await persisted.request.get(`${origin}/api/auth/guest`)).json()).enabled, false);
    await guestSwitch.click();
    await adminPage.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "cache/auth/guest.json"), "utf8")), { enabled: true });
    for (const width of [1440, 390, 320]) {
      await adminPage.setViewportSize({ width, height: 844 });
      const sizes = [];
      for (const label of ["账号安全", "外部存储", "关于", "访客模式"]) {
        await adminPage.locator(".settings-dialog").getByRole("button", { name: label, exact: true }).click();
        sizes.push(await adminPage.locator(".settings-dialog").boundingBox());
      }
      for (const size of sizes) {
        assert(Math.abs(size.width - sizes[0].width) < 1 && Math.abs(size.height - sizes[0].height) < 1);
        assert(size.x >= 10 && size.x + size.width <= width - 10);
      }
      await guestSwitch.waitFor();
      assert(await adminPage.locator(".settings-nav").evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await adminPage.screenshot({ path: join(tmpdir(), `pixhelf-guest-settings-${protocol}-${width}.png`), animations: "disabled" });
    }
    const visitors = [];
    const guestErrors = [];
    const navigation = async page => {
      const toggle = page.locator(".gallery-sidebar-toggle");
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      return page.locator(page.viewportSize().width <= 720 ? ".mobile-sidebar" : ".desktop-sidebar");
    };
    for (const width of [1440, 390, 320]) {
      const visitor = await browser.newContext({ ...contextOptions, ignoreHTTPSErrors: true, viewport: { width, height: 844 }, hasTouch: width <= 720 });
      const page = await visitor.newPage();
      page.on("pageerror", error => guestErrors.push(error.message));
      await page.goto(origin);
      await page.locator(".image-card").nth(24).waitFor();
      assert.equal(new URL(page.url()).pathname, "/", "guests must reach the gallery without a login step");
      assert.equal((await visitor.cookies()).some(cookie => cookie.name === "pixhelf-session"), false);
      assert.deepEqual(await (await visitor.request.get(`${origin}/api/auth/session`)).json(), { enabled: true, authenticated: false, guest: true });
      assert.equal((await visitor.request.get(`${origin}/api/storage/config`)).status(), 401);
      const nav = await navigation(page);
      assert(await nav.getByText("访客", { exact: true }).isVisible());
      assert.equal(await nav.getByRole("button", { name: "设置", exact: true }).count(), 0);
      assert.equal(await nav.getByRole("button", { name: "外部存储", exact: true }).count(), 0);
      assert(await nav.getByRole("link", { name: "管理员登录", exact: true }).isVisible());
      await page.screenshot({ path: join(tmpdir(), `pixhelf-guest-gallery-${protocol}-${width}.png`), animations: "disabled" });
      await nav.getByRole("button", { name: "相似图片", exact: true }).click();
      await page.getByLabel("上传查询图片").setInputFiles({ name: "guest-query.png", mimeType: "image/png", buffer: png(0) });
      await page.locator(".similar-search-page .image-card").first().waitFor();
      await page.locator(".similar-search-page .photo-card-open").first().click();
      await page.locator(".image-viewer").waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".image-viewer").waitFor({ state: "detached" });
      await (await navigation(page)).getByRole("link", { name: "管理员登录", exact: true }).click();
      await page.getByRole("heading", { name: "登录 Pixhelf", exact: true }).waitFor();
      assert.equal(await page.locator(".auth-story-caption").textContent(), "一隅光影，满架时光。");
      await page.screenshot({ path: join(tmpdir(), `pixhelf-guest-login-${protocol}-${width}.png`), animations: "disabled" });
      await page.getByRole("link", { name: "以访客身份浏览", exact: true }).click();
      await page.locator(".image-card").first().waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      visitors.push({ context: visitor, page });
    }
    const guestRestart = new Promise(resolve => backend.once("exit", resolve));
    backend.kill("SIGTERM");
    await guestRestart;
    await startBackend();
    for (const visitor of visitors) {
      await visitor.page.reload();
      await visitor.page.locator(".image-card").first().waitFor();
    }
    await adminPage.goto(`${origin}/login`);
    await adminPage.getByLabel("用户名", { exact: true }).fill(currentUsername);
    await adminPage.getByLabel("密码", { exact: true }).fill(currentPassword);
    await adminPage.getByRole("button", { name: "登录", exact: true }).click();
    await adminPage.waitForURL(`${origin}/`);
    await openSettings(adminPage);
    await adminPage.getByRole("button", { name: "访客模式", exact: true }).click();
    await adminPage.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
    await guestSwitch.click();
    await adminPage.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
    for (const visitor of visitors) {
      assert.equal((await visitor.context.request.get(`${origin}/api/gallery`)).status(), 401);
      await visitor.page.bringToFront();
      await visitor.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await visitor.page.waitForURL(`${origin}/login`);
      assert.equal(await visitor.page.getByRole("link", { name: "以访客身份浏览", exact: true }).count(), 0);
      await visitor.context.close();
    }
    assert.deepEqual(guestErrors, []);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "cache/auth/guest.json"), "utf8")), { enabled: false });
    await persisted.close();
    console.log(JSON.stringify({ protocol, guestWithoutPassword: true, guestSearch: true, adminOnlySettings: true, guestSettingsRetry: true, guestModePersists: true, guestRevocation: true }));
    console.log(`${protocol.toUpperCase()} setup, authentication and guest browser checks passed`);
  } catch (error) {
    console.error(backendLog);
    throw error;
  } finally {
    await browser?.close();
    for (const socket of tunnels) socket.destroy();
    proxy?.closeAllConnections();
    if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
    if (backend && backend.exitCode === null) {
      const exited = new Promise(resolve => backend.once("exit", resolve));
      backend.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

await checkAuthentication("https");
await checkAuthentication("http");
