import { useCallback, useEffect, useMemo, useState } from 'react';
import { EpisodeStatusList } from '../components/series/EpisodeStatusList';
import { SeriesPlanEditor } from '../components/series/SeriesPlanEditor';
import { ErrorBanner, type ErrorAction } from '../components/common/ErrorBanner';
import { Icon } from '../components/common/Icon';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { TopicArt } from '../components/common/TopicArt';
import { useAppState } from '../contexts/AppStateContext';
import { useCreate } from '../contexts/CreateContext';
import { usePlayer } from '../contexts/PlayerContext';
import {
  ApiError,
  approveSeries,
  createSeriesDraft,
  getLecture,
  getSeries,
  listSeries,
  pollSeriesUntilSettled,
  retrySeriesEpisode,
  saveSeriesPlan,
} from '../services/api-client';
import { formatDate } from '../utils/format';
import type { Lecture, SeriesDetail, SeriesEpisode, SeriesPlan, SeriesStatus, SeriesSummary } from '../types';

const STATUS_LABELS: Record<SeriesStatus, string> = {
  draft: 'Draft',
  planning: 'Planning',
  ready_for_approval: 'Ready to review',
  generating: 'Generating',
  attention: 'Needs attention',
  completed: 'Completed',
  failed: 'Planning failed',
};

interface PageError {
  message: string;
  actions?: ErrorAction[];
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function SeriesPage() {
  const { state, dispatch, navigate } = useAppState();
  const create = useCreate();
  const player = usePlayer();
  const selectedSeriesId = state.selectedSeriesId;
  const [seriesList, setSeriesList] = useState<SeriesSummary[]>([]);
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [editablePlan, setEditablePlan] = useState<SeriesPlan | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isReplanning, setIsReplanning] = useState(false);
  const [retryingEpisodeId, setRetryingEpisodeId] = useState<string | null>(null);
  const [error, setError] = useState<PageError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const startPlanning = () => {
    create.setMode('series');
    navigate({ page: 'create' });
  };

  const refreshList = useCallback(async (signal?: AbortSignal) => {
    setIsLoadingList(true);
    try {
      const response = await listSeries(signal);
      setSeriesList(response.series);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError({
          message: messageOf(err, 'Your lecture series could not be loaded.'),
          actions: [{ label: 'Try again', onClick: () => void refreshList() }],
        });
      }
    } finally {
      if (!signal?.aborted) setIsLoadingList(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshList(controller.signal);
    return () => controller.abort();
  }, [refreshList]);

  useEffect(() => {
    if (!selectedSeriesId) {
      setDetail(null);
      setEditablePlan(null);
      return;
    }
    const controller = new AbortController();
    setIsLoadingDetail(true);
    setError(null);
    void getSeries(selectedSeriesId, controller.signal)
      .then((next) => {
        setDetail(next);
        setEditablePlan(next.plan);
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError({
            message: messageOf(err, 'This lecture series could not be loaded.'),
            actions: [{ label: 'Try again', onClick: () => setReloadToken((value) => value + 1) }],
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingDetail(false);
      });
    return () => controller.abort();
  }, [reloadToken, selectedSeriesId]);

  useEffect(() => {
    if (!selectedSeriesId || !detail || !['planning', 'generating'].includes(detail.status)) return;
    const controller = new AbortController();
    const planning = detail.status === 'planning';
    setIsPolling(true);
    void pollSeriesUntilSettled(selectedSeriesId, {
      signal: controller.signal,
      pollWhile: planning ? ['planning'] : ['generating'],
      maxAttempts: planning ? 900 : undefined,
      onUpdate: (next) => {
        setDetail(next);
        if (next.plan) setEditablePlan((current) => current ?? next.plan);
      },
    })
      .then((next) => {
        setDetail(next);
        setEditablePlan(next.plan);
        void refreshList();
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError({
            message: messageOf(err, 'Live updates stopped.'),
            actions: [{ label: 'Refresh', onClick: () => setReloadToken((value) => value + 1) }],
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsPolling(false);
      });
    return () => controller.abort();
    // Restart polling only when the status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.status, refreshList, selectedSeriesId]);

  const isDirty = useMemo(() => {
    if (!detail?.plan || !editablePlan) return false;
    return JSON.stringify(detail.plan) !== JSON.stringify(editablePlan);
  }, [detail?.plan, editablePlan]);

  useEffect(() => {
    dispatch({ type: 'SET_UNSAVED', value: isDirty });
    return () => dispatch({ type: 'SET_UNSAVED', value: false });
  }, [dispatch, isDirty]);

  const conflictError = (): PageError => ({
    message: 'This plan changed somewhere else. Reload to see the latest version before saving again.',
    actions: [{ label: 'Reload plan', onClick: () => setReloadToken((value) => value + 1) }],
  });

  const showList = () => {
    // Guarded: an edited, unsaved plan asks before it is discarded.
    navigate({ page: 'series', seriesId: null });
    setError(null);
    void refreshList();
  };

  const savePlan = async (plan: SeriesPlan): Promise<SeriesDetail | null> => {
    if (!selectedSeriesId || !detail) return null;
    setIsSaving(true);
    setError(null);
    try {
      const next = await saveSeriesPlan(selectedSeriesId, plan, detail.revision);
      setDetail(next);
      setEditablePlan(next.plan);
      void refreshList();
      return next;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? conflictError() : { message: messageOf(err, 'The plan could not be saved. Your edits are still here.') });
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const generate = async (plan: SeriesPlan) => {
    if (!selectedSeriesId || !detail) return;
    const saved = isDirty ? await savePlan(plan) : detail;
    if (!saved) return;
    setIsApproving(true);
    setError(null);
    try {
      const next = await approveSeries(selectedSeriesId, saved.revision);
      setDetail(next);
      setEditablePlan(next.plan);
      void refreshList();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? conflictError() : { message: messageOf(err, 'Generation could not start. Your plan is saved.') });
    } finally {
      setIsApproving(false);
    }
  };

  const replan = async () => {
    if (!detail) return;
    setIsReplanning(true);
    setError(null);
    try {
      const draft = await createSeriesDraft(detail.prompt || detail.topic);
      navigate({ page: 'series', seriesId: draft.seriesId });
      void refreshList();
    } catch (err) {
      setError({ message: messageOf(err, 'Planning could not restart.'), actions: [{ label: 'Try again', onClick: () => void replan() }] });
    } finally {
      setIsReplanning(false);
    }
  };

  const retryEpisode = async (episode: SeriesEpisode) => {
    if (!selectedSeriesId) return;
    setRetryingEpisodeId(episode.episodeId);
    setError(null);
    try {
      const next = await retrySeriesEpisode(selectedSeriesId, episode.episodeId);
      setDetail(next);
      setEditablePlan(next.plan);
      void refreshList();
    } catch (err) {
      setError({ message: messageOf(err, `“${episode.title}” could not be retried.`) });
    } finally {
      setRetryingEpisodeId(null);
    }
  };

  const playEpisode = async (episode: SeriesEpisode) => {
    if (!episode.s3Key || !detail) return;
    if (player.lecture?.lectureId === (episode.lectureId ?? `episode:${episode.episodeId}`)) {
      player.setExpanded(true);
      return;
    }
    let lecture: Lecture = {
      // Without a lecture record the audio still plays, but it is never reported or
      // looked up under an id the lectures API doesn't own.
      lectureId: episode.lectureId ?? `episode:${episode.episodeId}`,
      untracked: !episode.lectureId,
      title: episode.title,
      topic: detail.title || detail.topic,
      s3Key: episode.s3Key,
      durationMinutes: episode.durationMinutes,
      createdAt: detail.updatedAt,
      seriesId: detail.seriesId,
      episodeId: episode.episodeId,
      episodeOrder: episode.order,
    };
    if (episode.lectureId) {
      try {
        const full = await getLecture(episode.lectureId);
        lecture = { ...lecture, ...full, topic: lecture.topic };
      } catch {
        // Playback still works; the transcript loads if available.
      }
    }
    await player.playLecture(lecture, { autoplay: true });
  };

  if (!selectedSeriesId) {
    return (
      <div className="page series">
        <div className="page__heading">
          <div>
            <h2>My series</h2>
            <p>Multi-part learning you review before it’s generated, then listen to episode by episode.</p>
          </div>
          <button type="button" className="btn btn--primary btn--small" onClick={startPlanning}>
            <Icon name="plus" size={16} /> Plan a series
          </button>
        </div>
        {error && <ErrorBanner message={error.message} actions={error.actions} onDismiss={() => setError(null)} />}
        {isLoadingList ? (
          <LoadingSpinner label="Loading your series…" />
        ) : seriesList.length === 0 ? (
          <div className="empty-state">
            <Icon name="layers" size={36} className="empty-state__icon" />
            <p>No series yet. Describe a subject and we’ll draft a 2–8 episode plan for you to edit and approve.</p>
            <button type="button" className="btn btn--primary" onClick={startPlanning}>
              Plan your first series
            </button>
          </div>
        ) : (
          <ul className="series-list">
            {seriesList.map((item) => {
              const percent = item.episodeCount > 0 ? (item.completedEpisodeCount / item.episodeCount) * 100 : 0;
              return (
                <li key={item.seriesId}>
                  <button
                    type="button"
                    className="series-card"
                    onClick={() => navigate({ page: 'series', seriesId: item.seriesId })}
                  >
                    <TopicArt text={item.title || item.topic} />
                    <span className="series-card__body">
                      <span className="series-card__heading">
                        <strong>{item.title || item.topic}</strong>
                        <span className={`status-pill status-pill--${item.status}`}>{STATUS_LABELS[item.status]}</span>
                      </span>
                      <span className="series-card__meta">
                        {item.completedEpisodeCount} of {item.episodeCount} episodes ready · Updated {formatDate(item.updatedAt)}
                      </span>
                      <span className="progress-line" aria-hidden="true">
                        <span style={{ width: `${percent}%` }} />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  if (isLoadingDetail || !detail) {
    return (
      <div className="page series">
        <button type="button" className="link back-link" onClick={showList}>← All series</button>
        {error && <ErrorBanner message={error.message} actions={error.actions} onDismiss={() => setError(null)} />}
        {isLoadingDetail && <LoadingSpinner label="Loading series…" />}
      </div>
    );
  }

  const showsPlan = editablePlan && ['draft', 'ready_for_approval'].includes(detail.status);
  const showsEpisodes = ['generating', 'attention', 'completed'].includes(detail.status);
  const playingEpisodeId = player.lecture?.seriesId === detail.seriesId ? player.lecture.episodeId ?? null : null;

  return (
    <div className="page series">
      <button type="button" className="link back-link" onClick={showList}>← All series</button>
      <div className="page__heading">
        <div>
          <h2>{detail.title || detail.topic}</h2>
          <p>{detail.description || detail.topic}</p>
        </div>
        <span className={`status-pill status-pill--${detail.status}`}>{STATUS_LABELS[detail.status]}</span>
      </div>

      {error && <ErrorBanner message={error.message} actions={error.actions} onDismiss={() => setError(null)} />}

      {detail.status === 'planning' && (
        <div className="stage-card" aria-live="polite">
          <LoadingSpinner label="Planning 2–8 focused episodes…" />
          <p>You can leave this page. Planning continues and the draft will be waiting here.</p>
        </div>
      )}

      {showsPlan && editablePlan && (
        <SeriesPlanEditor
          plan={editablePlan}
          isDirty={isDirty}
          isSaving={isSaving}
          isApproving={isApproving}
          onChange={setEditablePlan}
          onSave={(plan) => void savePlan(plan)}
          onGenerate={(plan) => void generate(plan)}
        />
      )}

      {detail.status === 'draft' && !editablePlan && (
        <div className="stage-card">
          <p>This draft doesn’t have a plan yet.</p>
          <button type="button" className="btn btn--ghost" onClick={() => setReloadToken((value) => value + 1)}>
            <Icon name="refresh" size={16} /> Check again
          </button>
        </div>
      )}

      {detail.status === 'generating' && (
        <div className="stage-card stage-card--compact" aria-live="polite">
          <strong>Generating episodes one at a time</strong>
          <span>{isPolling ? 'Updates appear automatically. Ready episodes can be played now.' : 'Checking status…'}</span>
        </div>
      )}

      {detail.status === 'attention' && (
        <div className="stage-card stage-card--attention">
          <strong>Some episodes need attention.</strong>
          <span>Ready episodes are playable. Retry only the ones that failed.</span>
        </div>
      )}

      {detail.status === 'failed' && (
        <div className="stage-card stage-card--attention">
          <strong>Planning this series didn’t finish.</strong>
          <span>No episodes were generated. You can plan it again with the same request.</span>
          <button type="button" className="btn btn--primary" onClick={() => void replan()} disabled={isReplanning}>
            <Icon name="refresh" size={16} /> {isReplanning ? 'Starting…' : 'Try planning again'}
          </button>
        </div>
      )}

      {detail.status === 'completed' && (
        <div className="stage-card stage-card--complete">
          <strong>Your series is complete.</strong>
          <span>Choose any episode to listen. Every episode is also in your Library.</span>
        </div>
      )}

      {showsEpisodes && (
        <EpisodeStatusList
          episodes={detail.episodes}
          activeEpisodeId={playingEpisodeId}
          retryingEpisodeId={retryingEpisodeId}
          onPlay={(episode) => void playEpisode(episode)}
          onRetry={(episode) => void retryEpisode(episode)}
        />
      )}
    </div>
  );
}
