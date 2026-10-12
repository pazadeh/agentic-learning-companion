import type { SeriesPlan, SeriesPlanEpisode } from '../../types';

interface SeriesPlanEditorProps {
  plan: SeriesPlan;
  revision: number;
  isDirty: boolean;
  isSaving?: boolean;
  isApproving?: boolean;
  onChange: (plan: SeriesPlan) => void;
  onSave: (plan: SeriesPlan, revision: number) => void;
  onApprove: (revision: number) => void;
}

const MIN_EPISODES = 2;
const MAX_EPISODES = 8;
const MIN_DURATION = 1;
const MAX_DURATION = 30;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_DESCRIPTION_LENGTH = 2000;
const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function resequence(episodes: SeriesPlanEpisode[]): SeriesPlanEpisode[] {
  return episodes.map((episode, index) => ({ ...episode, order: index + 1 }));
}

function validatePlan(plan: SeriesPlan): string[] {
  const errors: string[] = [];
  const title = plan.title.trim();
  if (!title) errors.push('Add a series title.');
  if (title.length > MAX_TITLE_LENGTH) {
    errors.push(`Series title must be at most ${MAX_TITLE_LENGTH} characters.`);
  }
  if (FORBIDDEN_CONTROL_CHARACTERS.test(plan.title)) {
    errors.push('Series title contains unsupported control characters.');
  }
  if (plan.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  if (FORBIDDEN_CONTROL_CHARACTERS.test(plan.description)) {
    errors.push('Description contains unsupported control characters.');
  }
  if (plan.episodes.length < MIN_EPISODES || plan.episodes.length > MAX_EPISODES) {
    errors.push(`A series needs ${MIN_EPISODES}–${MAX_EPISODES} episodes.`);
  }
  plan.episodes.forEach((episode, index) => {
    const episodeTitle = episode.title.trim();
    if (!episodeTitle) errors.push(`Episode ${index + 1} needs a title.`);
    if (episodeTitle.length > MAX_TITLE_LENGTH) {
      errors.push(`Episode ${index + 1} title must be at most ${MAX_TITLE_LENGTH} characters.`);
    }
    if (FORBIDDEN_CONTROL_CHARACTERS.test(episode.title)) {
      errors.push(`Episode ${index + 1} title contains unsupported control characters.`);
    }
    if (episode.summary.length > MAX_SUMMARY_LENGTH) {
      errors.push(`Episode ${index + 1} summary must be at most ${MAX_SUMMARY_LENGTH} characters.`);
    }
    if (FORBIDDEN_CONTROL_CHARACTERS.test(episode.summary)) {
      errors.push(`Episode ${index + 1} summary contains unsupported control characters.`);
    }
    if (
      !Number.isInteger(episode.durationMinutes) ||
      episode.durationMinutes < MIN_DURATION ||
      episode.durationMinutes > MAX_DURATION
    ) {
      errors.push(`Episode ${index + 1} duration must be a whole number from 1–30 minutes.`);
    }
  });
  return errors;
}

export function SeriesPlanEditor({
  plan,
  revision,
  isDirty,
  isSaving = false,
  isApproving = false,
  onChange,
  onSave,
  onApprove,
}: SeriesPlanEditorProps) {
  const errors = validatePlan(plan);
  const isValid = errors.length === 0;
  const isBusy = isSaving || isApproving;

  const updateEpisode = (index: number, update: Partial<SeriesPlanEpisode>) => {
    onChange({
      ...plan,
      episodes: plan.episodes.map((episode, episodeIndex) =>
        episodeIndex === index ? { ...episode, ...update } : episode
      ),
    });
  };

  const addEpisode = () => {
    if (plan.episodes.length >= MAX_EPISODES) return;
    onChange({
      ...plan,
      episodes: resequence([
        ...plan.episodes,
        {
          title: `Episode ${plan.episodes.length + 1}`,
          summary: '',
          order: plan.episodes.length + 1,
          durationMinutes: 10,
        },
      ]),
    });
  };

  const removeEpisode = (index: number) => {
    if (plan.episodes.length <= MIN_EPISODES) return;
    onChange({
      ...plan,
      episodes: resequence(plan.episodes.filter((_, episodeIndex) => episodeIndex !== index)),
    });
  };

  const moveEpisode = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= plan.episodes.length) return;
    const next = [...plan.episodes];
    const current = next[index];
    const target = next[destination];
    if (!current || !target) return;
    next[index] = target;
    next[destination] = current;
    onChange({ ...plan, episodes: resequence(next) });
  };

  return (
    <section className="series-plan" aria-labelledby="series-plan-title">
      <div className="series-plan__heading">
        <div>
          <h2 id="series-plan-title">Lecture plan</h2>
          <span className="series-plan__revision">Revision {revision}</span>
        </div>
        <span className={`series-plan__save-state ${isDirty ? 'is-dirty' : ''}`}>
          {isDirty ? 'Unsaved changes' : 'Saved'}
        </span>
      </div>

      <label className="field">
        <span>Series title</span>
        <input
          type="text"
          value={plan.title}
          maxLength={MAX_TITLE_LENGTH}
          onChange={(event) => onChange({ ...plan, title: event.target.value })}
          disabled={isBusy}
        />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea
          value={plan.description}
          maxLength={MAX_DESCRIPTION_LENGTH}
          onChange={(event) => onChange({ ...plan, description: event.target.value })}
          rows={3}
          disabled={isBusy}
        />
      </label>

      <ol className="series-plan__episodes">
        {plan.episodes.map((episode, index) => (
          <li key={episode.episodeId ?? `${index}-${episode.order}`} className="plan-episode">
            <div className="plan-episode__heading">
              <strong>Episode {index + 1}</strong>
              <div className="plan-episode__order" aria-label={`Reorder episode ${index + 1}`}>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => moveEpisode(index, -1)}
                  disabled={isBusy || index === 0}
                  aria-label={`Move episode ${index + 1} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => moveEpisode(index, 1)}
                  disabled={isBusy || index === plan.episodes.length - 1}
                  aria-label={`Move episode ${index + 1} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  onClick={() => removeEpisode(index)}
                  disabled={isBusy || plan.episodes.length <= MIN_EPISODES}
                  aria-label={`Remove episode ${index + 1}`}
                >
                  ×
                </button>
              </div>
            </div>
            <label className="field">
              <span>Title</span>
              <input
                type="text"
                value={episode.title}
                maxLength={MAX_TITLE_LENGTH}
                onChange={(event) => updateEpisode(index, { title: event.target.value })}
                disabled={isBusy}
              />
            </label>
            <label className="field">
              <span>What this episode covers</span>
              <textarea
                value={episode.summary}
                maxLength={MAX_SUMMARY_LENGTH}
                onChange={(event) => updateEpisode(index, { summary: event.target.value })}
                rows={2}
                disabled={isBusy}
              />
            </label>
            <label className="field plan-episode__duration">
              <span>Duration (minutes)</span>
              <input
                type="number"
                min={MIN_DURATION}
                max={MAX_DURATION}
                step={1}
                value={episode.durationMinutes}
                onChange={(event) =>
                  updateEpisode(index, { durationMinutes: Number(event.target.value) })
                }
                disabled={isBusy}
              />
            </label>
          </li>
        ))}
      </ol>

      <button
        type="button"
        className="btn btn--ghost series-plan__add"
        onClick={addEpisode}
        disabled={isBusy || plan.episodes.length >= MAX_EPISODES}
      >
        + Add episode
      </button>

      {errors.length > 0 && (
        <ul className="series-plan__errors" aria-label="Plan issues">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      <div className="series-plan__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => onSave({ ...plan, episodes: resequence(plan.episodes) }, revision)}
          disabled={isBusy || !isDirty || !isValid}
        >
          {isSaving ? 'Saving…' : 'Save plan'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => onApprove(revision)}
          disabled={isBusy || isDirty || !isValid}
          title={isDirty ? 'Save your changes before approving.' : undefined}
        >
          {isApproving ? 'Approving…' : 'Approve and generate'}
        </button>
      </div>
    </section>
  );
}
