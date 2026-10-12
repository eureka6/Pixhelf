import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp('/tmp/pixhelf-duplicate-startup-');
const gallery = join(directory, 'gallery'), cache = join(directory, 'cache');
const binary = process.env.PIXHELF_TEST_BINARY ?? join(project, 'target/debug/pixhelf');
let backend;
async function stop() {
  if (backend?.exitCode === null) {
    const stopped = new Promise(resolve => backend.once('exit', resolve));
    backend.kill('SIGTERM'); await stopped;
  }
}
async function start(expected = 120) {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let log = '';
  backend = spawn(binary, ['--gallery-dir', gallery, '--cache-dir', cache, '--listen', `127.0.0.1:${port}`, '--text-search-model', 'false', '--scan-interval', '60'], {
    cwd: directory, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PIXHELF_'))), PIXHELF_AUTH_ENABLED: 'false', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [backend.stdout, backend.stderr]) stream.on('data', data => { log = (log + data).slice(-24000).replace(/\x1b\[[0-9;]*m/g, ''); });
  const deadline = Date.now() + 30000;
  // Do not visit the duplicates endpoint until startup warmup has finished.
  while (!log.includes('重复图片后台检查完成')) {
    if (Date.now() > deadline || backend.exitCode !== null) throw new Error(`Background scan did not finish:\n${log}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const line = log.split('\n').find(line => line.includes('重复图片后台检查完成'));
  const stats = Object.fromEntries(['hashed', 'decoded', 'reused', 'elapsed_ms'].map(key => [key, Number(line.match(new RegExp(`${key}=(\\d+)`))?.[1])]));
  const result = await fetch(`${origin}/api/images/duplicates?plan=true&limit=1`).then(response => response.json());
  assert.equal(result.scanning, false);
  assert.equal(result.groups.length, 1);
  assert.equal(result.plan.length, 1);
  assert.equal(result.plan[0].images.length, expected);
  return stats;
}
try {
  await mkdir(gallery);
  for (let i = 0; i < 120; i++) await copyFile(join(project, 'frontend/scripts/fixtures/live-photo.jpg'), join(gallery, `copy-${i}.jpg`));
  const cold = await start();
  assert.equal(cold.hashed, 120);
  assert.equal(cold.decoded, 1, 'identical copies share one image decode');
  await stop();
  const warm = await start();
  assert.equal(warm.hashed, 0, 'restart does not reread unchanged originals');
  assert.equal(warm.decoded, 0, 'restart reuses verified pixel fingerprints');
  assert.equal(warm.reused, 120);
  await stop();
  await copyFile(join(project, 'frontend/scripts/fixtures/live-photo.jpg'), join(gallery, 'added.jpg'));
  const added = await start(121);
  assert.equal(added.hashed, 1, 'only the new file is read');
  assert.equal(added.decoded, 0, 'a new byte-identical copy reuses the existing pixel result');
  assert.equal(added.reused, 120);
  console.log(JSON.stringify({ images: 120, startupWithoutPageVisit: true, cold, restart: warm, addedCopy: added }, null, 2));
} finally { await stop(); await rm(directory, { recursive: true, force: true }); }
