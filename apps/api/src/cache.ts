/**
 * In-memory TTL cache. Concurrent getOrLoad calls for the same key share one
 * load, and a failed load is not cached.
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

  async getOrLoad(key: string, ttlMs: number, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const promise = load()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
