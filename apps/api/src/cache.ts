/**
 * In-memory TTL cache. Concurrent getOrLoad calls for the same key share one
 * load, and a failed load is not cached. A caller can stop waiting with its
 * own signal without cancelling the shared load.
 */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expiresAt: number }>();
  private pending = new Map<string, Promise<V>>();

  constructor(private now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async getOrLoad(key: string, ttlMs: number, load: () => Promise<V>, signal?: AbortSignal): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    let promise = this.pending.get(key);
    if (!promise) {
      promise = load()
        .then((value) => {
          this.set(key, value, ttlMs);
          return value;
        })
        .finally(() => this.pending.delete(key));
      promise.catch(() => {}); // every waiter may have given up; don't leave it unhandled
      this.pending.set(key, promise);
    }
    return signal ? untilAborted(promise, signal) : promise;
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
