import { useCallback, useEffect, useRef } from 'react';
import { recordPlayback } from '../services/api-client';
import type { PlaybackUpdate } from '../types';

interface PendingPlayback {
  lectureId: string;
  update: PlaybackUpdate;
}

const RETRY_DELAYS = [0, 500, 1500] as const;
// User-scoped (suffix = Cognito sub) so "Clear data on this device" removes it and a
// different account on the same browser can never replay it.
const storageKey = (lectureId: string, ownerSub: string) => `alc.playback.pending.${lectureId}.${ownerSub}`;
const legacyKey = (lectureId: string) => `alc.playback.pending.${lectureId}`;

function persistPending(item: PendingPlayback, ownerSub: string): void {
  try {
    localStorage.setItem(storageKey(item.lectureId, ownerSub), JSON.stringify(item.update));
  } catch {
    // Telemetry must never interrupt playback when storage is unavailable.
  }
}

function clearPendingIfSent(item: PendingPlayback, ownerSub: string): void {
  try {
    const raw = localStorage.getItem(storageKey(item.lectureId, ownerSub));
    if (!raw) return;
    const pending = JSON.parse(raw) as PlaybackUpdate;
    if (
      pending.playbackSessionId === item.update.playbackSessionId &&
      pending.sequence <= item.update.sequence
    ) {
      localStorage.removeItem(storageKey(item.lectureId, ownerSub));
    }
  } catch {
    // Ignore malformed or unavailable local storage.
  }
}

async function sendWithRetry(item: PendingPlayback, ownerSub: string): Promise<void> {
  let lastError: unknown;
  for (const delay of RETRY_DELAYS) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      await recordPlayback(item.lectureId, item.update);
      clearPendingIfSent(item, ownerSub);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  // Keep the newest cumulative event in localStorage. A future mount retries it.
  if (lastError) persistPending(item, ownerSub);
}

/** Serialize playback summaries, retry failures, and recover the latest unsent event. */
export function usePlaybackTracking(lectureId: string | null | undefined, ownerSub: string) {
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback(
    (item: PendingPlayback) => {
      if (!ownerSub) return;
      persistPending(item, ownerSub);
      // Strict ordering prevents concurrent sequence transactions from racing.
      chainRef.current = chainRef.current
        .catch(() => undefined)
        .then(() => sendWithRetry(item, ownerSub));
    },
    [ownerSub]
  );

  useEffect(() => {
    if (!lectureId || !ownerSub) return;
    try {
      // Pre-scoping entries cannot be attributed to an account; drop them.
      localStorage.removeItem(legacyKey(lectureId));
      const raw = localStorage.getItem(storageKey(lectureId, ownerSub));
      if (!raw) return;
      const update = JSON.parse(raw) as PlaybackUpdate;
      if (update?.playbackSessionId && Number.isInteger(update.sequence)) {
        enqueue({ lectureId, update });
      }
    } catch {
      localStorage.removeItem(storageKey(lectureId, ownerSub));
    }
  }, [enqueue, lectureId, ownerSub]);

  return useCallback(
    (update: PlaybackUpdate) => {
      if (!lectureId) return;
      enqueue({ lectureId, update });
    },
    [enqueue, lectureId]
  );
}
