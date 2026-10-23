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
  theme: 'alc.theme',
} as const;

/** Per-user keys keep shared-browser state isolated between Cognito accounts. */
export type UserScopedKey =
  | 'create'
  | 'createLease'
  | 'favorites'
  | 'nowPlaying'
  | 'onboarded'
  | 'positions'
  | 'profileCache'
  | 'speed';

export function userKey(sub: string, name: UserScopedKey): string {
  return `alc.${name}.${sub || 'anonymous'}`;
}

/** Remove every locally cached value that belongs to one user. */
export function removeUserItems(sub: string): void {
  if (!sub) return;
  try {
    const doomed: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith('alc.') && key.endsWith(`.${sub}`)) doomed.push(key);
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Ignore unavailable storage.
  }
}
