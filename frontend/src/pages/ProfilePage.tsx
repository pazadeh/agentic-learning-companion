import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getItem, setItem, STORAGE_KEYS } from '../utils/storage';
import { formatDuration } from '../utils/format';
import type { UserProfile } from '../types';

const DEFAULT_PROFILE: UserProfile = {
  email: '',
  profession: '',
  expertiseAreas: [],
  learningGoals: [],
  learningStyle: 'examples',
  preferredDuration: 15,
  lecturesCompleted: 0,
  totalListeningTime: 0,
};

export function ProfilePage() {
  const { user, logout } = useAuth();
  const [profile, setProfile] = useState<UserProfile>(() => ({
    ...DEFAULT_PROFILE,
    ...getItem<Partial<UserProfile>>(STORAGE_KEYS.profile, {}),
    email: user?.email ?? '',
  }));
  const [saved, setSaved] = useState(false);

  const update = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    setItem(STORAGE_KEYS.profile, profile);
    setSaved(true);
  };

  return (
    <form className="profile" onSubmit={onSave}>
      <label className="field">
        <span>Profession</span>
        <input
          type="text"
          value={profile.profession}
          onChange={(e) => update('profession', e.target.value)}
          placeholder="e.g. Software engineer"
        />
      </label>

      <TagInput
        label="Expertise areas"
        values={profile.expertiseAreas}
        onChange={(v) => update('expertiseAreas', v)}
      />
      <TagInput
        label="Learning goals"
        values={profile.learningGoals}
        onChange={(v) => update('learningGoals', v)}
      />

      <fieldset className="field">
        <legend>Learning style</legend>
        {(['examples', 'theory', 'practical'] as const).map((style) => (
          <label key={style} className="radio">
            <input
              type="radio"
              name="learningStyle"
              value={style}
              checked={profile.learningStyle === style}
              onChange={() => update('learningStyle', style)}
            />
            {style.charAt(0).toUpperCase() + style.slice(1)}
          </label>
        ))}
      </fieldset>

      <label className="field">
        <span>Preferred duration: {profile.preferredDuration} min</span>
        <input
          type="range"
          min={5}
          max={60}
          step={5}
          value={profile.preferredDuration}
          onChange={(e) => update('preferredDuration', Number(e.target.value))}
        />
      </label>

      <div className="profile__stats">
        <div>
          <strong>{profile.lecturesCompleted}</strong>
          <span>Lectures completed</span>
        </div>
        <div>
          <strong>{formatDuration(profile.totalListeningTime)}</strong>
          <span>Total listening</span>
        </div>
      </div>

      <div className="profile__actions">
        <button type="submit" className="btn btn--primary">
          {saved ? 'Saved ✓' : 'Save profile'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={logout}>
          Sign out
        </button>
      </div>
    </form>
  );
}

function TagInput({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const tag = draft.trim();
    if (tag && !values.includes(tag)) onChange([...values, tag]);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    }
  };

  return (
    <div className="field">
      <span>{label}</span>
      <div className="tags">
        {values.map((tag) => (
          <button
            key={tag}
            type="button"
            className="tag"
            onClick={() => onChange(values.filter((t) => t !== tag))}
            aria-label={`Remove ${tag}`}
          >
            {tag} ×
          </button>
        ))}
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        placeholder="Type and press Enter"
      />
    </div>
  );
}
