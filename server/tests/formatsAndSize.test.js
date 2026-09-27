import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SUPPORTED_EXTENSIONS, VIDEO_FORMATS } from '../src/utils/videoFormats.js';

const MB = 1024 * 1024;

/** Minimal file whose first bytes match the given container signature, padded with filler. */
function sampleFor(signature, size = 4096) {
  const b = Buffer.alloc(size, 7);
  switch (signature) {
    case 'isobmff':
      b.writeUInt32BE(24, 0);
      b.write('ftypisom', 4, 'latin1');
      break;
    case 'quicktime':
      b.writeUInt32BE(20, 0);
      b.write('ftypqt  ', 4, 'latin1');
      break;
    case 'ebml':
      b.writeUInt32BE(0x1a45dfa3, 0);
      break;
    case 'ogg':
      b.write('OggS', 0, 'latin1');
      break;
    case 'avi':
      b.write('RIFF', 0, 'latin1');
      b.writeUInt32LE(size - 8, 4);
      b.write('AVI LIST', 8, 'latin1');
      break;
    case 'asf':
      Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa]).copy(b, 0);
      break;
    case 'flv':
      b.write('FLV', 0, 'latin1');
      b[3] = 1;
      break;
    case 'realmedia':
      b.write('.RMF', 0, 'latin1');
      break;
    case 'mpeg-ps':
      b.writeUInt32BE(0x000001ba, 0);
      break;
    case 'mpeg-ts':
      for (let i = 0; i < size; i += 188) b[i] = 0x47; // sync byte every 188 bytes
      break;
    default:
      throw new Error(`no sample for ${signature}`);
  }
  return b;
}

let mongo;
let storageDir;
let app;

function makeConfig(overrides = {}) {
  const base = loadConfig({ NODE_ENV: 'test' }); // real defaults: no size cap
  return {
    ...base,
    storageDir,
    minFreeDiskBytes: 0,
    // These tests use tiny fake files (valid headers only), not real videos, so no ffmpeg.
    transcode: { ...base.transcode, enabled: false },
    rateLimits: { ...base.rateLimits, upload: { windowMs: 60_000, limit: 1000 } },
    ...overrides,
  };
}

const upload = (targetApp, buffer, filename, contentType = 'application/octet-stream') =>
  request(targetApp).post('/api/videos/upload').attach('video', buffer, { filename, contentType });

const storedFiles = () => fs.readdirSync(storageDir);

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strivo-formats-'));
  app = createApp(makeConfig());
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('all video formats are supported', () => {
  for (const ext of SUPPORTED_EXTENSIONS) {
    const { mimeType, signature } = VIDEO_FORMATS[ext];

    test(`${ext}: uploads, stores with its own extension, streams with ${mimeType}`, async () => {
      // The browser often sends no useful MIME type for these; the server must not care.
      const res = await upload(app, sampleFor(signature), `clip${ext}`);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.video.mimeType, mimeType);
      assert.equal(res.body.video.originalName, `clip${ext}`);
      assert.ok(storedFiles().some((f) => f.endsWith(ext) && /^[0-9a-f-]{36}\./.test(f)));

      const stream = await request(app).get(`/api/videos/${res.body.video.id}/stream`).set('Range', 'bytes=0-15');
      assert.equal(stream.status, 206);
      assert.equal(stream.headers['content-type'], mimeType);
      assert.equal(stream.headers['content-range'], 'bytes 0-15/4096');
    });
  }

  test('extensions are case-insensitive (CLIP.MKV)', async () => {
    const res = await upload(app, sampleFor('ebml'), 'HOLIDAY.MKV');
    assert.equal(res.status, 201);
    assert.equal(res.body.video.mimeType, 'video/x-matroska');
    assert.ok(storedFiles().some((f) => f.endsWith('.mkv')));
  });

  test('a file whose content does not match its extension is rejected and deleted', async () => {
    const before = storedFiles().length;
    const res = await upload(app, sampleFor('isobmff'), 'actually-mp4.avi');
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not a valid \.avi video/);
    assert.equal(storedFiles().length, before);
  });

  test('non-video, double-extension and extension-less files are still rejected', async () => {
    for (const name of ['setup.exe', 'clip.mp4.exe', 'script.js', 'photo.png', 'README', '.mp4evil']) {
      const res = await upload(app, sampleFor('isobmff'), name);
      assert.equal(res.status, 400, name);
      assert.match(res.body.message, /Unsupported file type/, name);
    }
  });

  test('?download=1 serves the file as an attachment with the original name', async () => {
    const { body } = await upload(app, sampleFor('avi'), 'Family trip.avi');
    const res = await request(app).get(`/api/videos/${body.video.id}/stream?download=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'video/x-msvideo');
    assert.match(res.headers['content-disposition'], /^attachment; filename="Family trip\.avi"/);

    const inline = await request(app).get(`/api/videos/${body.video.id}/stream`).set('Range', 'bytes=0-1');
    assert.equal(inline.headers['content-disposition'], undefined);
  });

  test('client and server extension lists are identical', () => {
    const apiJs = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/src/services/api.js'),
      'utf8',
    );
    const block = /ALLOWED_EXTENSIONS = \[([^\]]*)\]/.exec(apiJs)[1];
    const clientList = [...block.matchAll(/'(\.[a-z0-9]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...clientList].sort(), [...SUPPORTED_EXTENSIONS].sort());
  });
});

describe('streaming works with old TV video players', () => {
  test('an open-ended range ("bytes=0-") gets the WHOLE rest of the file by default', async () => {
    // Old TV players treat a shorter 206 answer as the end of the video: a 21 s clip
    // stopped after the first 1 MB (~4 s) and restarted. So by default there is no cap.
    assert.equal(loadConfig({}).streamChunkBytes, Infinity);
    const size = 3 * MB;
    const { body } = await upload(app, sampleFor('isobmff', size), 'tv.mp4');

    const res = await request(app)
      .get(`/api/videos/${body.video.id}/stream`)
      .set('Range', 'bytes=0-')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], `bytes 0-${size - 1}/${size}`);
    assert.equal(res.headers['content-length'], String(size));
    assert.equal(res.body.length, size);

    const fromMiddle = await request(app).head(`/api/videos/${body.video.id}/stream`).set('Range', `bytes=${MB}-`);
    assert.equal(fromMiddle.headers['content-range'], `bytes ${MB}-${size - 1}/${size}`);
  });

  test('STREAM_CHUNK_SIZE_MB can still cap responses if wanted', async () => {
    assert.equal(loadConfig({ STREAM_CHUNK_SIZE_MB: '1' }).streamChunkBytes, MB);
    const cappedApp = createApp(makeConfig({ streamChunkBytes: MB }));
    const { body } = await upload(cappedApp, sampleFor('isobmff', 3 * MB), 'capped.mp4');
    const res = await request(cappedApp).head(`/api/videos/${body.video.id}/stream`).set('Range', 'bytes=0-');
    assert.equal(res.headers['content-range'], `bytes 0-${MB - 1}/${3 * MB}`);
  });
});

describe('no upload size cap', () => {
  test('there is no size limit by default', () => {
    assert.equal(loadConfig({}).maxVideoSizeBytes, null);
    assert.equal(loadConfig({ MAX_VIDEO_SIZE_MB: '0' }).maxVideoSizeBytes, null);
    assert.equal(loadConfig({ MAX_VIDEO_SIZE_MB: '500' }).maxVideoSizeBytes, 500 * MB);
  });

  test('a file larger than the old 1 GB cap uploads and streams, without buffering in RAM', async (t) => {
    const size = 1024 * MB + 5 * MB; // 1.005 GB
    const { bavail, bsize } = fs.statfsSync(os.tmpdir());
    if (bavail * bsize < size * 2 + 1024 * MB) {
      t.skip('needs ~3 GB free disk space in the temp directory');
      return;
    }

    // Create the source file without allocating 1 GB: write the header, then extend it.
    const srcPath = path.join(os.tmpdir(), `strivo-big-${process.pid}.mp4`);
    fs.writeFileSync(srcPath, sampleFor('isobmff', 64));
    fs.truncateSync(srcPath, size);

    try {
      global.gc?.();
      const rssBefore = process.memoryUsage().rss;
      let peakRss = rssBefore;
      const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 100);

      // supertest streams the file from disk; the server (same process) streams it to disk.
      const res = await request(app)
        .post('/api/videos/upload')
        .attach('video', srcPath, { filename: 'huge.mp4', contentType: 'video/mp4' });
      clearInterval(sampler);

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.video.size, size);
      const growthMb = (peakRss - rssBefore) / MB;
      // Both the client and the server side run in this process; holding the file in memory
      // would add >1000 MB. Streaming keeps growth to a small fraction of that.
      assert.ok(growthMb < 300, `RSS grew by ${growthMb.toFixed(0)} MB during a 1 GB upload`);

      // Reading the tail of a >1 GB file works like any other range.
      const tail = await request(app).get(`/api/videos/${res.body.video.id}/stream`).set('Range', 'bytes=-100');
      assert.equal(tail.status, 206);
      assert.equal(tail.headers['content-range'], `bytes ${size - 100}-${size - 1}/${size}`);
    } finally {
      fs.rmSync(srcPath, { force: true });
    }
  });

  test('uploads that would exhaust the disk are refused with 507 before any bytes are stored', async () => {
    const guardedApp = createApp(makeConfig({ minFreeDiskBytes: Number.MAX_SAFE_INTEGER }));
    const before = storedFiles().length;
    const res = await upload(guardedApp, sampleFor('isobmff'), 'clip.mp4');
    assert.equal(res.status, 507);
    assert.deepEqual(res.body, { success: false, message: 'Not enough free disk space on the server for this video' });
    assert.equal(storedFiles().length, before);
  });
});
