import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { useCreate } from '../contexts/CreateContext';
import { useProfile } from '../contexts/ProfileContext';
import { DesignProgress, GenerationProgress } from '../components/generation/GenerationProgress';
import { LectureDesignPanel } from '../components/generation/LectureDesignPanel';
import { ErrorBanner } from '../components/common/ErrorBanner';
import { Icon, type IconName } from '../components/common/Icon';
import { SeriesSuggestionCard } from '../components/series/SeriesSuggestionCard';
import {
  createSpeechRecognition,
  isSpeechRecognitionSupported,
  type VoiceController,
} from '../services/voice-recognition';
import { PROFILE_STYLE_LABELS } from '../utils/briefLabels';
import type { CreateMode } from '../types';

const MODES: Array<{ mode: CreateMode; icon: IconName; title: string; description: string }> = [
  {
    mode: 'quick',
    icon: 'bolt',
    title: 'Quick lecture',
    description: 'Describe a topic and we generate it right away using your defaults.',
  },
  {
    mode: 'guided',
    icon: 'sparkle',
    title: 'Guided lecture',
    description: 'Answer up to three quick questions, review the brief, then generate.',
  },
  {
    mode: 'series',
    icon: 'layers',
    title: 'Plan a series',
    description: 'Get an editable 2–8 episode plan to approve before anything is created.',
  },
];

const STARTERS: Array<{ label: string; prompt: string }> = [
  { label: 'Understand a concept', prompt: 'Explain how mRNA vaccines work' },
  { label: 'Prepare for a meeting', prompt: 'Prepare me for a meeting about cloud cost optimization' },
  { label: 'Learn on a commute', prompt: 'A 10-minute lesson on the history of the printing press' },
  { label: 'Go deep on a field', prompt: 'Teach me the key ideas of behavioral economics' },
];

export function CreatePage() {
  const { state, navigate } = useAppState();
  const create = useCreate();
  const { profile } = useProfile();
  const {
    mode,
    input,
    messages,
    design,
    busy,
    creatingSeries,
    jobState,
    activeJob,
    error,
    seriesSuggestion,
  } = create;
  const [listening, setListening] = useState(false);
  const voiceRef = useRef<VoiceController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputValueRef = useRef(input);
  inputValueRef.current = input;
  const voiceSupported = isSpeechRecognitionSupported();

  const guidedDesign = mode === 'guided' ? design : null;
  const designFinal = Boolean(guidedDesign?.readyForConfirmation && guidedDesign.turn >= 3);
  const isEmpty = messages.length === 0 && !guidedDesign && !busy;
  const offline = !state.isOnline;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, Boolean(jobState), guidedDesign?.turn]);

  useEffect(() => () => voiceRef.current?.stop(), []);

  const focusInput = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void create.send(input);
  };

  const toggleVoice = () => {
    if (listening) {
      voiceRef.current?.stop();
      setListening(false);
      return;
    }
    const controller = createSpeechRecognition({
      onTranscript: (text, isFinal) => {
        if (!isFinal) return;
        inputValueRef.current = `${inputValueRef.current} ${text}`.trim();
        create.setInput(inputValueRef.current);
      },
      onEnd: () => setListening(false),
      onError: () => setListening(false),
    });
    if (!controller) return;
    voiceRef.current = controller;
    controller.start();
    setListening(true);
  };

  const explicit = profile?.explicit;
  const defaults = explicit
    ? `${explicit.preferredDuration} min · ${PROFILE_STYLE_LABELS[explicit.learningStyle] ?? 'Examples'}`
    : null;

  const placeholder =
    mode === 'series'
      ? 'What should the series cover? e.g. “Thinking, Fast and Slow in 4 parts”'
      : mode === 'guided'
        ? guidedDesign?.readyForConfirmation
          ? 'Describe a change, e.g. “make it shorter and more practical”'
          : guidedDesign
            ? 'Or type your own answer…'
            : 'What would you like to learn? We’ll shape it together.'
        : 'What do you want to understand?';

  const submitLabel =
    mode === 'series'
      ? 'Plan series'
      : mode === 'guided'
        ? guidedDesign?.readyForConfirmation
          ? 'Refine'
          : guidedDesign
            ? 'Send answer'
            : 'Start designing'
        : 'Generate lecture';

  const composerDisabled = busy || offline;

  return (
    <div className="page create">
      <div className="create__inner">
        <div className="page__heading">
          <div>
            <h2>{isEmpty ? 'What do you want to understand?' : 'Create'}</h2>
            <p>
              {isEmpty
                ? 'Turn any topic into a personalized audio lesson you can listen to anywhere.'
                : 'Your conversation and progress are saved, even if you leave this screen.'}
            </p>
          </div>
          {!isEmpty && (
            <button type="button" className="btn btn--ghost btn--small" onClick={create.clearConversation} disabled={busy}>
              <Icon name="plus" size={16} /> New
            </button>
          )}
        </div>

        <fieldset className="mode-cards" disabled={busy}>
          <legend className="visually-hidden">How should we create it?</legend>
          {MODES.map((option) => (
            <label key={option.mode} className={`mode-card ${mode === option.mode ? 'is-active' : ''}`}>
              <input
                type="radio"
                name="create-mode"
                value={option.mode}
                checked={mode === option.mode}
                onChange={() => {
                  create.setMode(option.mode);
                  focusInput();
                }}
              />
              <Icon name={option.icon} className="mode-card__icon" />
              <span className="mode-card__text">
                <strong>{option.title}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </fieldset>

        {messages.length > 0 && (
          <ol className="messages" aria-label="Conversation">
            {messages.map((message) => (
              <li key={message.id} className={`message message--${message.role}`}>
                <span className="visually-hidden">{message.role === 'user' ? 'You: ' : 'Companion: '}</span>
                {message.content}
              </li>
            ))}
          </ol>
        )}

        {activeJob?.kind === 'design' && <DesignProgress turn={(design?.turn ?? 0) + 1} />}
        {activeJob?.kind === 'lecture' && <GenerationProgress job={jobState} />}
        {creatingSeries && (
          <div className="design-progress" role="status">
            <span className="spinner spinner--small" aria-hidden="true" />
            <div>
              <strong>Creating your series draft…</strong>
              <span>You’ll review and edit the plan before anything is generated.</span>
            </div>
          </div>
        )}

        {guidedDesign && !(activeJob?.kind === 'design') && (
          <LectureDesignPanel
            design={guidedDesign}
            disabled={busy || offline}
            onAnswer={(answer) => void create.send(answer)}
            onGenerate={create.generateFromDesign}
            onRefine={focusInput}
            onUpdateBrief={create.updateBrief}
            onStartOver={() => {
              create.startOver();
              focusInput();
            }}
          />
        )}

        {design && mode !== 'guided' && !busy && (
          <button type="button" className="resume-design" onClick={() => create.setMode('guided')}>
            <Icon name="sparkle" size={16} /> Continue your guided lecture “{design.brief.title || design.brief.topic}”
          </button>
        )}

        {error && (
          <ErrorBanner
            message={error.message}
            detail={error.detail}
            actions={error.retry ? [{ label: 'Try again', onClick: () => { create.dismissError(); error.retry?.(); } }] : []}
            onDismiss={create.dismissError}
          />
        )}

        {seriesSuggestion && (
          <SeriesSuggestionCard
            topic={seriesSuggestion.topic}
            message={
              seriesSuggestion.kind === 'explicit'
                ? 'Plan this as a multi-part series you can review and edit before anything is generated.'
                : undefined
            }
            dismissLabel={seriesSuggestion.kind === 'explicit' ? 'One lecture instead' : 'Not now'}
            isCreating={creatingSeries}
            onCreate={() => void create.createSuggestedSeries()}
            onDismiss={create.dismissSuggestion}
          />
        )}

        {offline && (
          <p className="offline-note">
            You’re offline. Creating needs a connection; downloaded lectures still play from{' '}
            <button type="button" className="link" onClick={() => navigate({ page: 'library' })}>
              Library
            </button>
            .
          </p>
        )}

        {!designFinal && (
          <form className="composer" onSubmit={onSubmit}>
            <label className="visually-hidden" htmlFor="create-input">
              {placeholder}
            </label>
            <textarea
              id="create-input"
              ref={inputRef}
              className="composer__input"
              rows={2}
              placeholder={placeholder}
              value={input}
              onChange={(event) => create.setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (input.trim() && !composerDisabled) void create.send(input);
                }
              }}
              disabled={composerDisabled}
              maxLength={2000}
            />
            <div className="composer__bar">
              {voiceSupported && (
                <button
                  type="button"
                  className={`icon-btn composer__voice ${listening ? 'is-listening' : ''}`}
                  onClick={toggleVoice}
                  aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                  aria-pressed={listening}
                  disabled={composerDisabled}
                >
                  <Icon name={listening ? 'stop' : 'mic'} />
                </button>
              )}
              {mode === 'quick' && (
                <p className="composer__defaults">
                  {defaults ? <>Uses your defaults: <strong>{defaults}</strong>. </> : 'Uses your saved preferences. '}
                  Mention a length or style to override.{' '}
                  <button type="button" className="link" onClick={() => create.setMode('guided')} disabled={busy}>
                    Customize first
                  </button>
                  {' · '}
                  <button type="button" className="link" onClick={() => navigate({ page: 'you' })}>
                    Change defaults
                  </button>
                </p>
              )}
              <button className="btn btn--primary composer__send" type="submit" disabled={composerDisabled || !input.trim()}>
                {submitLabel}
              </button>
            </div>
          </form>
        )}

        {isEmpty && (
          <section className="starters" aria-labelledby="starters-title">
            <h3 id="starters-title">Need an idea?</h3>
            <div className="starters__list">
              {STARTERS.map((starter) => (
                <button
                  key={starter.prompt}
                  type="button"
                  className="starter"
                  onClick={() => {
                    create.setInput(starter.prompt);
                    focusInput();
                  }}
                >
                  <small>{starter.label}</small>
                  <span>{starter.prompt}</span>
                </button>
              ))}
            </div>
            <p className="starters__note">
              Lectures take a few minutes to research, write, and narrate. You can keep browsing while we work.
            </p>
          </section>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
