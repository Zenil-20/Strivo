import crypto from 'node:crypto';

// 16 random bytes = 128 bits of entropy -> 22 URL-safe characters.
// Guessing a valid share ID is practically impossible (unlike /watch/1, /watch/2 ...).
export const generateShareId = () => crypto.randomBytes(16).toString('base64url');
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// The delete token is a secret given only to the uploader. We store just its hash,
// so a database leak does not let anyone delete videos.
export const generateDeleteToken = () => crypto.randomBytes(32).toString('base64url');
export const DELETE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function tokenMatchesHash(token, expectedHash) {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  // Constant-time comparison so response timing leaks nothing about the hash.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
