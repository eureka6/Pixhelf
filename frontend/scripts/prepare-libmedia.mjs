import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../libmedia-assets.json", import.meta.url), "utf8"));
const cache = new URL(`../node_modules/.cache/libmedia-${manifest.version}/`, import.meta.url);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const pending = [...manifest.files];
let downloaded = 0;

// A clean build downloads pinned modules once; subsequent builds work offline.
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let entry; (entry = pending.shift());) {
    const target = new URL(entry.path, cache);
    const cached = await readFile(target).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (cached && cached.length === entry.size && digest(cached) === entry.sha256) continue;
    const response = await fetch(new URL(entry.path, manifest.baseUrl), { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`libmedia ${entry.path}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw new Error(`libmedia ${entry.path}: checksum mismatch`);
    await mkdir(new URL(".", target), { recursive: true });
    await writeFile(target, bytes);
    downloaded++;
  }
}));
if (downloaded) console.log(`libmedia ${manifest.version}: downloaded and verified ${downloaded} modules`);
