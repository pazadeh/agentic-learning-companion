import { useState } from 'react';
import type { GenerationStage, Job } from '../../types';
import { Icon } from '../common/Icon';

interface GenerationProgressProps {
  job: Job | null;
}

const STEPS: Array<{ key: string; label: string; stages: GenerationStage[] }> = [
  {
    key: 'prepare',
    label: 'Personalize',
    stages: ['queued', 'preparing', 'personalizing', 'validating', 'recalling', 'profiling'],
  },
  { key: 'research', label: 'Research', stages: ['researching'] },
  { key: 'write', label: 'Write', stages: ['writing', 'planning'] },
  { key: 'audio', label: 'Create audio', stages: ['synthesizing', 'uploading'] },
  { key: 'save', label: 'Save', stages: ['saving', 'finalizing', 'completed'] },
];

function stepIndex(stage: GenerationStage): number {
  const index = STEPS.findIndex((step) => step.stages.includes(stage));
  return index < 0 ? 0 : index;
}

function canNotify(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'default';
}

/** The full five-stage pipeline, shown only for real lecture generation. */
export function GenerationProgress({ job }: GenerationProgressProps) {
  const [notifyOffered, setNotifyOffered] = useState(canNotify);
  const stage = job?.stage ?? (job?.status === 'processing' ? 'preparing' : 'queued');
  const activeIndex = stepIndex(stage);
  const progress = Math.max(0, Math.min(100, Math.round(job?.progress ?? 0)));
  const message = job?.stage_message ?? 'Preparing your lecture';
  const detail = job?.stage_detail ?? 'Your request is queued securely.';
  const activeLabel = STEPS[activeIndex]?.label ?? 'Personalize';

  return (
    <section className="generation-progress" aria-label="Lecture generation progress">
      {/* Only stage transitions are announced, not every percentage update. */}
      <span className="visually-hidden" aria-live="polite">
        {`Step ${activeIndex + 1} of ${STEPS.length}: ${activeLabel}`}
      </span>
      <div className="generation-progress__heading">
        <span className="generation-progress__pulse" aria-hidden="true" />
        <div>
          <strong>{message}</strong>
          {detail && <span>{detail}</span>}
        </div>
        <b aria-hidden="true">{progress}%</b>
      </div>

      <div
        className="generation-progress__bar"
        role="progressbar"
        aria-label="Lecture generation"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      <ol className="generation-progress__steps">
        {STEPS.map((step, index) => {
          const state = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending';
          return (
            <li key={step.key} className={`is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
              <span aria-hidden="true">{state === 'complete' ? <Icon name="check" size={14} /> : index + 1}</span>
              <small>{step.label}</small>
            </li>
          );
        })}
      </ol>

      <div className="generation-progress__footer">
        <p>This usually takes a few minutes. You can leave this screen; we’ll keep working and let you know when it’s ready.</p>
        {notifyOffered && (
          <button
            type="button"
            className="btn btn--small btn--ghost"
            onClick={() => {
              void Notification.requestPermission().finally(() => setNotifyOffered(false));
            }}
          >
            <Icon name="bell" size={16} /> Notify me
          </button>
        )}
      </div>
    </section>
  );
}

/** Lightweight state for a guided-design turn: nothing is generated yet. */
export function DesignProgress({ turn }: { turn: number }) {
  return (
    <section className="design-progress" aria-label="Updating lecture brief" role="status">
      <span className="spinner spinner--small" aria-hidden="true" />
      <div>
        <strong>Updating your lecture brief…</strong>
        <span>
          Step {Math.min(3, Math.max(1, turn))} of up to 3 · Nothing is generated until you confirm.
        </span>
      </div>
    </section>
  );
}
