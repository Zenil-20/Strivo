import { Router } from 'express';
import { Video } from '../models/Video.js';
import { validateShareId } from '../middleware/validate.js';
import { AppError } from '../utils/AppError.js';

/**
 * "Simple TV mode": plain server-rendered HTML with NO JavaScript at all.
 *
 * Some TV browsers are so old that they cannot run the React app even with
 * polyfills. Links and a native <video> element work in practically every
 * browser ever shipped on a TV, so these pages always work:
 *   /tv            -> list of videos (big links, move with arrows, OK to open)
 *   /tv/watch/:id  -> the video player
 */

// Everything user-provided (titles, names) is escaped: this is plain string HTML.
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// Deliberately old-fashioned CSS (no variables, grid, clamp...) so ancient engines render it.
const STYLE = `
  body { margin: 0; padding: 24px; background: #111; color: #eee; font-family: sans-serif; font-size: 24px; }
  h1 { font-size: 34px; margin: 0 0 20px; }
  a { color: #8fb4ff; }
  .item { display: block; margin: 0 0 14px; padding: 18px 22px; background: #222; color: #fff;
          text-decoration: none; border: 4px solid #333; border-radius: 10px; }
  .item:focus, .item:hover, .btn:focus, .btn:hover { border-color: #f5a623; outline: none; background: #2c2c2c; }
  .meta { display: block; margin-top: 6px; font-size: 18px; color: #aaa; }
  .badge { color: #f5a623; }
  .btn { display: inline-block; margin: 16px 16px 0 0; padding: 14px 24px; background: #222; color: #fff;
         text-decoration: none; border: 4px solid #333; border-radius: 10px; }
  .btn.on { border-color: #2f6fed; background: #1d3a7a; }
  video { width: 100%; max-height: 80%; background: #000; }
  .hint { color: #aaa; font-size: 18px; }
`;

const TV_SCRIPT = `(function () {
  var video = document.getElementById('player');
  var button = document.getElementById('fullscreen');
  if (!video || !button) return;
  var enter = video.requestFullscreen || video.webkitRequestFullscreen || video.webkitEnterFullscreen ||
    video.mozRequestFullScreen || video.msRequestFullscreen;
  if (!enter) return; // no fullscreen API: keep the button hidden
  button.style.display = 'inline-block';
  button.onclick = function () {
    var result = enter.call(video);
    if (result && typeof result.then === 'function') result.then(null, function () {});
    return false; // don't follow the link
  };
})();
`;

function page(title, body, { refreshSeconds } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}
<title>${escapeHtml(title)} - Strivo</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function createTvRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    const videos = await Video.find()
      .sort({ title: 1, createdAt: 1 })
      .collation({ locale: 'en', numericOrdering: true, strength: 2 })
      .limit(1000);

    const items = videos
      .map((v) => {
        const status =
          v.status === 'processing'
            ? ` <span class="badge">Converting ${v.progress}%</span>`
            : v.status === 'failed'
              ? ' <span class="badge">Could not convert</span>'
              : '';
        return `<a class="item" href="/tv/watch/${escapeHtml(v.shareId)}">${escapeHtml(v.title)}
  <span class="meta">${formatBytes(v.size)}${status}</span></a>`;
      })
      .join('\n');

    const converting = videos.some((v) => v.status === 'processing');
    const body = `<h1>Strivo</h1>
${items || `<p>No videos yet. On your phone or laptop open <strong>${escapeHtml(req.get('host'))}/upload</strong>.</p>`}
<p class="hint">Arrows to choose, OK to play.</p>`;

    res.set('Cache-Control', 'no-cache');
    // While something converts, reload every 10 s so progress updates without JavaScript.
    res.send(page('Library', body, { refreshSeconds: converting ? 10 : 0 }));
  });

  router.get('/watch/:shareId', validateShareId, async (req, res) => {
    const video = await Video.findOne({ shareId: req.params.shareId });
    if (!video) throw new AppError(404, 'Video not found');

    const streamUrl = `/api/videos/${escapeHtml(video.shareId)}/stream`;
    res.set('Cache-Control', 'no-cache');

    if (video.status === 'processing') {
      return res.send(
        page(
          video.title,
          `<h1>${escapeHtml(video.title)}</h1>
<p>Converting for your TV: ${video.progress}%. This page refreshes by itself.</p>
<a class="btn" href="/tv">&larr; Back</a>`,
          { refreshSeconds: 10 },
        ),
      );
    }

    // Subtitles without JavaScript: the chosen track (?sub=0, ?sub=1 ...) gets the `default`
    // attribute so the browser shows it; ?sub=off (or nothing) shows none.
    const subtitles = video.subtitles ?? [];
    const chosen = /^\d{1,2}$/.test(String(req.query.sub)) ? Number(req.query.sub) : -1;
    const selected = chosen < subtitles.length ? chosen : -1;
    const base = `/tv/watch/${escapeHtml(video.shareId)}`;

    const tracks = subtitles
      .map(
        (s, i) =>
          `<track kind="subtitles" src="/api/videos/${escapeHtml(video.shareId)}/subtitles/${i}" ` +
          `srclang="${escapeHtml(s.language)}" label="${escapeHtml(s.label)}"${i === selected ? ' default' : ''}>`,
      )
      .join('');

    const subtitleLinks = subtitles.length
      ? `<div><span class="hint">Subtitles:</span>
  <a class="btn${selected === -1 ? ' on' : ''}" href="${base}?sub=off">Off</a>
  ${subtitles
    .map((s, i) => `<a class="btn${i === selected ? ' on' : ''}" href="${base}?sub=${i}">${escapeHtml(s.label)}</a>`)
    .join('\n  ')}
</div>`
      : '';

    res.send(
      page(
        video.title,
        `<h1>${escapeHtml(video.title)}</h1>
<video id="player" src="${streamUrl}" controls autoplay preload="metadata">${tracks}</video>
<div>
  <a class="btn" href="/tv">&larr; Back</a>
  <a class="btn" id="fullscreen" href="${streamUrl}" style="display:none">Fullscreen</a>
  <a class="btn" href="${streamUrl}">Open in TV player</a>
</div>
${subtitleLinks}
<p class="hint">If the video does not play here, press "Open in TV player":
the TV then plays the file with its own video player.</p>
<script src="/tv/tv.js"></script>`,
      ),
    );
  });

  /**
   * The ONE optional script of simple TV mode: a Fullscreen button. Plain ES5 so any browser
   * runs it. If it fails, the page still works (the button just stays hidden).
   * It is a separate file (not inline) so our CSP (script-src 'self') allows it.
   */
  router.get('/tv.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').send(TV_SCRIPT);
  });

  return router;
}
