import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { deleteVideo, forgetDeleteToken, formatBytes, getDeleteToken, getResumeTime, listVideos } from '../services/api.js';

/**
 * Remote-control navigation: arrow keys move focus to the nearest tile in that
 * direction, OK/Enter opens it (tiles are ordinary links). Many TV browsers do this
 * themselves, but not all, so we do it explicitly.
 */
function moveFocus(direction, container) {
  const tiles = [...container.querySelectorAll('[data-tile]')];
  const current = document.activeElement;
  if (!tiles.includes(current)) return tiles[0]?.focus();

  const from = current.getBoundingClientRect();
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = null;
  let bestScore = Infinity;

  for (const tile of tiles) {
    if (tile === current) continue;
    const r = tile.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const inDirection =
      (direction === 'ArrowRight' && dx > 1) ||
      (direction === 'ArrowLeft' && dx < -1) ||
      (direction === 'ArrowDown' && dy > 1) ||
      (direction === 'ArrowUp' && dy < -1);
    if (!inDirection) continue;
    // Prefer tiles straight ahead: penalise sideways distance.
    const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
    const score = horizontal ? Math.abs(dx) + Math.abs(dy) * 3 : Math.abs(dy) + Math.abs(dx) * 3;
    if (score < bestScore) {
      bestScore = score;
      best = tile;
    }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

export default function LibraryPage() {
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState('');
  const gridRef = useRef(null);
  const focusedOnce = useRef(false);

  async function load() {
    try {
      const data = await listVideos();
      setVideos(data.videos);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // While something is converting, refresh every 5 s so progress and "ready" show up by themselves.
  const converting = videos?.some((v) => v.status === 'processing');
  useEffect(() => {
    if (!converting) return undefined;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [converting]);

  // Put focus on the first tile once, so the remote works immediately.
  useEffect(() => {
    if (videos?.length && !focusedOnce.current) {
      focusedOnce.current = true;
      gridRef.current?.querySelector('[data-tile]')?.focus();
    }
  }, [videos]);

  useEffect(() => {
    function onKeyDown(e) {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) || !gridRef.current) return;
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      moveFocus(e.key, gridRef.current);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function onDelete(video) {
    try {
      await deleteVideo(video.id, getDeleteToken(video.id));
      forgetDeleteToken(video.id);
      setVideos((list) => list.filter((v) => v.id !== video.id));
    } catch (err) {
      setError(err.message);
    }
  }

  if (error && !videos) {
    return (
      <section className="card">
        <h1>Library unavailable</h1>
        <p className="error">{error}</p>
        <button type="button" onClick={load}>Try again</button>
      </section>
    );
  }
  if (!videos) return <p className="card muted">Loading library…</p>;

  if (videos.length === 0) {
    return (
      <section className="card">
        <h1>No videos yet</h1>
        <p>
          On your phone or laptop (same Wi-Fi), open <strong>{window.location.host}/upload</strong> and upload a
          movie or episodes.
        </p>
        <Link className="button" to="/upload" data-tile>Upload</Link>
      </section>
    );
  }

  return (
    <section>
      <div className="library-header">
        <h1>Library</h1>
        <span className="muted">{videos.length} video{videos.length === 1 ? '' : 's'}</span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="tile-grid" ref={gridRef}>
        {videos.map((video) => {
          const resumeAt = getResumeTime(video.id);
          const canDelete = Boolean(getDeleteToken(video.id));
          return (
            <div key={video.id} className="tile-wrap">
              <Link to={`/watch/${video.id}`} className="tile" data-tile>
                <span className="tile-title">{video.title}</span>
                <span className="tile-meta">
                  {video.status === 'processing' && <span className="badge">Converting {video.progress}%</span>}
                  {video.status === 'failed' && <span className="badge badge-error">Can’t convert</span>}
                  {video.status === 'ready' && resumeAt > 0 && <span className="badge">Resume</span>}
                  <span>{formatBytes(video.size)}</span>
                </span>
              </Link>
              {canDelete && (
                <button type="button" className="tile-delete danger" onClick={() => onDelete(video)} data-tile>
                  Delete
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
