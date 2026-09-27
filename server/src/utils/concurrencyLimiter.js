/**
 * A tiny in-memory counting semaphore (no Redis needed for a single server).
 * It limits how many video streams are being served at the same moment.
 * Instead of queueing, it rejects immediately, so a busy server fails fast
 * and cheaply rather than piling up open connections.
 */
export function createConcurrencyLimiter(maxActive) {
  let active = 0;

  return {
    tryAcquire() {
      if (active >= maxActive) return false;
      active += 1;
      return true;
    },
    release() {
      active = Math.max(active - 1, 0);
    },
    get active() {
      return active;
    },
  };
}
