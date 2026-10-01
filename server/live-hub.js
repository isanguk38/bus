const IDLE_CLEANUP_MS = 5 * 60_000;
const QUOTA_RETRY_MS = 60_000;

// 노선별 실시간 채널.
// 보고 있는 사람이 있는 노선만 수집하고, 같은 노선을 여러 명이 보면 외부 API는 한 번만 호출해 결과를 나눠준다.
export class LiveHub {
  #channels = new Map();

  subscribe(source, routeId, send) {
    const key = `${source.id}:${routeId}`;
    let channel = this.#channels.get(key);
    if (!channel) {
      channel = { key, source, routeId, clients: new Set(), timer: null, cleanup: null, polling: false, last: null, fetchedAt: 0 };
      this.#channels.set(key, channel);
    }
    clearTimeout(channel.cleanup);
    channel.clients.add(send);

    // 최근 결과가 있으면 바로 보내고, 다음 수집은 원래 주기에 맞춘다 (새로고침해도 호출이 늘지 않음).
    if (channel.last) send(channel.last);
    if (!channel.timer && !channel.polling) {
      const age = Date.now() - channel.fetchedAt;
      this.#schedule(channel, Math.max(0, source.pollMs - age));
    }
    return () => this.#unsubscribe(channel, send);
  }

  stats() {
    return [...this.#channels.values()].map((c) => ({ key: c.key, clients: c.clients.size }));
  }

  #unsubscribe(channel, send) {
    channel.clients.delete(send);
    if (channel.clients.size > 0) return;
    clearTimeout(channel.timer);
    channel.timer = null;
    channel.cleanup = setTimeout(() => this.#channels.delete(channel.key), IDLE_CLEANUP_MS);
  }

  #schedule(channel, delay) {
    channel.timer = setTimeout(() => this.#poll(channel), delay);
  }

  async #poll(channel) {
    channel.timer = null;
    channel.polling = true;
    let nextDelay = channel.source.pollMs;
    try {
      const buses = await channel.source.getPositions(channel.routeId);
      channel.fetchedAt = Date.now();
      channel.last = { type: 'positions', fetchedAt: channel.fetchedAt, pollMs: channel.source.pollMs, buses };
      this.#broadcast(channel, channel.last);
    } catch (err) {
      const quotaExceeded = err.code === 'QUOTA_EXCEEDED';
      // 한도 초과는 외부 호출 없이 판단되므로 자주 확인해도 비용이 없다. 그 외 오류는 간격을 늘려 재시도한다.
      nextDelay = quotaExceeded ? QUOTA_RETRY_MS : channel.source.pollMs * 2;
      if (!quotaExceeded) console.warn(`[live] ${channel.key} 수집 실패:`, err.message);
      this.#broadcast(channel, { type: 'error', message: err.message, code: err.code ?? null });
    } finally {
      channel.polling = false;
      if (channel.clients.size > 0) this.#schedule(channel, nextDelay);
    }
  }

  #broadcast(channel, message) {
    for (const send of channel.clients) send(message);
  }
}
