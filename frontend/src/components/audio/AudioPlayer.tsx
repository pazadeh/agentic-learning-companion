import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../../utils/format';
import type { PlaybackUpdate } from '../../types';

interface AudioPlayerProps {
  src: string;
  drivingMode?: boolean;
  title?: string;
  onProgress?: (percent: number) => void;
  onPlaybackUpdate?: (update: PlaybackUpdate) => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const HEARTBEAT_SECONDS = 20;

function sessionId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function AudioPlayer({
  src,
  drivingMode = false,
  title,
  onProgress,
  onPlaybackUpdate,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playingRef = useRef(false);
  const lastTickRef = useRef(0);
  const playedSecondsRef = useRef(0);
  const lastReportedRef = useRef(0);
  const sequenceRef = useRef(0);
  const sessionIdRef = useRef(sessionId());
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    // A source change is a new playback session. Seeking never increments played
    // time; only wall-clock time while the audio element is actively playing does.
    playingRef.current = false;
    lastTickRef.current = 0;
    playedSecondsRef.current = 0;
    lastReportedRef.current = 0;
    sequenceRef.current = 0;
    sessionIdRef.current = sessionId();
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  const accruePlayedTime = useCallback(() => {
    const audio = audioRef.current;
    if (!playingRef.current || !lastTickRef.current || !audio) return;
    const now = performance.now();
    // Count media time genuinely consumed (wall time × playback rate), never seek
    // distance. The cap prevents a suspended/backgrounded tab from counting idle time.
    const elapsed = Math.min(5, Math.max(0, (now - lastTickRef.current) / 1000));
    playedSecondsRef.current += elapsed * audio.playbackRate;
    lastTickRef.current = now;
  }, []);

  const emitPlayback = useCallback(
    (eventType: PlaybackUpdate['eventType']) => {
      const audio = audioRef.current;
      if (!audio || !onPlaybackUpdate || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      sequenceRef.current += 1;
      lastReportedRef.current = playedSecondsRef.current;
      onPlaybackUpdate({
        playbackSessionId: sessionIdRef.current,
        sequence: sequenceRef.current,
        playedSeconds: Number(playedSecondsRef.current.toFixed(3)),
        positionSeconds: Number(audio.currentTime.toFixed(3)),
        mediaDurationSeconds: Number(audio.duration.toFixed(3)),
        playbackRate: audio.playbackRate,
        eventType,
        occurredAt: new Date().toISOString(),
      });
    },
    [onPlaybackUpdate]
  );

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) audio.pause();
    else void audio.play();
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

  const handlePlay = useCallback(() => {
    playingRef.current = true;
    lastTickRef.current = performance.now();
    setIsPlaying(true);
  }, []);

  const handlePause = useCallback(() => {
    accruePlayedTime();
    playingRef.current = false;
    lastTickRef.current = 0;
    setIsPlaying(false);
    if (playedSecondsRef.current > lastReportedRef.current) emitPlayback('pause');
  }, [accruePlayedTime, emitPlayback]);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    accruePlayedTime();
    setCurrentTime(audio.currentTime);
    if (audio.duration > 0) onProgress?.((audio.currentTime / audio.duration) * 100);
    if (playedSecondsRef.current - lastReportedRef.current >= HEARTBEAT_SECONDS) {
      emitPlayback('heartbeat');
    }
  }, [accruePlayedTime, emitPlayback, onProgress]);

  const handleEnded = useCallback(() => {
    accruePlayedTime();
    playingRef.current = false;
    lastTickRef.current = 0;
    setIsPlaying(false);
    emitPlayback('ended');
  }, [accruePlayedTime, emitPlayback]);

  useEffect(
    () => () => {
      accruePlayedTime();
      playingRef.current = false;
      if (playedSecondsRef.current > lastReportedRef.current) emitPlayback('pause');
    },
    [accruePlayedTime, emitPlayback, src]
  );

  const wrapperClass = drivingMode ? 'audio-player audio-player--driving' : 'audio-player';

  return (
    <div className={wrapperClass}>
      {title && <p className="audio-player__title">{title}</p>}
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={handlePlay}
        onPause={handlePause}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={(event) => setDuration((event.target as HTMLAudioElement).duration || 0)}
        onEnded={handleEnded}
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
            {SPEEDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}×
              </option>
            ))}
          </select>
        </label>
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}
