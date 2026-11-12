/**
 * 동일 종목·TF·페이지는 REST 한 번만. 멀티차트가 같이 조회해도 중앙에서 공유.
 */
export class ChartGate {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, {at: number; value: unknown}>();
  constructor(private readonly ttlMs = 8000) {}

  key(parts: Record<string, string | boolean | undefined>): string {
    return Object.entries(parts)
      .map(([k, v]) => `${k}=${v === undefined ? '' : String(v)}`)
      .join('|');
  }

  async load<T>(key: string, run: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = run()
      .then((value) => {
        this.cache.set(key, {at: Date.now(), value});
        this.inflight.delete(key);
        return value;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });
    this.inflight.set(key, p);
    return p;
  }
}
