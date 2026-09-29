import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import multer from 'multer';
import { AppError } from '../utils/AppError.js';
import { SUPPORTED_EXTENSIONS, getVideoFormat } from '../utils/videoFormats.js';

/**
 * Multer streams the multipart body straight to disk chunk by chunk,
 * so even a 20 GB upload never sits in server RAM.
 *
 * Multer itself deletes a partially written file when the size limit is hit
 * or the client disconnects halfway. Failures AFTER the file is written
 * (bad magic bytes, database error) are cleaned up by the controller.
 */
export function createUploadMiddleware(config) {
  const storage = multer.diskStorage({
    // A fixed server-side directory: the client cannot choose the path.
    destination: config.storageDir,
    // A random UUID filename; the extension is one from our allow-list (lower-cased).
    filename(req, file, cb) {
      cb(null, `${crypto.randomUUID()}${getVideoFormat(file.originalname).ext}`);
    },
  });

  const limits = { files: 1, fields: 1, fieldSize: 1024, parts: 2 }; // one file + "title"
  // No size cap unless MAX_VIDEO_SIZE_MB is set; exceeding it -> LIMIT_FILE_SIZE -> 413.
  if (config.maxVideoSizeBytes) limits.fileSize = config.maxVideoSizeBytes;

  return multer({
    storage,
    defParamCharset: 'utf8', // decode non-ASCII original filenames correctly
    limits,
    // Runs BEFORE any bytes are written. The browser's MIME type is ignored on purpose:
    // it is client-controlled and often empty for .mkv/.avi/.ts files.
    fileFilter(req, file, cb) {
      if (!getVideoFormat(file.originalname)) {
        return cb(new AppError(400, `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`));
      }
      cb(null, true);
    },
  }).single('video');
}

/**
 * Without a size cap, a single huge upload could fill the disk (and take MongoDB
 * and the OS down with it). Before accepting any bytes, compare the request size
 * with the free space, keeping MIN_FREE_DISK_MB in reserve. 507 = Insufficient Storage.
 */
export function createDiskSpaceGuard(config) {
  return async function diskSpaceGuard(req, res, next) {
    // Content-Length is absent for chunked transfer encoding (some browsers and
    // upload tools omit it). In that case incomingBytes = 0 and the guard passes.
    // This is an inherent HTTP/1.1 limitation: the full body size is not known
    // until all chunks arrive. The guard is still effective for the common case
    // of a browser sending a standard multipart upload with Content-Length.
    const incomingBytes = Number(req.get('Content-Length')) || 0;
    const { bavail, bsize } = await fs.statfs(config.storageDir);
    if (incomingBytes + config.minFreeDiskBytes > bavail * bsize) {
      return next(new AppError(507, 'Not enough free disk space on the server for this video'));
    }
    next();
  };
}
