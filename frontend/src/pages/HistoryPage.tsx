import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { useAuth } from '../contexts/AuthContext';
import { ErrorBanner } from '../components/common/ErrorBanner';
import { ApiError, getLecture, listLectures, refreshAudioUrl } from '../services/api-client';
import {
  OfflineStorageError,
  formatOfflineBytes,
  getOfflineAudioUrl,
  getOfflineLecture,
  listOfflineLectures,
  removeOfflineLecture,
  saveOfflineLecture,
  type OfflineLectureRecord,
} from '../services/offline-lectures';
import { getItem, setItem } from '../utils/storage';
import { formatDate } from '../utils/format';
import type { Lecture } from '../types';

type Filter = 'all' | 'favorites' | 'completed' | 'offline';

export function HistoryPage() {
  const { state, dispatch } = useAppState();
  const { user } = useAuth();
  const ownerSub = user?.sub ?? '';
  const favoritesKey = `alc.favorites.${ownerSub}`;
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(
    () => new Set(getItem<string[]>(favoritesKey, []))
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!ownerSub) return;
    let cancelled = false;
    setFavorites(new Set(getItem<string[]>(favoritesKey, [])));
    setIsLoading(true);
    (async () => {
      let offline: OfflineLectureRecord[] = [];
      try {
        offline = await listOfflineLectures(ownerSub);
      } catch {
        if (!cancelled) setError('Offline storage is unavailable in this browser.');
      }
      if (cancelled) return;
      const offlineMap = new Map(offline.map((record) => [record.lectureId, record]));
      let remote: Lecture[] = [];
      if (state.isOnline) {
        try {
          remote = (await listLectures()).lectures;
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) throw err;
          setError('Cloud history is unavailable. Showing lectures saved on this device.');
        }
      }
      if (cancelled) return;
      const merged = new Map<string, Lecture>();
      for (const record of offline) {
        merged.set(record.lectureId, {
          ...record.lecture,
          script: record.script,
          offlineAvailable: true,
          offlineBytes: record.bytes,
        });
      }
      for (const lecture of remote) {
        const saved = offlineMap.get(lecture.lectureId);
        merged.set(lecture.lectureId, {
          ...lecture,
          offlineAvailable: Boolean(saved),
          offlineBytes: saved?.bytes,
        });
      }
      setLectures(
        [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      );
      setIsLoading(false);
    })().catch(() => {
      if (!cancelled) {
        setError('Could not load your lecture library.');
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [favoritesKey, ownerSub, state.isOnline]);

  const visible = useMemo(() => {
    if (filter === 'favorites') return lectures.filter((lecture) => favorites.has(lecture.lectureId));
    if (filter === 'completed') return lectures.filter((lecture) => (lecture.completionPercent ?? 0) >= 95);
    if (filter === 'offline') return lectures.filter((lecture) => lecture.offlineAvailable);
    return lectures;
  }, [favorites, filter, lectures]);

  const toggleFavorite = (id: string) => {
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavorites(next);
    setItem(favoritesKey, [...next]);
  };

  const open = async (lecture: Lecture) => {
    if (!ownerSub || savingId || loadingId) return;
    setError('');
    setLoadingId(lecture.lectureId);
    try {
      const offline = await getOfflineLecture(ownerSub, lecture.lectureId);
      if (offline) {
        dispatch({
          type: 'SET_LECTURE',
          lecture: { ...offline.lecture, script: offline.script, offlineAvailable: true },
        });
        dispatch({ type: 'SET_AUDIO_URL', url: getOfflineAudioUrl(offline) });
      } else {
        if (!state.isOnline) throw new OfflineStorageError('This lecture was not saved for offline use.');
        const detail = await getLecture(lecture.lectureId);
        const { url } = await refreshAudioUrl(detail.s3Key);
        dispatch({ type: 'SET_LECTURE', lecture: detail });
        dispatch({ type: 'SET_AUDIO_URL', url });
      }
      dispatch({ type: 'SET_PAGE', page: 'conversation' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that lecture.');
    } finally {
      setLoadingId(null);
    }
  };

  const saveOffline = async (lecture: Lecture) => {
    if (savingId) return;
    if (!ownerSub || !state.isOnline) {
      setError('Connect to the internet before saving a lecture for offline use.');
      return;
    }
    setError('');
    setSavingId(lecture.lectureId);
    try {
      const detail = await getLecture(lecture.lectureId);
      const { url } = await refreshAudioUrl(detail.s3Key);
      const response = await fetch(url);
      if (!response.ok) throw new Error('The lecture audio download failed.');
      const audio = await response.blob();
      const record = await saveOfflineLecture(ownerSub, detail, detail.script ?? null, audio);
      setLectures((previous) =>
        previous.map((item) =>
          item.lectureId === lecture.lectureId
            ? { ...item, transcriptAvailable: Boolean(record.script), offlineAvailable: true, offlineBytes: record.bytes }
            : item
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that lecture offline.');
    } finally {
      setSavingId(null);
    }
  };

  const removeOffline = async (lecture: Lecture) => {
    if (!ownerSub || savingId || loadingId) return;
    setError('');
    setLoadingId(lecture.lectureId);
    try {
      if (state.currentLecture?.lectureId === lecture.lectureId) {
        dispatch({ type: 'SET_AUDIO_URL', url: null });
        dispatch({ type: 'SET_LECTURE', lecture: null });
      }
      await removeOfflineLecture(ownerSub, lecture.lectureId);
      setLectures((previous) =>
        state.isOnline
          ? previous.map((item) =>
              item.lectureId === lecture.lectureId
                ? { ...item, offlineAvailable: false, offlineBytes: undefined }
                : item
            )
          : previous.filter((item) => item.lectureId !== lecture.lectureId)
      );
    } catch {
      setError('Could not remove the offline copy.');
    } finally {
      setLoadingId(null);
    }
  };

  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'offline', label: 'Offline' },
    { value: 'favorites', label: 'Favorites' },
    { value: 'completed', label: 'Completed' },
  ];

  return (
    <div className="history">
      <div className="history__filters" role="tablist" aria-label="Filter lectures">
        {filters.map(({ value, label }) => (
          <button
            key={value}
            role="tab"
            aria-selected={filter === value}
            className={`chip ${filter === value ? 'chip--active' : ''}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {isLoading ? (
        <p className="history__empty">Loading your lectures…</p>
      ) : visible.length === 0 ? (
        <p className="history__empty">
          {filter === 'offline'
            ? 'No lectures saved offline yet.'
            : 'No lectures yet. Head to Chat and ask to learn something.'}
        </p>
      ) : (
        <ul className="history__list">
          {visible.map((lecture) => (
            <li key={lecture.lectureId} className="lecture-card">
              <button
                className="lecture-card__main"
                onClick={() => void open(lecture)}
                disabled={loadingId !== null || savingId !== null}
              >
                <span className="lecture-card__title">{lecture.title || lecture.topic}</span>
                <span className="lecture-card__meta">
                  {lecture.durationMinutes} min · {formatDate(lecture.createdAt)}
                </span>
                {lecture.offlineAvailable && (
                  <span className="lecture-card__offline">
                    Available offline · {formatOfflineBytes(lecture.offlineBytes ?? 0)}
                    {!lecture.transcriptAvailable && ' · audio only'}
                  </span>
                )}
                <span className="lecture-card__progress" aria-hidden="true">
                  <span
                    className="lecture-card__progress-bar"
                    style={{ width: `${Math.min(100, lecture.completionPercent ?? 0)}%` }}
                  />
                </span>
              </button>
              <div className="lecture-card__actions">
                {lecture.offlineAvailable ? (
                  <button className="btn btn--small" disabled={savingId !== null || loadingId !== null} onClick={() => void removeOffline(lecture)}>
                    Remove download
                  </button>
                ) : (
                  <button
                    className="btn btn--small"
                    disabled={!state.isOnline || savingId !== null || loadingId !== null}
                    onClick={() => void saveOffline(lecture)}
                  >
                    {savingId === lecture.lectureId ? 'Saving…' : 'Save offline'}
                  </button>
                )}
                <button
                  className={`lecture-card__fav ${favorites.has(lecture.lectureId) ? 'is-fav' : ''}`}
                  onClick={() => toggleFavorite(lecture.lectureId)}
                  aria-label={favorites.has(lecture.lectureId) ? 'Remove favorite' : 'Add favorite'}
                  aria-pressed={favorites.has(lecture.lectureId)}
                >
                  {favorites.has(lecture.lectureId) ? '★' : '☆'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
