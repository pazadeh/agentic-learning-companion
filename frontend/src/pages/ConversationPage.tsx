import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { AudioPlayer } from '../components/audio/AudioPlayer';
import { ErrorBanner } from '../components/common/ErrorBanner';
import { ApiError, pollJobUntilDone, refreshAudioUrl, startJob } from '../services/api-client';
import {
  createSpeechRecognition,
  isSpeechRecognitionSupported,
  type VoiceController,
} from '../services/voice-recognition';
import { getItem, setItem, STORAGE_KEYS } from '../utils/storage';
import type { ChatMessage, Lecture, LectureResult } from '../types';

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function ConversationPage() {
  const { state, dispatch } = useAppState();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const voiceRef = useRef<VoiceController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const voiceSupported = isSpeechRecognitionSupported();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages, progress]);

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

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setError('');
      setProgress(0);

      const userMessage: ChatMessage = {
        id: newId(),
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };
      dispatch({ type: 'ADD_MESSAGE', message: userMessage });
      setInput('');
      setBusy(true);

      try {
        const { job_id } = await startJob(trimmed, 'lecture');
        const job = await pollJobUntilDone(job_id, (p) => setProgress(p));
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
        }
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : 'Something went wrong generating your lecture.';
        setError(message);
        dispatch({
          type: 'ADD_MESSAGE',
          message: { id: newId(), role: 'assistant', content: message, timestamp: Date.now() },
        });
      } finally {
        setBusy(false);
        setProgress(0);
      }
    },
    [busy, dispatch, persistLecture]
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
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
        if (isFinal) setInput((prev) => `${prev} ${text}`.trim());
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
          {state.messages.map((m) => (
            <div key={m.id} className={`message message--${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && (
            <div className="message message--assistant message--pending">
              Researching and writing your lecture… {progress > 0 ? `${Math.round(progress)}%` : ''}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <ErrorBanner message={error} onDismiss={() => setError('')} />

        <form className="composer" onSubmit={onSubmit}>
          <input
            className="composer__input"
            type="text"
            placeholder="What would you like to learn?"
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
            Send
          </button>
        </form>
      </section>

      {state.audioUrl && (
        <section className="conversation__audio" aria-label="Lecture audio">
          <AudioPlayer
            src={state.audioUrl}
            drivingMode={state.drivingMode}
            title={state.currentLecture?.title}
          />
        </section>
      )}
    </div>
  );
}
