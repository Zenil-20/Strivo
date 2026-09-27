import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Video } from '../src/models/Video.js';
import { cleanupOrphans } from '../src/services/cleanupService.js';
import { describeSubtitle, extractableSubtitles, probeVideo } from '../src/services/transcodeService.js';

const baseConfig = loadConfig({ NODE_ENV: 'test' });
const ffmpeg = baseConfig.transcode.ffmpegPath;
const ffprobe = baseConfig.transcode.ffprobePath;

let mongo;
let storageDir;
let samplesDir;
let config;
let app;

const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const VIDEO_IN = ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15'];
const TONE_IN = (freq = 440) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`];
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];

/** A 2-second H.264 video whose audio uses the given codec. */
function videoWithAudio(name, audioArgs) {
  const out = path.join(samplesDir, name);
  run([...VIDEO_IN, ...TONE_IN(), '-shortest', ...H264, ...audioArgs, out]);
  return out;
}

// "00:01.500" or "00:00:01.500" -> 1.5
function firstCueSeconds(vtt) {
  const [, h = '0', m, s] = /(?:(\d+):)?(\d{2}):(\d{2}\.\d{3}) -->/.exec(vtt);
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
// Presentation time of the video track's first frame (what the browser's currentTime starts from).
function videoStartSeconds(file) {
  const out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', file]);
  return Number(String(out).trim());
}

const upload = (file, name = path.basename(file)) =>
  request(app).post('/api/videos/upload').attach('video', file, { filename: name, contentType: 'application/octet-stream' });
const waitForJobs = () => app.locals.conversionQueue.whenIdle();
const storedFiles = () => fs.readdirSync(storageDir);
const record = (shareId) => Video.findOne({ shareId });

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strivo-av-'));
  samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strivo-av-samples-'));
  config = {
    ...baseConfig,
    storageDir,
    clientDistDir: null,
    minFreeDiskBytes: 0,
    rateLimits: { ...baseConfig.rateLimits, upload: { windowMs: 60_000, limit: 1000 }, api: { windowMs: 60_000, limit: 5000 } },
  };
  app = createApp(config);
});

after(async () => {
  await app.locals.conversionQueue.stop();
  await mongoose.disconnect();
  await mongo.stop();
  for (const dir of [storageDir, samplesDir]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('every audio format inside videos ends up playable on the TV', () => {
  // [file name, ffmpeg audio args, expected audio codec in the result]
  const CASES = [
    ['aac.mkv', ['-c:a', 'aac'], 'aac'], // container change only: copied
    ['mp3.mkv', ['-c:a', 'libmp3lame'], 'mp3'], // copied
    ['dolby-ac3.mkv', ['-c:a', 'ac3'], 'aac'],
    ['dolby-plus-eac3.mkv', ['-c:a', 'eac3'], 'aac'],
    ['dts.mkv', ['-c:a', 'dca', '-strict', '-2', '-ar', '48000', '-ac', '2'], 'aac'],
    ['dolby-truehd.mkv', ['-c:a', 'truehd', '-strict', '-2', '-ar', '48000'], 'aac'],
    ['flac.mkv', ['-c:a', 'flac'], 'aac'],
    ['opus.mkv', ['-c:a', 'libopus'], 'aac'],
    ['vorbis.mkv', ['-c:a', 'libvorbis'], 'aac'],
    ['pcm-16bit.mkv', ['-c:a', 'pcm_s16le'], 'aac'],
    ['pcm-24bit.mov', ['-c:a', 'pcm_s24le'], 'aac'], // camera-style MOV
    ['mp2.mkv', ['-c:a', 'mp2'], 'aac'],
    ['wma.mkv', ['-c:a', 'wmav2'], 'aac'],
    ['alac.mkv', ['-c:a', 'alac'], 'aac'],
    ['adpcm.avi', ['-c:a', 'adpcm_ima_wav'], 'aac'],
    ['phone-amr.3gp', ['-c:a', 'libopencore_amrnb', '-ar', '8000', '-ac', '1', '-b:a', '12.2k'], 'aac'],
    ['ac3-in.mp4', ['-c:a', 'ac3'], 'aac'], // MP4 container is fine, audio is not
  ];

  for (const [name, audioArgs, expectedCodec] of CASES) {
    test(`${name} -> H.264 + ${expectedCodec.toUpperCase()} MP4 with sound`, async () => {
      const res = await upload(videoWithAudio(name, audioArgs));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.video.status, 'processing');
      await waitForJobs();

      const video = await record(res.body.video.id);
      assert.equal(video.status, 'ready');
      assert.equal(video.mimeType, 'video/mp4');
      const info = await probeVideo(ffprobe, path.join(storageDir, video.storedName));
      assert.equal(info.video.codec, 'h264');
      assert.ok(info.audio, 'the sound track must survive conversion');
      assert.equal(info.audio.codec, expectedCodec);
      assert.ok(info.duration > 1.5, `duration ${info.duration}`);
    });
  }

  test('dual-audio movie: the track marked as default is kept (not simply the first)', async () => {
    const out = path.join(samplesDir, 'dual-audio.mkv');
    run([
      ...VIDEO_IN, ...TONE_IN(300), ...TONE_IN(900), '-shortest',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', ...H264,
      '-c:a:0', 'mp2', '-c:a:1', 'ac3',
      '-metadata:s:a:0', 'language=hin', '-metadata:s:a:1', 'language=eng',
      '-disposition:a:0', '0', '-disposition:a:1', 'default',
      out,
    ]);
    const res = await upload(out);
    await waitForJobs();
    const video = await record(res.body.video.id);
    const info = await probeVideo(ffprobe, path.join(storageDir, video.storedName));
    assert.equal(info.audio.codec, 'aac');
    assert.equal(info.audio.language, 'eng');
  });
});

describe('subtitles inside the video file', () => {
  let mkvVideo;

  before(async () => {
    const srt = path.join(samplesDir, 'subs.srt');
    fs.writeFileSync(srt, '1\n00:00:00,100 --> 00:00:01,500\nHello TV\n\n2\n00:00:01,600 --> 00:00:01,900\nSecond line\n');
    const out = path.join(samplesDir, 'movie-with-subs.mkv');
    run([
      ...VIDEO_IN, ...TONE_IN(), '-i', srt, '-i', srt, '-shortest',
      '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s', ...H264, '-c:a', 'aac',
      '-c:s:0', 'srt', '-c:s:1', 'ass',
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=hin', '-metadata:s:s:1', 'title=Hindi <Full>',
      out,
    ]);
    const res = await upload(out);
    assert.equal(res.body.video.status, 'processing');
    await waitForJobs();
    mkvVideo = (await request(app).get(`/api/videos/${res.body.video.id}`)).body.video;
  });

  test('text subtitle tracks (SRT, ASS) are extracted with language and label', () => {
    assert.equal(mkvVideo.status, 'ready');
    assert.deepEqual(mkvVideo.subtitles, [
      { index: 0, language: 'en', label: 'English' },
      { index: 1, language: 'hi', label: 'Hindi <Full>' },
    ]);
  });

  test('each track is served as WebVTT for <track>', async () => {
    const res = await request(app).get(`/api/videos/${mkvVideo.id}/subtitles/0`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/vtt/);
    assert.match(res.text, /^WEBVTT/);
    assert.match(res.text, /Hello TV/);
    assert.match(res.text, /Second line/);
    const ass = await request(app).get(`/api/videos/${mkvVideo.id}/subtitles/1`);
    assert.match(ass.text, /Hello TV/);
  });

  test('subtitles stay in sync with the converted video (cue 0.100 s after the first frame)', async () => {
    const video = await record(mkvVideo.id);
    const vtt = (await request(app).get(`/api/videos/${mkvVideo.id}/subtitles/0`)).text;
    const offset = firstCueSeconds(vtt) - videoStartSeconds(path.join(storageDir, video.storedName));
    assert.ok(Math.abs(offset - 0.1) < 0.01, `cue is ${offset.toFixed(3)} s after the first frame, expected 0.100`);
  });

  test('bad or missing subtitle indexes are rejected; stored filenames stay private', async () => {
    assert.equal((await request(app).get(`/api/videos/${mkvVideo.id}/subtitles/7`)).status, 404);
    assert.equal((await request(app).get(`/api/videos/${mkvVideo.id}/subtitles/abc`)).status, 400);
    assert.equal((await request(app).get(`/api/videos/${mkvVideo.id}/subtitles/..%2F..%2Fx`)).status, 400);
    const meta = await request(app).get(`/api/videos/${mkvVideo.id}`);
    assert.doesNotMatch(JSON.stringify(meta.body), /\.vtt/);
  });

  test('an MP4 that already plays keeps its file; only subtitles are extracted', async () => {
    const out = path.join(samplesDir, 'ready-with-subs.mp4');
    const srt = path.join(samplesDir, 'subs.srt');
    run([...VIDEO_IN, ...TONE_IN(), '-i', srt, '-shortest', '-map', '0:v', '-map', '1:a', '-map', '2:s', ...H264, '-c:a', 'aac', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=spa', out]);
    const res = await upload(out);
    const before = (await record(res.body.video.id)).storedName;
    await waitForJobs();
    const video = await record(res.body.video.id);
    assert.equal(video.status, 'ready');
    assert.equal(video.storedName, before, 'no re-conversion of an already-playable file');
    assert.deepEqual(video.toPublicJSON().subtitles, [{ index: 0, language: 'es', label: 'Spanish' }]);
    // In sync with the ORIGINAL (unshifted) video timeline.
    const vtt = (await request(app).get(`/api/videos/${res.body.video.id}/subtitles/0`)).text;
    const offset = firstCueSeconds(vtt) - videoStartSeconds(path.join(storageDir, video.storedName));
    assert.ok(Math.abs(offset - 0.1) < 0.01, `cue is ${offset.toFixed(3)} s after the first frame, expected 0.100`);
  });

  test('simple TV mode: subtitles on/off with plain links (no JavaScript needed)', async () => {
    const on = await request(app).get(`/tv/watch/${mkvVideo.id}?sub=1`);
    assert.match(on.text, /<track kind="subtitles" src="\/api\/videos\/[\w-]+\/subtitles\/1" srclang="hi" label="Hindi &lt;Full&gt;" default>/);
    assert.equal((on.text.match(/ default>/g) ?? []).length, 1);
    assert.match(on.text, /href="\/tv\/watch\/[\w-]+\?sub=off">Off/);
    assert.match(on.text, /class="btn on" href="\/tv\/watch\/[\w-]+\?sub=1">Hindi &lt;Full&gt;/);

    const off = await request(app).get(`/tv/watch/${mkvVideo.id}?sub=off`);
    assert.equal((off.text.match(/<track /g) ?? []).length, 2);
    assert.doesNotMatch(off.text, / default>/);

    const bogus = await request(app).get(`/tv/watch/${mkvVideo.id}?sub=99`);
    assert.doesNotMatch(bogus.text, / default>/);
  });

  test('deleting a video also deletes its subtitle files', async () => {
    const out = path.join(samplesDir, 'movie-with-subs.mkv');
    const res = await upload(out, 'to-delete.mkv');
    await waitForJobs();
    const video = await record(res.body.video.id);
    const vttFiles = video.subtitles.map((s) => s.file);
    assert.equal(vttFiles.length, 2);
    assert.ok(vttFiles.every((f) => storedFiles().includes(f)));

    const del = await request(app).delete(`/api/videos/${res.body.video.id}`).set('X-Delete-Token', res.body.deleteToken);
    assert.equal(del.status, 200);
    assert.ok(vttFiles.every((f) => !storedFiles().includes(f)));
    assert.ok(!storedFiles().includes(video.storedName));
  });

  test('cleanup removes orphaned subtitle files but keeps referenced ones', async () => {
    const orphan = path.join(storageDir, 'aaaaaaaa-bbbb-4ccc-8ddd-000000000000.vtt');
    fs.writeFileSync(orphan, 'WEBVTT\n\n');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(orphan, old, old);
    const kept = (await record(mkvVideo.id)).subtitles.map((s) => s.file);

    await cleanupOrphans(config);

    assert.ok(!fs.existsSync(orphan));
    assert.ok(kept.every((f) => storedFiles().includes(f)));
  });
});

describe('subtitle helpers', () => {
  test('picture-based subtitles (PGS, VobSub, DVB) are skipped: only text tracks are extracted', () => {
    const info = {
      subtitles: [
        { index: 2, codec: 'hdmv_pgs_subtitle', isText: false },
        { index: 3, codec: 'subrip', isText: true },
        { index: 4, codec: 'dvd_subtitle', isText: false },
        { index: 5, codec: 'ass', isText: true },
      ],
    };
    assert.deepEqual(extractableSubtitles(info).map((s) => s.index), [3, 5]);
  });

  test('labels: track title first, then language name, then "Subtitle N"', () => {
    assert.deepEqual(describeSubtitle({ language: 'eng' }, 0), { language: 'en', label: 'English' });
    assert.deepEqual(describeSubtitle({ language: 'hin', title: 'Hindi SDH' }, 1), { language: 'hi', label: 'Hindi SDH' });
    assert.deepEqual(describeSubtitle({ language: 'fr' }, 0), { language: 'fr', label: 'French' });
    assert.deepEqual(describeSubtitle({}, 2), { language: 'und', label: 'Subtitle 3' });
  });
});
