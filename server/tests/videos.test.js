import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { parseRange } from '../src/utils/range.js';

// A fake but structurally valid MP4 header ("ftyp" box) followed by padding.
function fakeMp4(size = 10_000) {
  const buf = Buffer.alloc(size, 7);
  buf.writeUInt32BE(24, 0);
  buf.write('ftypisom', 4, 'latin1');
  return buf;
}

let mongo;
let config;
let app;
let storageDir;

// Defaults = production defaults (no size cap), except: no disk reserve (so tests don't
// depend on the machine's free space) and a high upload rate limit (many uploads below).
function makeConfig(overrides = {}) {
  const base = loadConfig({ NODE_ENV: 'test' });
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

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strivo-test-'));
  config = makeConfig();
  app = createApp(config);
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

const storedFiles = () => fs.readdirSync(storageDir);

describe('upload', () => {
  test('successful upload stores file on disk and returns a share URL', async () => {
    const res = await request(app)
      .post('/api/videos/upload')
      .field('title', 'Holiday clip')
      .attach('video', fakeMp4(), { filename: 'my-movie.mp4', contentType: 'video/mp4' });

    assert.equal(res.status, 201);
    assert.equal(res.body.video.title, 'Holiday clip');
    assert.equal(res.body.video.originalName, 'my-movie.mp4');
    assert.match(res.body.video.id, /^[A-Za-z0-9_-]{22}$/);
    // The share URL uses the address the uploader connected to, so it also works on the TV.
    assert.match(res.body.shareUrl, /^http:\/\/127\.0\.0\.1:\d+\/watch\//);
    assert.ok(res.body.shareUrl.endsWith(`/watch/${res.body.video.id}`));
    assert.equal(res.body.video.status, 'ready');
    assert.ok(res.body.deleteToken);
    // Stored under a random UUID name, never the original filename.
    assert.ok(storedFiles().some((f) => /^[0-9a-f-]{36}\.mp4$/.test(f)));
    assert.ok(!storedFiles().includes('my-movie.mp4'));
  });

  test('rejects a non-video file type', async () => {
    const res = await request(app)
      .post('/api/videos/upload')
      .attach('video', Buffer.from('#!/bin/sh\necho hi'), { filename: 'evil.sh', contentType: 'text/x-sh' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  test('rejects a fake .mp4 whose content is not a video and leaves no file behind', async () => {
    const before = storedFiles().length;
    const res = await request(app)
      .post('/api/videos/upload')
      .attach('video', Buffer.alloc(5000, 1), { filename: 'fake.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 400);
    assert.equal(storedFiles().length, before);
  });

  test('an optional MAX_VIDEO_SIZE_MB cap still returns 413 and cleans up the partial file', async () => {
    const cappedApp = createApp(makeConfig({ maxVideoSizeBytes: 1024 * 1024 }));
    const before = storedFiles().length;
    const res = await request(cappedApp)
      .post('/api/videos/upload')
      .attach('video', fakeMp4(1024 * 1024 + 1), { filename: 'big.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 413);
    assert.equal(storedFiles().length, before);
  });
});

describe('metadata and streaming', () => {
  const size = 10_000;
  let shareId;
  let deleteToken;

  before(async () => {
    const res = await request(app)
      .post('/api/videos/upload')
      .attach('video', fakeMp4(size), { filename: 'clip.mp4', contentType: 'video/mp4' });
    shareId = res.body.video.id;
    deleteToken = res.body.deleteToken;
  });

  test('returns metadata without any storage details', async () => {
    const res = await request(app).get(`/api/videos/${shareId}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.video).sort(), ['createdAt', 'id', 'mimeType', 'originalName', 'progress', 'size', 'status', 'subtitles', 'title']);
    assert.equal(res.body.video.size, size);
    assert.equal(res.body.video.title, 'clip');
  });

  test('returns 404 for an unknown share ID', async () => {
    const res = await request(app).get('/api/videos/AAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, message: 'Video not found' });
  });

  test('returns 400 for a malformed share ID', async () => {
    const res = await request(app).get('/api/videos/..%2F..%2Fetc');
    assert.equal(res.status, 400);
  });

  test('Range request returns 206 with exactly the requested bytes', async () => {
    const res = await request(app)
      .get(`/api/videos/${shareId}/stream`)
      .set('Range', 'bytes=100-199')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], `bytes 100-199/${size}`);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['content-length'], '100');
    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal(res.body.length, 100);
  });

  test('unsatisfiable or malformed Range returns 416', async () => {
    const outOfBounds = await request(app).get(`/api/videos/${shareId}/stream`).set('Range', `bytes=${size}-`);
    assert.equal(outOfBounds.status, 416);
    assert.equal(outOfBounds.headers['content-range'], `bytes */${size}`);

    const garbage = await request(app).get(`/api/videos/${shareId}/stream`).set('Range', 'pages=1-2');
    assert.equal(garbage.status, 416);
  });

  test('storage directory is not publicly served', async () => {
    const [file] = storedFiles();
    const res = await request(app).get(`/storage/videos/${file}`);
    assert.equal(res.status, 404);
  });

  test('delete requires the correct token and removes record + file', async () => {
    const filesBefore = storedFiles().length;
    const wrong = await request(app).delete(`/api/videos/${shareId}`).set('X-Delete-Token', 'x'.repeat(43));
    assert.equal(wrong.status, 403);

    const ok = await request(app).delete(`/api/videos/${shareId}`).set('X-Delete-Token', deleteToken);
    assert.equal(ok.status, 200);
    assert.equal(storedFiles().length, filesBefore - 1);
    assert.equal((await request(app).get(`/api/videos/${shareId}`)).status, 404);
  });
});

test('rate limiting returns 429 once the limit is exceeded', async () => {
  const limitedApp = createApp(makeConfig({ rateLimits: { ...config.rateLimits, api: { windowMs: 60_000, limit: 2 } } }));
  const url = '/api/videos/AAAAAAAAAAAAAAAAAAAAAA';
  assert.equal((await request(limitedApp).get(url)).status, 404);
  assert.equal((await request(limitedApp).get(url)).status, 404);
  const third = await request(limitedApp).get(url);
  assert.equal(third.status, 429);
  assert.equal(third.body.success, false);
});

describe('parseRange', () => {
  const MB = 1024 * 1024;
  test('handles explicit, open-ended and suffix ranges', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000, MB), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=900-', 1000, MB), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', 1000, MB), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=0-5000', 1000, MB), { start: 0, end: 999 });
  });
  test('caps open-ended ranges to the chunk size', () => {
    assert.deepEqual(parseRange('bytes=0-', 10 * MB, MB), { start: 0, end: MB - 1 });
  });
  test('rejects invalid ranges', () => {
    for (const h of ['bytes=500-100', 'bytes=1000-', 'bytes=-', 'bytes=0-1,5-9', 'bytes=abc', 'items=0-1']) {
      assert.equal(parseRange(h, 1000, MB), null, h);
    }
  });
});
