import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import ProgressBar from '../components/ProgressBar.jsx';
import {
  deleteVideo,
  forgetDeleteToken,
  formatBytes,
  getDeleteToken,
  getDownloadUrl,
  getResumeTime,
  getStreamUrl,
  getSubtitleUrl,
  getVideo,
  setResumeTime,
} from '../services/api.js';
import {
  getSubtitlePreference,
  setSubtitlePreference,
  showSubtitleTrack,
  toggleFullscreen,
} from '../services/player.js';

const MEDIA_ERRORS = {
  2: 'A network error stopped the video. Check the laptop is on and connected, then retry.',
  3: 'This browser could not decode the video.',
  4: 'This browser cannot play this video (or the server is busy).',
};

export default function WatchPage() {
  const { shareId } = useParams();
  const navigate = useNavigate();
  const [video, setVideo] = useState(null);
  const [error, setError] = useState('');
  const [playerError, setPlayerError] = useState('');
  const [playerKey, setPlayerKey] = useState(0); // bump to remount <video> on retry
  const [deleteError, setDeleteError] = useState('');
  const [deleteRunning, setDeleteRunning] = useState(false);
  const videoRef = useRef(null);
  const [subtitleIndex, setSubtitleIndex] = useState(-1); // -1 = subtitles off
  const subtitles = video?.subtitles ?? [];
  const subtitleIndexRef = useRef(-1);
  subtitleIndexRef.current = subtitleIndex;

  // Only show Delete on the device that did the upload (has the token in localStorage).
  const deleteToken = video ? getDeleteToken(video.id) : null;

  // Start with the language chosen last time on this device (if this video has it).
  useEffect(() => {
    const preferred = getSubtitlePreference();
    const match = subtitles.findIndex((s) => s.language === preferred);
    setSubtitleIndex(preferred === 'off' ? -1 : match);
  }, [video?.id, subtitles.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply the choice to the <video>'s text tracks (also after a retry remounts the player).
  useEffect(() => {
    showSubtitleTrack(videoRef.current, subtitleIndex);
  }, [subtitleIndex, playerKey, video]);

  // Off -> first track -> second track -> ... -> Off
  function cycleSubtitles() {
    const next = subtitleIndexRef.current + 1 >= subtitles.length ? -1 : subtitleIndexRef.current + 1;
    setSubtitleIndex(next);
    setSubtitlePreference(next === -1 ? 'off' : subtitles[next].language);
  }
  const cycleSubtitlesRef = useRef(cycleSubtitles);
  cycleSubtitlesRef.current = cycleSubtitles;

  // Load metadata; while the file is converting, poll every 3 s until it is ready.
  useEffect(() => {
    let cancelled = false;
    let timer;
    let prevStatus = null;
    async function load() {
      try {
        const data = await getVideo(shareId);
        if (cancelled) return;
        setVideo(data.video);
        const status = data.video.status;
        if (status === 'processing') {
          // Keep polling until the conversion finishes.
          timer = setTimeout(load, 3000);
        } else if (prevStatus === 'processing') {
          // Status just changed from 'processing' → 'ready' or 'failed'.
          // One extra fetch after a short delay ensures the final state
          // (e.g. the 'failed' error banner) is visible without a manual reload.
          timer = setTimeout(load, 1000);
        }
        prevStatus = status;
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [shareId]);

  // Remote control: OK/Enter/Play-Pause toggles, Left/Right seek 10 s, F = fullscreen, S = subtitles.
  useEffect(() => {
    function onKeyDown(e) {
      const el = videoRef.current;
      if (!el) return;
      // OK on a focused link/button (Library, Download, Retry) must still activate it.
      const onControl = e.target instanceof HTMLAnchorElement || e.target instanceof HTMLButtonElement;
      if (onControl && (e.key === 'Enter' || e.key === ' ')) return;
      switch (e.key) {
        case 'Enter':
        case ' ':
        case 'MediaPlayPause':
          e.preventDefault();
          if (el.paused) el.play();
          else el.pause();
          break;
        case 'MediaPlay':
          el.play();
          break;
        case 'MediaPause':
          el.pause();
          break;
        case 'ArrowRight':
        case 'MediaFastForward':
          e.preventDefault();
          el.currentTime = Math.min(el.currentTime + 10, el.duration || Infinity);
          break;
        case 'ArrowLeft':
        case 'MediaRewind':
          e.preventDefault();
          el.currentTime = Math.max(el.currentTime - 10, 0);
          break;
        case 'f':
          toggleFullscreen(el);
          break;
        case 's':
        case 'Subtitle': // subtitle key on some remotes
          cycleSubtitlesRef.current();
          break;
        case 'Escape':
        case 'Backspace':
        case 'BrowserBack':
        case 'GoBack':
          if (!onControl) {
            e.preventDefault();
            navigate('/');
          }
          break;
        default:
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  function onLoadedMetadata(e) {
    setPlayerError('');
    const el = e.currentTarget;
    const resumeAt = getResumeTime(shareId);
    // Resume where we stopped, unless that was right at the end.
    if (resumeAt > 5 && resumeAt < el.duration - 30) el.currentTime = resumeAt;
    // Text tracks exist now: apply the subtitle choice.
    showSubtitleTrack(el, subtitleIndexRef.current);
    el.focus();
  }

  // Save position every few seconds (timeupdate fires ~4x/s; the helper is cheap).
  const lastSaved = useRef(0);
  function onTimeUpdate(e) {
    const t = e.currentTarget.currentTime;
    if (Math.abs(t - lastSaved.current) >= 5) {
      lastSaved.current = t;
      setResumeTime(shareId, t);
    }
  }

  async function onDelete() {
    if (!deleteToken) return;
    setDeleteRunning(true);
    setDeleteError('');
    try {
      await deleteVideo(video.id, deleteToken);
      forgetDeleteToken(video.id);
      setResumeTime(shareId, 0); // clear saved position
      navigate('/');
    } catch (err) {
      setDeleteError(err.message);
      setDeleteRunning(false);
    }
  }

  if (error) {
    return (
      <section className="card">
        <h1>Video unavailable</h1>
        <p className="error">{error}</p>
        <Link className="button" to="/">Back to library</Link>
      </section>
    );
  }
  if (!video) return <p className="card muted">Loading video…</p>;

  if (video.status === 'processing') {
    return (
      <section className="card">
        <h1>{video.title}</h1>
        <p>Converting so it plays on your TV… this page will start the video when it’s ready.</p>
        <ProgressBar percent={video.progress} />
        <p className="muted small">Short for most files; a full movie that needs re-encoding can take a while.</p>
        <Link className="button secondary" to="/">Back to library</Link>
      </section>
    );
  }

  return (
    <section className="watch">
      <div className="watch-header">
        <Link to="/" className="button secondary" data-tile>← Library</Link>
        <h1>{video.title}</h1>
      </div>
      {video.status === 'failed' && (
        <p className="error">
          This file couldn’t be converted, so it may not play here. You can still download it and use a player like VLC.
        </p>
      )}
      {/*
        The browser does the hard work: it sends Range requests, buffers ahead,
        and requests new ranges when you seek.
      */}
      <video
        key={playerKey}
        ref={videoRef}
        className="player"
        controls
        autoPlay
        preload="metadata"
        playsInline
        src={getStreamUrl(shareId)}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onEnded={() => setResumeTime(shareId, 0)}
        onError={(e) => setPlayerError(MEDIA_ERRORS[e.currentTarget.error?.code] ?? 'The video failed to load.')}
      >
        {/* Subtitle tracks extracted from the video file (WebVTT). Which one shows is
            controlled with textTracks modes, so no `default` attribute here. */}
        {subtitles.map((s) => (
          <track
            key={s.index}
            kind="subtitles"
            src={getSubtitleUrl(shareId, s.index)}
            srcLang={s.language}
            label={s.label}
          />
        ))}
      </video>
      {playerError && (
        <div className="error">
          {playerError}{' '}
          <button type="button" className="link-button" onClick={() => setPlayerKey((k) => k + 1)}>
            Retry
          </button>
        </div>
      )}
      <div className="watch-footer">
        <div className="actions player-actions">
          <button type="button" onClick={() => toggleFullscreen(videoRef.current)} data-tile>⛶ Fullscreen</button>
          {subtitles.length > 0 && (
            <button type="button" className="secondary" onClick={cycleSubtitles} aria-live="polite" data-tile>
              CC Subtitles: {subtitleIndex === -1 ? 'Off' : subtitles[subtitleIndex]?.label}
            </button>
          )}
          <a className="button secondary" href={getDownloadUrl(shareId)} data-tile>Download</a>
          {deleteToken && (
            <button
              type="button"
              className="secondary danger"
              onClick={onDelete}
              disabled={deleteRunning}
              title="Delete this video (only visible on the device that uploaded it)"
              data-tile
            >
              {deleteRunning ? 'Deleting…' : '🗑 Delete'}
            </button>
          )}
        </div>
        {deleteError && <p className="error small">{deleteError}</p>}
        <div className="remote-hints-bar">
          <span className="remote-hint"><kbd>OK</kbd> Play / Pause</span>
          <span className="remote-hint"><kbd>◀ ▶</kbd> Skip 10s</span>
          <span className="remote-hint"><kbd>Back</kbd> Library</span>
          {subtitles.length > 0 && <span className="remote-hint"><kbd>S</kbd> Subtitles</span>}
          <span className="remote-hint"><kbd>F</kbd> Fullscreen</span>
          <span className="remote-hint-size">{formatBytes(video.size)}</span>
        </div>
      </div>
    </section>
  );
}
