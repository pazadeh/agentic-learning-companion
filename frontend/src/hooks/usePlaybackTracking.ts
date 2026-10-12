import { useCallback, useEffect, useRef } from 'react';
import { recordPlayback } from '../services/api-client';
import type { PlaybackUpdate } from '../types';

interface PendingPlayback {
  lectureId: string;
  update: PlaybackUpdate;
}

const RETRY_DELAYS = [0, 500, 1500] as const;
const storageKey = (lectureId: string) => `alc.playback.pending.${lectureId}`;

function persistPending(item: PendingPlayback): void {
  try {
    localStorage.setItem(storageKey(item.lectureId), JSON.stringify(item.update));
  } catch {
    // Telemetry must never interrupt playback when storage is unavailable.
  }
}

function clearPendingIfSent(item: PendingPlayback): void {
  try {
    const raw = localStorage.getItem(storageKey(item.lectureId));
    if (!raw) return;
    const pending = JSON.parse(raw) as PlaybackUpdate;
    if (
      pending.playbackSessionId === item.update.playbackSessionId &&
      pending.sequence <= item.update.sequence
    ) {
      localStorage.removeItem(storageKey(item.lectureId));
    }
  } catch {
    // Ignore malformed or unavailable local storage.
  }
}

async function sendWithRetry(item: PendingPlayback): Promise<void> {
  let lastError: unknown;
  for (const delay of RETRY_DELAYS) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      await recordPlayback(item.lectureId, item.update);
      clearPendingIfSent(item);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  // Keep the newest cumulative event in localStorage. A future mount retries it.
  if (lastError) persistPending(item);
}

/** Serialize playback summaries, retry failures, and recover the latest unsent event. */
export function usePlaybackTracking(lectureId?: string | null) {
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback((item: PendingPlayback) => {
    persistPending(item);
    // Strict per-player ordering prevents concurrent sequence transactions from racing.
    chainRef.current = chainRef.current
      .catch(() => undefined)
      .then(() => sendWithRetry(item));
  }, []);

  useEffect(() => {
    if (!lectureId) return;
    try {
      const raw = localStorage.getItem(storageKey(lectureId));
      if (!raw) return;
      const update = JSON.parse(raw) as PlaybackUpdate;
      if (update?.playbackSessionId && Number.isInteger(update.sequence)) {
        enqueue({ lectureId, update });
      }
    } catch {
      localStorage.removeItem(storageKey(lectureId));
    }
  }, [enqueue, lectureId]);

  return useCallback(
    (update: PlaybackUpdate) => {
      if (!lectureId) return;
      enqueue({ lectureId, update });
    },
    [enqueue, lectureId]
  );
}
