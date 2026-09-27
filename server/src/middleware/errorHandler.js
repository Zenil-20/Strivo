import multer from 'multer';
import { AppError } from '../utils/AppError.js';

export function notFound(req, res, next) {
  next(new AppError(404, 'Route not found'));
}

// Translate known error types into an HTTP status + a message that is safe to show.
function toStatusAndMessage(err, config) {
  if (err instanceof AppError) return [err.statusCode, err.message];

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return [413, `Video is larger than ${Math.round(config.maxVideoSizeBytes / 1024 / 1024)} MB`];
    }
    return [400, 'Invalid upload: send exactly one file in the "video" field'];
  }

  if (err.name === 'ZodError') return [400, err.issues?.[0]?.message ?? 'Invalid input'];
  if (err.code === 11000) return [409, 'Duplicate video ID, please retry the upload'];
  if (err.type === 'entity.too.large') return [413, 'Request too large'];
  // Malformed multipart body, client aborted the upload, etc.
  if (err.message === 'Unexpected end of form' || err.message === 'Request aborted') {
    return [400, 'Upload was interrupted'];
  }
  return [500, 'Internal server error'];
}

// Centralised error handler: every error ends up here and becomes clean JSON.
export function createErrorHandler(config) {
  // Express recognises error handlers by their 4 arguments.
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, next) {
    const [status, message] = toStatusAndMessage(err, config);

    if (status >= 500 && config.env !== 'test') console.error(err);

    // Mid-stream failure: headers are already sent, so we can only cut the connection.
    if (res.headersSent) return res.destroy();

    const body = { success: false, message };
    // Stack traces only outside production, never file paths in the message itself.
    if (config.env === 'development' && status >= 500) body.stack = err.stack;
    res.status(status).json(body);
  };
}
