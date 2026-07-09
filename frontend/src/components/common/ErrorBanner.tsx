interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          className="error-banner__dismiss"
          aria-label="Dismiss error"
          onClick={onDismiss}
        >
          ×
        </button>
      )}
    </div>
  );
}
