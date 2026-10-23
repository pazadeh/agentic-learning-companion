import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface FocusTrapOptions {
  active: boolean;
  onEscape?: () => void;
  /** Element to focus on open; defaults to the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * Keep keyboard focus inside a modal surface, close on Escape, and restore focus to
 * the element that opened it.
 */
export function useFocusTrap(container: RefObject<HTMLElement | null>, options: FocusTrapOptions) {
  const { active, onEscape, initialFocus } = options;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(container.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (element) => !element.closest('[inert]')
      );
    (initialFocus?.current ?? focusables()[0] ?? container.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && escapeRef.current) {
        event.preventDefault();
        escapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const inside = container.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [active, container, initialFocus]);
}
