import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createVideoController } from '../src/controllers/videoController.js';
import { loadConfig } from '../src/config.js';
import { Video } from '../src/models/Video.js';
import { createConversionQueue } from '../src/services/conversionQueue.js';
import { probeVideo } from '../src/services/transcodeService.js';

// ES5 check without extra dependencies: ES5 engines reject let/const/arrows/template strings.
function parseEs5(code) {
  if (/=>|`|\b(let|const|class)\s/.test(code)) throw new Error('uses syntax newer than ES5');
  return new vm.Script(code); // also a real syntax check
}

let mongo;
let storageDir;
let samplesDir;
let distDir;
let config;
let app;

const baseConfig = loadConfig({ NODE_ENV: 'test' });

// Real (tiny) videos generated with the bundled ffmpeg: a test pattern plus a tone.
const SAMPLES = {
  'ready.mp4': ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], // already TV-friendly
  'h264-ac3.mkv': ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3'], // copy video, re-encode audio
  'h264-aac.ts': ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts'], // copy both
  'xvid-pcm.avi': ['-c:v', 'mpeg4', '-c:a', 'pcm_s16le'], // re-encode both
  'dvd.mpg': ['-c:v', 'mpeg2video', '-c:a', 'mp2', '-f', 'mpeg'], // re-encode both
};

function makeSample(name, args, seconds = 2) {
  const out = path.join(samplesDir, name);
  execFileSync(baseConfig.transcode.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-shortest', ...args, out,
  ]);
  return out;
}

function makeConfig(overrides = {}) {
  return {
    ...baseConfig,
    storageDir,
    clientDistDir: distDir,
    minFreeDiskBytes: 0,
    rateLimits: { ...baseConfig.rateLimits, upload: { windowMs: 60_000, limit: 1000 } },
    ...overrides,
  };
}

const upload = (file, name = path.basename(file), title) => {
  const req = request(app).post('/api/videos/upload');
  if (title) req.field('title', title);
  return req.attach('video', file, { filename: name, contentType: 'application/octet-stream' });
};
const waitForConversions = () => app.locals.conversionQueue.whenIdle();
const storedFiles = () => fs.readdirSync(storageDir);
const storedNameOf = async (shareId) => (await Video.findOne({ shareId })).storedName;

before(async () => {
  assert.ok(baseConfig.transcode.enabled, 'bundled ffmpeg/ffprobe should be available');
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strivo-tv-'));
  samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strivo-samples-'));
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strivo-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>strivo-test-index</title>');
  for (const [name, args] of Object.entries(SAMPLES)) makeSample(name, args);
  config = makeConfig();
  app = createApp(config);
});

after(async () => {
  await app.locals.conversionQueue.stop();
  await mongoose.disconnect();
  await mongo.stop();
  for (const dir of [storageDir, samplesDir, distDir]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('automatic conversion to TV-friendly MP4', () => {
  test('an H.264/AAC MP4 is ready immediately and is not converted', async () => {
    const res = await upload(path.join(samplesDir, 'ready.mp4'));
    assert.equal(res.status, 201);
    assert.equal(res.body.video.status, 'ready');
    assert.equal(res.body.video.progress, 100);
    assert.equal(res.body.video.mimeType, 'video/mp4');
  });

  for (const name of ['h264-ac3.mkv', 'h264-aac.ts', 'xvid-pcm.avi', 'dvd.mpg']) {
    test(`${name} is converted to H.264/AAC MP4 and the original is removed`, async () => {
      const res = await upload(path.join(samplesDir, name));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.video.status, 'processing'); // upload returns before conversion
      const originalStored = await storedNameOf(res.body.video.id);

      await waitForConversions();

      const meta = await request(app).get(`/api/videos/${res.body.video.id}`);
      assert.equal(meta.body.video.status, 'ready');
      assert.equal(meta.body.video.progress, 100);
      assert.equal(meta.body.video.mimeType, 'video/mp4');
      assert.equal(meta.body.video.originalName, name); // display name unchanged

      const stored = await storedNameOf(res.body.video.id);
      assert.match(stored, /\.mp4$/);
      assert.ok(!storedFiles().includes(originalStored), 'original file should be deleted');

      const info = await probeVideo(config.transcode.ffprobePath, path.join(storageDir, stored));
      assert.equal(info.video.codec, 'h264');
      assert.equal(info.video.pixelFormat, 'yuv420p');
      assert.equal(info.audio.codec, 'aac');

      // It streams as MP4, and a download gets the real .mp4 extension.
      const range = await request(app).get(`/api/videos/${res.body.video.id}/stream`).set('Range', 'bytes=0-99');
      assert.equal(range.status, 206);
      assert.equal(range.headers['content-type'], 'video/mp4');
      const download = await request(app).head(`/api/videos/${res.body.video.id}/stream?download=1`);
      assert.match(download.headers['content-disposition'], new RegExp(`filename="${name.replace(/\..+$/, '')}\\.mp4"`));
    });
  }

  test('a file with no video track (audio-only .mp4) is rejected and deleted', async () => {
    const audioOnly = path.join(samplesDir, 'song.mp4');
    execFileSync(config.transcode.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', audioOnly,
    ]);
    const before = storedFiles().length;
    const res = await upload(audioOnly);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /readable video track/);
    assert.equal(storedFiles().length, before);
  });

  test('a file with a valid header but garbage content is rejected', async () => {
    const fake = Buffer.alloc(8192, 7);
    fake.writeUInt32BE(24, 0);
    fake.write('ftypisom', 4, 'latin1');
    const res = await request(app)
      .post('/api/videos/upload')
      .attach('video', fake, { filename: 'fake.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 400);
  });

  test('deleting a video while it converts stops ffmpeg and leaves no files behind', async () => {
    const longClip = makeSample('long.avi', ['-c:v', 'mpeg4', '-c:a', 'pcm_s16le'], 20);
    const before = new Set(storedFiles());
    const res = await upload(longClip);
    assert.equal(res.body.video.status, 'processing');

    const del = await request(app).delete(`/api/videos/${res.body.video.id}`).set('X-Delete-Token', res.body.deleteToken);
    assert.equal(del.status, 200);
    await waitForConversions();

    assert.deepEqual(new Set(storedFiles()), before, 'no original or partial output left');
    assert.equal(await Video.countDocuments({ shareId: res.body.video.id }), 0);
  });

  test('a conversion interrupted by a restart is resumed from the original file', async () => {
    const res = await upload(path.join(samplesDir, 'h264-ac3.mkv'));
    await waitForConversions();
    // Simulate "server stopped mid-conversion": record still processing, original file present.
    // (Remove the MP4 from the first conversion so this test leaves no orphan behind.)
    fs.rmSync(path.join(storageDir, await storedNameOf(res.body.video.id)));
    const original = path.join(storageDir, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mkv');
    fs.copyFileSync(path.join(samplesDir, 'h264-ac3.mkv'), original);
    await Video.updateOne(
      { shareId: res.body.video.id },
      { status: 'processing', progress: 40, storedName: path.basename(original), mimeType: 'video/x-matroska' },
    );

    const freshQueue = createConversionQueue(config); // what server.js does on startup
    freshQueue.enqueue((await Video.findOne({ shareId: res.body.video.id }))._id);
    await freshQueue.whenIdle();

    const video = await Video.findOne({ shareId: res.body.video.id });
    assert.equal(video.status, 'ready');
    assert.match(video.storedName, /\.mp4$/);
    assert.ok(!fs.existsSync(original));
  });

  test('streaming is refused (409) while a video is still converting', async () => {
    const res = await upload(path.join(samplesDir, 'ready.mp4'), 'busy.mp4');
    await Video.updateOne({ shareId: res.body.video.id }, { status: 'processing', progress: 10 });
    const stream = await request(app).get(`/api/videos/${res.body.video.id}/stream`).set('Range', 'bytes=0-99');
    assert.equal(stream.status, 409);
    assert.equal(stream.body.message, 'Video is still being processed');
  });

  test('a video whose conversion failed can still be streamed and downloaded (original kept)', async () => {
    const res = await upload(path.join(samplesDir, 'h264-ac3.mkv'), 'broken.mkv');
    await waitForConversions();
    await Video.updateOne({ shareId: res.body.video.id }, { status: 'failed' });

    const stream = await request(app).get(`/api/videos/${res.body.video.id}/stream`).set('Range', 'bytes=0-99');
    assert.equal(stream.status, 206);
    const download = await request(app).head(`/api/videos/${res.body.video.id}/stream?download=1`);
    assert.equal(download.status, 200);
    assert.match(download.headers['content-disposition'], /^attachment/);
  });

  test('deleteAllVideos removes every record and every stored file', async () => {
    const clip = path.join(samplesDir, 'ready.mp4');
    await upload(clip, 'one.mp4');
    await upload(path.join(samplesDir, 'h264-ac3.mkv'), 'two.mkv'); // may still be converting
    const controller = createVideoController(config, app.locals.conversionQueue);
    const res = { json(body) { this.body = body; } };

    await controller.deleteAllVideos({}, res);

    assert.equal(res.body.success, true);
    assert.ok(res.body.deletedCount >= 2);
    assert.equal(res.body.failedFileDeletes, 0);
    assert.equal(await Video.countDocuments(), 0);
    await waitForConversions();
    assert.deepEqual(storedFiles().filter((f) => /^[0-9a-f-]{36}\./.test(f)), []);
  });

  test('with TRANSCODE_ENABLED=false files are kept exactly as uploaded', async () => {
    assert.equal(loadConfig({ TRANSCODE_ENABLED: 'false' }).transcode.enabled, false);
    const plainApp = createApp(makeConfig({ transcode: { ...config.transcode, enabled: false } }));
    const res = await request(plainApp)
      .post('/api/videos/upload')
      .attach('video', path.join(samplesDir, 'h264-ac3.mkv'), { filename: 'keep.mkv' });
    assert.equal(res.body.video.status, 'ready');
    assert.equal(res.body.video.mimeType, 'video/x-matroska');
  });
});

describe('TV library', () => {
  test('lists videos with episodes in natural order (S01E2 before S01E10)', async () => {
    await Video.deleteMany({});
    const clip = path.join(samplesDir, 'ready.mp4');
    for (const title of ['Show S01E10', 'show S01E2', 'A Movie', 'Show S01E1']) await upload(clip, 'x.mp4', title);

    const res = await request(app).get('/api/videos');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.videos.map((v) => v.title),
      ['A Movie', 'Show S01E1', 'show S01E2', 'Show S01E10'],
    );
    // Library entries expose the same safe public fields only.
    assert.equal(res.body.videos[0].storedName, undefined);
    assert.equal(res.body.videos[0].deleteTokenHash, undefined);
  });

  test('turns scene-style filenames into readable titles', async () => {
    const res = await upload(path.join(samplesDir, 'ready.mp4'), 'Breaking.Bad.S01E01.720p_WEB.mp4');
    assert.equal(res.body.video.title, 'Breaking Bad S01E01 720p WEB');
  });

  test('share links use the address the device connected to (e.g. the laptop LAN IP)', async () => {
    const res = await request(app)
      .post('/api/videos/upload')
      .set('Host', '192.168.1.5:5000')
      .attach('video', path.join(samplesDir, 'ready.mp4'), { filename: 'lan.mp4' });
    assert.equal(res.body.shareUrl, `http://192.168.1.5:5000/watch/${res.body.video.id}`);
  });
});

describe('simple TV mode (/tv, no JavaScript)', () => {
  let video;

  before(async () => {
    const res = await upload(path.join(samplesDir, 'ready.mp4'), 'x.mp4', '<b>Evil</b> "Movie" & more');
    video = res.body.video;
  });

  test('/tv lists videos as plain links, with titles HTML-escaped and no scripts', async () => {
    const res = await request(app).get('/tv');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(res.text.includes(`href="/tv/watch/${video.id}"`));
    assert.ok(res.text.includes('&lt;b&gt;Evil&lt;/b&gt; &quot;Movie&quot; &amp; more'));
    assert.ok(!res.text.includes('<b>Evil</b>'), 'title must not be injected as HTML');
    assert.doesNotMatch(res.text, /<script/i);
  });

  test('/tv/watch/:id is a native <video> player with a fallback link to the raw stream', async () => {
    const res = await request(app).get(`/tv/watch/${video.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(`<video id="player" src="/api/videos/${video.id}/stream" controls autoplay`));
    assert.ok(res.text.includes(`href="/api/videos/${video.id}/stream">Open in TV player`));
    // Only one optional, external script (fullscreen button); no inline scripts.
    const scripts = res.text.match(/<script[^>]*>/gi) ?? [];
    assert.deepEqual(scripts, ['<script src="/tv/tv.js">']);
    // Works without it: the fullscreen button is hidden until the script shows it.
    assert.match(res.text, /id="fullscreen"[^>]*style="display:none"/);
  });

  test('/tv/tv.js is a small ES5 script that only adds the fullscreen button', async () => {
    const res = await request(app).get('/tv/tv.js');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.doesNotThrow(() => parseEs5(res.text));
    assert.match(res.text, /webkitRequestFullscreen/);
  });

  test('a converting video shows progress and refreshes itself instead of a player', async () => {
    await Video.updateOne({ shareId: video.id }, { status: 'processing', progress: 37 });
    try {
      const page = await request(app).get(`/tv/watch/${video.id}`);
      assert.match(page.text, /Converting for your TV: 37%/);
      assert.match(page.text, /<meta http-equiv="refresh" content="10">/);
      assert.doesNotMatch(page.text, /<video/);
      const list = await request(app).get('/tv');
      assert.match(list.text, /Converting 37%/);
      assert.match(list.text, /http-equiv="refresh"/);
    } finally {
      await Video.updateOne({ shareId: video.id }, { status: 'ready', progress: 100 });
    }
  });

  test('unknown and malformed IDs are rejected', async () => {
    assert.equal((await request(app).get('/tv/watch/AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
    assert.equal((await request(app).get('/tv/watch/..%2F..%2Fsecret')).status, 400);
  });
});

describe('one address for phone, laptop and TV', () => {
  test('the React app is served for client routes from the API server', async () => {
    for (const route of ['/', '/upload', '/watch/AAAAAAAAAAAAAAAAAAAAAA']) {
      const res = await request(app).get(route);
      assert.equal(res.status, 200, route);
      assert.match(res.text, /strivo-test-index/, route);
    }
  });

  test('unknown API routes and file-like paths are still 404 (storage stays private)', async () => {
    assert.equal((await request(app).get('/api/nope')).status, 404);
    const file = storedFiles().find((f) => f.endsWith('.mp4'));
    assert.equal((await request(app).get(`/storage/videos/${file}`)).status, 404);
    assert.equal((await request(app).get(`/${file}`)).status, 404);
  });

  test('CSP allows the legacy loader script by its exact hash, never unsafe-inline', async () => {
    const loader = "System.import(document.getElementById('vite-legacy-entry').getAttribute('data-src'))";
    const legacyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'strivo-legacy-'));
    fs.writeFileSync(
      path.join(legacyDist, 'index.html'),
      `<!doctype html><div id="root"></div><script src="/assets/polyfills-legacy.js"></script>` +
        `<script id="vite-legacy-entry" data-src="/assets/index-legacy.js">${loader}</script>`,
    );
    try {
      const legacyApp = createApp(makeConfig({ clientDistDir: legacyDist }));
      const res = await request(legacyApp).get('/');
      const scriptSrc = /script-src ([^;]*)/.exec(res.headers['content-security-policy'])[1];
      const expected = crypto.createHash('sha256').update(loader).digest('base64');
      assert.ok(scriptSrc.includes(`'sha256-${expected}'`), scriptSrc);
      assert.ok(!scriptSrc.includes('unsafe-inline'));
      assert.equal(scriptSrc.match(/sha256-/g).length, 1, 'only the inline script is hashed, not src scripts');
    } finally {
      fs.rmSync(legacyDist, { recursive: true, force: true });
    }
  });

  test('works over plain http on the LAN: no HTTPS upgrade, no HSTS', async () => {
    const res = await request(app).get('/');
    assert.doesNotMatch(res.headers['content-security-policy'], /upgrade-insecure-requests/);
    assert.equal(res.headers['strict-transport-security'], undefined);
  });
});
