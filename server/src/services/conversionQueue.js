import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Video } from '../models/Video.js';
import { removeFileQuietly, resolveSubtitlePath, resolveVideoPath } from './storageService.js';
import {
  ENCODE_ALL,
  buildFfmpegArgs,
  describeSubtitle,
  extractableSubtitles,
  planConversion,
  probeVideo,
  runFfmpeg,
} from './transcodeService.js';

const EMPTY_VTT_BYTES = 20; // "WEBVTT" header only = the track had no text cues

/**
 * A tiny in-memory job queue (no Redis/worker needed for one laptop).
 * Jobs run ONE AT A TIME because ffmpeg uses every CPU core it can get.
 * A job does whichever of these the upload needs, in a single ffmpeg pass:
 *  - convert video/audio to a TV-friendly MP4
 *  - extract text subtitle tracks to WebVTT files
 *
 * Crash safety: the original file is deleted only after the new files are safely
 * written and the DB record points at them. If the server stops mid-job, the video
 * is still "processing" with its original file, and server.js re-queues it on startup.
 */
export function createConversionQueue(config) {
  const pending = [];
  let current = null; // { id, cancel, cancelled, done }
  let idleWaiters = [];

  async function convert(id) {
    const video = await Video.findById(id);
    if (!video || video.status !== 'processing') return;

    const input = resolveVideoPath(config.storageDir, video.storedName);
    const outputName = `${crypto.randomUUID()}.mp4`;
    const output = resolveVideoPath(config.storageDir, outputName);
    let subtitleOutputs = [];
    const removeOutputs = () =>
      Promise.all([removeFileQuietly(output), ...subtitleOutputs.map((s) => removeFileQuietly(s.output))]);

    let lastSaved = -1;
    const onProgress = (percent) => {
      // Throttle DB writes: only when the percentage changes.
      if (percent === lastSaved) return;
      lastSaved = percent;
      Video.updateOne({ _id: id, status: 'processing' }, { progress: percent }).catch(() => {});
    };

    try {
      const info = await probeVideo(config.transcode.ffprobePath, input);
      const plan = planConversion(info, path.extname(video.storedName)); // null = keep the video file
      subtitleOutputs = extractableSubtitles(info).map((sub, position) => {
        const file = `${crypto.randomUUID()}.vtt`;
        return { ...sub, ...describeSubtitle(sub, position), file, output: resolveSubtitlePath(config.storageDir, file) };
      });
      const hasSubs = subtitleOutputs.length > 0;

      // Try the cheapest option first, then safer ones:
      //  1. as planned (stream copy where possible) + subtitles
      //  2. full re-encode + subtitles   (copying fails for some odd files, e.g. old AVIs)
      //  3. without subtitles            (an unusual subtitle track must not block the video)
      const attempts = [{ plan, withSubs: hasSubs }];
      if (plan && (plan.video !== 'encode' || plan.audio !== 'encode')) attempts.push({ plan: ENCODE_ALL, withSubs: hasSubs });
      if (hasSubs) attempts.push({ plan: plan ? ENCODE_ALL : null, withSubs: false });

      let used = null;
      let lastError;
      for (const attempt of attempts) {
        // cancel() may arrive before ffmpeg is even started: don't start it then.
        if (current.cancelled) throw new Error('cancelled');
        await removeOutputs(); // partial files from a previous attempt
        if (!attempt.plan && !attempt.withSubs) {
          used = attempt; // nothing left to do (file already plays; subtitles couldn't be read)
          break;
        }
        const args = buildFfmpegArgs({
          input,
          info,
          video: attempt.plan ? { output, plan: attempt.plan } : null,
          subtitles: attempt.withSubs ? subtitleOutputs : [],
        });
        const job = runFfmpeg({ ffmpegPath: config.transcode.ffmpegPath, args, duration: info.duration, onProgress });
        current.cancel = job.cancel;
        try {
          await job.promise;
          used = attempt;
          break;
        } catch (err) {
          if (current.cancelled) throw err;
          lastError = err;
          console.warn(`[convert] ${video.shareId}: attempt failed, trying a safer option (${err.message})`);
        }
      }
      if (!used) throw lastError;
      if (current.cancelled) throw new Error('cancelled');

      // Keep only subtitle files that really contain text.
      const subtitles = [];
      if (used.withSubs) {
        for (const s of subtitleOutputs) {
          const { size } = await fs.stat(s.output).catch(() => ({ size: 0 }));
          if (size > EMPTY_VTT_BYTES) subtitles.push({ file: s.file, language: s.language, label: s.label });
          else await removeFileQuietly(s.output);
        }
      }

      const update = { subtitles, status: 'ready', progress: 100 };
      if (used.plan) {
        const { size } = await fs.stat(output);
        Object.assign(update, { storedName: outputName, mimeType: 'video/mp4', size });
      }
      // Only swap if the video wasn't deleted in the meantime.
      const updated = await Video.findOneAndUpdate({ _id: id, status: 'processing' }, update);
      if (!updated) {
        await removeOutputs();
        return;
      }
      if (used.plan) await removeFileQuietly(input);
      console.log(
        `[convert] ${video.shareId}: done (${used.plan ? `${used.plan.video} video, ${used.plan.audio} audio` : 'video kept'}, ` +
          `${subtitles.length} subtitle track(s))`,
      );
    } catch (err) {
      await removeOutputs();
      if (current?.cancelled) return;
      console.error(`[convert] ${video.shareId}: failed: ${err.message}`);
      // Keep the original so it can still be downloaded.
      await Video.updateOne({ _id: id }, { status: 'failed' });
    }
  }

  async function runNext() {
    if (current) return;
    const id = pending.shift();
    if (!id) {
      idleWaiters.forEach((resolve) => resolve());
      idleWaiters = [];
      return;
    }
    current = { id, cancel: () => {}, cancelled: false };
    current.done = convert(id).catch((err) => console.error(`[convert] unexpected error: ${err.message}`));
    await current.done;
    current = null;
    // Tail call: must also be guarded so a throw here doesn't surface as an
    // unhandled rejection (the caller may have already released its .catch chain).
    runNext().catch((err) => console.error(`[convert] queue error: ${err.message}`));
  }

  return {
    enqueue(id) {
      const key = String(id);
      if (!pending.includes(key) && current?.id !== key) pending.push(key);
      runNext().catch((err) => console.error(`[convert] queue error: ${err.message}`));
    },
    /** Stop (or un-queue) a conversion, e.g. because the video is being deleted. */
    async cancel(id) {
      const key = String(id);
      const index = pending.indexOf(key);
      if (index !== -1) pending.splice(index, 1);
      if (current?.id === key) {
        current.cancelled = true;
        current.cancel();
        await current.done; // wait until ffmpeg has exited and released the files
      }
    },
    /** On shutdown: kill ffmpeg. The video stays "processing" and is re-queued on next start. */
    async stop() {
      pending.length = 0;
      if (current) await this.cancel(current.id);
    },
    /** Resolves when no conversion is running or waiting (used by tests). */
    whenIdle() {
      if (!current && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
