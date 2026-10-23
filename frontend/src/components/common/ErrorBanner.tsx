import { Icon } from './Icon';

export interface ErrorAction {
  label: string;
  onClick: () => void;
}

interface ErrorBannerProps {
  message: string;
  /** What is safe or retained, e.g. "Your brief is still here." */
  detail?: string;
  actions?: ErrorAction[];
  onDismiss?: () => void;
}

/** Errors explain what happened, what was preserved, and what to do next. */
export function ErrorBanner({ message, detail, actions = [], onDismiss }: ErrorBannerProps) {
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <Icon name="alert" className="error-banner__icon" />
      <div className="error-banner__body">
        <strong>{message}</strong>
        {detail && <span>{detail}</span>}
        {actions.length > 0 && (
          <div className="error-banner__actions">
            {actions.map((action) => (
              <button key={action.label} type="button" className="btn btn--small btn--danger-ghost" onClick={action.onClick}>
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {onDismiss && (
        <button type="button" className="error-banner__dismiss" aria-label="Dismiss error" onClick={onDismiss}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
