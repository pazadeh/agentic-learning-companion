interface LoadingSpinnerProps {
  label?: string;
}

export function LoadingSpinner({ label = 'Loading' }: LoadingSpinnerProps) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <span className="spinner__label">{label}</span>
    </div>
  );
}
