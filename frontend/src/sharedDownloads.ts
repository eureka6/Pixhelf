type Download<T> = { controller: AbortController; promise: Promise<T>; owners: number };

// Share in-flight work without giving one consumer ownership of another's IO.
export class SharedDownloads<T> {
  private readonly pending = new Map<string, Download<T>>();

  get(source: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let download = this.pending.get(source);
    if (!download || download.controller.signal.aborted) {
      const controller = new AbortController();
      const current: Download<T> = { controller, owners: 0, promise: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return load(controller.signal);
      }) };
      current.promise = current.promise.finally(() => {
        if (this.pending.get(source) === current) this.pending.delete(source);
      });
      this.pending.set(source, current);
      download = current;
    }
    const current = download;
    current.owners++;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal.removeEventListener("abort", abort);
        current.controller.signal.removeEventListener("abort", cancelled);
        current.owners--;
        // Component cleanup and its replacement can hand off the same download
        // within one commit, even when the previous owner releases first.
        queueMicrotask(() => {
          if (!current.owners && this.pending.get(source) === current) {
            this.pending.delete(source);
            current.controller.abort();
          }
        });
      };
      const abort = () => { release(); reject(signal.reason); };
      const cancelled = () => { release(); reject(current.controller.signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      current.controller.signal.addEventListener("abort", cancelled, { once: true });
      current.promise.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
    });
  }

  clear(): void {
    for (const download of this.pending.values()) download.controller.abort();
    this.pending.clear();
  }
}
