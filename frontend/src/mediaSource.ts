import type AVPlayer from "@libmedia/avplayer/AVPlayer";

type ReadBuffer = Parameters<InstanceType<typeof AVPlayer.IOLoader.CustomIOLoader>["read"]>[0];
const IO_END = -1048576;

// Keep original HTTP Range bytes seekable, including seeking exactly to EOF.
// The owner's abort signal also cancels HEAD requests before a reader exists.
export function createMediaSource(Player: typeof AVPlayer, source: string, filename: string, signal: AbortSignal) {
  const input = new class extends Player.IOLoader.CustomIOLoader {
    private request: AbortController | undefined;
    private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    private remaining: Uint8Array = new Uint8Array(0);
    private position = 0n;
    private length = 0n;

    get ext() { return filename.split(".").at(-1)?.toLowerCase() ?? ""; }
    get name() { return filename; }
    get flags() { return 2; } // Network IO; the file remains seekable.

    cancel() {
      this.request?.abort();
      void this.reader?.cancel().catch(() => {});
      this.reader = undefined;
      this.remaining = new Uint8Array(0);
    }

    private async fetch(method: string, range?: string) {
      if (signal.aborted) throw new DOMException("Playback cancelled", "AbortError");
      this.request = new AbortController();
      const response = await fetch(source, {
        method, headers: range ? { Range: range } : undefined,
        credentials: "same-origin", referrerPolicy: "no-referrer", signal: this.request.signal,
      });
      if (!response.ok) throw new Error(`视频加载失败 (${response.status})`);
      return response;
    }

    async open() {
      let response = await this.fetch("HEAD");
      let size = response.headers.get("content-length");
      if (!size) {
        response = await this.fetch("GET", "bytes=0-0");
        size = response.headers.get("content-range")?.split("/").at(-1) ?? null;
        await response.body?.cancel();
      }
      if (!size || !/^\d+$/.test(size)) throw new Error("无法读取视频文件长度");
      this.length = BigInt(size);
      return 0;
    }

    async read(buffer: ReadBuffer) {
      if (signal.aborted || this.position >= this.length) return IO_END;
      if (!this.remaining.length) {
        if (!this.reader) {
          const response = await this.fetch("GET", `bytes=${this.position}-`);
          if (this.position > 0n && response.status !== 206) throw new Error("服务器不支持视频进度跳转");
          this.reader = response.body!.getReader();
        }
        const { value, done } = await this.reader.read();
        if (done) return IO_END;
        this.remaining = value;
      }
      const count = Math.min(buffer.length, this.remaining.length);
      buffer.set(this.remaining.subarray(0, count));
      this.remaining = this.remaining.subarray(count);
      this.position += BigInt(count);
      return count;
    }

    async seek(position: bigint) {
      if (signal.aborted || position < 0n || position > this.length) return -10;
      if (position !== this.position) { this.cancel(); this.position = position; }
      return 0;
    }
    async size() { return this.length; }
    async stop() { this.cancel(); }
  }();
  signal.addEventListener("abort", () => input.cancel(), { once: true });
  return input;
}
