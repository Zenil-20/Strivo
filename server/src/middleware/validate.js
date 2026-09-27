import { z } from 'zod';
import { AppError } from '../utils/AppError.js';
import { DELETE_TOKEN_PATTERN, SHARE_ID_PATTERN } from '../utils/ids.js';

const shareIdSchema = z.string().regex(SHARE_ID_PATTERN);
const deleteTokenSchema = z.string().regex(DELETE_TOKEN_PATTERN);

export const uploadBodySchema = z.object({
  title: z
    .string()
    .trim()
    .max(100, 'Title must be at most 100 characters')
    .optional()
    .transform((t) => t || undefined),
});

// Reject malformed share IDs before touching the database.
export function validateShareId(req, res, next) {
  if (!shareIdSchema.safeParse(req.params.shareId).success) {
    return next(new AppError(400, 'Invalid share ID'));
  }
  next();
}

export function requireDeleteToken(req, res, next) {
  if (!deleteTokenSchema.safeParse(req.get('X-Delete-Token')).success) {
    return next(new AppError(401, 'A valid delete token is required'));
  }
  next();
}
