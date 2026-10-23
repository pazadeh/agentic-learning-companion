import { Icon } from '../common/Icon';

interface SeriesSuggestionCardProps {
  topic: string;
  /** Explanation shown under the heading. */
  message?: string;
  /** Label for the secondary action (e.g. "Not now" or "One lecture instead"). */
  dismissLabel?: string;
  isCreating?: boolean;
  onCreate: () => void;
  onDismiss: () => void;
}

/** Advisory, never automatic: the learner decides whether to plan a series. */
export function SeriesSuggestionCard({
  topic,
  message,
  dismissLabel = 'Not now',
  isCreating = false,
  onCreate,
  onDismiss,
}: SeriesSuggestionCardProps) {
  return (
    <aside className="series-suggestion" aria-label="Lecture series suggestion">
      <Icon name="layers" className="series-suggestion__icon" />
      <div>
        <strong>Want to go deeper?</strong>
        <p>{message ?? `Turn “${topic}” into an editable, multi-part lecture plan.`}</p>
      </div>
      <div className="series-suggestion__actions">
        <button type="button" className="btn btn--primary" onClick={onCreate} disabled={isCreating}>
          {isCreating ? 'Creating…' : 'Plan a series'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDismiss} disabled={isCreating}>
          {dismissLabel}
        </button>
      </div>
    </aside>
  );
}
