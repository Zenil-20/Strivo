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
  const currentUpload = useRef(null);
  const cancelled = useRef(false);

  const update = (key, patch) => setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  function onFilesChange(e) {
    const files = [...(e.target.files ?? [])];
    e.target.value = ''; // allow picking the same files again
    setItems((list) => [
      ...list.filter((it) => it.status !== 'waiting' && it.status !== 'error'),
      ...files.map((file) => {
        const problem = validateFile(file);
        return { key: nextKey++, file, status: problem ? 'error' : 'waiting', progress: 0, error: problem, result: null };
      }),
    ]);
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

  return (
    <section className="card">
      <h1>Upload movies or episodes</h1>
      <p className="muted">
        Any video format (MP4, MKV, AVI, MOV, WebM, WMV, TS…), no size limit. Files your TV can’t play are converted
        automatically after upload. You can select a whole season at once.
      </p>

      <label className="file-picker">
        <input
          type="file"
          multiple
          accept={['video/*', ...ALLOWED_EXTENSIONS].join(',')}
          onChange={onFilesChange}
          disabled={running}
        />
        <span>{items.length ? 'Add more videos' : 'Choose videos'}</span>
      </label>

      {waitingCount === 1 && !running && (
        <label className="field">
          Title <span className="muted">(optional)</span>
          <input
            type="text"
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Defaults to the filename"
          />
        </label>
      )}

      {items.length > 0 && (
        <ul className="upload-list">
          {items.map((it) => (
            <li key={it.key} className={`upload-item upload-${it.status}`}>
              <div className="upload-row">
                <span className="upload-name">{it.file.name}</span>
                <span className="muted small">{formatBytes(it.file.size)}</span>
              </div>
              {it.status === 'uploading' && <ProgressBar percent={it.progress} />}
              {it.status === 'waiting' && <span className="muted small">Waiting</span>}
              {it.status === 'error' && <span className="error small">{it.error}</span>}
              {it.status === 'deleted' && <span className="muted small">Deleted</span>}
              {it.status === 'done' && (
                <div className="upload-row">
                  <span className="small">
                    {it.result.video.status === 'processing' ? '✓ Uploaded, converting for TV…' : '✓ Ready to watch'}
                  </span>
                  <span className="upload-actions">
                    <Link to={`/watch/${it.result.video.id}`}>Watch</Link>
                    <button type="button" className="link-button danger-link" onClick={() => onDelete(it)}>
                      Delete
                    </button>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button type="button" onClick={uploadAll} disabled={!waitingCount || running}>
          {running ? 'Uploading…' : `Upload ${waitingCount > 1 ? `${waitingCount} videos` : ''}`.trim()}
        </button>
        {running && (
          <button type="button" className="secondary" onClick={cancel}>Cancel</button>
        )}
        {doneCount > 0 && !running && <Link className="button secondary" to="/">Open library</Link>}
      </div>

      {running && (
        <p className="muted small">Keep this page open (and your phone’s screen on) until uploads finish.</p>
      )}
    </section>
  );
}
