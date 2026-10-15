import type { GenerationStage, Job } from '../../types';

interface GenerationProgressProps {
  job: Job | null;
}

const STEPS: Array<{
  key: string;
  label: string;
  stages: GenerationStage[];
}> = [
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

export function GenerationProgress({ job }: GenerationProgressProps) {
  const stage = job?.stage ?? (job?.status === 'processing' ? 'preparing' : 'queued');
  const activeIndex = stepIndex(stage);
  const progress = Math.max(0, Math.min(100, Math.round(job?.progress ?? 0)));
  const message = job?.stage_message ?? 'Preparing your lecture';
  const detail = job?.stage_detail ?? 'Your request is queued securely.';

  return (
    <div className="generation-progress" aria-live="polite" aria-label="Lecture generation progress">
      <div className="generation-progress__heading">
        <span className="generation-progress__pulse" aria-hidden="true" />
        <div>
          <strong>{message}</strong>
          {detail && <span>{detail}</span>}
        </div>
        <b>{progress}%</b>
      </div>

      <div
        className="generation-progress__bar"
        role="progressbar"
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
            <li key={step.key} className={`is-${state}`}>
              <span aria-hidden="true">{state === 'complete' ? '✓' : index + 1}</span>
              <small>{step.label}</small>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
