import type { GenerationStage, SeriesEpisode, SeriesEpisodeStatus } from '../../types';
import { Icon } from '../common/Icon';

interface EpisodeStatusListProps {
  episodes: SeriesEpisode[];
  activeEpisodeId?: string | null;
  retryingEpisodeId?: string | null;
  onPlay: (episode: SeriesEpisode) => void;
  onRetry: (episode: SeriesEpisode) => void;
}

const STATUS_LABELS: Record<SeriesEpisodeStatus, string> = {
  planned: 'Planned',
  pending: 'Waiting',
  queued: 'Queued',
  researching: 'Researching',
  writing: 'Writing',
  synthesizing: 'Creating audio',
  processing: 'Processing',
  completed: 'Ready',
  failed: 'Failed',
};

const STAGE_LABELS: Partial<Record<GenerationStage, string>> = {
  preparing: 'Preparing',
  validating: 'Validating',
  recalling: 'Personalizing',
  profiling: 'Personalizing',
  researching: 'Researching',
  writing: 'Writing',
  synthesizing: 'Creating audio',
  uploading: 'Uploading audio',
  saving: 'Saving',
  finalizing: 'Finalizing',
};

function statusIsActive(status: SeriesEpisodeStatus): boolean {
  return !['planned', 'completed', 'failed'].includes(status);
}

function boundedProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, Math.round(progress)));
}

export function EpisodeStatusList({
  episodes,
  activeEpisodeId,
  retryingEpisodeId,
  onPlay,
  onRetry,
}: EpisodeStatusListProps) {
  if (episodes.length === 0) {
    return <p className="empty-state">Episodes will appear when the plan is ready.</p>;
  }

  const orderedEpisodes = [...episodes].sort((a, b) => a.order - b.order);

  return (
    <ol className="episode-status-list" aria-label="Series episodes">
      {orderedEpisodes.map((episode) => {
        const progress = boundedProgress(episode.progress);
        const canPlay = episode.status === 'completed' && Boolean(episode.s3Key);
        const isRetrying = retryingEpisodeId === episode.episodeId;
        const isActive = activeEpisodeId === episode.episodeId;
        const label = episode.stage && statusIsActive(episode.status)
          ? STAGE_LABELS[episode.stage] ?? STATUS_LABELS[episode.status]
          : STATUS_LABELS[episode.status];
        return (
          <li key={episode.episodeId} className={`episode-status ${isActive ? 'is-active' : ''}`}>
            <div className="episode-status__number" aria-hidden="true">
              {episode.order}
            </div>
            <div className="episode-status__body">
              <div className="episode-status__heading">
                <strong>{episode.title}</strong>
                <span className={`status-pill status-pill--${episode.status}`}>{label}</span>
              </div>
              {episode.summary && <p>{episode.summary}</p>}
              {episode.stageDetail && statusIsActive(episode.status) && (
                <p className="episode-status__stage-detail">{episode.stageDetail}</p>
              )}
              <span className="episode-status__meta">{episode.durationMinutes} min</span>

              {statusIsActive(episode.status) && (
                <div
                  className="progress-line progress-line--labeled"
                  role="progressbar"
                  aria-label={`${episode.title} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
              )}

              {episode.error && <p className="episode-status__error">{episode.error}</p>}

              <div className="episode-status__actions">
                {canPlay && (
                  <button
                    type="button"
                    className={`btn btn--small ${isActive ? 'btn--ghost' : 'btn--primary'}`}
                    onClick={() => onPlay(episode)}
                  >
                    <Icon name={isActive ? 'expand' : 'play'} size={16} />
                    {isActive ? 'Now playing' : 'Play episode'}
                  </button>
                )}
                {episode.retryable && (
                  <button
                    type="button"
                    className="btn btn--small btn--ghost"
                    onClick={() => onRetry(episode)}
                    disabled={isRetrying}
                  >
                    <Icon name="refresh" size={16} />
                    {isRetrying ? 'Retrying…' : episode.status === 'failed' ? 'Retry' : 'Retry stalled episode'}
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
