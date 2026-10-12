import { useCallback, useEffect, useMemo, useState } from 'react';
import { EpisodeStatusList } from '../components/series/EpisodeStatusList';
import { SeriesPlanEditor } from '../components/series/SeriesPlanEditor';
import { ErrorBanner } from '../components/common/ErrorBanner';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { AudioPlayer } from '../components/audio/AudioPlayer';
import { useAppState } from '../contexts/AppStateContext';
import {
  ApiError,
  approveSeries,
  getSeries,
  listSeries,
  pollSeriesUntilSettled,
  refreshAudioUrl,
  retrySeriesEpisode,
  saveSeriesPlan,
} from '../services/api-client';
import { formatDate } from '../utils/format';
import { usePlaybackTracking } from '../hooks/usePlaybackTracking';
import type {
  Lecture,
  SeriesDetail,
  SeriesEpisode,
  SeriesPlan,
  SeriesStatus,
  SeriesSummary,
} from '../types';

const STATUS_LABELS: Record<SeriesStatus, string> = {
  draft: 'Draft',
  planning: 'Planning',
  ready_for_approval: 'Ready to review',
  generating: 'Generating',
  attention: 'Needs attention',
  completed: 'Completed',
  failed: 'Failed',
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

export function SeriesPage() {
  const { state, dispatch } = useAppState();
  const selectedSeriesId = state.selectedSeriesId;
  const [seriesList, setSeriesList] = useState<SeriesSummary[]>([]);
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [editablePlan, setEditablePlan] = useState<SeriesPlan | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [retryingEpisodeId, setRetryingEpisodeId] = useState<string | null>(null);
  const [activeEpisodeId, setActiveEpisodeId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const trackPlayback = usePlaybackTracking(state.currentLecture?.lectureId);

  const refreshList = useCallback(async (signal?: AbortSignal) => {
    setIsLoadingList(true);
    try {
      const response = await listSeries(signal);
      setSeriesList(response.series);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(errorMessage(err, 'Could not load your lecture series.'));
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
    setActiveEpisodeId(null);
    if (!selectedSeriesId) {
      setDetail(null);
      setEditablePlan(null);
      return;
    }

    const controller = new AbortController();
    setIsLoadingDetail(true);
    setError('');
    void getSeries(selectedSeriesId, controller.signal)
      .then((next) => {
        setDetail(next);
        setEditablePlan(next.plan);
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(errorMessage(err, 'Could not load this lecture series.'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingDetail(false);
      });
    return () => controller.abort();
  }, [selectedSeriesId]);

  useEffect(() => {
    if (!selectedSeriesId || !detail || !['planning', 'generating'].includes(detail.status)) return;

    const controller = new AbortController();
    const planning = detail.status === 'planning';
    setIsPolling(true);
    void pollSeriesUntilSettled(selectedSeriesId, {
      signal: controller.signal,
      pollWhile: planning ? ['planning'] : ['generating'],
      maxAttempts: planning ? 900 : undefined, // planning is bounded to ~30 minutes
      onUpdate: (next) => {
        setDetail(next);
        if (next.plan) setEditablePlan(next.plan);
      },
    })
      .then((next) => {
        setDetail(next);
        setEditablePlan(next.plan);
        void refreshList();
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(errorMessage(err, 'Series updates stopped. Refresh to try again.'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsPolling(false);
      });

    return () => controller.abort();
    // Restart polling only when the status changes. Depending on `detail` itself
    // would abort and restart the poll on every update, hammering the API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.status, refreshList, selectedSeriesId]);

  const isDirty = useMemo(() => {
    if (!detail?.plan || !editablePlan) return false;
    return JSON.stringify(detail.plan) !== JSON.stringify(editablePlan);
  }, [detail?.plan, editablePlan]);

  const selectSeries = (seriesId: string) => {
    dispatch({ type: 'SET_SELECTED_SERIES', seriesId });
  };

  const showList = () => {
    dispatch({ type: 'SET_SELECTED_SERIES', seriesId: null });
    setError('');
    void refreshList();
  };

  const savePlan = async (plan: SeriesPlan, revision: number) => {
    if (!selectedSeriesId) return;
    setIsSaving(true);
    setError('');
    try {
      const next = await saveSeriesPlan(selectedSeriesId, plan, revision);
      setDetail(next);
      setEditablePlan(next.plan);
      void refreshList();
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? 'This plan has a newer revision. Reload the series before saving again.'
          : errorMessage(err, 'Could not save the plan.');
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const approve = async (revision: number) => {
    if (!selectedSeriesId || isDirty) return;
    setIsApproving(true);
    setError('');
    try {
      const next = await approveSeries(selectedSeriesId, revision);
      setDetail(next);
      setEditablePlan(next.plan);
      void refreshList();
    } catch (err) {
      setError(errorMessage(err, 'Could not approve this series.'));
    } finally {
      setIsApproving(false);
    }
  };

  const retryEpisode = async (episode: SeriesEpisode) => {
    if (!selectedSeriesId) return;
    setRetryingEpisodeId(episode.episodeId);
    setError('');
    try {
      const next = await retrySeriesEpisode(selectedSeriesId, episode.episodeId);
      setDetail(next);
      setEditablePlan(next.plan);
      void refreshList();
    } catch (err) {
      setError(errorMessage(err, `Could not retry “${episode.title}”.`));
    } finally {
      setRetryingEpisodeId(null);
    }
  };

  const playEpisode = async (episode: SeriesEpisode) => {
    if (!episode.s3Key || !detail) return;
    setError('');
    try {
      const { url } = await refreshAudioUrl(episode.s3Key);
      const lecture: Lecture = {
        lectureId: episode.lectureId ?? episode.episodeId,
        title: episode.title,
        topic: detail.topic,
        s3Key: episode.s3Key,
        durationMinutes: episode.durationMinutes,
        createdAt: detail.updatedAt,
      };
      dispatch({ type: 'SET_LECTURE', lecture });
      dispatch({ type: 'SET_AUDIO_URL', url });
      setActiveEpisodeId(episode.episodeId);
    } catch (err) {
      setError(errorMessage(err, `Could not play “${episode.title}”.`));
    }
  };

  if (!selectedSeriesId) {
    return (
      <div className="series">
        <div className="series__page-heading">
          <div>
            <h2>Lecture series</h2>
            <p>Review plans, follow generation, and listen episode by episode.</p>
          </div>
        </div>
        <ErrorBanner message={error} onDismiss={() => setError('')} />
        {isLoadingList ? (
          <LoadingSpinner label="Loading your series…" />
        ) : seriesList.length === 0 ? (
          <p className="series__empty">No series yet. Choose Series in Chat to create a draft.</p>
        ) : (
          <ul className="series-list">
            {seriesList.map((item) => (
              <li key={item.seriesId}>
                <button type="button" className="series-card" onClick={() => selectSeries(item.seriesId)}>
                  <span className="series-card__heading">
                    <strong>{item.title || item.topic}</strong>
                    <span className={`status-pill status-pill--${item.status}`}>
                      {STATUS_LABELS[item.status]}
                    </span>
                  </span>
                  <span className="series-card__meta">
                    {item.completedEpisodeCount}/{item.episodeCount} episodes · Updated {formatDate(item.updatedAt)}
                  </span>
                  <span className="episode-status__progress" aria-hidden="true">
                    <span
                      style={{
                        width: `${item.episodeCount > 0 ? (item.completedEpisodeCount / item.episodeCount) * 100 : 0}%`,
                      }}
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (isLoadingDetail || !detail) {
    return (
      <div className="series series--detail">
        <button type="button" className="link series__back" onClick={showList}>← All series</button>
        <ErrorBanner message={error} onDismiss={() => setError('')} />
        {isLoadingDetail && <LoadingSpinner label="Loading series…" />}
      </div>
    );
  }

  const showsPlan =
    editablePlan && ['draft', 'ready_for_approval'].includes(detail.status);
  const showsEpisodes = ['generating', 'attention', 'completed'].includes(detail.status);

  return (
    <div className="series series--detail">
      <button type="button" className="link series__back" onClick={showList}>← All series</button>
      <div className="series__page-heading">
        <div>
          <h2>{detail.title || detail.topic}</h2>
          <p>{detail.description || detail.topic}</p>
        </div>
        <span className={`status-pill status-pill--${detail.status}`}>
          {STATUS_LABELS[detail.status]}
        </span>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {detail.status === 'planning' && (
        <div className="series-stage" aria-live="polite">
          <LoadingSpinner label="Planning 2–8 focused episodes…" />
          <p>You can leave this page. Your draft will keep planning.</p>
        </div>
      )}

      {showsPlan && (
        <SeriesPlanEditor
          plan={editablePlan}
          revision={detail.revision}
          isDirty={isDirty}
          isSaving={isSaving}
          isApproving={isApproving}
          onChange={setEditablePlan}
          onSave={(plan, revision) => void savePlan(plan, revision)}
          onApprove={(revision) => void approve(revision)}
        />
      )}

      {detail.status === 'draft' && !editablePlan && (
        <div className="series-stage">
          <p>This draft does not have a plan yet. Refresh once planning begins.</p>
        </div>
      )}

      {detail.status === 'generating' && (
        <div className="series-stage series-stage--compact" aria-live="polite">
          <strong>Generating episodes</strong>
          <span>{isPolling ? ' Updates refresh automatically.' : ' Checking status…'}</span>
        </div>
      )}

      {detail.status === 'attention' && (
        <div className="series-stage series-stage--attention">
          <strong>Some episodes need attention.</strong>
          <span>Completed episodes are playable. Retry only the failed episodes.</span>
        </div>
      )}

      {detail.status === 'failed' && (
        <div className="series-stage series-stage--attention">
          <strong>Planning this series failed.</strong>
          <span>Nothing was generated. Create a new series draft from Chat to try again.</span>
        </div>
      )}

      {detail.status === 'completed' && (
        <div className="series-stage series-stage--complete">
          <strong>Your series is complete.</strong>
          <span>Choose any episode to listen.</span>
        </div>
      )}

      {showsEpisodes && (
        <EpisodeStatusList
          episodes={detail.episodes}
          activeEpisodeId={activeEpisodeId}
          retryingEpisodeId={retryingEpisodeId}
          onPlay={(episode) => void playEpisode(episode)}
          onRetry={(episode) => void retryEpisode(episode)}
        />
      )}

      {activeEpisodeId && state.audioUrl && (
        <section className="series__audio" aria-label="Series episode audio">
          <AudioPlayer
            src={state.audioUrl}
            drivingMode={state.drivingMode}
            title={state.currentLecture?.title}
            onPlaybackUpdate={trackPlayback}
          />
        </section>
      )}
    </div>
  );
}
