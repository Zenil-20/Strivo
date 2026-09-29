import { useRef, useState } from 'react';
import { Link } from 'react-router';
import ProgressBar from '../components/ProgressBar.jsx';
import {
  ALLOWED_EXTENSIONS,
  MAX_VIDEO_SIZE_BYTES,
  deleteVideo,
  forgetDeleteToken,
  formatBytes,
  saveDeleteToken,
  uploadVideo,
} from '../services/api.js';

// Client-side checks are only for fast feedback. The server re-validates everything.
function validateFile(file) {
  const dot = file.name.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) return 'Unsupported file type';
  if (MAX_VIDEO_SIZE_BYTES && file.size > MAX_VIDEO_SIZE_BYTES) {
    return `Too large (max ${formatBytes(MAX_VIDEO_SIZE_BYTES)})`;
  }
  return null;
}

let nextKey = 0;

export default function UploadPage() {
  // One row per selected file: waiting | uploading | done | error | deleted
  const [items, setItems] = useState([]);
  const [title, setTitle] = useState('');
  const [running, setRunning] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const currentUpload = useRef(null);
  const cancelled = useRef(false);
  const fileInputRef = useRef(null);

  const update = (key, patch) => setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  function handleAddFiles(files) {
    if (!files || files.length === 0) return;
    setItems((list) => [
      ...list.filter((it) => it.status !== 'waiting' && it.status !== 'error'),
      ...files.map((file) => {
        const problem = validateFile(file);
        return { key: nextKey++, file, status: problem ? 'error' : 'waiting', progress: 0, error: problem, result: null };
      }),
    ]);
  }

  function onFilesChange(e) {
    const files = [...(e.target.files ?? [])];
    e.target.value = ''; // allow picking the same files again
    handleAddFiles(files);
  }

  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!running) setIsDragOver(true);
  }

  function onDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }

  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (running) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    handleAddFiles(files);
  }

  function removeItem(key) {
    if (running) return;
    setItems((list) => list.filter((it) => it.key !== key));
  }

  // Upload one file at a time: parallel uploads would only compete for the same Wi-Fi bandwidth.
  async function uploadAll() {
    const queue = items.filter((it) => it.status === 'waiting');
    const singleTitle = queue.length === 1 ? title.trim() : '';
    cancelled.current = false;
    setRunning(true);

    for (const item of queue) {
      if (cancelled.current) break;
      update(item.key, { status: 'uploading', progress: 0 });
      const upload = uploadVideo(item.file, singleTitle, (progress) => update(item.key, { progress }));
      currentUpload.current = upload;
      try {
        const result = await upload.promise;
        saveDeleteToken(result.video.id, result.deleteToken);
        update(item.key, { status: 'done', progress: 100, result });
      } catch (err) {
        update(item.key, { status: 'error', error: err.message });
      }
    }
    currentUpload.current = null;
    setRunning(false);
    setTitle('');
  }

  function cancel() {
    cancelled.current = true;
    currentUpload.current?.abort();
  }

  async function onDelete(item) {
    try {
      await deleteVideo(item.result.video.id, item.result.deleteToken);
      forgetDeleteToken(item.result.video.id);
      update(item.key, { status: 'deleted' });
    } catch (err) {
      update(item.key, { error: err.message });
    }
  }

  const waitingCount = items.filter((it) => it.status === 'waiting').length;
  const doneCount = items.filter((it) => it.status === 'done').length;
  const uploadingCount = items.filter((it) => it.status === 'uploading').length;

  return (
    <section className="upload-container">
      {/* Page Header */}
      <div className="page-hero">
        <h1 className="hero-title">Upload</h1>
      </div>

      {/* Modern CollectUI-inspired Dropzone Card */}
      <div className="upload-card">
        <div
          className={`dropzone ${isDragOver ? 'dropzone-active' : ''} ${running ? 'dropzone-disabled' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => !running && fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !running) {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          aria-label="Upload files drop zone"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={['video/*', ...ALLOWED_EXTENSIONS].join(',')}
            onChange={onFilesChange}
            disabled={running}
            className="file-input-hidden"
          />

          <div className="dropzone-icon-wrap">
            <svg className="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div className="icon-pulse-glow" />
          </div>

          <div className="dropzone-text">
            <p className="dropzone-main-text">
              <span className="text-highlight">Choose videos</span> or drag and drop
            </p>
            <p className="dropzone-sub-text">
              MP4, MKV, AVI, MOV, WebM, WMV, TS
            </p>
          </div>
        </div>

        {/* Optional Title input if exactly 1 video is queued */}
        {waitingCount === 1 && !running && (
          <div className="field-group">
            <label className="field-label" htmlFor="video-custom-title">
              Title <span className="field-hint">(optional)</span>
            </label>
            <div className="input-wrapper">
              <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              <input
                id="video-custom-title"
                type="text"
                maxLength={100}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Video title"
                className="custom-title-input"
              />
            </div>
          </div>
        )}

        {/* Upload List / Queued items */}
        {items.length > 0 && (
          <div className="queue-section">
            <div className="queue-header">
              <h2 className="queue-title">Queue ({items.length})</h2>
              {waitingCount > 0 && !running && (
                <button
                  type="button"
                  className="link-btn-clear"
                  onClick={() => setItems((list) => list.filter((it) => it.status !== 'waiting' && it.status !== 'error'))}
                >
                  Clear
                </button>
              )}
            </div>

            <ul className="upload-cards-list">
              {items.map((it) => (
                <li key={it.key} className={`upload-card-item upload-item-${it.status}`}>
                  <div className="file-card-main">
                    <div className="file-icon-box">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                      </svg>
                    </div>

                    <div className="file-info">
                      <div className="file-name-row">
                        <span className="file-name" title={it.file.name}>{it.file.name}</span>
                        <span className="file-size">{formatBytes(it.file.size)}</span>
                      </div>

                      {/* Status / Progress indicators */}
                      {it.status === 'uploading' && (
                        <div className="upload-progress-wrap">
                          <ProgressBar percent={it.progress} />
                          <div className="progress-info-row">
                            <span className="status-badge status-uploading">
                              <span className="pulse-dot" /> Uploading ({Math.round(it.progress)}%)
                            </span>
                          </div>
                        </div>
                      )}

                      {it.status === 'waiting' && (
                        <div className="status-row">
                          <span className="status-badge status-waiting">Ready</span>
                        </div>
                      )}

                      {it.status === 'error' && (
                        <div className="status-row">
                          <span className="status-badge status-error">✕ {it.error}</span>
                        </div>
                      )}

                      {it.status === 'deleted' && (
                        <div className="status-row">
                          <span className="status-badge status-deleted">Deleted</span>
                        </div>
                      )}

                      {it.status === 'done' && (
                        <div className="status-row done-row">
                          <span className={`status-badge ${it.result?.video?.status === 'processing' ? 'status-processing' : 'status-ready'}`}>
                            {it.result?.video?.status === 'processing' ? (
                              <>
                                <span className="pulse-dot" /> Converting…
                              </>
                            ) : (
                              '✓ Ready'
                            )}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Action buttons on file item */}
                    <div className="file-actions">
                      {it.status === 'waiting' && !running && (
                        <button
                          type="button"
                          className="item-remove-btn"
                          onClick={() => removeItem(it.key)}
                          title="Remove"
                          aria-label="Remove video"
                        >
                          ✕
                        </button>
                      )}

                      {it.status === 'done' && (
                        <div className="item-done-actions">
                          <Link to={`/watch/${it.result.video.id}`} className="button-mini-watch" data-tile>
                            Play
                          </Link>
                          <button
                            type="button"
                            className="item-delete-btn"
                            onClick={() => onDelete(it)}
                            title="Delete"
                            data-tile
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Action Controls */}
        {(waitingCount > 0 || doneCount > 0 || running) && (
          <div className="upload-actions-bar">
            {waitingCount > 0 && (
              <button
                type="button"
                className="btn-primary-upload"
                onClick={uploadAll}
                disabled={running}
              >
                {running ? (
                  <>
                    <span className="spinner-dot" /> Uploading…
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="btn-icon">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    {waitingCount > 1 ? `Upload ${waitingCount} Videos` : 'Upload Video'}
                  </>
                )}
              </button>
            )}

            {running && (
              <button type="button" className="btn-secondary-cancel" onClick={cancel}>
                Cancel
              </button>
            )}

            {doneCount > 0 && !running && (
              <Link className={waitingCount === 0 ? 'btn-primary-upload' : 'btn-secondary-library'} to="/">
                Go to Library →
              </Link>
            )}
          </div>
        )}

        {running && (
          <p className="muted small" style={{ marginTop: '16px', textAlign: 'center' }}>
            Keep this tab open while uploading.
          </p>
        )}
      </div>
    </section>
  );
}


