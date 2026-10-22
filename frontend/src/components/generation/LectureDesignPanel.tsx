import { useEffect, useState } from 'react';
import type { LectureDesign } from '../../types';

interface Props {
  design: LectureDesign;
  disabled?: boolean;
  onAnswer: (answer: string) => void;
  onGenerate: () => void;
  onRefine: () => void;
}

export function LectureDesignPanel({ design, disabled, onAnswer, onGenerate, onRefine }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => setSelected(new Set()), [design.turn, design.question?.id]);

  const question = design.question;
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
    const rows = [
      ['Goal', brief.learningObjective || brief.topic],
      ['Level', brief.knowledgeLevel],
      ['Length', `${brief.durationMinutes} minutes`],
      ['Depth', brief.depth],
      ['Style', brief.learningStyle],
      ['Tone', brief.tone],
      ['Include', brief.includeTopics.join(', ') || 'AI-selected essentials'],
      ['Exclude', brief.excludeTopics.join(', ') || 'Nothing specified'],
      ['Example', brief.exampleContext || 'AI-selected'],
      ['Ending', brief.reinforcement],
    ];
    return (
      <section className="design-card" aria-label="Lecture brief">
        <div className="design-card__heading">
          <span className="design-card__eyebrow">Ready for confirmation</span>
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
        <div className="design-card__actions">
          <button className="btn btn--primary" disabled={disabled} onClick={onGenerate}>
            Generate lecture
          </button>
          {design.turn < 3 && (
            <button className="btn" disabled={disabled} onClick={onRefine}>
              Continue refining
            </button>
          )}
        </div>
        <p className="design-card__hint">You can also type any change below.</p>
      </section>
    );
  }

  if (!question) return null;
  return (
    <section className="design-card" aria-label="Lecture design question">
      <h3>{question.prompt}</h3>
      <div className="design-choices" role={question.selection === 'single' ? 'radiogroup' : 'group'}>
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
          Use selected topics
        </button>
      )}
      {question.allowCustomAnswer && (
        <p className="design-card__hint">Or type a different answer in the chat box.</p>
      )}
    </section>
  );
}
