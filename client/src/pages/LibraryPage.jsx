import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  deleteAllVideos,
  deleteVideo,
  forgetDeleteToken,
  formatBytes,
  getDeleteToken,
  getResumeTime,
  listVideos,
} from '../services/api.js';

/**
 * Generates a deterministic vibrant gradient based on video id/title
 * giving every video in the gallery a unique, rich CollectUI thumbnail look.
 */
const GRADIENT_PALETTES = [
  'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)',
  'linear-gradient(135deg, #3a1c71 0%, #d76d77 50%, #ffaf7b 100%)',
  'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  'linear-gradient(135deg, #134e5e 0%, #71b280 100%)',
  'linear-gradient(135deg, #4b1248 0%, #f0c27b 100%)',
  'linear-gradient(135deg, #1f4037 0%, #99f2c8 100%)',
  'linear-gradient(135deg, #2c3e50 0%, #3498db 100%)',
  'linear-gradient(135deg, #302b63 0%, #0f0c29 100%)',
  'linear-gradient(135deg, #1a2a6c 0%, #b21f1f 50%, #fdbb2d 100%)',
  'linear-gradient(135deg, #000428 0%, #004e92 100%)',
];

function getCardGradient(id = '') {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % GRADIENT_PALETTES.length;
  return GRADIENT_PALETTES[index];
}

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
  const [searchQuery, setSearchQuery] = useState('');
  const gridRef = useRef(null);
  const focusedOnce = useRef(false);

  // Delete-all dialog state
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [deleteAllError, setDeleteAllError] = useState('');
  const [deleteAllRunning, setDeleteAllRunning] = useState(false);

  // Load video list
  const load = useCallback(async () => {
    try {
      const data = await listVideos();
      setVideos(data.videos);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While something is converting, refresh every 5 s so progress and "ready" show up by themselves.
  const converting = videos?.some((v) => v.status === 'processing');
  useEffect(() => {
    if (!converting) return undefined;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [converting, load]);

  // Put focus on the first tile once, so the TV remote works immediately.
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

  async function onDelete(video, e) {
    e?.preventDefault();
    e?.stopPropagation();
    try {
      await deleteVideo(video.id, getDeleteToken(video.id));
      forgetDeleteToken(video.id);
      setVideos((list) => list.filter((v) => v.id !== video.id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function onDeleteAll() {
    setDeleteAllRunning(true);
    setDeleteAllError('');
    try {
      await deleteAllVideos();
      setShowDeleteAll(false);
      await load();
    } catch (err) {
      setDeleteAllError(err.message);
    } finally {
      setDeleteAllRunning(false);
    }
  }

  const filteredVideos = useMemo(() => {
    if (!videos) return [];
    if (!searchQuery.trim()) return videos;
    const q = searchQuery.toLowerCase();
    return videos.filter((v) => v.title.toLowerCase().includes(q));
  }, [videos, searchQuery]);

  if (error && !videos) {
    return (
      <section className="state-card">
        <div className="state-icon-box error-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 className="state-title">Library Unavailable</h1>
        <p className="state-description error">{error}</p>
        <button type="button" className="btn-primary" onClick={load} data-tile>
          Try Again
        </button>
      </section>
    );
  }

  if (!videos) {
    return (
      <div className="state-card">
        <div className="state-spinner" />
        <p className="state-title">Loading Video Library…</p>
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <section className="state-card empty-library-card">
        <div className="state-icon-box tv-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
            <polyline points="17 2 12 7 7 2" />
          </svg>
        </div>
        <h1 className="state-title">No videos yet</h1>
        <p className="state-description">
          Upload videos to start watching.
        </p>
        <Link className="btn-primary" to="/upload" data-tile>
          Upload Videos
        </Link>
      </section>
    );
  }

  return (
    <section className="library-container">
      {/* Gallery Header */}
      <div className="library-top-bar">
        <div className="library-title-group">
          <h1 className="library-heading">Library</h1>
          <span className="library-count-pill">
            {videos.length} {videos.length === 1 ? 'video' : 'videos'}
          </span>
        </div>

        <div className="library-actions-group">
          {videos.length > 3 && (
            <div className="search-box">
              <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="search-input"
              />
              {searchQuery && (
                <button type="button" className="search-clear" onClick={() => setSearchQuery('')}>
                  ✕
                </button>
              )}
            </div>
          )}

          <Link to="/upload" className="btn-header-upload" data-tile>
            <span>+ Upload</span>
          </Link>

          <button
            type="button"
            className="btn-header-danger"
            onClick={() => {
              setShowDeleteAll(true);
              setDeleteAllError('');
            }}
            title="Delete all videos"
            data-tile
          >
            🗑 Delete All
          </button>
        </div>
      </div>

      {/* Delete-All Modal Dialog */}
      {showDeleteAll && (
        <div className="modal-backdrop" onClick={() => !deleteAllRunning && setShowDeleteAll(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-icon-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </div>
            <h2 className="modal-title">Delete all {videos.length} videos?</h2>
            <p className="modal-description">
              This permanently deletes all videos.
            </p>
            {deleteAllError && <p className="modal-error">{deleteAllError}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="btn-modal-danger"
                onClick={onDeleteAll}
                disabled={deleteAllRunning}
                autoFocus
              >
                {deleteAllRunning ? 'Deleting…' : 'Delete All'}
              </button>
              <button
                type="button"
                className="btn-modal-cancel"
                onClick={() => {
                  setShowDeleteAll(false);
                  setDeleteAllError('');
                }}
                disabled={deleteAllRunning}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="error-banner">{error}</p>}

      {/* CollectUI Inspired Video Shot Grid */}
      <div className="gallery-grid" ref={gridRef}>
        {filteredVideos.map((video) => {
          const resumeAt = getResumeTime(video.id);
          const canDelete = Boolean(getDeleteToken(video.id));
          const cardBackground = getCardGradient(video.id);

          return (
            <div key={video.id} className="gallery-card-wrapper">
              <Link to={`/watch/${video.id}`} className="gallery-card" data-tile tabIndex={0}>
                {/* Visual Thumbnail Banner */}
                <div className="card-thumb" style={{ background: cardBackground }}>
                  {/* Decorative film pattern overlay */}
                  <div className="card-thumb-pattern" />

                  {/* Play Overlay */}
                  <div className="card-play-overlay">
                    <div className="play-button-icon">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </div>
                  </div>

                  {/* Top Status Badges */}
                  <div className="card-badge-top-left">
                    {video.status === 'processing' && (
                      <span className="card-badge badge-converting">
                        <span className="pulse-dot" /> Converting {video.progress}%
                      </span>
                    )}
                    {video.status === 'failed' && (
                      <span className="card-badge badge-failed">Failed</span>
                    )}
                    {video.status === 'ready' && resumeAt > 0 && (
                      <span className="card-badge badge-resume">
                        ▶ Resume
                      </span>
                    )}
                  </div>

                  {/* Video Size & Format Pill */}
                  <div className="card-badge-bottom-right">
                    <span className="card-size-pill">{formatBytes(video.size)}</span>
                  </div>
                </div>

                {/* Card Content Footer */}
                <div className="card-info">
                  <h3 className="card-video-title" title={video.title}>
                    {video.title}
                  </h3>
                </div>
              </Link>

              {/* Uploader Delete Button */}
              {canDelete && (
                <button
                  type="button"
                  className="card-quick-delete-btn"
                  onClick={(e) => onDelete(video, e)}
                  title="Delete"
                  data-tile
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="del-icon">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  <span>Delete</span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* TV Remote Shortcuts Legend */}
      <footer className="library-remote-footer">
        <div className="remote-hints-bar">
          <span className="remote-hint"><kbd>▲ ▼ ◀ ▶</kbd> Move</span>
          <span className="remote-hint"><kbd>OK</kbd> Open</span>
          <span className="remote-hint"><kbd>Back</kbd> Exit</span>
        </div>
      </footer>
    </section>
  );
}


