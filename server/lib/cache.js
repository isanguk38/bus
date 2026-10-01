// 만료 시간이 있는 캐시. 같은 키를 동시에 요청하면 외부 API는 한 번만 호출한다.
export class TtlCache {
  #entries = new Map();

  constructor(ttlMs, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key, load) {
    const hit = this.#entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.promise;

    const promise = load();
    this.#entries.set(key, { promise, expiresAt: Date.now() + this.ttlMs });
    if (this.#entries.size > this.maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    // 실패한 결과는 캐시에 남기지 않는다.
    promise.catch(() => {
      if (this.#entries.get(key)?.promise === promise) this.#entries.delete(key);
    });
    return promise;
  }
}
