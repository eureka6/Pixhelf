import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants } from "node:zlib";

const [sourceArg, outputArg, arch] = process.argv.slice(2);
if (!sourceArg || !outputArg || !["x86_64", "aarch64"].includes(arch)) {
  throw new Error("Usage: pack-media.mjs SOURCE_DIR OUTPUT_DIR x86_64|aarch64");
}
const source = resolve(sourceArg), output = resolve(outputArg);
const binaries = [];
for (const name of ["ffmpeg", "ffprobe"]) {
  const path = join(source, name), bytes = await readFile(path);
  if (bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== (arch === "x86_64" ? 62 : 183)) {
    throw new Error(`Invalid ${arch} ELF: ${name}`);
  }
  const headers = Number(bytes.readBigUInt64LE(32));
  const entrySize = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (entrySize < 56 || headers + count * entrySize > bytes.length) throw new Error("Invalid ELF program headers");
  for (let index = 0; index < count; index++) {
    const header = headers + index * entrySize, type = bytes.readUInt32LE(header);
    if (type === 3) throw new Error(`${name} requires a dynamic loader`);
    if (type === 2) {
      const offset = Number(bytes.readBigUInt64LE(header + 8));
      const size = Number(bytes.readBigUInt64LE(header + 32));
      if (offset + size > bytes.length) throw new Error("Invalid ELF dynamic segment");
      for (let at = offset; at + 16 <= offset + size; at += 16) {
        const tag = bytes.readBigInt64LE(at);
        if (tag === 0n) break;
        if (tag === 1n) throw new Error(`${name} requires a shared library`);
      }
    }
  }
  binaries.push(bytes);
}
// Shared codec code in the two programs compresses together. Decode once, then
// retain only the sealed executable memory files, not a second copy of the data.
const raw = Buffer.concat(binaries);
if (raw.length > 96 * 1024 * 1024) throw new Error("Media runtime exceeds 96 MiB uncompressed");
const hash = createHash("sha256").update(raw).digest("hex");
const cache = join(source, `${hash}.br`);
let packed = await readFile(cache).catch(error => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
if (!packed || !(await promisify(brotliDecompress)(packed, { maxOutputLength: raw.length }).catch(() => null))?.equals(raw)) {
  packed = await promisify(brotliCompress)(raw, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_LGWIN]: 24,
  } });
  const temporary = `${cache}.${process.pid}.tmp`;
  await writeFile(temporary, packed);
  await rename(temporary, cache);
}
await mkdir(output, { recursive: true });
const packedPath = join(output, "media-runtime.br");
await writeFile(packedPath, packed);
const licensePath = join(output, "media-licenses.txt");
const licenseFiles = ["COPYING.GPLv2", "COPYING.x264", "LICENSE.zlib", "COPYING.dav1d"];
await writeFile(licensePath, "Embedded FFmpeg 8.1.3, x264, dav1d 1.5.3 and zlib 1.3.2. Sources and reproducible build: packaging/build-media-runtime.sh.\n\n" +
  (await Promise.all(licenseFiles.map(async name => `${name}\n\n${await readFile(join(source, name), "utf8")}`))).join("\n\n"));
await writeFile(join(output, "media_runtime.rs"), [
  `const PACKED: &[u8] = include_bytes!(${JSON.stringify(packedPath)});`,
  `const LENGTHS: [usize; 2] = [${binaries.map(bytes => bytes.length).join(", ")}];`,
  `const SHA256: [u8; 32] = [${[...Buffer.from(hash, "hex")].join(", ")}];`,
  `pub(crate) const LICENSES: &str = include_str!(${JSON.stringify(licensePath)});`,
  "",
].join("\n"));
console.log(`Embedded media: ${raw.length} -> ${packed.length} bytes (${arch})`);
