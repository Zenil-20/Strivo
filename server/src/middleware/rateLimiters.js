import { rateLimit } from 'express-rate-limit';

// Separate buckets so heavy video watching can't block uploads (and vice versa).
// The store is in memory: fine for one server, resets on restart.
function limiter({ windowMs, limit }, message) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8', // RateLimit / RateLimit-Policy headers
    legacyHeaders: false,
    message: { success: false, message },
  });
}

export function createRateLimiters(config) {
  const { upload, stream, api } = config.rateLimits;
  return {
    uploadLimiter: limiter(upload, 'Too many uploads, please try again later'),
    streamLimiter: limiter(stream, 'Too many video requests, please slow down'),
    apiLimiter: limiter(api, 'Too many requests, please try again later'),
  };
}
