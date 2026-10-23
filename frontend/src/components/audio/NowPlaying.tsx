import { useEffect, useRef } from 'react';
import { useAppState } from '../../contexts/AppStateContext';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { usePlayer, usePlayerTime } from '../../contexts/PlayerContext';
import { Icon } from '../common/Icon';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { TopicArt } from '../common/TopicArt';
import { DownloadButton } from './DownloadButton';
import { PlayerControls } from './PlayerControls';
import { Transcript } from './Transcript';

/** Full player: a persistent side panel on desktop, a sheet on mobile. */
export function NowPlaying({ variant }: { variant: 'panel' | 'sheet' }) {
  const { state } = useAppState();
  const player = usePlayer();
  const { lecture, status, notice, retry, close, setExpanded, isOfflineSource, expanded } = player;
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(sheetRef, {
    active: variant === 'sheet' && Boolean(lecture),
    onEscape: () => setExpanded(false),
    initialFocus: closeRef,
  });

  // Desktop: "open player" requests bring the always-visible panel into focus.
  useEffect(() => {
    if (variant !== 'panel' || !expanded) return;
    panelRef.current?.scrollIntoView?.({ block: 'nearest' });
    panelRef.current?.focus();
    setExpanded(false);
  }, [expanded, setExpanded, variant]);

  if (!lecture) return null;
  const title = lecture.title || lecture.topic || 'Lecture';

  const body = (
    <>
      <div className="now-playing__header">
        <span className="now-playing__eyebrow">Now playing{isOfflineSource ? ' · from this device' : ''}</span>
        <div className="now-playing__header-actions">
          {variant === 'sheet' && (
            <button
              ref={closeRef}
              type="button"
              className="icon-btn"
              onClick={() => setExpanded(false)}
              aria-label="Minimize player"
            >
              <Icon name="chevronDown" />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={close} aria-label="Stop and close player">
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="now-playing__identity">
        <TopicArt text={lecture.topic || title} size="lg" />
        <div>
          <h2 className="now-playing__title">{title}</h2>
          <p className="now-playing__meta">
            {lecture.durationMinutes ? `${lecture.durationMinutes} min` : ''}
            {lecture.topic && lecture.topic !== title ? ` · ${lecture.topic}` : ''}
          </p>
        </div>
      </div>

      {(status === 'loading' || status === 'buffering') && (
        <div className="now-playing__status">
          <LoadingSpinner label={status === 'loading' ? 'Loading audio…' : 'Buffering…'} />
        </div>
      )}
      {status === 'error' && (
        <div className="now-playing__status now-playing__status--error" role="alert">
          <span>{notice || 'The audio could not be played.'}</span>
          <button type="button" className="btn btn--small btn--ghost" onClick={retry}>
            <Icon name="refresh" size={16} /> Retry
          </button>
        </div>
      )}
      {status !== 'error' && notice && status !== 'loading' && (
        <p className="now-playing__notice">{notice}</p>
      )}

      <PlayerControls large={state.drivingMode || variant === 'sheet'} />

      <div className="now-playing__actions">
        <DownloadButton lecture={lecture} />
      </div>

      <section className="now-playing__transcript" aria-label="Transcript">
        <h3>Transcript</h3>
        {lecture.script ? (
          <Transcript script={lecture.script} />
        ) : lecture.script === null ? (
          <p className="muted">No transcript is available for this lecture.</p>
        ) : (
          <p className="muted">Loading transcript…</p>
        )}
      </section>
    </>
  );

  if (variant === 'panel') {
    return (
      <aside
        ref={panelRef}
        tabIndex={-1}
        className={`now-playing now-playing--panel ${state.drivingMode ? 'is-driving' : ''}`}
        aria-label="Now playing"
      >
        {body}
      </aside>
    );
  }
  return (
    <div className="sheet-backdrop" onClick={() => setExpanded(false)}>
      <div
        ref={sheetRef}
        className={`now-playing now-playing--sheet ${state.drivingMode ? 'is-driving' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Now playing"
        onClick={(event) => event.stopPropagation()}
      >
        {body}
      </div>
    </div>
  );
}

/** Compact player above the bottom navigation on small screens. */
export function MiniPlayer() {
  const { state } = useAppState();
  const { lecture, status, togglePlay, setExpanded, retry } = usePlayer();
  const { currentTime, duration } = usePlayerTime();
  if (!lecture) return null;
  const title = lecture.title || lecture.topic || 'Lecture';
  const isPlaying = status === 'playing' || status === 'buffering';
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <section className={`mini-player ${state.drivingMode ? 'is-driving' : ''}`} aria-label="Mini player">
      <span className="mini-player__progress" style={{ width: `${progress}%` }} aria-hidden="true" />
      <button type="button" className="mini-player__open" onClick={() => setExpanded(true)} aria-label={`Open player for ${title}`}>
        <TopicArt text={lecture.topic || title} size="sm" />
        <span className="mini-player__text">
          <strong>{title}</strong>
          <small>
            {status === 'loading'
              ? 'Loading audio…'
              : status === 'buffering'
                ? 'Buffering…'
                : status === 'error'
                  ? 'Playback problem · tap Retry'
                  : isPlaying
                    ? 'Playing'
                    : 'Paused'}
          </small>
        </span>
        <Icon name="chevronUp" className="mini-player__chevron" />
      </button>
      {status === 'error' ? (
        <button type="button" className="audio-btn audio-btn--primary mini-player__play" onClick={retry} aria-label="Retry playback">
          <Icon name="refresh" />
        </button>
      ) : (
        <button
          type="button"
          className="audio-btn audio-btn--primary mini-player__play"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          disabled={status === 'loading'}
        >
          <Icon name={isPlaying ? 'pause' : 'play'} />
        </button>
      )}
    </section>
  );
}
