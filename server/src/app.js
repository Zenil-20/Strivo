import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createErrorHandler, notFound } from './middleware/errorHandler.js';
import { createRateLimiters } from './middleware/rateLimiters.js';
import { createTvRouter } from './routes/tvRoutes.js';
import { createVideoRouter } from './routes/videoRoutes.js';
import { createConversionQueue } from './services/conversionQueue.js';

/**
 * The legacy (old-TV-browser) build puts one tiny inline loader script in index.html.
 * Instead of allowing ALL inline scripts ('unsafe-inline', which would defeat XSS protection),
 * the CSP allows exactly that script by its SHA-256 hash. Re-read when index.html changes,
 * so a rebuild while the server is running still works.
 */
function inlineScriptHashes(indexHtml) {
  let cache = { mtimeMs: -1, value: '' };
  return () => {
    try {
      const { mtimeMs } = fs.statSync(indexHtml);
      if (mtimeMs !== cache.mtimeMs) {
        const html = fs.readFileSync(indexHtml, 'utf8');
        // <script> tags WITHOUT a src attribute (note: data-src is not src).
        const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
          .map((m) => m[1])
          .filter((code) => code.trim())
          .map((code) => `'sha256-${crypto.createHash('sha256').update(code).digest('base64')}'`);
        cache = { mtimeMs, value: hashes.join(' ') };
      }
    } catch {
      cache = { mtimeMs: -1, value: '' }; // no build yet
    }
    return cache.value;
  };
}

// Builds the Express app without starting it (so tests can create their own instance).
export function createApp(config) {
  fs.mkdirSync(config.storageDir, { recursive: true });

  const app = express();
  const indexHtml = config.clientDistDir && path.join(config.clientDistDir, 'index.html');
  const conversionQueue = createConversionQueue(config);
  app.locals.conversionQueue = conversionQueue; // server.js re-queues unfinished work on startup

  app.use(
    helmet({
      // The React dev server runs on another port (same *site*), so allow the <video>
      // element there to load our stream.
      crossOriginResourcePolicy: { policy: 'same-site' },
      contentSecurityPolicy: {
        // On a home network the app runs over plain http://192.168.x.x. Helmet's default
        // "upgrade-insecure-requests" would make the browser try https:// and break everything.
        directives: {
          upgradeInsecureRequests: null,
          scriptSrc: ["'self'", ...(indexHtml ? [inlineScriptHashes(indexHtml)] : [])],
        },
      },
      // Same reason: HSTS must not be sent for a plain-HTTP LAN site.
      strictTransportSecurity: false,
    }),
  );

  // Only needed for `npm run dev` (Vite on :5173). In `npm start` the app is same-origin.
  app.use(
    cors({
      origin: config.clientUrl,
      methods: ['GET', 'HEAD', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Range', 'X-Delete-Token'],
      exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
    }),
  );

  // No JSON/urlencoded body parsers: the only request body we accept is the multipart upload.
  // Note: there is NO express.static for storage/ — videos are reachable only via /stream.

  app.get('/api/health', (req, res) => res.json({ success: true }));
  app.use('/api/videos', createVideoRouter(config, conversionQueue));
  // No-JavaScript pages for TV browsers too old to run the React app.
  app.use('/tv', createRateLimiters(config).apiLimiter, createTvRouter());

  // Serve the built React app, so phone, laptop and TV all use http://<laptop-ip>:5000
  if (indexHtml && fs.existsSync(indexHtml)) {
    app.use(express.static(config.clientDistDir, { index: false, maxAge: '1h' }));
    // Client-side routes (/, /upload, /watch/:id) all get index.html. Paths that look like
    // files (have an extension) or are under /api still 404, so nothing else leaks.
    app.get('/{*path}', (req, res, next) => {
      if (req.path.startsWith('/api/') || path.extname(req.path)) return next();
      res.set('Cache-Control', 'no-cache').sendFile(indexHtml);
    });
  }

  app.use(notFound);
  app.use(createErrorHandler(config));

  return app;
}
