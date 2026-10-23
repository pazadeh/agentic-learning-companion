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
import { useAuth } from './AuthContext';
import { usePlayer } from './PlayerContext';
import { useToast } from './ToastContext';
import { getLecture, refreshAudioUrl } from '../services/api-client';
import {
  OfflineStorageError,
  downloadAudio,
  listOfflineLectures,
  removeOfflineLecture,
  saveOfflineLecture,
  type OfflineLectureRecord,
} from '../services/offline-lectures';
import type { Lecture } from '../types';

export const REMOVAL_UNDO_MS = 8000;

export interface ActiveDownload {
  receivedBytes: number;
  totalBytes: number | null;
}

interface DownloadsContextValue {
  /** Offline records for this user, keyed by lecture id. */
  offline: Map<string, OfflineLectureRecord>;
  active: Map<string, ActiveDownload>;
  /** Lectures whose offline copy will be deleted unless the user undoes it. */
  pendingRemoval: Set<string>;
  ready: boolean;
  storageError: string;
  saveOffline: (lecture: Lecture) => Promise<void>;
  cancelDownload: (lectureId: string) => void;
  removeOffline: (lecture: Lecture) => void;
  undoRemoval: (lectureId: string) => void;
  refresh: () => Promise<void>;
}

const DownloadsContext = createContext<DownloadsContextValue | undefined>(undefined);

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const ownerSub = user?.sub ?? '';
  const player = usePlayer();
  const { showToast, dismissToast } = useToast();
  const [records, setRecords] = useState<Map<string, OfflineLectureRecord>>(new Map());
  const [pendingRemoval, setPendingRemoval] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<Map<string, ActiveDownload>>(new Map());
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const controllers = useRef(new Map<string, AbortController>());
  // Deferred deletions are owned here (not by the toast), so they always commit or undo.
  const removals = useRef(new Map<string, { timer: number; toastId: number; commit: () => Promise<void> }>());
  const playerRef = useRef(player);
  playerRef.current = player;

  const refresh = useCallback(async () => {
    if (!ownerSub) return;
    try {
      const list = await listOfflineLectures(ownerSub);
      setRecords(new Map(list.map((record) => [record.lectureId, record])));
      setStorageError('');
    } catch {
      setStorageError('Offline storage is unavailable in this browser.');
    } finally {
      setReady(true);
    }
  }, [ownerSub]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearPending = (lectureId: string) =>
    setPendingRemoval((previous) => {
      if (!previous.has(lectureId)) return previous;
      const next = new Set(previous);
      next.delete(lectureId);
      return next;
    });

  const undoRemoval = useCallback(
    (lectureId: string) => {
      const pending = removals.current.get(lectureId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      dismissToast(pending.toastId);
      removals.current.delete(lectureId);
      clearPending(lectureId);
    },
    [dismissToast]
  );

  useEffect(
    () => () => {
      controllers.current.forEach((controller) => controller.abort());
      // Leaving (sign-out) commits removals the user did not undo.
      removals.current.forEach((pending) => {
        window.clearTimeout(pending.timer);
        void pending.commit();
      });
      removals.current.clear();
    },
    []
  );

  const setProgress = (lectureId: string, progress: ActiveDownload | null) => {
    setActive((previous) => {
      const next = new Map(previous);
      if (progress) next.set(lectureId, progress);
      else next.delete(lectureId);
      return next;
    });
  };

  const saveOffline = useCallback(
    async (lecture: Lecture) => {
      if (!ownerSub || controllers.current.has(lecture.lectureId)) return;
      // The copy is still on the device: saving again simply keeps it.
      if (removals.current.has(lecture.lectureId)) {
        undoRemoval(lecture.lectureId);
        showToast({ message: 'Kept the offline copy.', tone: 'success' });
        return;
      }
      if (!navigator.onLine) {
        showToast({ message: 'Connect to the internet to save this lecture offline.', tone: 'error' });
        return;
      }
      const controller = new AbortController();
      controllers.current.set(lecture.lectureId, controller);
      setProgress(lecture.lectureId, { receivedBytes: 0, totalBytes: null });
      try {
        const detail = await getLecture(lecture.lectureId);
        const { url } = await refreshAudioUrl(detail.s3Key);
        const audio = await downloadAudio(url, {
          signal: controller.signal,
          onProgress: (progress) => setProgress(lecture.lectureId, progress),
        });
        const record = await saveOfflineLecture(ownerSub, detail, detail.script ?? null, audio);
        setRecords((previous) => new Map(previous).set(record.lectureId, record));
        showToast({ message: `“${detail.title || detail.topic}” is available offline.`, tone: 'success' });
      } catch (error) {
        if ((error as DOMException)?.name === 'AbortError') {
          showToast({ message: 'Download cancelled.' });
        } else {
          showToast({
            message:
              error instanceof OfflineStorageError
                ? error.message
                : 'Could not save that lecture offline. The cloud copy is unaffected.',
            tone: 'error',
            actionLabel: 'Retry',
            onAction: () => void saveOffline(lecture),
          });
        }
      } finally {
        controllers.current.delete(lecture.lectureId);
        setProgress(lecture.lectureId, null);
      }
    },
    [ownerSub, showToast, undoRemoval]
  );

  const cancelDownload = useCallback((lectureId: string) => {
    controllers.current.get(lectureId)?.abort();
  }, []);

  const removeOffline = useCallback(
    (lecture: Lecture) => {
      const lectureId = lecture.lectureId;
      if (!ownerSub || removals.current.has(lectureId)) return;
      setPendingRemoval((previous) => new Set(previous).add(lectureId));
      const commit = async () => {
        removals.current.delete(lectureId);
        const current = playerRef.current;
        const isActive = current.lecture?.lectureId === lectureId && current.isOfflineSource;
        try {
          await removeOfflineLecture(ownerSub, lectureId, { keepActiveUrl: isActive });
          setRecords((previous) => {
            const next = new Map(previous);
            next.delete(lectureId);
            return next;
          });
        } catch {
          showToast({ message: 'Could not remove the offline copy.', tone: 'error' });
        } finally {
          clearPending(lectureId);
        }
      };
      const toastId = showToast({
        message: `Removing the offline copy of “${lecture.title || lecture.topic}”.`,
        actionLabel: 'Undo',
        onAction: () => undoRemoval(lectureId),
        durationMs: REMOVAL_UNDO_MS,
      });
      const timer = window.setTimeout(() => void commit(), REMOVAL_UNDO_MS);
      removals.current.set(lectureId, { timer, toastId, commit });
    },
    [ownerSub, showToast, undoRemoval]
  );

  const value = useMemo(
    () => ({
      offline: records,
      active,
      pendingRemoval,
      ready,
      storageError,
      saveOffline,
      cancelDownload,
      removeOffline,
      undoRemoval,
      refresh,
    }),
    [active, cancelDownload, pendingRemoval, ready, records, refresh, removeOffline, saveOffline, storageError, undoRemoval]
  );
  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

export function useDownloads(): DownloadsContextValue {
  const ctx = useContext(DownloadsContext);
  if (!ctx) throw new Error('useDownloads must be used within a DownloadsProvider');
  return ctx;
}
