import { useAppState } from '../../contexts/AppStateContext';
import { useDownloads } from '../../contexts/DownloadsContext';
import { formatOfflineBytes } from '../../services/offline-lectures';
import type { Lecture } from '../../types';
import { Icon } from '../common/Icon';

/** Save / progress+cancel / remove control for one lecture's offline copy. */
export function DownloadButton({ lecture, compact = false }: { lecture: Lecture; compact?: boolean }) {
  const { state } = useAppState();
  const { offline, active, pendingRemoval, saveOffline, cancelDownload, removeOffline, undoRemoval } = useDownloads();
  const record = offline.get(lecture.lectureId);
  const download = active.get(lecture.lectureId);
  const name = lecture.title || lecture.topic;

  if (pendingRemoval.has(lecture.lectureId)) {
    return (
      <button
        type="button"
        className="btn btn--small btn--ghost download-btn is-pending"
        onClick={() => undoRemoval(lecture.lectureId)}
        aria-label={`Undo removing the offline copy of ${name}`}
      >
        <Icon name="restart" size={18} />
        {compact ? 'Undo' : <span>Removing… Undo</span>}
      </button>
    );
  }

  if (download) {
    const percent =
      download.totalBytes && download.totalBytes > 0
        ? Math.round((download.receivedBytes / download.totalBytes) * 100)
        : null;
    return (
      <button
        type="button"
        className="btn btn--small btn--ghost download-btn is-active"
        onClick={() => cancelDownload(lecture.lectureId)}
        aria-label={`Cancel download of ${name}`}
      >
        <span
          className="download-btn__ring"
          style={{ ['--progress' as string]: `${percent ?? 15}%` }}
          aria-hidden="true"
        />
        {percent === null ? formatOfflineBytes(download.receivedBytes) : `${percent}%`}
        {!compact && <span>Cancel</span>}
      </button>
    );
  }

  if (record) {
    return (
      <button
        type="button"
        className="btn btn--small btn--ghost download-btn is-saved"
        onClick={() => removeOffline(lecture)}
        aria-label={`Remove offline copy of ${name} (${formatOfflineBytes(record.bytes)})`}
      >
        <Icon name="downloaded" size={18} />
        {!compact && <span>Downloaded</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn btn--small btn--ghost download-btn"
      onClick={() => void saveOffline(lecture)}
      disabled={!state.isOnline}
      aria-label={`Save ${name} offline`}
      title={state.isOnline ? undefined : 'Reconnect to download'}
    >
      <Icon name="download" size={18} />
      {!compact && <span>Save offline</span>}
    </button>
  );
}
