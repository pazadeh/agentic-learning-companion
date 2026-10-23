import { useEffect, useState } from 'react';
import type { LectureDesign, LectureDesignBrief } from '../../types';
import {
  DEPTH_LABELS,
  FRESHNESS_LABELS,
  LEVEL_LABELS,
  REINFORCEMENT_LABELS,
  STYLE_LABELS,
  capitalize,
  validateBrief,
} from '../../utils/briefLabels';
import { Icon } from '../common/Icon';
import { BriefEditor } from './BriefEditor';

interface Props {
  design: LectureDesign;
  disabled?: boolean;
  onAnswer: (answer: string) => void;
  onGenerate: () => void;
  /** Focus the composer for another AI refinement (only while turns remain). */
  onRefine: () => void;
  onUpdateBrief: (brief: LectureDesignBrief) => void;
  onStartOver: () => void;
}

const MAX_TURNS = 3;

function BriefPreview({ brief }: { brief: LectureDesignBrief }) {
  return (
    <p className="design-card__preview">
      <span className="visually-hidden">Brief so far: </span>
      {brief.durationMinutes} min · {LEVEL_LABELS[brief.knowledgeLevel]} · {STYLE_LABELS[brief.learningStyle]} ·{' '}
      {DEPTH_LABELS[brief.depth]}
    </p>
  );
}

export function LectureDesignPanel({
  design,
  disabled,
  onAnswer,
  onGenerate,
  onRefine,
  onUpdateBrief,
  onStartOver,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);

  useEffect(() => setSelected(new Set()), [design.turn, design.question?.id]);

  const question = design.question;
  const turnsLeft = Math.max(0, MAX_TURNS - design.turn);
  const stepLabel = `Step ${Math.min(design.turn, MAX_TURNS)} of up to ${MAX_TURNS}`;

  const choose = (id: string, value: string) => {
    if (question?.selection !== 'multiple') {
      onAnswer(value);
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (design.readyForConfirmation) {
    const brief = design.brief;
    const issues = validateBrief(brief);
    if (editing) {
      return (
        <section className="design-card" aria-label="Edit lecture brief">
          <div className="design-card__heading">
            <span className="design-card__eyebrow">Edit your brief</span>
            <h3>{brief.title || brief.topic}</h3>
          </div>
          <BriefEditor
            brief={brief}
            onCancel={() => setEditing(false)}
            onSave={(next) => {
              onUpdateBrief(next);
              setEditing(false);
            }}
          />
        </section>
      );
    }

    const rows: Array<[string, string]> = [
      ['Goal', brief.learningObjective || brief.topic],
      ['Level', LEVEL_LABELS[brief.knowledgeLevel]],
      ['Length', `${brief.durationMinutes} minutes`],
      ['Depth', DEPTH_LABELS[brief.depth]],
      ['Style', STYLE_LABELS[brief.learningStyle]],
      ['Tone', capitalize(brief.tone)],
      ['Include', brief.includeTopics.join(', ') || 'AI-selected essentials'],
      ['Exclude', brief.excludeTopics.join(', ') || 'Nothing specified'],
      ['Example', brief.exampleContext || 'AI-selected'],
      ['Ending', REINFORCEMENT_LABELS[brief.reinforcement]],
      ['Language', capitalize(brief.language)],
      ['Sources', FRESHNESS_LABELS[brief.sourceFreshness]],
    ];
    return (
      <section className="design-card design-card--confirm" aria-label="Lecture brief">
        <div className="design-card__heading">
          <span className="design-card__eyebrow">Review before generating</span>
          <h3>{brief.title || brief.topic}</h3>
        </div>
        <dl className="design-card__brief">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {issues.length > 0 && (
          <ul className="form-errors" role="alert">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        <div className="design-card__actions">
          <button type="button" className="btn btn--primary" disabled={disabled || issues.length > 0} onClick={onGenerate}>
            Generate {brief.durationMinutes}-minute lecture
          </button>
          <button type="button" className="btn btn--ghost" disabled={disabled} onClick={() => setEditing(true)}>
            <Icon name="edit" size={16} /> Edit brief
          </button>
          {turnsLeft > 0 && (
            <button type="button" className="btn btn--ghost" disabled={disabled} onClick={onRefine}>
              Refine with AI
            </button>
          )}
          <button type="button" className="btn btn--text" disabled={disabled} onClick={onStartOver}>
            Start over
          </button>
        </div>
        <p className="design-card__hint">
          {turnsLeft > 0
            ? `You can edit any field directly, or describe a change below (${turnsLeft} AI ${turnsLeft === 1 ? 'turn' : 'turns'} left).`
            : 'Edit any field directly before generating. Nothing is created until you confirm.'}
        </p>
      </section>
    );
  }

  if (!question) return null;
  return (
    <section className="design-card" aria-label="Lecture design question">
      <div className="design-card__step">
        <span className="design-card__eyebrow">{stepLabel}</span>
        <button type="button" className="btn btn--text" disabled={disabled} onClick={onStartOver}>
          Start over
        </button>
      </div>
      <h3>{question.prompt}</h3>
      <BriefPreview brief={design.brief} />
      <div
        className="design-choices"
        role="group"
        aria-label={question.selection === 'multiple' ? `${question.prompt} (choose any)` : question.prompt}
      >
        {question.choices.map((choice) => {
          const active = selected.has(choice.id);
          return (
            <button
              key={choice.id}
              type="button"
              className={`design-choice ${active ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={question.selection === 'multiple' ? active : undefined}
              onClick={() => choose(choice.id, choice.value)}
            >
              <span>
                {choice.label}
                {choice.recommended && <strong>Recommended</strong>}
              </span>
              {choice.description && <small>{choice.description}</small>}
            </button>
          );
        })}
      </div>
      {question.selection === 'multiple' && (
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled || selected.size === 0}
          onClick={() =>
            onAnswer(
              question.choices
                .filter((choice) => selected.has(choice.id))
                .map((choice) => choice.value)
                .join(', ')
            )
          }
        >
          {selected.size ? `Use ${selected.size} selected` : 'Use selected'}
        </button>
      )}
      {question.allowCustomAnswer && (
        <p className="design-card__hint">Something else? Type a different answer in the box below.</p>
      )}
    </section>
  );
}
