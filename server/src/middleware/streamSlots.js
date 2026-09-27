import { createConcurrencyLimiter } from '../utils/concurrencyLimiter.js';

/**
 * Caps the number of streaming responses in flight across ALL users.
 * Each open stream costs a file descriptor, a small buffer and bandwidth;
 * past the cap we answer 503 immediately instead of degrading everyone.
 */
export function createStreamSlots(maxConcurrentStreams) {
  const limiter = createConcurrencyLimiter(maxConcurrentStreams);

  function streamSlots(req, res, next) {
    if (!limiter.tryAcquire()) {
      res.set('Retry-After', '2');
      return res.status(503).json({ success: false, message: 'Server is busy streaming, please retry shortly' });
    }
    // 'close' fires exactly once: when the response finished OR the viewer disconnected.
    // Either way the slot is freed, so slots can't leak.
    res.once('close', () => limiter.release());
    next();
  }

  streamSlots.limiter = limiter; // exposed for tests/inspection
  return streamSlots;
}
