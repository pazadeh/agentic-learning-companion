import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { AudioPlayer } from '../components/audio/AudioPlayer';
import { GenerationProgress } from '../components/generation/GenerationProgress';
import { ErrorBanner } from '../components/common/ErrorBanner';
import { SeriesSuggestionCard } from '../components/series/SeriesSuggestionCard';
import {
  ApiError,
  createSeriesDraft,
  pollJobUntilDone,
  refreshAudioUrl,
  startJob,
} from '../services/api-client';
import {
  createSpeechRecognition,
  isSpeechRecognitionSupported,
  type VoiceController,
} from '../services/voice-recognition';
import { getItem, setItem, STORAGE_KEYS } from '../utils/storage';
import { hasSeriesPotential, isExplicitSeriesRequest } from '../utils/seriesSuggestion';
import { usePlaybackTracking } from '../hooks/usePlaybackTracking';
import type { ChatMessage, Job, Lecture, LectureResult } from '../types';

type LearningMode = 'lecture' | 'series';

interface SeriesSuggestion {
  prompt: string;
  topic: string;
  /** `explicit`: the learner asked for several lectures in Lecture mode (nothing started yet).
   *  `after_lecture`: a broad topic just produced one lecture. */
  kind: 'explicit' | 'after_lecture';
}

interface SendOptions {
  /** Generate one lecture even if the text reads like a series request. */
  forceSingle?: boolean;
  /** The user message is already in the transcript. */
  skipUserMessage?: boolean;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function ConversationPage() {
  const { state, dispatch } = useAppState();
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<LearningMode>('lecture');
  const [busy, setBusy] = useState(false);
  const [jobState, setJobState] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const [seriesSuggestion, setSeriesSuggestion] = useState<SeriesSuggestion | null>(null);
  const [creatingSuggestedSeries, setCreatingSuggestedSeries] = useState(false);
  const voiceRef = useRef<VoiceController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const voiceSupported = isSpeechRecognitionSupported();
  const trackPlayback = usePlaybackTracking(state.currentLecture?.lectureId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages, jobState?.progress]);

  const persistLecture = useCallback((lecture: LectureResult) => {
    const stored = getItem<Lecture[]>(STORAGE_KEYS.lectures, []);
    const entry: Lecture = {
      lectureId: lecture.lectureId,
      title: lecture.title,
      topic: lecture.topic ?? '',
      s3Key: lecture.s3Key,
      durationMinutes: lecture.durationMinutes,
      createdAt: lecture.createdAt ?? new Date().toISOString(),
      completionPercent: 0,
      isFavorite: false,
    };
    const next = [entry, ...stored.filter((l) => l.lectureId !== entry.lectureId)];
    setItem(STORAGE_KEYS.lectures, next);
    return entry;
  }, []);

  const openSeries = useCallback(
    (seriesId: string) => {
      dispatch({ type: 'SET_SELECTED_SERIES', seriesId });
      dispatch({ type: 'SET_PAGE', page: 'series' });
    },
    [dispatch]
  );

  const createDraft = useCallback(
    async (prompt: string) => {
      const draft = await createSeriesDraft(prompt);
      openSeries(draft.seriesId);
      return draft;
    },
    [openSeries]
  );

  const send = useCallback(
    async (text: string, options: SendOptions = {}) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setError('');
      setJobState(null);
      setSeriesSuggestion(null);

      if (!options.skipUserMessage) {
        const userMessage: ChatMessage = {
          id: newId(),
          role: 'user',
          content: trimmed,
          timestamp: Date.now(),
        };
        dispatch({ type: 'ADD_MESSAGE', message: userMessage });
        setInput('');
      }

      // An explicit multi-lecture request in Lecture mode: ask, never convert silently.
      if (mode === 'lecture' && !options.forceSingle && isExplicitSeriesRequest(trimmed)) {
        dispatch({
          type: 'ADD_MESSAGE',
          message: {
            id: newId(),
            role: 'assistant',
            content:
              'That sounds like several lectures. I can plan an editable series for you to review first, or make a single lecture.',
            timestamp: Date.now(),
          },
        });
        setSeriesSuggestion({ prompt: trimmed, topic: trimmed, kind: 'explicit' });
        return;
      }

      setBusy(true);

      try {
        if (mode === 'series') {
          const draft = await createDraft(trimmed);
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              id: newId(),
              role: 'assistant',
              content: `Created the “${draft.title || draft.topic}” series draft for you to review.`,
              timestamp: Date.now(),
            },
          });
          return;
        }

        const { job_id } = await startJob(trimmed, 'lecture');
        setJobState({
          job_id,
          status: 'pending',
          progress: 0,
          stage: 'queued',
          stage_message: 'Queued for generation',
          stage_detail: 'Waiting for a worker',
        });
        const job = await pollJobUntilDone(job_id, setJobState);
        const response = job.result?.response ?? 'Your lecture is ready.';
        dispatch({
          type: 'ADD_MESSAGE',
          message: { id: newId(), role: 'assistant', content: response, timestamp: Date.now(), jobId: job_id },
        });

        const lecture = job.result?.lecture;
        if (lecture?.s3Key) {
          const entry = persistLecture(lecture);
          const { url } = await refreshAudioUrl(lecture.s3Key);
          dispatch({ type: 'SET_LECTURE', lecture: entry });
          dispatch({ type: 'SET_AUDIO_URL', url });
          // Offer a series only when the topic is broad enough to warrant one.
          if (hasSeriesPotential(trimmed)) {
            setSeriesSuggestion({
              prompt: trimmed,
              topic: lecture.topic || lecture.title || trimmed,
              kind: 'after_lecture',
            });
          }
        }
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : mode === 'series'
              ? 'Something went wrong creating your series draft.'
              : 'Something went wrong generating your lecture.';
        setError(message);
        dispatch({
          type: 'ADD_MESSAGE',
          message: { id: newId(), role: 'assistant', content: message, timestamp: Date.now() },
        });
      } finally {
        setBusy(false);
        setJobState(null);
      }
    },
    [busy, createDraft, dispatch, mode, persistLecture]
  );

  const createSuggestedSeries = useCallback(async () => {
    if (!seriesSuggestion || creatingSuggestedSeries) return;
    setCreatingSuggestedSeries(true);
    setError('');
    try {
      await createDraft(seriesSuggestion.prompt);
      setSeriesSuggestion(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the series draft.');
    } finally {
      setCreatingSuggestedSeries(false);
    }
  }, [createDraft, creatingSuggestedSeries, seriesSuggestion]);

  const dismissSuggestion = useCallback(() => {
    const suggestion = seriesSuggestion;
    setSeriesSuggestion(null);
    // For an explicit request nothing has started yet: "One lecture instead" runs it.
    if (suggestion?.kind === 'explicit') {
      void send(suggestion.prompt, { forceSingle: true, skipUserMessage: true });
    }
  }, [send, seriesSuggestion]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send(input);
  };

  const toggleVoice = useCallback(() => {
    if (listening) {
      voiceRef.current?.stop();
      setListening(false);
      return;
    }
    const controller = createSpeechRecognition({
      onTranscript: (text, isFinal) => {
        if (isFinal) setInput((previous) => `${previous} ${text}`.trim());
      },
      onEnd: () => setListening(false),
      onError: () => setListening(false),
    });
    if (!controller) return;
    voiceRef.current = controller;
    controller.start();
    setListening(true);
  }, [listening]);

  return (
    <div className="conversation">
      <section className="conversation__chat" aria-label="Conversation">
        <div className="messages">
          {state.messages.length === 0 && (
            <p className="messages__empty">Ask me to teach you anything. Try “Teach me about black holes.”</p>
          )}
          {state.messages.map((message) => (
            <div key={message.id} className={`message message--${message.role}`}>
              {message.content}
            </div>
          ))}
          {busy && (
            mode === 'series' ? (
              <div className="message message--assistant message--pending">
                Creating your editable series draft…
              </div>
            ) : (
              <GenerationProgress job={jobState} />
            )
          )}
          <div ref={messagesEndRef} />
        </div>

        <ErrorBanner message={error} onDismiss={() => setError('')} />

        {seriesSuggestion && (
          <SeriesSuggestionCard
            topic={seriesSuggestion.topic}
            message={
              seriesSuggestion.kind === 'explicit'
                ? 'Plan this as a multi-part series you can review and edit before anything is generated.'
                : undefined
            }
            dismissLabel={seriesSuggestion.kind === 'explicit' ? 'One lecture instead' : 'Not now'}
            isCreating={creatingSuggestedSeries}
            onCreate={() => void createSuggestedSeries()}
            onDismiss={dismissSuggestion}
          />
        )}

        <form className="composer-wrap" onSubmit={onSubmit}>
          <fieldset className="mode-choice" disabled={busy}>
            <legend>What would you like to create?</legend>
            <label className={mode === 'lecture' ? 'is-active' : ''}>
              <input
                type="radio"
                name="learning-mode"
                value="lecture"
                checked={mode === 'lecture'}
                onChange={() => setMode('lecture')}
              />
              Lecture
            </label>
            <label className={mode === 'series' ? 'is-active' : ''}>
              <input
                type="radio"
                name="learning-mode"
                value="series"
                checked={mode === 'series'}
                onChange={() => setMode('series')}
              />
              Series
            </label>
          </fieldset>
          <div className="composer">
            <input
              className="composer__input"
              type="text"
              placeholder={mode === 'series' ? 'What series would you like to learn?' : 'What would you like to learn?'}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
              aria-label="Message"
            />
            {voiceSupported && (
              <button
                type="button"
                className={`composer__voice ${listening ? 'is-listening' : ''}`}
                onClick={toggleVoice}
                aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                disabled={busy}
              >
                {listening ? '●' : '🎤'}
              </button>
            )}
            <button className="composer__send btn btn--primary" type="submit" disabled={busy || !input.trim()}>
              {mode === 'series' ? 'Create draft' : 'Send'}
            </button>
          </div>
        </form>
      </section>

      {state.audioUrl && (
        <section className="conversation__audio" aria-label="Lecture audio">
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
