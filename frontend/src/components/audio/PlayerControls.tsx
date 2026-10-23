import { SPEEDS, usePlayer, usePlayerTime } from '../../contexts/PlayerContext';
import { formatDuration } from '../../utils/format';
import { Icon } from '../common/Icon';

/** Transport controls, seek bar with remaining time, and speed. */
export function PlayerControls({ large = false }: { large?: boolean }) {
  const { status, speed, togglePlay, skip, seek, setSpeed } = usePlayer();
  const { currentTime, duration } = usePlayerTime();
  const isPlaying = status === 'playing' || status === 'buffering';
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const remaining = Math.max(0, duration - currentTime);
  const unavailable = status === 'loading' || status === 'error';

  return (
    <div className={`player-controls ${large ? 'player-controls--large' : ''}`}>
      <div className="player-controls__transport">
        <button type="button" className="audio-btn audio-btn--skip" onClick={() => skip(-15)} aria-label="Back 15 seconds" disabled={unavailable}>
          <Icon name="back15" size={large ? 26 : 20} />
          <span className="audio-btn__label" aria-hidden="true">15s</span>
        </button>
        <button
          type="button"
          className="audio-btn audio-btn--primary"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          disabled={status === 'loading'}
        >
          <Icon name={isPlaying ? 'pause' : 'play'} size={large ? 36 : 30} />
        </button>
        <button type="button" className="audio-btn audio-btn--skip" onClick={() => skip(15)} aria-label="Forward 15 seconds" disabled={unavailable}>
          <Icon name="forward15" size={large ? 26 : 20} />
          <span className="audio-btn__label" aria-hidden="true">15s</span>
        </button>
      </div>

      <input
        type="range"
        className="seek"
        min={0}
        max={duration || 0}
        step={1}
        value={Math.min(currentTime, duration || 0)}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label="Seek"
        aria-valuetext={`${formatDuration(currentTime)} of ${formatDuration(duration)}`}
        style={{ ['--progress' as string]: `${progress}%` }}
        disabled={!duration}
      />

      <div className="player-controls__meta">
        <span>{formatDuration(currentTime)}</span>
        <label className="player-controls__speed">
          <span>Speed</span>
          <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label="Playback speed">
            {SPEEDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}×
              </option>
            ))}
          </select>
        </label>
        <span aria-label={`${formatDuration(remaining)} remaining`}>−{formatDuration(remaining)}</span>
      </div>
    </div>
  );
}
