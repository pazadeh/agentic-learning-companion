import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../../utils/format';

interface AudioPlayerProps {
  src: string;
  drivingMode?: boolean;
  title?: string;
  onProgress?: (percent: number) => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function AudioPlayer({ src, drivingMode = false, title, onProgress }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    // Reset state when the source changes.
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      void audio.play();
    }
  }, [isPlaying]);

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.min(
      Math.max(0, audio.currentTime + seconds),
      audio.duration || audio.currentTime
    );
  }, []);

  const onSeek = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Number(event.target.value);
  }, []);

  const changeSpeed = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = Number(event.target.value);
    setSpeed(value);
    if (audioRef.current) audioRef.current.playbackRate = value;
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    if (audio.duration > 0) onProgress?.((audio.currentTime / audio.duration) * 100);
  }, [onProgress]);

  const wrapperClass = drivingMode ? 'audio-player audio-player--driving' : 'audio-player';

  return (
    <div className={wrapperClass}>
      {title && <p className="audio-player__title">{title}</p>}
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={(e) => setDuration((e.target as HTMLAudioElement).duration || 0)}
        onEnded={() => setIsPlaying(false)}
        data-testid="audio-element"
      />

      <div className="audio-player__controls">
        <button type="button" className="audio-btn" onClick={() => skip(-15)} aria-label="Back 15 seconds">
          −15
        </button>
        <button
          type="button"
          className="audio-btn audio-btn--primary"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '❚❚' : '►'}
        </button>
        <button type="button" className="audio-btn" onClick={() => skip(15)} aria-label="Forward 15 seconds">
          +15
        </button>
      </div>

      <input
        type="range"
        className="audio-player__seek"
        min={0}
        max={duration || 0}
        step={0.1}
        value={currentTime}
        onChange={onSeek}
        aria-label="Seek"
      />

      <div className="audio-player__meta">
        <span>{formatDuration(currentTime)}</span>
        <label className="audio-player__speed">
          Speed
          <select value={speed} onChange={changeSpeed} aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}
