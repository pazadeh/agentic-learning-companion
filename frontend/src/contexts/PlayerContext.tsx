import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { useProfile } from './ProfileContext';
import { ApiError, getLecture, refreshAudioUrl } from '../services/api-client';
import {
  getOfflineAudioUrl,
  getOfflineLecture,
  revokeAllOfflineAudioUrls,
  revokeOfflineAudioUrlValue,
} from '../services/offline-lectures';
import { usePlaybackTracking } from '../hooks/usePlaybackTracking';
import { getItem, removeItem, setItem, userKey } from '../utils/storage';
import type { Lecture, PlaybackUpdate } from '../types';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const HEARTBEAT_SECONDS = 20;
const POSITION_SAVE_SECONDS = 5;
const MAX_POSITIONS = 200;

export type PlayerStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'error';

interface PlayOptions {
  autoplay?: boolean;
}

/** Identity, status, and actions. Changes rarely, so most consumers stay cheap. */
export interface PlayerContextValue {
  lecture: Lecture | null;
  status: PlayerStatus;
  /** User-facing explanation for loading/error/blocked-autoplay states. */
  notice: string;
  speed: number;
  isOfflineSource: boolean;
  expanded: boolean;
  playLecture: (lecture: Lecture, options?: PlayOptions) => Promise<void>;
  togglePlay: () => void;
  seek: (seconds: number) => void;
  skip: (seconds: number) => void;
  setSpeed: (speed: number) => void;
  retry: () => void;
  close: () => void;
  /** Mobile: opens the sheet. Desktop: brings the persistent panel into focus. */
  setExpanded: (expanded: boolean) => void;
}

/** Playback clock. Updates several times a second; only time displays subscribe. */
export interface PlayerTimeValue {
  currentTime: number;
  duration: number;
}

const PlayerContext = createContext<PlayerContextValue | undefined>(undefined);
const PlayerTimeContext = createContext<PlayerTimeValue>({ currentTime: 0, duration: 0 });

function newSessionId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function nearestSpeed(value: number): number {
  return SPEEDS.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
  );
}

type Positions = Record<string, { seconds: number; at: number }>;

/**
 * Owns the single audio element for the whole app, so listening survives
 * navigation between Create, My series, Library, and You.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const ownerSub = user?.sub ?? '';
  const nowPlayingKey = userKey(ownerSub, 'nowPlaying');
  const positionsKey = userKey(ownerSub, 'positions');
  const speedKey = userKey(ownerSub, 'speed');

  const audioRef = useRef<HTMLAudioElement>(null);
  // Kept after unmount detaches the ref so teardown can still flush.
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const [lecture, setLecture] = useState<Lecture | null>(() => getItem<Lecture | null>(nowPlayingKey, null));
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [notice, setNotice] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeedState] = useState<number>(() => getItem<number | null>(speedKey, null) ?? 1);
  const [isOfflineSource, setIsOfflineSource] = useState(false);
  const [expanded, setExpandedState] = useState(false);

  const lectureRef = useRef(lecture);
  lectureRef.current = lecture;
  const loadSeq = useRef(0);
  const autoplayRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const autoRetriedRef = useRef(false);
  const previousSrc = useRef<string | null>(null);
  const lastPositionSave = useRef(0);
  // The lecture whose media is actually loaded. Media events fire asynchronously, so
  // positions are attributed to this id rather than to (possibly newer) React state.
  const mediaOwnerRef = useRef<string | null>(null);
  // Telemetry: count media time genuinely consumed (currentTime deltas while playing),
  // never seek distance and never stalled wall-clock time.
  const playingRef = useRef(false);
  const lastMediaTimeRef = useRef<number | null>(null);
  const playedSecondsRef = useRef(0);
  const lastReportedRef = useRef(0);
  const sequenceRef = useRef(0);
  const sessionIdRef = useRef(newSessionId());
  const trackPlayback = usePlaybackTracking(lecture && !lecture.untracked ? lecture.lectureId : null, ownerSub);
  const trackRef = useRef<(update: PlaybackUpdate) => void>(trackPlayback);
  trackRef.current = trackPlayback;

  const getAudio = () => audioRef.current ?? audioElement.current;

  useEffect(() => {
    audioElement.current = audioRef.current;
  });

  // Apply a confident learned playback rate only when the user never chose one.
  useEffect(() => {
    if (getItem<number | null>(speedKey, null) !== null) return;
    const inferred = profile?.inferred?.preferredPlaybackRate;
    if (inferred && inferred.confidencePercent >= 70) setSpeedState(nearestSpeed(inferred.value));
  }, [profile, speedKey]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
  }, [speed, src]);

  // Revoke superseded offline Blob URLs.
  useEffect(() => {
    const previous = previousSrc.current;
    if (previous && previous !== src) revokeOfflineAudioUrlValue(previous);
    previousSrc.current = src;
  }, [src]);

  const savePosition = useCallback(
    (lectureId: string, seconds: number) => {
      const positions = getItem<Positions | Record<string, number>>(positionsKey, {});
      const normalized: Positions = {};
      for (const [id, value] of Object.entries(positions)) {
        normalized[id] = typeof value === 'number' ? { seconds: value, at: 0 } : value;
      }
      normalized[lectureId] = { seconds: Math.max(0, Math.round(seconds)), at: Date.now() };
      // Trim by recency so the entry just written is never the one evicted.
      const kept = Object.entries(normalized)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_POSITIONS);
      setItem(positionsKey, Object.fromEntries(kept));
    },
    [positionsKey]
  );

  const readPosition = useCallback(
    (lectureId: string): number | undefined => {
      const value = getItem<Positions | Record<string, number>>(positionsKey, {})[lectureId];
      return typeof value === 'number' ? value : value?.seconds;
    },
    [positionsKey]
  );

  const accrue = useCallback(() => {
    const audio = getAudio();
    if (!audio || !playingRef.current) return;
    const now = audio.currentTime;
    const last = lastMediaTimeRef.current;
    lastMediaTimeRef.current = now;
    if (last === null) return;
    const delta = now - last;
    // Ignore jumps (seeks) and backwards motion; timeupdate fires ~4×/s.
    if (delta > 0 && delta <= 3 * Math.max(1, audio.playbackRate)) playedSecondsRef.current += delta;
  }, []);

  const emitPlayback = useCallback((eventType: PlaybackUpdate['eventType']) => {
    const audio = getAudio();
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    sequenceRef.current += 1;
    lastReportedRef.current = playedSecondsRef.current;
    trackRef.current({
      playbackSessionId: sessionIdRef.current,
      sequence: sequenceRef.current,
      playedSeconds: Number(playedSecondsRef.current.toFixed(3)),
      positionSeconds: Number(audio.currentTime.toFixed(3)),
      mediaDurationSeconds: Number(audio.duration.toFixed(3)),
      playbackRate: audio.playbackRate,
      eventType,
      occurredAt: new Date().toISOString(),
    });
  }, []);

  /** Save the loaded lecture's position and report unsent listening time. */
  const flushSession = useCallback(() => {
    const audio = getAudio();
    accrue();
    playingRef.current = false;
    lastMediaTimeRef.current = null;
    if (audio && mediaOwnerRef.current) savePosition(mediaOwnerRef.current, audio.currentTime);
    if (playedSecondsRef.current > lastReportedRef.current) emitPlayback('pause');
  }, [accrue, emitPlayback, savePosition]);

  const resetSession = useCallback(() => {
    playingRef.current = false;
    lastMediaTimeRef.current = null;
    playedSecondsRef.current = 0;
    lastReportedRef.current = 0;
    sequenceRef.current = 0;
    sessionIdRef.current = newSessionId();
  }, []);

  // Sign-out or account switch unmounts the provider: flush before freeing Blob URLs.
  const flushRef = useRef(flushSession);
  flushRef.current = flushSession;
  useEffect(
    () => () => {
      flushRef.current();
      revokeAllOfflineAudioUrls();
    },
    []
  );

  const startPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const attempt = audio.play();
    if (!attempt?.catch) return;
    attempt.catch((error: unknown) => {
      const name = (error as DOMException)?.name;
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') {
        setStatus('paused');
        setNotice('Tap play to start listening.');
        return;
      }
      setStatus('error');
      setNotice('Playback could not start. Try again.');
    });
  }, []);

  const resolveSource = useCallback(
    async (target: Lecture, seq: number) => {
      setStatus('loading');
      setNotice('Loading audio…');
      try {
        const offline =
          ownerSub && !target.untracked
            ? await getOfflineLecture(ownerSub, target.lectureId).catch(() => null)
            : null;
        if (seq !== loadSeq.current) return;
        if (offline) {
          setIsOfflineSource(true);
          setSrc(getOfflineAudioUrl(offline));
          setLecture((current) =>
            current?.lectureId === target.lectureId && current.script === undefined
              ? { ...current, script: offline.script ?? null }
              : current
          );
          return;
        }
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          setStatus('error');
          setNotice('This lecture is not saved on this device. Reconnect to play it.');
          return;
        }
        const { url } = await refreshAudioUrl(target.s3Key);
        if (seq !== loadSeq.current) return;
        setIsOfflineSource(false);
        setSrc(url);
        if (target.script === undefined) {
          const setScript = (script: string | null) =>
            setLecture((current) =>
              current?.lectureId === target.lectureId
                ? { ...current, script, transcriptAvailable: Boolean(script) }
                : current
            );
          if (target.untracked) setScript(null);
          else {
            // A failed lookup settles to "no transcript" instead of loading forever.
            void getLecture(target.lectureId)
              .then((detail) => seq === loadSeq.current && setScript(detail.script ?? null))
              .catch(() => seq === loadSeq.current && setScript(null));
          }
        }
      } catch (error) {
        if (seq !== loadSeq.current) return;
        setStatus('error');
        setNotice(
          error instanceof ApiError
            ? `${error.message} Try again.`
            : 'The audio could not be loaded. Check your connection and try again.'
        );
      }
    },
    [ownerSub]
  );

  const playLecture = useCallback(
    async (next: Lecture, options: PlayOptions = {}) => {
      const audio = audioRef.current;
      const autoplay = options.autoplay ?? true;
      const current = lectureRef.current;
      if (current?.lectureId === next.lectureId && src && status !== 'error') {
        setLecture((existing) => (existing ? { ...existing, ...next, script: next.script ?? existing.script } : next));
        if (autoplay && audio?.paused) startPlayback();
        return;
      }
      // Save and report the outgoing lecture before its media is replaced.
      if (current) flushSession();
      mediaOwnerRef.current = null;
      audio?.pause();
      resetSession();
      loadSeq.current += 1;
      const seq = loadSeq.current;
      autoplayRef.current = autoplay;
      autoRetriedRef.current = false;
      pendingSeekRef.current = null;
      setLecture(next);
      setCurrentTime(0);
      setDuration(0);
      setSrc(null);
      await resolveSource(next, seq);
    },
    [flushSession, resetSession, resolveSource, src, startPlayback, status]
  );

  // Restore the last lecture after reload (paused, ready to resume).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !lecture) return;
    restored.current = true;
    loadSeq.current += 1;
    autoplayRef.current = false;
    void resolveSource(lecture, loadSeq.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lecture) setItem(nowPlayingKey, lecture);
  }, [lecture, nowPlayingKey]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    const current = lectureRef.current;
    if (!audio || !current) return;
    if (!src) {
      autoplayRef.current = true;
      loadSeq.current += 1;
      void resolveSource(current, loadSeq.current);
      return;
    }
    if (audio.paused) {
      setNotice('');
      startPlayback();
    } else audio.pause();
  }, [resolveSource, src, startPlayback]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
    audio.currentTime = Math.min(Math.max(0, seconds), max);
    lastMediaTimeRef.current = audio.currentTime;
    setCurrentTime(audio.currentTime);
  }, []);

  const skip = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      seek(audio.currentTime + seconds);
    },
    [seek]
  );

  const setSpeed = useCallback(
    (value: number) => {
      setSpeedState(value);
      setItem(speedKey, value);
    },
    [speedKey]
  );

  const retry = useCallback(() => {
    const current = lectureRef.current;
    if (!current) return;
    const audio = audioRef.current;
    pendingSeekRef.current = audio?.currentTime || null;
    autoplayRef.current = true;
    autoRetriedRef.current = false;
    loadSeq.current += 1;
    setSrc(null);
    void resolveSource(current, loadSeq.current);
  }, [resolveSource]);

  const close = useCallback(() => {
    flushSession();
    mediaOwnerRef.current = null;
    audioRef.current?.pause();
    loadSeq.current += 1;
    setLecture(null);
    setSrc(null);
    setStatus('idle');
    setNotice('');
    setExpandedState(false);
    removeItem(nowPlayingKey);
  }, [flushSession, nowPlayingKey]);

  const setExpanded = useCallback((value: boolean) => setExpandedState(value), []);

  // ----- media element events -----
  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    const current = lectureRef.current;
    if (!audio || !current) return;
    mediaOwnerRef.current = current.lectureId;
    lastPositionSave.current = 0;
    audio.playbackRate = speed;
    const total = Number.isFinite(audio.duration) ? audio.duration : 0;
    setDuration(total);
    const desired = pendingSeekRef.current ?? readPosition(current.lectureId) ?? current.resumePositionSeconds ?? 0;
    pendingSeekRef.current = null;
    if (desired > 5 && (!total || desired < total - 15)) {
      audio.currentTime = desired;
      setCurrentTime(desired);
    }
    setStatus('ready');
    setNotice('');
    if (autoplayRef.current) {
      autoplayRef.current = false;
      startPlayback();
    }
  };

  const onPlay = () => {
    playingRef.current = true;
    lastMediaTimeRef.current = audioRef.current?.currentTime ?? null;
    setStatus('playing');
    setNotice('');
  };

  const onPlaying = () => {
    // A successful (re)start re-arms the one transparent presigned-URL refresh.
    autoRetriedRef.current = false;
    setStatus('playing');
  };

  const onPause = () => {
    const audio = audioRef.current;
    accrue();
    playingRef.current = false;
    lastMediaTimeRef.current = null;
    setStatus((current) => (current === 'error' ? current : 'paused'));
    if (mediaOwnerRef.current && audio) savePosition(mediaOwnerRef.current, audio.currentTime);
    if (playedSecondsRef.current > lastReportedRef.current) emitPlayback('pause');
  };

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio || !mediaOwnerRef.current) return;
    accrue();
    setCurrentTime(audio.currentTime);
    if (Math.abs(audio.currentTime - lastPositionSave.current) >= POSITION_SAVE_SECONDS) {
      lastPositionSave.current = audio.currentTime;
      savePosition(mediaOwnerRef.current, audio.currentTime);
    }
    if (playedSecondsRef.current - lastReportedRef.current >= HEARTBEAT_SECONDS) emitPlayback('heartbeat');
  };

  const onEnded = () => {
    accrue();
    playingRef.current = false;
    lastMediaTimeRef.current = null;
    setStatus('paused');
    if (mediaOwnerRef.current) savePosition(mediaOwnerRef.current, 0);
    emitPlayback('ended');
  };

  const onError = () => {
    const current = lectureRef.current;
    if (!current || !src) return;
    // Presigned URLs expire after an hour; refresh once transparently.
    if (!isOfflineSource && !autoRetriedRef.current) {
      autoRetriedRef.current = true;
      const wasPlaying = playingRef.current || autoplayRef.current;
      accrue();
      playingRef.current = false;
      lastMediaTimeRef.current = null;
      pendingSeekRef.current = audioRef.current?.currentTime || null;
      autoplayRef.current = wasPlaying;
      loadSeq.current += 1;
      void resolveSource(current, loadSeq.current);
      return;
    }
    setStatus('error');
    setNotice('The audio stopped unexpectedly. Retry to continue where you left off.');
  };

  // Lock-screen / car controls, torn down when nothing is loaded.
  useEffect(() => {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!session) return;
    const actions = ['play', 'pause', 'seekbackward', 'seekforward'] as const;
    try {
      if (!lecture) {
        session.metadata = null;
        actions.forEach((action) => session.setActionHandler(action, null));
        return;
      }
      if (typeof MediaMetadata !== 'undefined') {
        session.metadata = new MediaMetadata({ title: lecture.title || lecture.topic, artist: 'Audio Learning Companion' });
      }
      session.setActionHandler('play', () => togglePlay());
      session.setActionHandler('pause', () => audioRef.current?.pause());
      session.setActionHandler('seekbackward', () => skip(-15));
      session.setActionHandler('seekforward', () => skip(15));
    } catch {
      // Media Session support varies by browser.
    }
  }, [lecture, skip, togglePlay]);

  useEffect(() => {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!session) return;
    try {
      session.playbackState = !lecture ? 'none' : status === 'playing' || status === 'buffering' ? 'playing' : 'paused';
    } catch {
      // Optional API.
    }
  }, [lecture, status]);

  // Persist telemetry and position if the page is hidden or closed mid-lecture.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      const audio = getAudio();
      if (mediaOwnerRef.current && audio) savePosition(mediaOwnerRef.current, audio.currentTime);
      accrue();
      if (playedSecondsRef.current > lastReportedRef.current) emitPlayback('pause');
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [accrue, emitPlayback, savePosition]);

  const value = useMemo<PlayerContextValue>(
    () => ({
      lecture,
      status,
      notice,
      speed,
      isOfflineSource,
      expanded,
      playLecture,
      togglePlay,
      seek,
      skip,
      setSpeed,
      retry,
      close,
      setExpanded,
    }),
    [close, expanded, isOfflineSource, lecture, notice, playLecture, retry, seek, setExpanded, setSpeed, skip, speed, status, togglePlay]
  );
  const time = useMemo(() => ({ currentTime, duration }), [currentTime, duration]);

  return (
    <PlayerContext.Provider value={value}>
      <PlayerTimeContext.Provider value={time}>
        {children}
        <audio
          ref={audioRef}
          src={src ?? undefined}
          preload="metadata"
          onLoadStart={() => src && setStatus((current) => (current === 'playing' ? current : 'loading'))}
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={(event) => {
            const total = (event.target as HTMLAudioElement).duration;
            if (Number.isFinite(total)) setDuration(total);
          }}
          onWaiting={() => setStatus('buffering')}
          onPlaying={onPlaying}
          onPlay={onPlay}
          onPause={onPause}
          onSeeked={() => {
            lastMediaTimeRef.current = audioRef.current?.currentTime ?? null;
          }}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          onError={onError}
          data-testid="audio-element"
        />
      </PlayerTimeContext.Provider>
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within a PlayerProvider');
  return ctx;
}

export function usePlayerTime(): PlayerTimeValue {
  return useContext(PlayerTimeContext);
}
