import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { useAuth } from '../contexts/AuthContext';
import { useDownloads } from '../contexts/DownloadsContext';
import { usePlayer } from '../contexts/PlayerContext';
import { ErrorBanner } from '../components/common/ErrorBanner';
import { Icon } from '../components/common/Icon';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { TopicArt } from '../components/common/TopicArt';
import { DownloadButton } from '../components/audio/DownloadButton';
import { ApiError, listLectures } from '../services/api-client';
import { formatOfflineBytes } from '../services/offline-lectures';
import { getItem, setItem, userKey } from '../utils/storage';
import { describeProgress, formatDate } from '../utils/format';
import type { Lecture } from '../types';

type Filter = 'all' | 'in_progress' | 'offline' | 'favorites' | 'completed';
type Sort = 'newest' | 'oldest' | 'title' | 'recent';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'offline', label: 'Downloaded' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'completed', label: 'Completed' },
];

const EMPTY_COPY: Record<Filter, string> = {
  all: 'No lectures yet. Create your first one and it will appear here.',
  in_progress: 'Nothing in progress. Lectures you start listening to appear here.',
  offline: 'No downloads yet. Use “Save offline” on any lecture to listen without a connection.',
  favorites: 'No favorites yet. Tap the star on a lecture to keep it close.',
  completed: 'No completed lectures yet. Lectures you finish appear here.',
};

const isInProgress = (lecture: Lecture) => {
  const percent = lecture.completionPercent ?? 0;
  return percent > 0 && percent < 95;
};

export function LibraryPage() {
  const { state, navigate } = useAppState();
  const { user } = useAuth();
  const ownerSub = user?.sub ?? '';
  const favoritesKey = userKey(ownerSub, 'favorites');
  const player = usePlayer();
  const { offline, ready: offlineReady, storageError } = useDownloads();
  const [remote, setRemote] = useState<Lecture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(getItem<string[]>(favoritesKey, [])));
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [query, setQuery] = useState('');
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    if (!state.isOnline) {
      setRemote([]);
      setLoading(false);
      return;
    }
    try {
      setRemote((await listLectures()).lectures);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your cloud library could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [state.isOnline]);

  useEffect(() => {
    void load();
  }, [load]);

  const lectures = useMemo(() => {
    const merged = new Map<string, Lecture>();
    offline.forEach((record) => {
      merged.set(record.lectureId, { ...record.lecture, script: record.script, offlineAvailable: true, offlineBytes: record.bytes });
    });
    remote.forEach((lecture) => {
      const saved = offline.get(lecture.lectureId);
      merged.set(lecture.lectureId, { ...lecture, offlineAvailable: Boolean(saved), offlineBytes: saved?.bytes });
    });
    return [...merged.values()];
  }, [offline, remote]);

  const continueListening = useMemo(
    () =>
      lectures
        .filter(isInProgress)
        .sort((a, b) => (b.lastListenedAt ?? b.createdAt).localeCompare(a.lastListenedAt ?? a.createdAt))[0],
    [lectures]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = lectures.filter((lecture) => {
      if (needle && !`${lecture.title} ${lecture.topic}`.toLowerCase().includes(needle)) return false;
      if (filter === 'in_progress') return isInProgress(lecture);
      if (filter === 'offline') return lecture.offlineAvailable;
      if (filter === 'favorites') return favorites.has(lecture.lectureId);
      if (filter === 'completed') return (lecture.completionPercent ?? 0) >= 95;
      return true;
    });
    return filtered.sort((a, b) => {
      if (sort === 'oldest') return a.createdAt.localeCompare(b.createdAt);
      if (sort === 'title') return (a.title || a.topic).localeCompare(b.title || b.topic);
      if (sort === 'recent') return (b.lastListenedAt ?? '').localeCompare(a.lastListenedAt ?? '');
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [favorites, filter, lectures, query, sort]);

  const toggleFavorite = (id: string) => {
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavorites(next);
    setItem(favoritesKey, [...next]);
  };

  const play = async (lecture: Lecture) => {
    setOpeningId(lecture.lectureId);
    try {
      await player.playLecture(lecture, { autoplay: true });
    } finally {
      setOpeningId(null);
    }
  };

  const actionLabel = (lecture: Lecture) => {
    if (player.lecture?.lectureId === lecture.lectureId) return 'Now playing';
    const percent = lecture.completionPercent ?? 0;
    if (percent >= 95) return 'Play again';
    return percent > 0 ? 'Resume' : 'Play';
  };

  const isLoading = loading || !offlineReady;

  return (
    <div className="page library">
      <div className="page__heading">
        <div>
          <h2>Library</h2>
          <p>
            {isLoading
              ? 'Loading your lectures…'
              : `${lectures.length} ${lectures.length === 1 ? 'lecture' : 'lectures'}${offline.size ? ` · ${offline.size} downloaded` : ''}`}
          </p>
        </div>
      </div>

      {!state.isOnline && (
        <p className="offline-note">You’re offline. Showing lectures downloaded to this device.</p>
      )}
      <ErrorBanner
        message={error}
        detail={offline.size ? 'Downloaded lectures are still listed below.' : undefined}
        actions={[{ label: 'Try again', onClick: () => void load() }]}
        onDismiss={() => setError('')}
      />
      <ErrorBanner message={storageError} detail="Cloud lectures still play; downloads are unavailable in this browser." />

      {continueListening && filter === 'all' && !query && (
        <section className="continue-card" aria-labelledby="continue-title">
          <TopicArt text={continueListening.topic || continueListening.title} size="lg" />
          <div className="continue-card__body">
            <span id="continue-title" className="eyebrow">Continue listening</span>
            <strong>{continueListening.title || continueListening.topic}</strong>
            <small>{describeProgress(continueListening.completionPercent, continueListening.durationMinutes)}</small>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => void play(continueListening)}>
            <Icon name="play" size={18} /> Resume
          </button>
        </section>
      )}

      <div className="library__tools">
        <label className="search">
          <Icon name="search" size={18} />
          <span className="visually-hidden">Search lectures</span>
          <input type="search" placeholder="Search by title or topic" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="sort">
          <span>Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
            <option value="newest">Newest</option>
            <option value="recent">Recently played</option>
            <option value="oldest">Oldest</option>
            <option value="title">Title A–Z</option>
          </select>
        </label>
      </div>

      <div className="chips" role="group" aria-label="Filter lectures">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            className={`chip ${filter === value ? 'chip--active' : ''}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {filter === 'favorites' && <p className="muted small-note">Favorites are saved on this device only.</p>}

      {isLoading ? (
        <LoadingSpinner label="Loading your lectures…" />
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <p>{query ? `No lectures match “${query}”.` : EMPTY_COPY[filter]}</p>
          {query ? (
            <button type="button" className="btn btn--ghost" onClick={() => setQuery('')}>
              Clear search
            </button>
          ) : (
            filter === 'all' && (
              <button type="button" className="btn btn--primary" onClick={() => navigate({ page: 'create' })}>
                Create a lecture
              </button>
            )
          )}
        </div>
      ) : (
        <ul className="lecture-list">
          {visible.map((lecture) => {
            const title = lecture.title || lecture.topic;
            const percent = Math.min(100, Math.round(lecture.completionPercent ?? 0));
            const isCurrent = player.lecture?.lectureId === lecture.lectureId;
            return (
              <li key={lecture.lectureId} className={`lecture-card ${isCurrent ? 'is-current' : ''}`}>
                <TopicArt text={lecture.topic || title} />
                <div className="lecture-card__body">
                  <strong className="lecture-card__title">{title}</strong>
                  <span className="lecture-card__meta">
                    {lecture.durationMinutes} min · {formatDate(lecture.createdAt)}
                    {lecture.offlineAvailable && ` · Downloaded (${formatOfflineBytes(lecture.offlineBytes ?? 0)})`}
                    {lecture.offlineAvailable && lecture.transcriptAvailable === false && ' · audio only'}
                  </span>
                  <span className="lecture-card__progress-text">{describeProgress(lecture.completionPercent, lecture.durationMinutes)}</span>
                  <span
                    className="progress-line"
                    role="progressbar"
                    aria-label={`${title} listening progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </span>
                </div>
                <div className="lecture-card__actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--small"
                    onClick={() => (isCurrent ? player.setExpanded(true) : void play(lecture))}
                    disabled={openingId === lecture.lectureId || (!state.isOnline && !lecture.offlineAvailable)}
                    aria-label={`${actionLabel(lecture)}: ${title}`}
                  >
                    <Icon name={isCurrent ? 'expand' : 'play'} size={16} />
                    {openingId === lecture.lectureId ? 'Opening…' : actionLabel(lecture)}
                  </button>
                  <DownloadButton lecture={lecture} compact />
                  <button
                    type="button"
                    className={`icon-btn favorite ${favorites.has(lecture.lectureId) ? 'is-fav' : ''}`}
                    onClick={() => toggleFavorite(lecture.lectureId)}
                    aria-label={favorites.has(lecture.lectureId) ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
                    aria-pressed={favorites.has(lecture.lectureId)}
                  >
                    <Icon name={favorites.has(lecture.lectureId) ? 'starFilled' : 'star'} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
