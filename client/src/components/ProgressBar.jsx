export default function ProgressBar({ percent, showLabel = true }) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent || 0)));
  return (
    <div className="progress" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${clamped}%` }}>
        <div className="progress-shimmer" />
      </div>
      {showLabel && <span className="progress-label">{clamped}%</span>}
    </div>
  );
}

