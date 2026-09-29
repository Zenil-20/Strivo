// Relative by default: the page and the API come from the same address
// (http://<laptop-ip>:5000 in `npm start`, or through Vite's proxy in `npm run dev`).
const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

// 0 / unset = no client-side size check (the server has no cap by default either).
export const MAX_VIDEO_SIZE_BYTES = Number(import.meta.env.VITE_MAX_VIDEO_SIZE_MB || 0) * 1024 * 1024;
// Mirrors server/src/utils/videoFormats.js. The browser's MIME type is not checked:
// it is often empty for .mkv/.avi/.ts, and the server verifies the file content anyway.
export const ALLOWED_EXTENSIONS = [
  '.mp4', '.m4v', '.mov', '.3gp', '.3g2', '.webm', '.mkv', '.ogv', '.avi',
  '.wmv', '.asf', '.flv', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts',
  '.vob', '.divx', '.f4v', '.ogm', '.rm', '.rmvb',
];

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Request failed (${res.status})`);
  return body;
}

/**
 * Upload with XMLHttpRequest because fetch() cannot report upload progress.
 * Returns { promise, abort }.
 */
export function uploadVideo(file, title, onProgress) {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  if (title) form.append('title', title); // text fields before the file
  form.append('video', file);

  const promise = new Promise((resolve, reject) => {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON response */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error — is the server running?'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
  });

  xhr.open('POST', `${API_URL}/api/videos/upload`);
  xhr.send(form);
  return { promise, abort: () => xhr.abort() };
}

export async function listVideos() {
  return readJson(await fetch(`${API_URL}/api/videos`));
}

export async function getVideo(shareId) {
  return readJson(await fetch(`${API_URL}/api/videos/${encodeURIComponent(shareId)}`));
}

export async function deleteVideo(shareId, deleteToken) {
  const res = await fetch(`${API_URL}/api/videos/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
    headers: { 'X-Delete-Token': deleteToken },
  });
  return readJson(res);
}

export async function deleteAllVideos() {
  const res = await fetch(`${API_URL}/api/videos`, {
    method: 'DELETE',
  });
  return readJson(res);
}

// The <video> element fetches this URL itself, using Range requests.
export const getStreamUrl = (shareId) => `${API_URL}/api/videos/${encodeURIComponent(shareId)}/stream`;
export const getDownloadUrl = (shareId) => `${getStreamUrl(shareId)}?download=1`;
export const getSubtitleUrl = (shareId, index) =>
  `${API_URL}/api/videos/${encodeURIComponent(shareId)}/subtitles/${index}`;

// Delete tokens are remembered on the device that uploaded the video, so "Delete" shows up
// in that device's library later. localStorage can be unavailable (private mode), hence try/catch.
const TOKEN_KEY = 'strivo.deleteTokens';
function readTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY)) || {};
  } catch {
    return {};
  }
}
function writeTokens(tokens) {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch {
    /* not persisted: delete only works until the page is closed */
  }
}
export const getDeleteToken = (shareId) => readTokens()[shareId];
export const saveDeleteToken = (shareId, token) => writeTokens({ ...readTokens(), [shareId]: token });
export function forgetDeleteToken(shareId) {
  const tokens = readTokens();
  delete tokens[shareId];
  writeTokens(tokens);
}

// Remember where playback stopped, per video, on this device (TV).
const RESUME_KEY = (shareId) => `strivo.resume.${shareId}`;
export function getResumeTime(shareId) {
  try {
    return Number(localStorage.getItem(RESUME_KEY(shareId))) || 0;
  } catch {
    return 0;
  }
}
export function setResumeTime(shareId, seconds) {
  try {
    if (seconds > 0) localStorage.setItem(RESUME_KEY(shareId), String(Math.floor(seconds)));
    else localStorage.removeItem(RESUME_KEY(shareId));
  } catch {
    /* ignore */
  }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
