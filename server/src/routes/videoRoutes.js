import { Router } from 'express';
import { createVideoController } from '../controllers/videoController.js';
import { createRateLimiters } from '../middleware/rateLimiters.js';
import { createStreamSlots } from '../middleware/streamSlots.js';
import { createDiskSpaceGuard, createUploadMiddleware } from '../middleware/upload.js';
import { requireDeleteToken, validateShareId } from '../middleware/validate.js';

// Middleware order matters: cheap checks (rate limit, validation) run before
// expensive work (disk writes, DB queries, opening files).
export function createVideoRouter(config, conversionQueue) {
  const router = Router();
  const controller = createVideoController(config, conversionQueue);
  const { uploadLimiter, streamLimiter, apiLimiter } = createRateLimiters(config);
  const upload = createUploadMiddleware(config);
  const diskSpaceGuard = createDiskSpaceGuard(config);
  const streamSlots = createStreamSlots(config.maxConcurrentStreams);

  router.get('/', apiLimiter, controller.listVideos);
  router.post('/upload', uploadLimiter, diskSpaceGuard, upload, controller.uploadVideo);
  router.get('/:shareId/stream', streamLimiter, validateShareId, streamSlots, controller.streamVideo);
  router.get('/:shareId/subtitles/:index', apiLimiter, validateShareId, controller.getSubtitle);
  router.get('/:shareId', apiLimiter, validateShareId, controller.getVideo);
  router.delete('/:shareId', apiLimiter, validateShareId, requireDeleteToken, controller.deleteVideo);
  // Delete all videos — confirmation is handled in the UI ("Are you sure?").
  router.delete('/', apiLimiter, controller.deleteAllVideos);

  return router;
}
