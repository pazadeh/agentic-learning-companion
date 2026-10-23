import { useState, type FormEvent } from 'react';
import type { LectureDesignBrief } from '../../types';
import {
  DEPTH_LABELS,
  FRESHNESS_LABELS,
  LEVEL_LABELS,
  REINFORCEMENT_LABELS,
  STYLE_LABELS,
  parseTopicList,
  validateBrief,
} from '../../utils/briefLabels';

interface BriefEditorProps {
  brief: LectureDesignBrief;
  onSave: (brief: LectureDesignBrief) => void;
  onCancel: () => void;
}

function options<T extends string>(labels: Record<T, string>) {
  return (Object.keys(labels) as T[]).map((value) => (
    <option key={value} value={value}>
      {labels[value]}
    </option>
  ));
}

/** Direct editing of every generation-affecting field, validated like the API. */
export function BriefEditor({ brief, onSave, onCancel }: BriefEditorProps) {
  const [draft, setDraft] = useState<LectureDesignBrief>(brief);
  const [include, setInclude] = useState(brief.includeTopics.join(', '));
  const [exclude, setExclude] = useState(brief.excludeTopics.join(', '));
  const [submitted, setSubmitted] = useState(false);

  const candidate: LectureDesignBrief = {
    ...draft,
    includeTopics: parseTopicList(include),
    excludeTopics: parseTopicList(exclude),
  };
  const errors = validateBrief(candidate);

  const set = <K extends keyof LectureDesignBrief>(key: K, value: LectureDesignBrief[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (errors.length === 0) onSave(candidate);
  };

  return (
    <form className="brief-editor" onSubmit={submit} aria-label="Edit lecture brief" noValidate>
      <label className="field">
        <span>Title</span>
        <input type="text" value={draft.title} maxLength={200} onChange={(event) => set('title', event.target.value)} />
      </label>
      <label className="field">
        <span>Topic</span>
        <input type="text" value={draft.topic} maxLength={500} onChange={(event) => set('topic', event.target.value)} />
      </label>
      <label className="field">
        <span>Goal</span>
        <textarea
          value={draft.learningObjective}
          maxLength={1000}
          rows={2}
          onChange={(event) => set('learningObjective', event.target.value)}
        />
      </label>
      <div className="brief-editor__grid">
        <label className="field">
          <span>Length (minutes)</span>
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={draft.durationMinutes}
            onChange={(event) => set('durationMinutes', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Level</span>
          <select value={draft.knowledgeLevel} onChange={(event) => set('knowledgeLevel', event.target.value as LectureDesignBrief['knowledgeLevel'])}>
            {options(LEVEL_LABELS)}
          </select>
        </label>
        <label className="field">
          <span>Depth</span>
          <select value={draft.depth} onChange={(event) => set('depth', event.target.value as LectureDesignBrief['depth'])}>
            {options(DEPTH_LABELS)}
          </select>
        </label>
        <label className="field">
          <span>Style</span>
          <select value={draft.learningStyle} onChange={(event) => set('learningStyle', event.target.value as LectureDesignBrief['learningStyle'])}>
            {options(STYLE_LABELS)}
          </select>
        </label>
        <label className="field">
          <span>Tone</span>
          <input type="text" value={draft.tone} maxLength={100} onChange={(event) => set('tone', event.target.value)} />
        </label>
        <label className="field">
          <span>Language</span>
          <input type="text" value={draft.language} maxLength={100} onChange={(event) => set('language', event.target.value)} />
        </label>
        <label className="field">
          <span>Ending</span>
          <select value={draft.reinforcement} onChange={(event) => set('reinforcement', event.target.value as LectureDesignBrief['reinforcement'])}>
            {options(REINFORCEMENT_LABELS)}
          </select>
        </label>
        <label className="field">
          <span>Sources</span>
          <select value={draft.sourceFreshness} onChange={(event) => set('sourceFreshness', event.target.value as LectureDesignBrief['sourceFreshness'])}>
            {options(FRESHNESS_LABELS)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Include (comma-separated)</span>
        <input type="text" value={include} onChange={(event) => setInclude(event.target.value)} />
      </label>
      <label className="field">
        <span>Exclude (comma-separated)</span>
        <input type="text" value={exclude} onChange={(event) => setExclude(event.target.value)} />
      </label>
      <label className="field">
        <span>Example context</span>
        <input
          type="text"
          value={draft.exampleContext}
          maxLength={500}
          onChange={(event) => set('exampleContext', event.target.value)}
          placeholder="e.g. a small online shop"
        />
      </label>
      {submitted && errors.length > 0 && (
        <ul className="form-errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="brief-editor__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary">
          Save changes
        </button>
      </div>
    </form>
  );
}
