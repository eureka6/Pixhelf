// Exercise the real publisher against two disposable loopback registries.
// The tiny model layer is a metadata fixture, not an inference model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "pixhelf-publish-check-"));
const publisher = fileURLToPath(new URL("./publish-image.sh", import.meta.url));
const source = await readFile(publisher, "utf8");
const setting = name => source.match(new RegExp(`^${name}=([a-z0-9-]+)$`, "m"))?.[1];
const revision = setting("model_revision"), checksum = setting("model_checksum"), vocab = setting("vocab_checksum");
assert.ok(revision && checksum && vocab);
const modelPath = `/opt/pixhelf/models/${setting("model_name")}`;
const cacheTag = `model-${revision}-v1`;
const children = [], proxies = [], requests = [];

async function run(command, args, extraEnv = {}, allowFailure = false) {
  const child = spawn(command, args, {
    cwd: directory, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const [code] = await once(child, "close");
  if (!allowFailure && code !== 0) throw new Error(`${command} ${args.join(" ")}: ${code}\n${stdout}\n${stderr}`);
  return { code, stdout: stdout.trim(), stderr };
}
const crane = process.argv[2] ? resolve(process.argv[2]) : (await run("sh", ["-c", "command -v crane"])).stdout;
const cli = async (...args) => (await run(crane, args)).stdout;

async function registry() {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(crane, ["registry", "serve", "--address", `127.0.0.1:${port}`], { stdio: "ignore" });
  children.push(child);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Test registry exited");
    if (await fetch(`http://127.0.0.1:${port}/v2/`).then(r => r.ok).catch(() => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, "registry startup");
  const proxy = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    const upstream = http.request({ hostname: "127.0.0.1", port, method: request.method, path: request.url, headers: request.headers }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on("error", error => response.destroy(error));
    request.pipe(upstream);
  });
  proxies.push(proxy);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return `127.0.0.1:${proxy.address().port}/pixhelf`;
}

try {
  const primary = await registry(), secondary = await registry();
  const fixture = join(directory, "model-root");
  await mkdir(fixture + modelPath, { recursive: true });
  await writeFile(join(fixture + modelPath, "model.safetensors"), "small registry model fixture\n");
  const modelTar = join(directory, "model.tar");
  await run("tar", ["-cf", modelTar, "-C", fixture, "opt"]);
  const rawBase = await cli("append", "--oci-empty-base", "--new_layer", modelTar, "--new_tag", `${primary}:${cacheTag}`);
  const base = await cli("mutate", rawBase,
    "--env", `PIXHELF_TEXT_SEARCH_MODEL=${modelPath}`,
    "--label", `io.pixhelf.model.revision=${revision}`,
    "--label", `io.pixhelf.model.sha256=${checksum}`,
    "--label", `io.pixhelf.model.vocab-sha256=${vocab}`);
  await cli("tag", base, cacheTag);
  const modelDigest = JSON.parse(await cli("manifest", base)).layers[0].digest;
  const modelReads = () => requests.filter(r => r.method === "GET" && r.url.endsWith(`/blobs/${modelDigest}`)).length;

  await mkdir(join(directory, "dist"));
  await mkdir(join(directory, "bin"));
  for (const arch of ["amd64", "arm64"]) await writeFile(join(directory, "dist", `pixhelf-${arch}-linux`), `application fixture ${arch}\n`);
  // A cache hit must never invoke curl. On a miss, supply corrupt bytes to
  // verify that the publisher rejects them before changing application tags.
  await writeFile(join(directory, "bin/curl"), `#!/bin/sh
printf 'download\\n' >> "$PIXHELF_TEST_DOWNLOAD_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then printf 'corrupt model fixture\\n' > "$2"; exit 0; fi
  shift
done
exit 1
`, { mode: 0o755 });
  await writeFile(join(directory, "bin/crane"), `#!/bin/sh
if [ "$PIXHELF_TEST_FAIL_COPY" = 1 ] && [ "$1" = copy ]; then exit 42; fi
exec "$PIXHELF_TEST_CRANE" "$@"
`, { mode: 0o755 });
  await writeFile(join(directory, "bin/sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const downloadLog = join(directory, "downloads.log");
  const environment = {
    PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    PIXHELF_TEST_CRANE: crane, PIXHELF_TEST_DOWNLOAD_LOG: downloadLog,
    IMAGE: primary, DOCKERHUB_IMAGE: secondary, IMAGE_ARCHITECTURES: "amd64 arm64",
    IMAGE_VERSION: "0.0.1", PUBLISH_LATEST: "true", REVISION: "a".repeat(40), SOURCE_URL: "https://example.invalid/pixhelf",
  };
  const publish = (overrides = {}, allowFailure = false) => run("sh", [publisher], { ...environment, ...overrides }, allowFailure);
  const digest = image => cli("digest", image);
  const missingTag = async image => assert.notEqual((await run(crane, ["digest", image], {}, true)).code, 0, image);

  await publish();
  const firstDigest = await digest(`${primary}:0.0.1`);
  assert.equal(await digest(`${secondary}:0.0.1`), firstDigest, "identical multi-platform images at both registries");
  const index = JSON.parse(await cli("manifest", `${primary}@${firstDigest}`));
  assert.deepEqual(index.manifests.map(m => m.platform.architecture).sort(), ["amd64", "arm64"]);
  for (const entry of index.manifests) {
    const manifest = JSON.parse(await cli("manifest", `${primary}@${entry.digest}`));
    assert.equal(manifest.layers.length, 2);
    assert.equal(manifest.layers[0].digest, modelDigest);
  }
  assert.ok(modelReads() > 0, "first copy transfers the missing model to the second registry");

  const beforeWarm = modelReads();
  await writeFile(join(directory, "dist/pixhelf-amd64-linux"), "updated application fixture\n");
  const warm = await publish({ IMAGE_VERSION: "0.0.2" });
  assert.match(warm.stdout, /\[cache\] Reusing model base/);
  assert.equal(modelReads(), beforeWarm, "warm publication must not download the model blob");
  assert.equal(await readFile(downloadLog, "utf8").catch(() => ""), "", "no Hugging Face download on cache hits");
  const stableDigest = await digest(`${primary}:latest`);
  assert.notEqual(stableDigest, firstDigest, "updated application published");
  assert.equal(await digest(`${secondary}:latest`), stableDigest);

  const failed = await publish({ IMAGE_VERSION: "0.0.3", PIXHELF_TEST_FAIL_COPY: "1" }, true);
  assert.notEqual(failed.code, 0);
  for (const repo of [primary, secondary]) {
    assert.equal(await digest(`${repo}:latest`), stableDigest, "failed copy preserves latest");
    await missingTag(`${repo}:0.0.3`);
  }

  await publish({ IMAGE_VERSION: "latest", IMAGE_ARCHITECTURES: "amd64", DOCKERHUB_IMAGE: "", PUBLISH_LATEST: "false" });
  const single = JSON.parse(await cli("manifest", `${primary}:latest`));
  assert.deepEqual(single.manifests.map(m => m.platform.architecture), ["amd64"]);
  const localDigest = await digest(`${primary}:latest`);

  const invalidBase = await cli("mutate", base, "--label", "io.pixhelf.model.sha256=wrong");
  await cli("tag", invalidBase, cacheTag);
  const invalid = await publish({}, true);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stdout, /FAILED/);
  assert.equal(await digest(`${primary}:latest`), localDigest, "invalid cache and corrupt download preserve latest");
  const cold = await publish({ IMAGE: `${primary}-empty` }, true);
  assert.notEqual(cold.code, 0);
  assert.match(cold.stdout, /FAILED/);
  await missingTag(`${primary}-empty:0.0.1`);
  assert.equal((await readFile(downloadLog, "utf8")).trim().split("\n").length, 2);
  console.log("Publisher passed: two registries, both architectures, zero model downloads on warm runs, single-architecture mode, failed-copy tag protection, and invalid-cache/download rejection");
} finally {
  for (const proxy of proxies) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  for (const child of children) {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
  await rm(directory, { recursive: true, force: true });
}
