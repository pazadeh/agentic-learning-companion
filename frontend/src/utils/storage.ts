/** Tiny typed wrapper around localStorage with JSON (de)serialization.
 * All operations are safe: failures (quota, disabled storage, bad JSON) return
 * fallbacks instead of throwing.
 */
export function getItem<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setItem<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota / unavailable storage errors.
  }
}

export function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}

export const STORAGE_KEYS = {
  lectures: 'alc.lectures',
  profile: 'alc.profile',
  drivingMode: 'alc.drivingMode',
} as const;
