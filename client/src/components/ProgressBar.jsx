export default function ProgressBar({ percent }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${percent}%` }} />
      <span className="progress-label">{percent}%</span>
    </div>
  );
}
