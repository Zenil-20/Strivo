import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * What every TV / phone browser can play: H.264 video (8-bit 4:2:0) + AAC or MP3 audio
 * inside an MP4/MOV container. Anything else gets converted to exactly that.
 * Audio in ANY other codec ffmpeg can decode (AC3, E-AC3, DTS, TrueHD, FLAC, Opus, Vorbis,
 * PCM, MP2, WMA, ALAC, AMR, RealAudio, ...) is re-encoded to AAC.
 */
const TV_VIDEO_CODECS = new Set(['h264']);
const TV_PIXEL_FORMATS = new Set(['yuv420p', 'yuvj420p']); // 10-bit H.264 does NOT play in browsers
const TV_AUDIO_CODECS = new Set(['aac', 'mp3']);
const TV_CONTAINERS = new Set(['.mp4', '.m4v', '.mov']);

/**
 * Subtitle tracks that are TEXT can be converted to WebVTT, which browsers show with <track>.
 * Picture-based subtitles (Blu-ray PGS, DVD VobSub, DVB) would need OCR, so they are skipped.
 */
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
export const MAX_SUBTITLE_TRACKS = 20;

export const ENCODE_ALL = { video: 'encode', audio: 'encode' };

const byDefaultThenFirst = (streams) => streams.find((s) => s.disposition?.default) ?? streams[0];

/** Read container/track info with ffprobe (reads only the file header, so it's fast). */
export async function probeVideo(ffprobePath, filePath) {
  const { stdout } = await execFileAsync(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 10 * 1024 * 1024, timeout: 60_000, windowsHide: true },
  );
  const data = JSON.parse(stdout);
  const streams = data.streams ?? [];

  // Ignore cover-art "video" streams (a still image attached to the file).
  const video = byDefaultThenFirst(
    streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic),
  );
  // Dual-audio movies: keep the track the file marks as default (else the first one).
  const audio = byDefaultThenFirst(streams.filter((s) => s.codec_type === 'audio'));

  return {
    duration: Number(data.format?.duration) || 0,
    video: video ? { index: video.index, codec: video.codec_name, pixelFormat: video.pix_fmt } : null,
    audio: audio ? { index: audio.index, codec: audio.codec_name, language: audio.tags?.language } : null,
    subtitles: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        language: s.tags?.language,
        title: s.tags?.title,
        isText: TEXT_SUBTITLE_CODECS.has(s.codec_name),
      })),
  };
}

/** Text subtitle tracks we can extract (bitmap ones are skipped). */
export const extractableSubtitles = (info) => info.subtitles.filter((s) => s.isText).slice(0, MAX_SUBTITLE_TRACKS);

/**
 * Decide what to do with the video/audio of an upload.
 * Returns null when the file already plays everywhere, otherwise which streams
 * can be copied as-is ("copy" = seconds, just re-packaging) and which must be
 * re-encoded ("encode" = CPU-heavy, especially video).
 */
export function planConversion(info, ext) {
  // Guard: probeVideo() returns video:null for audio-only or unreadable containers.
  // The upload controller already rejects such files, but the conversion worker
  // calls this function too — a crash here would silently freeze the job.
  if (!info.video) return null;
  const videoOk = TV_VIDEO_CODECS.has(info.video.codec) && TV_PIXEL_FORMATS.has(info.video.pixelFormat);
  const audioOk = !info.audio || TV_AUDIO_CODECS.has(info.audio.codec);
  if (videoOk && audioOk && TV_CONTAINERS.has(ext)) return null;
  return { video: videoOk ? 'copy' : 'encode', audio: audioOk ? 'copy' : 'encode' };
}

/**
 * One ffmpeg command, possibly several outputs, so a big file is read ONCE:
 *  - (optional) the TV-friendly MP4: chosen video track + chosen audio track
 *  - (optional) one .vtt file per text subtitle track
 */
export function buildFfmpegArgs({ input, info, video, subtitles = [] }) {
  // Subtitle sync: by default ffmpeg shifts ALL outputs by the input's start time (e.g. AAC
  // priming makes a file start at -0.023 s; MPEG-TS files often start at +1.4 s). When the
  // MP4 is written in the same run, video and subtitles shift together and stay in sync.
  // When only subtitles are extracted (the original video file is kept), the video is NOT
  // shifted, so the subtitles must keep the original timestamps too: -copyts.
  const keepTimestamps = !video ? ['-copyts'] : [];
  const args = ['-hide_banner', '-nostdin', '-y', ...keepTimestamps, '-i', input, '-progress', 'pipe:1', '-nostats'];

  if (video) {
    const { output, plan } = video;
    args.push('-map', `0:${info.video.index}`);
    if (info.audio) args.push('-map', `0:${info.audio.index}`);
    args.push(
      '-sn', '-dn',
      ...(plan.video === 'copy'
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p']),
      // Stereo AAC: every TV/browser plays it; 5.1/7.1 is downmixed.
      ...(plan.audio === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
      // Put the MP4 index at the start so playback can begin before the whole file is fetched.
      '-movflags', '+faststart',
      '-f', 'mp4', output,
    );
  }

  for (const sub of subtitles) {
    args.push('-map', `0:${sub.index}`, '-c:s', 'webvtt', '-f', 'webvtt', sub.output);
  }
  return args;
}

/**
 * Run ffmpeg. `onProgress(percent)` is called as it works.
 * Returns { promise, cancel } so a delete can stop a running conversion.
 */
export function runFfmpeg({ ffmpegPath, args, duration, onProgress }) {
  const child = spawn(ffmpegPath, args, { windowsHide: true });
  let stderrTail = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    // ffmpeg -progress prints "out_time_us=12345678" (microseconds) lines.
    const match = /out_time_(?:us|ms)=(\d+)/.exec(text);
    if (match && duration > 0) {
      onProgress(Math.min(99, Math.floor((Number(match[1]) / 1e6 / duration) * 100)));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    stderrTail = (stderrTail + text).slice(-2000); // keep only the end, for error logs
  });

  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${signal ?? code}: ${stderrTail.trim().split('\n').pop()}`));
    });
  });

  return { promise, cancel: () => child.kill('SIGKILL') };
}

// ISO 639-2 (what video files use) -> ISO 639-1 (what <track srclang> expects).
const ISO_639_2_TO_1 = {
  eng: 'en', hin: 'hi', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it',
  por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', ara: 'ar', tur: 'tr',
  tam: 'ta', tel: 'te', mar: 'mr', ben: 'bn', guj: 'gu', kan: 'kn', mal: 'ml', pan: 'pa',
  urd: 'ur', dut: 'nl', nld: 'nl', swe: 'sv', pol: 'pl', ind: 'id', tha: 'th', vie: 'vi',
};

/** "eng" -> { srclang: "en", label: "English" }, with the track title preferred as label. */
export function describeSubtitle(sub, position) {
  const code = (sub.language || '').toLowerCase();
  const srclang = ISO_639_2_TO_1[code] ?? (code.length === 2 ? code : '');
  let languageName = '';
  if (srclang) {
    try {
      languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(srclang) ?? '';
    } catch {
      languageName = '';
    }
  }
  const title = (sub.title || '').trim().slice(0, 60);
  return {
    language: srclang || 'und',
    label: title || languageName || `Subtitle ${position + 1}`,
  };
}
