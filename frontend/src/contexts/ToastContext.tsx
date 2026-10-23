import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from '../components/common/Icon';

export interface ToastOptions {
  message: string;
  tone?: 'info' | 'success' | 'error';
  actionLabel?: string;
  onAction?: () => void;
  /** Called when the toast closes without the action being used. */
  onExpire?: () => void;
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  showToast: (toast: ToastOptions) => number;
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());
  const toastsRef = useRef<ToastItem[]>([]);
  toastsRef.current = toasts;

  const close = useCallback((id: number, usedAction: boolean) => {
    const toast = toastsRef.current.find((item) => item.id === id);
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    toastsRef.current = toastsRef.current.filter((item) => item.id !== id);
    setToasts((previous) => previous.filter((item) => item.id !== id));
    if (toast && !usedAction) toast.onExpire?.();
  }, []);

  const showToast = useCallback(
    (toast: ToastOptions) => {
      const id = nextId.current;
      nextId.current += 1;
      // Toasts pushed out of the visible queue expire normally, so their callbacks still run.
      const evicted = toastsRef.current.slice(0, Math.max(0, toastsRef.current.length - 2));
      evicted.forEach((item) => {
        const timer = timers.current.get(item.id);
        if (timer) window.clearTimeout(timer);
        timers.current.delete(item.id);
        item.onExpire?.();
      });
      const next = [...toastsRef.current.slice(-2), { ...toast, id }];
      toastsRef.current = next;
      setToasts(next);
      const duration = toast.durationMs ?? (toast.actionLabel ? 8000 : 5000);
      timers.current.set(id, window.setTimeout(() => close(id, false), duration));
      return id;
    },
    [close]
  );

  // Commit any pending expiry actions (e.g. deferred deletions) on unmount.
  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      toastsRef.current.forEach((toast) => toast.onExpire?.());
    },
    []
  );

  const value = useMemo(
    () => ({ showToast, dismissToast: (id: number) => close(id, false) }),
    [close, showToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone ?? 'info'}`}>
            <span>{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  toast.onAction?.();
                  close(toast.id, true);
                }}
              >
                {toast.actionLabel}
              </button>
            )}
            <button type="button" className="toast__close" aria-label="Dismiss notification" onClick={() => close(toast.id, false)}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
