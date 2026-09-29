import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { z } from 'zod';

const MB = 1024 * 1024;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .default('true')
  .transform((v) => v === 'true' || v === '1');

// Validate environment variables once at startup so a typo fails fast
// instead of causing strange behaviour later.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/video-sharing'),
  // Only needed for the Vite dev server (npm run dev). In `npm start` everything is same-origin.
  CLIENT_URL: z.url().default('http://localhost:5173'),
  // 0 = no upload size limit (the default). Set a number to cap uploads again.
  MAX_VIDEO_SIZE_MB: z.coerce.number().int().min(0).default(0),
  // Uploads are refused if they would leave less than this much free disk space.
  MIN_FREE_DISK_MB: z.coerce.number().int().min(0).default(1024),
  MAX_CONCURRENT_STREAMS: z.coerce.number().int().positive().default(20),
  // 0 (default) = answer "bytes=START-" with everything up to the end of the file.
  // Old TV players treat a shorter 206 answer as the END of the video (a 21 s clip stopped
  // after the first 1 MB = ~4 s and restarted). RAM is still safe: the file is streamed with
  // backpressure. Set e.g. 1 to cap each response (fine for modern browsers only).
  STREAM_CHUNK_SIZE_MB: z.coerce.number().min(0).max(50).default(0),
  // Optional comma-separated DNS servers for Node (see services/db.js).
  DNS_SERVERS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  // Convert uploads that TV browsers can't play into H.264/AAC MP4 (needs ffmpeg).
  TRANSCODE_ENABLED: booleanFlag,
  // Optional: use your own ffmpeg/ffprobe instead of the bundled ones.
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
});

export function loadConfig(env = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;

  const ffmpegPath = e.FFMPEG_PATH || ffmpegStaticPath;
  const ffprobePath = e.FFPROBE_PATH || ffprobeStatic?.path;

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    mongoUri: e.MONGODB_URI,
    dnsServers: e.DNS_SERVERS,
    clientUrl: e.CLIENT_URL.replace(/\/$/, ''),
    maxVideoSizeBytes: e.MAX_VIDEO_SIZE_MB ? e.MAX_VIDEO_SIZE_MB * MB : null, // null = unlimited
    minFreeDiskBytes: e.MIN_FREE_DISK_MB * MB,
    maxConcurrentStreams: e.MAX_CONCURRENT_STREAMS,
    // 0 → Infinity (no cap). A sub-1-byte decimal value would floor to 0, which
    // would make every range request return 416; enforce a 1-byte minimum so the
    // calculation in parseRange always produces a valid end >= start.
    streamChunkBytes: e.STREAM_CHUNK_SIZE_MB
      ? Math.max(Math.floor(e.STREAM_CHUNK_SIZE_MB * MB), 1)
      : Infinity,
    // Fixed on the server. The client can never influence where files go.
    storageDir: path.join(serverRoot, 'storage', 'videos'),
    // The built React app (npm run build -w client). Served by Express when present,
    // so phone, laptop and TV all use ONE short address: http://<laptop-ip>:5000
    clientDistDir: path.join(serverRoot, '..', 'client', 'dist'),
    transcode: {
      enabled: e.TRANSCODE_ENABLED && Boolean(ffmpegPath && ffprobePath && fs.existsSync(ffmpegPath)),
      ffmpegPath,
      ffprobePath,
    },
    rateLimits: {
      upload: { windowMs: 15 * 60 * 1000, limit: 50 }, // 50 uploads / 15 min / IP (a whole series)
      stream: { windowMs: 60 * 1000, limit: 600 }, // 600 range requests / min / IP
      api: { windowMs: 60 * 1000, limit: 300 }, // library, metadata, delete (library polls while converting)
    },
  };
}
