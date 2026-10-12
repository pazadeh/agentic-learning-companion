import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { ErrorBanner } from '../components/common/ErrorBanner';
import { ApiError, listLectures, refreshAudioUrl } from '../services/api-client';
import { getItem, setItem, STORAGE_KEYS } from '../utils/storage';
import { formatDate } from '../utils/format';
import type { Lecture } from '../types';

type Filter = 'all' | 'favorites' | 'completed';

export function HistoryPage() {
  const { dispatch } = useAppState();
  const [lectures, setLectures] = useState<Lecture[]>(() =>
    getItem<Lecture[]>(STORAGE_KEYS.lectures, [])
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Load the user's lectures from the backend so history follows them across
  // devices. Local per-device flags (favorite, completion) are merged on top, and
  // the local cache is used as an offline fallback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { lectures: remote } = await listLectures();
        if (cancelled) return;
        const local = getItem<Lecture[]>(STORAGE_KEYS.lectures, []);
        const flagsById = new Map(local.map((l) => [l.lectureId, l]));
        const merged: Lecture[] = remote.map((r) => {
          const prior = flagsById.get(r.lectureId);
          return {
            ...r,
            isFavorite: prior?.isFavorite ?? false,
            completionPercent: r.completionPercent ?? prior?.completionPercent ?? 0,
          };
        });
        setLectures(merged);
        setItem(STORAGE_KEYS.lectures, merged);
      } catch (err) {
        if (cancelled) return;
        // Offline or transient error: keep whatever is cached locally.
        if (err instanceof ApiError && err.status !== 401) {
          setError('Showing offline history. Pull to refresh when back online.');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    if (filter === 'favorites') return lectures.filter((l) => l.isFavorite);
    if (filter === 'completed') return lectures.filter((l) => (l.completionPercent ?? 0) >= 95);
    return lectures;
  }, [lectures, filter]);

  const persist = (next: Lecture[]) => {
    setLectures(next);
    setItem(STORAGE_KEYS.lectures, next);
  };

  const toggleFavorite = (id: string) => {
    persist(lectures.map((l) => (l.lectureId === id ? { ...l, isFavorite: !l.isFavorite } : l)));
  };

  const open = async (lecture: Lecture) => {
    setError('');
    setLoadingId(lecture.lectureId);
    try {
      const { url } = await refreshAudioUrl(lecture.s3Key);
      dispatch({ type: 'SET_LECTURE', lecture });
      dispatch({ type: 'SET_AUDIO_URL', url });
      dispatch({ type: 'SET_PAGE', page: 'conversation' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load that lecture.');
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="history">
      <div className="history__filters" role="tablist" aria-label="Filter lectures">
        {(['all', 'favorites', 'completed'] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            className={`chip ${filter === f ? 'chip--active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'favorites' ? 'Favorites' : 'Completed'}
          </button>
        ))}
      </div>

      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {isLoading ? (
        <p className="history__empty">Loading your lectures…</p>
      ) : visible.length === 0 ? (
        <p className="history__empty">No lectures yet. Head to Chat and ask to learn something.</p>
      ) : (
        <ul className="history__list">
          {visible.map((lecture) => (
            <li key={lecture.lectureId} className="lecture-card">
              <button
                className="lecture-card__main"
                onClick={() => void open(lecture)}
                disabled={loadingId === lecture.lectureId}
              >
                <span className="lecture-card__title">{lecture.title || lecture.topic}</span>
                <span className="lecture-card__meta">
                  {lecture.durationMinutes} min · {formatDate(lecture.createdAt)}
                </span>
                <span className="lecture-card__progress" aria-hidden="true">
                  <span
                    className="lecture-card__progress-bar"
                    style={{ width: `${Math.min(100, lecture.completionPercent ?? 0)}%` }}
                  />
                </span>
              </button>
              <button
                className={`lecture-card__fav ${lecture.isFavorite ? 'is-fav' : ''}`}
                onClick={() => toggleFavorite(lecture.lectureId)}
                aria-label={lecture.isFavorite ? 'Remove favorite' : 'Add favorite'}
                aria-pressed={lecture.isFavorite}
              >
                {lecture.isFavorite ? '★' : '☆'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
