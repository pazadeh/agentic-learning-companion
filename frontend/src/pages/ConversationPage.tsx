import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { AudioPlayer } from '../components/audio/AudioPlayer';
import { GenerationProgress } from '../components/generation/GenerationProgress';
import { LectureDesignPanel } from '../components/generation/LectureDesignPanel';
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
import { hasSeriesPotential, isExplicitSeriesRequest } from '../utils/seriesSuggestion';
import { usePlaybackTracking } from '../hooks/usePlaybackTracking';
import type { ChatMessage, Job, Lecture, LectureDesign, LectureDesignBrief, LectureResult } from '../types';

type LearningMode = 'lecture' | 'design' | 'series';

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
  /** Bypass guided-design mode after explicit brief confirmation. */
  forceLecture?: boolean;
  /** Structured, validated brief that must survive into generation. */
  confirmedBrief?: LectureDesignBrief;
}

function lecturePrompt(brief: LectureDesignBrief): string {
  return [
    `Create a ${brief.durationMinutes}-minute ${brief.depth} lecture titled "${brief.title}" about ${brief.topic}.`,
    `Learning objective: ${brief.learningObjective || brief.topic}.`,
    `Audience level: ${brief.knowledgeLevel}. Teaching style: ${brief.learningStyle}. Tone: ${brief.tone}.`,
    brief.includeTopics.length ? `Must include: ${brief.includeTopics.join(', ')}.` : '',
    brief.excludeTopics.length ? `Exclude: ${brief.excludeTopics.join(', ')}.` : '',
    brief.exampleContext ? `Use this example context: ${brief.exampleContext}.` : '',
    `Finish with ${brief.reinforcement}. Use ${brief.language}. Source freshness: ${brief.sourceFreshness}.`,
  ].filter(Boolean).join(' ');
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
  const [design, setDesign] = useState<LectureDesign | null>(null);
  const [designRequest, setDesignRequest] = useState('');
  const [designHistory, setDesignHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const voiceRef = useRef<VoiceController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const voiceSupported = isSpeechRecognitionSupported();
  const trackPlayback = usePlaybackTracking(state.currentLecture?.lectureId);
  const designLocked = mode === 'design' && design?.readyForConfirmation && design.turn >= 3;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages, jobState?.progress]);

  const persistLecture = useCallback((lecture: LectureResult) => {
    const entry: Lecture = {
      lectureId: lecture.lectureId,
      title: lecture.title,
      topic: lecture.topic ?? '',
      s3Key: lecture.s3Key,
      durationMinutes: lecture.durationMinutes,
      createdAt: lecture.createdAt ?? new Date().toISOString(),
      audioProvider: lecture.audioProvider,
      audioFormat: lecture.audioFormat,
      completionPercent: 0,
      isFavorite: false,
    };
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
      if (!state.isOnline) {
        setError('Connect to the internet to design or generate a lecture.');
        return;
      }
      const activeMode: LearningMode = options.forceLecture ? 'lecture' : mode;
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
      if (activeMode === 'lecture' && !options.forceSingle && isExplicitSeriesRequest(trimmed)) {
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
        if (activeMode === 'design') {
          const originalRequest = designRequest || trimmed;
          const turn = Math.min(3, (design?.turn ?? 0) + 1);
          const nextHistory = [...designHistory, { role: 'user' as const, content: trimmed }].slice(-6);
          const { job_id } = await startJob(trimmed, 'design', {
            request: originalRequest,
            answer: trimmed,
            brief: design?.brief,
            history: nextHistory,
            turn,
          });
          setJobState({
            job_id,
            status: 'pending',
            progress: 0,
            stage: 'queued',
            stage_message: 'Preparing your lecture design',
          });
          const job = await pollJobUntilDone(job_id, setJobState);
          const nextDesign = job.result?.design;
          if (!nextDesign) throw new Error('The lecture designer returned no brief.');
          setDesign(nextDesign);
          setDesignRequest(originalRequest);
          const assistantContext = nextDesign.question
            ? `${nextDesign.message}\nQuestion: ${nextDesign.question.prompt}\nChoices: ${nextDesign.question.choices.map((choice) => `${choice.label} (${choice.value})`).join('; ')}`
            : nextDesign.message;
          setDesignHistory(
            [...nextHistory, { role: 'assistant' as const, content: assistantContext.slice(0, 1000) }].slice(-6)
          );
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              id: newId(),
              role: 'assistant',
              content: nextDesign.message,
              timestamp: Date.now(),
              jobId: job_id,
            },
          });
          return;
        }

        if (activeMode === 'series') {
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

        const { job_id } = await startJob(trimmed, 'lecture', undefined, options.confirmedBrief);
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
          if (options.confirmedBrief) {
            setDesign(null);
            setDesignHistory([]);
            setDesignRequest('');
            setMode('lecture');
          }
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
            : activeMode === 'series'
              ? 'Something went wrong creating your series draft.'
              : activeMode === 'design'
                ? 'Something went wrong refining your lecture design.'
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
    [busy, createDraft, design, designHistory, designRequest, dispatch, mode, persistLecture, state.isOnline]
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

  const generateConfirmedDesign = useCallback(() => {
    if (!design?.readyForConfirmation || busy || !state.isOnline) {
      if (!state.isOnline) setError('Connect to the internet to generate this lecture.');
      return;
    }
    dispatch({
      type: 'ADD_MESSAGE',
      message: { id: newId(), role: 'user', content: 'Generate this lecture.', timestamp: Date.now() },
    });
    const prompt = lecturePrompt(design.brief);
    void send(prompt, {
      forceSingle: true,
      forceLecture: true,
      skipUserMessage: true,
      confirmedBrief: design.brief,
    });
  }, [busy, design, dispatch, send, state.isOnline]);

  const refineDesign = useCallback(() => {
    setInput('Change ');
  }, []);

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

  const changeMode = (nextMode: LearningMode) => {
    setMode(nextMode);
    setDesign(null);
    setDesignRequest('');
    setDesignHistory([]);
    setSeriesSuggestion(null);
  };

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

        {design && (
          <LectureDesignPanel
            design={design}
            disabled={busy || !state.isOnline}
            onAnswer={(answer) => void send(answer)}
            onGenerate={generateConfirmedDesign}
            onRefine={refineDesign}
          />
        )}

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

        {!state.isOnline && (
          <p className="offline-note">Generation is unavailable offline. Open History to play saved lectures.</p>
        )}

        <form className="composer-wrap" onSubmit={onSubmit}>
          <fieldset className="mode-choice" disabled={busy || !state.isOnline}>
            <legend>What would you like to create?</legend>
            <label className={mode === 'lecture' ? 'is-active' : ''}>
              <input
                type="radio"
                name="learning-mode"
                value="lecture"
                checked={mode === 'lecture'}
                onChange={() => changeMode('lecture')}
              />
              Lecture
            </label>
            <label className={mode === 'design' ? 'is-active' : ''}>
              <input
                type="radio"
                name="learning-mode"
                value="design"
                checked={mode === 'design'}
                onChange={() => changeMode('design')}
              />
              Design with AI
            </label>
            <label className={mode === 'series' ? 'is-active' : ''}>
              <input
                type="radio"
                name="learning-mode"
                value="series"
                checked={mode === 'series'}
                onChange={() => changeMode('series')}
              />
              Series
            </label>
          </fieldset>
          <div className="composer">
            <input
              className="composer__input"
              type="text"
              placeholder={
                mode === 'series'
                  ? 'What series would you like to learn?'
                  : mode === 'design'
                    ? design
                      ? 'Type another preference or choose a button above…'
                      : 'What would you like help designing?'
                    : 'What would you like to learn?'
              }
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy || !state.isOnline || Boolean(designLocked)}
              aria-label="Message"
            />
            {voiceSupported && (
              <button
                type="button"
                className={`composer__voice ${listening ? 'is-listening' : ''}`}
                onClick={toggleVoice}
                aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                disabled={busy || !state.isOnline || Boolean(designLocked)}
              >
                {listening ? '●' : '🎤'}
              </button>
            )}
            <button className="composer__send btn btn--primary" type="submit" disabled={busy || !state.isOnline || Boolean(designLocked) || !input.trim()}>
              {mode === 'series' ? 'Create draft' : mode === 'design' ? 'Refine' : 'Send'}
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
          {state.currentLecture?.script && (
            <details className="lecture-transcript">
              <summary>Read transcript</summary>
              <div className="lecture-transcript__text">{state.currentLecture.script}</div>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
