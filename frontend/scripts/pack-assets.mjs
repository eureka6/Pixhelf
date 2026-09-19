import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants } from "node:zlib";

const compress = promisify(brotliCompress), decompress = promisify(brotliDecompress);
const [assetsArgument, outputArgument] = process.argv.slice(2);
if (!assetsArgument || !outputArgument) throw new Error("Usage: pack-assets.mjs ASSETS_DIR OUTPUT_DIR");
const assets = resolve(assetsArgument), output = resolve(outputArgument);
const cache = new URL("../node_modules/.cache/pixhelf-packed-assets/", import.meta.url);
const maxGroupBytes = 8 * 1024 * 1024;
const paths = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) paths.push(path);
  }
}
await collect(join(assets, "libmedia"));
const groups = new Map();
for (const path of paths.sort()) {
  const name = relative(assets, path).split(sep).join("/");
  // Keep a decoder's plain/SIMD/atomic variants together to compress shared code.
  const key = name.endsWith(".wasm") ? name.replace(/-(simd|atomic)\.wasm$/, ".wasm") : "libmedia/player";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ name, path });
}
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const modules = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const entries = [];
let batch = [], batchBytes = 0;
for (const [name, sources] of modules) {
  const sizes = await Promise.all(sources.map(async source => (await stat(source.path)).size));
  const length = sizes.reduce((total, size) => total + size, 0);
  if (length > maxGroupBytes) throw new Error(`Asset module exceeds 8 MiB: ${name}`);
  if (!name.endsWith(".wasm")) { entries.push(sources); continue; }
  // Adjacent modules also share Wasm runtime code. Bound each group so loading
  // one asset needs at most 8 MiB of output and two groups fit the runtime cache.
  if (batchBytes + length > maxGroupBytes && batch.length) {
    entries.push(batch); batch = []; batchBytes = 0;
  }
  batch.push(...sources); batchBytes += length;
}
if (batch.length) entries.push(batch);
const packed = new Array(entries.length);
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < entries.length) {
    const index = next++, sources = entries[index];
    const contents = await Promise.all(sources.map(source => readFile(source.path)));
    const raw = Buffer.concat(contents);
    if (raw.length > maxGroupBytes) throw new Error("Asset group changed while packing");
    const key = createHash("sha256").update(`brotli-${process.versions.brotli}-q11-w23\0`).update(raw).digest("hex");
    const cachedPath = new URL(`${key}.br`, cache);
    let compressed = await readFile(cachedPath).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    // Validate cached bytes so interrupted or corrupt build caches cannot ship.
    if (!compressed || !(await decompress(compressed, { maxOutputLength: raw.length }).catch(() => null))?.equals(raw)) {
      compressed = await compress(raw, { params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 23,
      } });
      const temporary = new URL(`${key}.${process.pid}.${index}.tmp`, cache);
      await writeFile(temporary, compressed);
      await rename(temporary, cachedPath);
    }
    const filename = `${index}.br`;
    await writeFile(join(output, filename), compressed);
    let offset = 0;
    const files = sources.map((source, i) => {
      const file = { name: source.name, offset, length: contents[i].length };
      offset += file.length;
      return file;
    });
    packed[index] = { filename, length: raw.length, compressedLength: compressed.length, files };
  }
}));
await writeFile(join(output, "manifest.json"), JSON.stringify(packed));
const size = field => packed.reduce((total, group) => total + group[field], 0);
console.log(`Packed ${paths.length} libmedia assets in ${packed.length} groups: ${size("length")} -> ${size("compressedLength")} bytes`);
