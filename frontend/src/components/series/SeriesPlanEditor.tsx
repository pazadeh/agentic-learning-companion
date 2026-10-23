import { useState } from 'react';
import type { SeriesPlan, SeriesPlanEpisode } from '../../types';
import { formatMinutes, truncate } from '../../utils/format';
import { Icon } from '../common/Icon';

interface SeriesPlanEditorProps {
  plan: SeriesPlan;
  isDirty: boolean;
  isSaving?: boolean;
  isApproving?: boolean;
  onChange: (plan: SeriesPlan) => void;
  onSave: (plan: SeriesPlan) => void;
  /** Saves pending edits first when needed, then starts generation. */
  onGenerate: (plan: SeriesPlan) => void;
}

const MIN_EPISODES = 2;
const MAX_EPISODES = 8;
const MIN_DURATION = 1;
const MAX_DURATION = 30;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_DESCRIPTION_LENGTH = 2000;
const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function resequence(episodes: SeriesPlanEpisode[]): SeriesPlanEpisode[] {
  return episodes.map((episode, index) => ({ ...episode, order: index + 1 }));
}

export function validatePlan(plan: SeriesPlan): string[] {
  const errors: string[] = [];
  const title = plan.title.trim();
  if (!title) errors.push('Add a series title.');
  if (title.length > MAX_TITLE_LENGTH) errors.push(`Series title must be at most ${MAX_TITLE_LENGTH} characters.`);
  if (FORBIDDEN_CONTROL_CHARACTERS.test(plan.title)) errors.push('Series title contains unsupported control characters.');
  if (plan.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  if (FORBIDDEN_CONTROL_CHARACTERS.test(plan.description)) errors.push('Description contains unsupported control characters.');
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
  isDirty,
  isSaving = false,
  isApproving = false,
  onChange,
  onSave,
  onGenerate,
}: SeriesPlanEditorProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const errors = validatePlan(plan);
  const isValid = errors.length === 0;
  const isBusy = isSaving || isApproving;
  const totalMinutes = plan.episodes.reduce((sum, episode) => sum + (Number(episode.durationMinutes) || 0), 0);

  const updateEpisode = (index: number, update: Partial<SeriesPlanEpisode>) => {
    onChange({
      ...plan,
      episodes: plan.episodes.map((episode, episodeIndex) => (episodeIndex === index ? { ...episode, ...update } : episode)),
    });
  };

  const addEpisode = () => {
    if (plan.episodes.length >= MAX_EPISODES) return;
    onChange({
      ...plan,
      episodes: resequence([
        ...plan.episodes,
        { title: `Episode ${plan.episodes.length + 1}`, summary: '', order: plan.episodes.length + 1, durationMinutes: 10 },
      ]),
    });
    setOpenIndex(plan.episodes.length);
  };

  const removeEpisode = (index: number) => {
    if (plan.episodes.length <= MIN_EPISODES) return;
    onChange({ ...plan, episodes: resequence(plan.episodes.filter((_, episodeIndex) => episodeIndex !== index)) });
    setOpenIndex(null);
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
    if (openIndex === index) setOpenIndex(destination);
  };

  const finalPlan = () => ({ ...plan, episodes: resequence(plan.episodes) });

  return (
    <section className="series-plan" aria-labelledby="series-plan-title">
      <div className="series-plan__heading">
        <div>
          <h3 id="series-plan-title">Review the plan</h3>
          <p className="series-plan__summary">
            {plan.episodes.length} episodes · {formatMinutes(totalMinutes)} total
          </p>
        </div>
        <span className={`save-state ${isDirty ? 'is-dirty' : ''}`} aria-live="polite">
          {isSaving ? 'Saving…' : isDirty ? 'Unsaved changes' : 'Draft saved'}
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
          rows={2}
          disabled={isBusy}
        />
      </label>

      <ol className="plan-episodes">
        {plan.episodes.map((episode, index) => {
          const isOpen = openIndex === index;
          const number = index + 1;
          return (
            <li key={episode.episodeId ?? `${index}-${episode.order}`} className={`plan-episode ${isOpen ? 'is-open' : ''}`}>
              <div className="plan-episode__row">
                <span className="plan-episode__number" aria-hidden="true">{number}</span>
                <button
                  type="button"
                  className="plan-episode__toggle"
                  onClick={() => setOpenIndex(isOpen ? null : index)}
                  aria-expanded={isOpen}
                  aria-controls={`plan-episode-${index}`}
                >
                  <strong>{episode.title || `Episode ${number}`}</strong>
                  <small>
                    {episode.durationMinutes} min{episode.summary ? ` · ${truncate(episode.summary, 90)}` : ''}
                  </small>
                </button>
                <div className="plan-episode__order">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => moveEpisode(index, -1)}
                    disabled={isBusy || index === 0}
                    aria-label={`Move episode ${number} up`}
                  >
                    <Icon name="arrowUp" size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => moveEpisode(index, 1)}
                    disabled={isBusy || index === plan.episodes.length - 1}
                    aria-label={`Move episode ${number} down`}
                  >
                    <Icon name="arrowDown" size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    onClick={() => removeEpisode(index)}
                    disabled={isBusy || plan.episodes.length <= MIN_EPISODES}
                    aria-label={`Remove episode ${number}`}
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
              </div>
              {isOpen && (
                <div className="plan-episode__editor" id={`plan-episode-${index}`}>
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
                      rows={3}
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
                      onChange={(event) => updateEpisode(index, { durationMinutes: Number(event.target.value) })}
                      disabled={isBusy}
                    />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        className="btn btn--ghost series-plan__add"
        onClick={addEpisode}
        disabled={isBusy || plan.episodes.length >= MAX_EPISODES}
      >
        <Icon name="plus" size={16} /> Add episode
      </button>

      {errors.length > 0 && (
        <ul className="form-errors" aria-label="Plan issues">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      <div className="series-plan__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => onSave(finalPlan())}
          disabled={isBusy || !isDirty || !isValid}
        >
          {isSaving ? 'Saving…' : 'Save draft'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => onGenerate(finalPlan())}
          disabled={isBusy || !isValid}
          aria-describedby="series-generate-hint"
        >
          {isApproving
            ? 'Starting…'
            : `${isDirty ? 'Save and generate' : 'Generate'} ${plan.episodes.length} episodes`}
        </button>
      </div>
      <p className="series-plan__hint" id="series-generate-hint">
        {isValid
          ? `Episodes are created one at a time (about ${formatMinutes(totalMinutes)} of audio). Each becomes playable as soon as it’s ready.`
          : 'Fix the issues above to continue.'}
      </p>
    </section>
  );
}
