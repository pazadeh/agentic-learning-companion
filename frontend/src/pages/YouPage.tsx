import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { ErrorBanner, type ErrorAction } from '../components/common/ErrorBanner';
import { Icon } from '../components/common/Icon';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { useAppState } from '../contexts/AppStateContext';
import { useAuth } from '../contexts/AuthContext';
import { useCreate } from '../contexts/CreateContext';
import { useDownloads } from '../contexts/DownloadsContext';
import { usePlayer } from '../contexts/PlayerContext';
import { useProfile } from '../contexts/ProfileContext';
import { useToast } from '../contexts/ToastContext';
import {
  ApiError,
  listLectures,
  listSeries,
  resetProfileInferences,
  saveProfile,
} from '../services/api-client';
import { clearOfflineLectures } from '../services/offline-lectures';
import { PROFILE_STYLE_LABELS } from '../utils/briefLabels';
import { formatDuration } from '../utils/format';
import { removeItem, removeUserItems, userKey } from '../utils/storage';
import type { ProfileResponse, ThemePreference, UserProfile } from '../types';

type ExplicitProfile = Omit<UserProfile, 'email' | 'lecturesCompleted' | 'totalListeningTime'>;

const DEFAULTS: ExplicitProfile = {
  profession: '',
  expertiseAreas: [],
  learningGoals: [],
  learningStyle: 'examples',
  preferredDuration: 15,
  behavioralPersonalizationEnabled: true,
};

const STYLE_DESCRIPTIONS: Record<ExplicitProfile['learningStyle'], string> = {
  examples: 'Concrete examples and analogies first.',
  theory: 'Principles and the reasoning behind them.',
  practical: 'Steps, decisions, and how to apply it.',
};

function explicitFrom(profile: ProfileResponse | null): ExplicitProfile {
  const explicit = profile?.explicit;
  return {
    profession: explicit?.profession ?? DEFAULTS.profession,
    expertiseAreas: explicit?.expertiseAreas ?? DEFAULTS.expertiseAreas,
    learningGoals: explicit?.learningGoals ?? DEFAULTS.learningGoals,
    learningStyle: explicit?.learningStyle ?? DEFAULTS.learningStyle,
    preferredDuration: explicit?.preferredDuration ?? DEFAULTS.preferredDuration,
    behavioralPersonalizationEnabled:
      explicit?.behavioralPersonalizationEnabled ?? DEFAULTS.behavioralPersonalizationEnabled,
  };
}

type Pending = 'reset' | 'clear-device' | 'discard' | null;

export function YouPage() {
  const { user, logout } = useAuth();
  const { state, dispatch } = useAppState();
  const { profile, status, error: loadError, reload, setProfile } = useProfile();
  const player = usePlayer();
  const downloads = useDownloads();
  const create = useCreate();
  const { showToast } = useToast();
  const [form, setForm] = useState<ExplicitProfile>(() => explicitFrom(profile));
  const [baseline, setBaseline] = useState<ExplicitProfile>(() => explicitFrom(profile));
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<{ message: string; actions?: ErrorAction[] } | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  // Adopt the cloud profile whenever it (re)loads and there are no local edits.
  useEffect(() => {
    const next = explicitFrom(profile);
    setBaseline(next);
    setForm((current) => (JSON.stringify(current) === JSON.stringify(baseline) ? next : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(baseline), [baseline, form]);

  // The app shell owns navigation and browser-unload guards for this dirty state.
  useEffect(() => {
    dispatch({ type: 'SET_UNSAVED', value: dirty });
  }, [dirty, dispatch]);

  useEffect(() => () => dispatch({ type: 'SET_UNSAVED', value: false }), [dispatch]);

  const update = <K extends keyof ExplicitProfile>(key: K, value: ExplicitProfile[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const response = await saveProfile(form, profile.revision);
      setProfile(response);
      setBaseline(explicitFrom(response));
      setForm(explicitFrom(response));
      showToast({ message: 'Your settings are saved.', tone: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError({
          message: 'Your profile changed on another device.',
          actions: [
            {
              label: 'Keep my edits and update',
              onClick: () => {
                setError(null);
                // The baseline moves to the latest server copy; the form keeps local edits
                // so Save applies them on top of the new revision.
                void reload().then((next) => {
                  if (next) showToast({ message: 'Latest version loaded. Your edits are kept — review and save.' });
                });
              },
            },
            {
              label: 'Use the other device’s version',
              onClick: () => {
                setError(null);
                void reload().then((next) => {
                  if (next) setForm(explicitFrom(next));
                });
              },
            },
          ],
        });
      } else {
        setError({
          message: err instanceof ApiError ? err.message : 'Your settings could not be saved.',
          actions: [{ label: 'Try again', onClick: () => void save() }],
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const resetLearned = async () => {
    setPending(null);
    setResetting(true);
    setError(null);
    try {
      await resetProfileInferences();
      await reload();
      showToast({ message: 'Learned preferences were reset. Your listening history is kept.', tone: 'success' });
    } catch (err) {
      setError({ message: err instanceof ApiError ? err.message : 'Learned preferences could not be reset.' });
    } finally {
      setResetting(false);
    }
  };

  const exportData = async () => {
    setExporting(true);
    try {
      // Fail visibly rather than downloading an incomplete export.
      let lectures, series;
      try {
        [lectures, series] = await Promise.all([
          listLectures().then((response) => response.lectures),
          listSeries().then((response) => response.series),
        ]);
      } catch {
        showToast({
          message: 'Your data could not be exported completely. Nothing was downloaded.',
          tone: 'error',
          actionLabel: 'Retry',
          onAction: () => void exportData(),
        });
        return;
      }
      const payload = {
        exportedAt: new Date().toISOString(),
        account: { email: user?.email ?? '' },
        profile,
        lectures,
        series,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audio-learning-companion-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setExporting(false);
    }
  };

  const clearDevice = async () => {
    setPending(null);
    if (create.busy) return;
    const sub = user?.sub ?? '';
    player.close();
    create.clearConversation();
    let removed = 0;
    let downloadsFailed = false;
    try {
      removed = await clearOfflineLectures(sub);
    } catch {
      downloadsFailed = true;
    }
    removeUserItems(sub);
    await downloads.refresh();
    if (downloadsFailed) {
      showToast({
        message: 'Local settings were cleared, but some downloads could not be removed. Try again or clear site data in your browser.',
        tone: 'error',
        actionLabel: 'Retry',
        onAction: () => void clearDevice(),
      });
      return;
    }
    showToast({
      message: `Cleared this device${removed ? ` (${removed} download${removed === 1 ? '' : 's'})` : ''}. Your cloud library is unaffected.`,
      tone: 'success',
    });
  };

  const signOut = () => {
    // Flush listening position and telemetry while the session is still valid.
    player.close();
    logout();
  };

  const setTheme = (theme: ThemePreference) => dispatch({ type: 'SET_THEME', theme });

  if (status === 'loading' && !profile) {
    return (
      <div className="page you">
        <LoadingSpinner label="Loading your profile…" />
      </div>
    );
  }

  const inferred = profile?.inferred;
  const stats = profile?.stats;

  return (
    <div className="page you">
      <div className="page__heading">
        <div>
          <h2>You</h2>
          <p>{user?.email ? `Signed in as ${user.email}` : 'Your learning preferences and privacy.'}</p>
        </div>
      </div>

      {status === 'error' && (
        <ErrorBanner
          message={loadError || 'Your profile could not be loaded.'}
          detail="Settings can’t be saved until your profile loads."
          actions={[{ label: 'Retry', onClick: () => void reload() }]}
        />
      )}
      {error && <ErrorBanner message={error.message} actions={error.actions} onDismiss={() => setError(null)} />}

      <div className="stats">
        <div>
          <strong>{stats?.lecturesCompleted ?? 0}</strong>
          <span>Lectures completed</span>
        </div>
        <div>
          <strong>{formatDuration(stats?.totalListeningSeconds ?? 0)}</strong>
          <span>Total listening</span>
        </div>
      </div>

      <form id="profile-form" className="section" onSubmit={(event) => void save(event)} aria-labelledby="settings-title">
        <div className="section__heading">
          <h3 id="settings-title">Learning defaults</h3>
          <p>Used for Quick lectures. Anything you say in a request, or choose in a Guided lecture, takes priority.</p>
        </div>

        <label className="field">
          <span>Preferred length: {form.preferredDuration} min</span>
          <input
            type="range"
            min={5}
            max={60}
            step={5}
            value={form.preferredDuration}
            onChange={(event) => update('preferredDuration', Number(event.target.value))}
            aria-valuetext={`${form.preferredDuration} minutes`}
          />
        </label>

        <fieldset className="field choice-list">
          <legend>Explanation style</legend>
          {(['examples', 'theory', 'practical'] as const).map((style) => (
            <label key={style} className={`choice ${form.learningStyle === style ? 'is-active' : ''}`}>
              <input
                type="radio"
                name="learningStyle"
                value={style}
                checked={form.learningStyle === style}
                onChange={() => update('learningStyle', style)}
              />
              <span>
                <strong>{PROFILE_STYLE_LABELS[style]}</strong>
                <small>{STYLE_DESCRIPTIONS[style]}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="field">
          <span>Profession</span>
          <input
            type="text"
            maxLength={200}
            value={form.profession}
            onChange={(event) => update('profession', event.target.value)}
            placeholder="e.g. Software engineer"
          />
        </label>
        <TagInput label="Expertise areas" values={form.expertiseAreas} onChange={(value) => update('expertiseAreas', value)} />
        <TagInput label="Learning goals" values={form.learningGoals} maxLength={500} onChange={(value) => update('learningGoals', value)} />

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={form.behavioralPersonalizationEnabled}
            onChange={(event) => update('behavioralPersonalizationEnabled', event.target.checked)}
          />
          <span>
            <strong>Learn from my listening activity</strong>
            <small>Uses completed lectures, length, playback speed, and requested topics to personalize future lectures.</small>
          </span>
        </label>
      </form>

      <section className="section" aria-labelledby="learned-title">
        <div className="section__heading section__heading--row">
          <div>
            <h3 id="learned-title">Learned preferences</h3>
            <p>Behavioral estimates. They never override your choices above.</p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => setPending('reset')}
            disabled={resetting || !baseline.behavioralPersonalizationEnabled || !profile}
          >
            {resetting ? 'Resetting…' : 'Reset'}
          </button>
        </div>
        {!baseline.behavioralPersonalizationEnabled ? (
          <p className="muted">Learning from listening is turned off.</p>
        ) : !inferred || inferred.topicInterests.length === 0 ? (
          <p className="muted">Listen to a few lectures and what we learn will appear here.</p>
        ) : (
          <div className="learned-grid">
            <LearnedValue
              label="Preferred length"
              value={inferred.preferredDuration ? `${inferred.preferredDuration.value} minutes` : 'Still learning'}
              confidence={inferred.preferredDuration?.confidencePercent}
            />
            <LearnedValue
              label="Playback speed"
              value={inferred.preferredPlaybackRate ? `${inferred.preferredPlaybackRate.value}×` : 'Still learning'}
              confidence={inferred.preferredPlaybackRate?.confidencePercent}
            />
            <LearnedValue
              label="Explanation style"
              value={inferred.learningStyle ? PROFILE_STYLE_LABELS[inferred.learningStyle.value] : 'Still learning'}
              confidence={inferred.learningStyle?.confidencePercent}
            />
            <div className="learned-item learned-item--wide">
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

      <section className="section" aria-labelledby="appearance-title">
        <div className="section__heading">
          <h3 id="appearance-title">Appearance and listening</h3>
        </div>
        <fieldset className="field segmented">
          <legend>Theme</legend>
          {(['system', 'light', 'dark'] as const).map((theme) => (
            <label key={theme} className={state.theme === theme ? 'is-active' : ''}>
              <input type="radio" name="theme" value={theme} checked={state.theme === theme} onChange={() => setTheme(theme)} />
              {theme === 'system' ? 'Match device' : theme === 'light' ? 'Light' : 'Dark'}
            </label>
          ))}
        </fieldset>
        <label className="toggle-row">
          <input type="checkbox" checked={state.drivingMode} onChange={() => dispatch({ type: 'TOGGLE_DRIVING_MODE' })} />
          <span>
            <strong>Driving mode</strong>
            <small>Larger playback controls that are easier to reach at a glance.</small>
          </span>
        </label>
      </section>

      <section className="section" aria-labelledby="privacy-title">
        <div className="section__heading">
          <h3 id="privacy-title">Privacy and data</h3>
          <p>Downloads and favorites live only on this device. Lectures and settings are stored in your cloud account.</p>
        </div>
        <div className="action-list">
          <button type="button" className="btn btn--ghost" onClick={() => void exportData()} disabled={exporting || !state.isOnline}>
            <Icon name="download" size={16} /> {exporting ? 'Preparing…' : 'Export my data'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setPending('clear-device')}
            disabled={create.busy}
            aria-describedby={create.busy ? 'clear-device-hint' : undefined}
          >
            <Icon name="trash" size={16} /> Clear data on this device
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              removeItem(userKey(user?.sub ?? '', 'onboarded'));
              window.location.reload();
            }}
          >
            Show the welcome tour again
          </button>
        </div>
        {create.busy && (
          <p id="clear-device-hint" className="muted small-note">
            Wait for the lecture that’s being created to finish before clearing this device.
          </p>
        )}
        <p className="muted small-note">
          To delete your account and everything stored in the cloud, ask the app administrator. Deletion removes your
          lectures, audio, series, and profile.
        </p>
      </section>

      <div className="section section--plain">
        <button type="button" className="btn btn--ghost" onClick={() => (dirty ? setPending('discard') : signOut())}>
          Sign out
        </button>
      </div>

      {dirty && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span>You have unsaved changes.</span>
          <div>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setForm(baseline)} disabled={saving}>
              Discard
            </button>
            <button type="submit" form="profile-form" className="btn btn--primary btn--small" disabled={saving || !profile}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pending === 'reset'}
        title="Reset learned preferences?"
        message="We’ll forget the length, speed, style, and interests learned from your listening. Your settings, lectures, and listening statistics are kept."
        confirmLabel="Reset"
        destructive
        onConfirm={() => void resetLearned()}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'clear-device'}
        title="Clear data on this device?"
        message="This removes downloaded lectures, favorites, playback positions, and saved drafts from this browser. Your cloud library and settings are not affected."
        confirmLabel="Clear device data"
        destructive
        onConfirm={() => void clearDevice()}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'discard'}
        title="Sign out without saving?"
        message="Your unsaved setting changes will be lost."
        confirmLabel="Sign out"
        destructive
        onConfirm={() => {
          setPending(null);
          setForm(baseline);
          signOut();
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function LearnedValue({ label, value, confidence }: { label: string; value: string; confidence?: number }) {
  return (
    <div className="learned-item">
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
  const [hint, setHint] = useState('');
  const inputId = `tag-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const hintId = `${inputId}-hint`;

  const add = () => {
    const tag = draft.trim().slice(0, maxLength);
    if (!tag) return;
    if (values.some((value) => value.toLowerCase() === tag.toLowerCase())) {
      setHint(`“${tag}” is already added.`);
      setDraft('');
      return;
    }
    if (values.length >= 20) {
      setHint('You can add up to 20. Remove one to add another.');
      return; // keep the draft so nothing typed is lost
    }
    onChange([...values, tag]);
    setDraft('');
    setHint('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    }
  };

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      {values.length > 0 && (
        <div className="tags">
          {values.map((tag) => (
            <button
              key={tag}
              type="button"
              className="tag"
              onClick={() => onChange(values.filter((value) => value !== tag))}
              aria-label={`Remove ${tag}`}
            >
              {tag} <Icon name="close" size={14} />
            </button>
          ))}
        </div>
      )}
      <input
        id={inputId}
        type="text"
        maxLength={maxLength}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        placeholder="Type and press Enter"
        aria-describedby={hint ? hintId : undefined}
      />
      {hint && (
        <span id={hintId} className="muted small-note" role="status">
          {hint}
        </span>
      )}
    </div>
  );
}
