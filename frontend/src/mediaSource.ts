import type AVPlayer from "@libmedia/avplayer/AVPlayer";

type ReadBuffer = Parameters<InstanceType<typeof AVPlayer.IOLoader.CustomIOLoader>["read"]>[0];
const IO_END = -1048576;
const CACHE_BLOCK_BYTES = 256 * 1024;
const CACHE_FILE_BYTES = 32n * 1024n * 1024n;
const CACHE_TOTAL_BYTES = 64 * 1024 * 1024;
const CACHE_SOURCE_LIMIT = 32;
const EMPTY_BYTES = new Uint8Array(0);
type CachedSource = { length: bigint; blocks: Map<number, Uint8Array>; bytes: number };
const cachedSources = new Map<string, CachedSource>();
let cachedBytes = 0;
let recentSource = "";

// Retain compressed original bytes, independently of decoder lifetimes. Motion
// URLs include the file version, so replacements cannot reuse an older clip.
function cachedSource(source: string): CachedSource | undefined {
  const entry = cachedSources.get(source);
  if (entry && recentSource !== source) {
    cachedSources.delete(source);
    cachedSources.set(source, entry);
    recentSource = source;
  }
  return entry;
}

function cacheSource(source: string, length: bigint, start?: number, bytes?: Uint8Array) {
  if (length <= 0n || length > CACHE_FILE_BYTES) return;
  let entry = cachedSource(source);
  if (!entry) {
    entry = { length, blocks: new Map(), bytes: 0 };
    cachedSources.set(source, entry);
    recentSource = source;
  }
  if (start !== undefined && bytes && !entry.blocks.has(start)) {
    entry.blocks.set(start, bytes);
    entry.bytes += bytes.byteLength;
    cachedBytes += bytes.byteLength;
  }
  while (cachedBytes > CACHE_TOTAL_BYTES || cachedSources.size > CACHE_SOURCE_LIMIT) {
    const oldest = cachedSources.entries().next().value!;
    cachedBytes -= oldest[1].bytes;
    cachedSources.delete(oldest[0]);
  }
}

function cancelled() { return new DOMException("Playback cancelled", "AbortError"); }

// Keep original HTTP Range bytes seekable, including seeking exactly to EOF.
// The owner's abort signal also cancels HEAD requests before a reader exists.
function mediaReader(source: string, filename: string, signal: AbortSignal, retainBytes: boolean) {
  const input = new class {
    private request: AbortController | undefined;
    private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    private remaining: Uint8Array = EMPTY_BYTES;
    private position = 0n;
    private length = 0n;
    private generation = 0;
    private streamPosition = 0;
    private streamEnd = 0;

    get ext() { return filename.split(".").at(-1)?.toLowerCase() ?? ""; }
    get name() { return filename; }
    get flags() { return 2; } // Network IO; the file remains seekable.

    cancel() {
      this.generation++;
      this.cancelRequest();
    }

    private cancelRequest() {
      this.request?.abort();
      const reader = this.reader;
      if (reader) void reader.cancel().catch(() => {}).finally(() => reader.releaseLock());
      this.request = undefined;
      this.reader = undefined;
      this.remaining = EMPTY_BYTES;
    }

    private async fetch(method: string, range?: string) {
      if (signal.aborted) throw cancelled();
      const generation = this.generation;
      this.request = new AbortController();
      const response = await fetch(source, {
        method, headers: range ? { Range: range } : undefined,
        credentials: "same-origin", referrerPolicy: "no-referrer", signal: this.request.signal,
      });
      try {
        this.checkCurrent(generation);
        if (!response.ok) throw new Error(`视频加载失败 (${response.status})`);
        return response;
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
    }

    private checkCurrent(generation: number) {
      if (signal.aborted || generation !== this.generation) throw cancelled();
    }

    private async receive(generation: number) {
      const reader = this.reader!;
      while (true) {
        const { value, done } = await reader.read();
        this.checkCurrent(generation);
        this.remaining = value ?? EMPTY_BYTES;
        if (done) { reader.releaseLock(); this.reader = undefined; return false; }
        if (this.remaining.length) return true;
      }
    }

    private async openRange(start: bigint, end: bigint, generation: number, openEnded = false) {
      const response = await this.fetch("GET", `bytes=${start}-${openEnded ? "" : end - 1n}`);
      try {
        this.checkCurrent(generation);
        const valid = response.status === 206
          ? response.headers.get("content-range") === `bytes ${start}-${end - 1n}/${this.length}`
          : response.status === 200 && start === 0n && end === this.length;
        if (!valid || !response.body) throw new Error("服务器返回的视频分段不正确");
        this.reader = response.body.getReader();
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
    }

    private consume(buffer: ReadBuffer, offset = 0) {
      const count = Math.min(buffer.length - offset, this.remaining.length);
      buffer.set(this.remaining.subarray(0, count), offset);
      this.remaining = count < this.remaining.length ? this.remaining.subarray(count) : EMPTY_BYTES;
      return count;
    }

    async open() {
      const generation = this.generation;
      this.checkCurrent(generation);
      signal.addEventListener("abort", abort, { once: true });
      const cached = retainBytes ? cachedSource(source) : undefined;
      if (cached) { this.length = cached.length; return 0; }
      let response = await this.fetch("HEAD");
      this.checkCurrent(generation);
      let size = response.headers.get("content-length");
      if (!size) {
        response = await this.fetch("GET", "bytes=0-0");
        size = response.headers.get("content-range")?.split("/").at(-1) ?? null;
        await response.body?.cancel();
      }
      this.checkCurrent(generation);
      if (!size || !/^\d+$/.test(size)) throw new Error("无法读取视频文件长度");
      this.length = BigInt(size);
      if (retainBytes) cacheSource(source, this.length);
      return 0;
    }

    private async readCached(buffer: ReadBuffer, generation: number) {
      const position = Number(this.position);
      const start = Math.floor(position / CACHE_BLOCK_BYTES) * CACHE_BLOCK_BYTES;
      const length = Number(this.length);
      const entry = cachedSource(source);
      let bytes = entry?.blocks.get(start);
      if (!bytes) {
        if (!this.reader || this.streamPosition !== start) {
          this.cancelRequest();
          // Stream consecutive missing blocks in one request. Demuxers often
          // read the MOV footer first; stop before that already-cached range.
          this.streamEnd = length;
          for (const offset of entry?.blocks.keys() ?? []) {
            if (offset > start && offset < this.streamEnd) this.streamEnd = offset;
          }
          await this.openRange(BigInt(start), BigInt(this.streamEnd), generation);
          this.checkCurrent(generation);
          this.streamPosition = start;
        }
        // Retain complete blocks as the stream arrives; an aborted partial block
        // cannot masquerade as a successful read on the next playback.
        bytes = new Uint8Array(Math.min(CACHE_BLOCK_BYTES, length - start));
        let written = 0;
        while (written < bytes.length) {
          if (!this.remaining.length && !await this.receive(generation)) throw new Error("视频分段未完整加载，请重试");
          this.checkCurrent(generation);
          if (this.remaining.length > this.streamEnd - this.streamPosition) {
            throw new Error("服务器返回的视频分段不正确");
          }
          written += this.consume(bytes, written);
          this.streamPosition = start + written;
        }
        if (this.streamPosition === this.streamEnd) {
          if (await this.receive(generation)) throw new Error("服务器返回的视频分段不正确");
          this.checkCurrent(generation);
        }
        cacheSource(source, this.length, start, bytes);
      }
      const data = bytes.subarray(position - start, position - start + buffer.length);
      buffer.set(data);
      this.position += BigInt(data.length);
      return data.length;
    }

    private async readStream(buffer: ReadBuffer, generation: number) {
      if (!this.remaining.length) {
        if (!this.reader) {
          await this.openRange(this.position, this.length, generation, true);
          this.checkCurrent(generation);
        }
        if (!await this.receive(generation)) throw new Error("视频分段未完整加载，请重试");
        this.checkCurrent(generation);
      }
      if (BigInt(this.remaining.length) > this.length - this.position) {
        throw new Error("服务器返回的视频分段不正确");
      }
      const count = this.consume(buffer);
      if (this.position + BigInt(count) === this.length) {
        if (await this.receive(generation)) throw new Error("服务器返回的视频分段不正确");
        this.checkCurrent(generation);
      }
      this.position += BigInt(count);
      return count;
    }

    async read(buffer: ReadBuffer) {
      if (signal.aborted || this.position >= this.length) return IO_END;
      if (!buffer.length) return 0;
      const generation = this.generation;
      try {
        return retainBytes && this.length <= CACHE_FILE_BYTES
          ? await this.readCached(buffer, generation)
          : await this.readStream(buffer, generation);
      } catch (error) {
        // A failed read releases its stream so retrying at the same position
        // can recover. An old request must never cancel a newer seek's stream.
        if (generation === this.generation) this.cancelRequest();
        throw error;
      }
    }

    async seek(position: bigint) {
      if (signal.aborted || position < 0n || position > this.length) return -10;
      if (position !== this.position) { this.cancel(); this.position = position; }
      return 0;
    }
    async size() { return this.length; }
    async stop() { signal.removeEventListener("abort", abort); this.cancel(); }
  }();
  const abort = () => input.cancel();
  return input;
}

export function createMediaSource(Player: typeof AVPlayer, source: string, filename: string, signal: AbortSignal, retainBytes = false) {
  const reader = mediaReader(source, filename, signal, retainBytes);
  return new class extends Player.IOLoader.CustomIOLoader {
    get ext() { return reader.ext; }
    get name() { return reader.name; }
    get flags() { return reader.flags; }
    open() { return reader.open(); }
    read(buffer: ReadBuffer) { return reader.read(buffer); }
    seek(position: bigint) { return reader.seek(position); }
    size() { return reader.size(); }
    stop() { return reader.stop(); }
  }();
}

// Native Live Photos and the compatibility decoder share the same bounded,
// versioned byte cache. Large clips retain browser streaming instead of blobs.
export async function motionBlob(source: string, signal: AbortSignal): Promise<Blob | undefined> {
  const reader = mediaReader(source, "motion.mov", signal, true);
  try {
    await reader.open();
    const length = await reader.size();
    if (length > CACHE_FILE_BYTES) return;
    if (length <= 0n) throw new Error("实况片段为空");
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let position = 0; position < Number(length);) {
      if (signal.aborted) throw cancelled();
      const buffer = new Uint8Array(Math.min(CACHE_BLOCK_BYTES, Number(length) - position));
      const count = await reader.read(buffer);
      if (count !== buffer.length) throw new Error("实况片段未完整加载，请重试");
      parts.push(buffer);
      position += count;
    }
    if (signal.aborted) throw cancelled();
    return new Blob(parts, { type: "video/mp4" });
  } finally { await reader.stop(); }
}
