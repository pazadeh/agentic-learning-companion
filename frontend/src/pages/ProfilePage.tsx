import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ErrorBanner } from '../components/common/ErrorBanner';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { useAuth } from '../contexts/AuthContext';
import {
  ApiError,
  getProfile,
  resetProfileInferences,
  saveProfile,
} from '../services/api-client';
import { getItem, setItem, STORAGE_KEYS } from '../utils/storage';
import { formatDuration } from '../utils/format';
import type { InferredProfile, UserProfile } from '../types';

const DEFAULT_PROFILE: UserProfile = {
  email: '',
  profession: '',
  expertiseAreas: [],
  learningGoals: [],
  learningStyle: 'examples',
  preferredDuration: 15,
  behavioralPersonalizationEnabled: true,
  lecturesCompleted: 0,
  totalListeningTime: 0,
};

export function ProfilePage() {
  const { user, logout } = useAuth();
  const profileStorageKey = `${STORAGE_KEYS.profile}.${user?.sub ?? 'anonymous'}`;
  const [profile, setProfile] = useState<UserProfile>(() => ({
    ...DEFAULT_PROFILE,
    ...getItem<Partial<UserProfile>>(profileStorageKey, {}),
    email: user?.email ?? '',
  }));
  const [inferred, setInferred] = useState<InferredProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const [cloudReady, setCloudReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getProfile()
      .then((response) => {
        if (cancelled) return;
        const next: UserProfile = {
          ...DEFAULT_PROFILE,
          ...response.explicit,
          email: user?.email ?? '',
          lecturesCompleted: response.stats.lecturesCompleted,
          totalListeningTime: response.stats.totalListeningSeconds,
        };
        setProfile(next);
        setInferred(response.inferred);
        setRevision(response.revision);
        setCloudReady(true);
        setItem(profileStorageKey, next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? `${err.message} Saving is disabled until the cloud profile reloads.`
              : 'Could not load your cloud profile. Saving is disabled until it reloads.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileStorageKey, user?.email]);

  const update = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
    setProfile((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!cloudReady) return;
    setSaving(true);
    setError('');
    try {
      const { email: _email, lecturesCompleted: _completed, totalListeningTime: _time, ...explicit } = profile;
      const response = await saveProfile(explicit, revision);
      const next = {
        ...profile,
        ...response.explicit,
        lecturesCompleted: response.stats.lecturesCompleted,
        totalListeningTime: response.stats.totalListeningSeconds,
      };
      setProfile(next);
      setInferred(response.inferred);
      setRevision(response.revision);
      setItem(profileStorageKey, next);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setCloudReady(false);
      setError(err instanceof ApiError ? err.message : 'Could not save your profile.');
    } finally {
      setSaving(false);
    }
  };

  const resetLearnedPreferences = async () => {
    setResetting(true);
    setError('');
    try {
      await resetProfileInferences();
      const response = await getProfile();
      setInferred(response.inferred);
      setRevision(response.revision);
      setProfile((previous) => ({
        ...previous,
        lecturesCompleted: response.stats.lecturesCompleted,
        totalListeningTime: response.stats.totalListeningSeconds,
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset learned preferences.');
    } finally {
      setResetting(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading your profile…" />;

  return (
    <form className="profile" onSubmit={(event) => void onSave(event)}>
      <ErrorBanner message={error} onDismiss={() => setError('')} />

      <section className="profile__section" aria-labelledby="declared-profile-title">
        <div className="profile__section-heading">
          <div>
            <h2 id="declared-profile-title">Your settings</h2>
            <p>Settings you choose always take priority over learned preferences.</p>
          </div>
        </div>

        <label className="field">
          <span>Profession</span>
          <input
            type="text"
            maxLength={200}
            value={profile.profession}
            onChange={(event) => update('profession', event.target.value)}
            placeholder="e.g. Software engineer"
          />
        </label>

        <TagInput
          label="Expertise areas"
          values={profile.expertiseAreas}
          onChange={(value) => update('expertiseAreas', value)}
        />
        <TagInput
          label="Learning goals"
          values={profile.learningGoals}
          maxLength={500}
          onChange={(value) => update('learningGoals', value)}
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
            onChange={(event) => update('preferredDuration', Number(event.target.value))}
          />
        </label>

        <label className="profile__privacy-toggle">
          <input
            type="checkbox"
            checked={profile.behavioralPersonalizationEnabled}
            onChange={(event) =>
              update('behavioralPersonalizationEnabled', event.target.checked)
            }
          />
          <span>
            <strong>Learn from my listening activity</strong>
            <small>
              Use completed lectures, duration, playback speed, and requested topics to personalize future lectures.
            </small>
          </span>
        </label>
      </section>

      <section className="profile__section" aria-labelledby="learned-profile-title">
        <div className="profile__section-heading">
          <div>
            <h2 id="learned-profile-title">Learned preferences</h2>
            <p>These are behavioral estimates. They never override your settings above.</p>
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void resetLearnedPreferences()}
            disabled={resetting || !profile.behavioralPersonalizationEnabled}
          >
            {resetting ? 'Resetting…' : 'Reset learned preferences'}
          </button>
        </div>

        {!profile.behavioralPersonalizationEnabled ? (
          <p className="profile__learned-empty">Behavioral personalization is disabled.</p>
        ) : !inferred || inferred.topicInterests.length === 0 ? (
          <p className="profile__learned-empty">
            Listen to a few lectures and your learned preferences will appear here.
          </p>
        ) : (
          <div className="profile__learned-grid">
            <LearnedValue
              label="Preferred session"
              value={inferred.preferredDuration ? `${inferred.preferredDuration.value} minutes` : 'Learning'}
              confidence={inferred.preferredDuration?.confidencePercent}
            />
            <LearnedValue
              label="Playback pace"
              value={inferred.preferredPlaybackRate ? `${inferred.preferredPlaybackRate.value}×` : 'Learning'}
              confidence={inferred.preferredPlaybackRate?.confidencePercent}
            />
            <LearnedValue
              label="Explanation style"
              value={inferred.learningStyle?.value ?? 'Learning'}
              confidence={inferred.learningStyle?.confidencePercent}
            />
            <div className="profile__learned-item profile__learned-item--wide">
              <span>Current interests</span>
              <div className="tags">
                {inferred.topicInterests.slice(0, 5).map((interest) => (
                  <span className="tag tag--static" key={interest.topic}>
                    {interest.topic} · {interest.confidencePercent}%
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

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
        <button type="submit" className="btn btn--primary" disabled={saving || !cloudReady}>
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save profile'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={logout}>
          Sign out
        </button>
      </div>
    </form>
  );
}

function LearnedValue({
  label,
  value,
  confidence,
}: {
  label: string;
  value: string;
  confidence?: number;
}) {
  return (
    <div className="profile__learned-item">
      <span>{label}</span>
      <strong>{value}</strong>
      {confidence !== undefined && <small>{confidence}% confidence</small>}
    </div>
  );
}

function TagInput({
  label,
  values,
  maxLength = 100,
  onChange,
}: {
  label: string;
  values: string[];
  maxLength?: number;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const tag = draft.trim().slice(0, maxLength);
    if (tag && values.length < 20 && !values.some((value) => value.toLowerCase() === tag.toLowerCase())) {
      onChange([...values, tag]);
    }
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
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
            onClick={() => onChange(values.filter((value) => value !== tag))}
            aria-label={`Remove ${tag}`}
          >
            {tag} ×
          </button>
        ))}
      </div>
      <input
        type="text"
        maxLength={maxLength}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        placeholder="Type and press Enter"
      />
    </div>
  );
}
