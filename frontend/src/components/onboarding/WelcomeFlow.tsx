import { useEffect, useRef, useState } from 'react';
import { useProfile } from '../../contexts/ProfileContext';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ApiError, saveProfile } from '../../services/api-client';
import { PROFILE_STYLE_LABELS } from '../../utils/briefLabels';
import { Icon } from '../common/Icon';

interface WelcomeFlowProps {
  /** `recorded`: a personalization choice exists, so the tour need not show again. */
  onDone: (recorded: boolean) => void;
}

type Consent = 'yes' | 'no' | null;

/** First-use introduction plus an intentional personalization choice. */
export function WelcomeFlow({ onDone }: WelcomeFlowProps) {
  const { profile, status, setProfile } = useProfile();
  const [step, setStep] = useState<1 | 2>(1);
  const [duration, setDuration] = useState(profile?.explicit.preferredDuration ?? 15);
  const [style, setStyle] = useState<'examples' | 'theory' | 'practical'>(profile?.explicit.learningStyle ?? 'examples');
  const [consent, setConsent] = useState<Consent>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { active: true, initialFocus: headingRef });

  useEffect(() => {
    if (profile) {
      setDuration(profile.explicit.preferredDuration ?? 15);
      setStyle(profile.explicit.learningStyle ?? 'examples');
    }
  }, [profile]);

  useEffect(() => headingRef.current?.focus(), [step]);

  const save = async (choice: { duration: number; style: typeof style; personalize: boolean }) => {
    if (!profile) return false;
    const { explicit } = profile;
    const response = await saveProfile(
      {
        profession: explicit.profession ?? '',
        expertiseAreas: explicit.expertiseAreas ?? [],
        learningGoals: explicit.learningGoals ?? [],
        learningStyle: choice.style,
        preferredDuration: choice.duration,
        behavioralPersonalizationEnabled: choice.personalize,
      },
      profile.revision
    );
    setProfile(response);
    return true;
  };

  /**
   * Skipping never counts as consent. An account that already saved settings keeps its
   * recorded choice; otherwise skipping records "only use my settings". Without a
   * loaded profile nothing can be recorded, so the tour returns next time.
   */
  const skip = async () => {
    if (status !== 'ready' || !profile) {
      onDone(false);
      return;
    }
    if (profile.hasExplicitProfile) {
      onDone(true);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await save({
        duration: profile.explicit.preferredDuration ?? 15,
        style: profile.explicit.learningStyle ?? 'examples',
        personalize: false,
      });
      onDone(true);
    } catch {
      onDone(false);
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    if (!profile || consent === null) {
      onDone(false);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await save({ duration, style, personalize: consent === 'yes' });
      onDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your choices could not be saved. You can set them later in You.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="welcome__card" ref={dialogRef}>
        <div className="welcome__progress" aria-label={`Step ${step} of 2`}>
          <span className={step >= 1 ? 'is-done' : ''} />
          <span className={step >= 2 ? 'is-done' : ''} />
        </div>

        {step === 1 ? (
          <>
            <h2 id="welcome-title" ref={headingRef} tabIndex={-1}>
              Turn any topic into a personalized audio lesson
            </h2>
            <p className="welcome__lead">
              Ask about anything. We research it, write a lecture for your level, and narrate it so you can listen
              while you walk, commute, or cook.
            </p>
            <ul className="welcome__modes">
              <li>
                <Icon name="bolt" />
                <span>
                  <strong>Quick lecture</strong> — type a topic and generate right away.
                </span>
              </li>
              <li>
                <Icon name="sparkle" />
                <span>
                  <strong>Guided lecture</strong> — answer a few quick questions, review the brief, then generate.
                </span>
              </li>
              <li>
                <Icon name="layers" />
                <span>
                  <strong>Plan a series</strong> — get an editable multi-episode plan before anything is created.
                </span>
              </li>
            </ul>
            <p className="muted">Lectures take a few minutes to create. You can keep browsing; we’ll tell you when they’re ready.</p>
            <div className="welcome__actions">
              <button type="button" className="btn btn--text" onClick={() => void skip()} disabled={saving}>
                Skip
              </button>
              <button type="button" className="btn btn--primary" onClick={() => setStep(2)}>
                Next
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="welcome-title" ref={headingRef} tabIndex={-1}>
              Make it yours
            </h2>
            {status !== 'ready' && (
              <p className="muted">We couldn’t load your profile right now. You can set these later in You.</p>
            )}
            <label className="field">
              <span>Typical lecture length: {duration} min</span>
              <input
                type="range"
                min={5}
                max={60}
                step={5}
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
                aria-valuetext={`${duration} minutes`}
                disabled={status !== 'ready'}
              />
            </label>
            <fieldset className="field segmented" disabled={status !== 'ready'}>
              <legend>Explanation style</legend>
              {(['examples', 'theory', 'practical'] as const).map((value) => (
                <label key={value} className={style === value ? 'is-active' : ''}>
                  <input type="radio" name="welcome-style" checked={style === value} onChange={() => setStyle(value)} />
                  {PROFILE_STYLE_LABELS[value]}
                </label>
              ))}
            </fieldset>
            <fieldset className="field choice-list" disabled={status !== 'ready'}>
              <legend>Should we learn from your listening?</legend>
              <label className={`choice ${consent === 'yes' ? 'is-active' : ''}`}>
                <input type="radio" name="welcome-consent" checked={consent === 'yes'} onChange={() => setConsent('yes')} />
                <span>
                  <strong>Yes, adapt to me</strong>
                  <small>Use completed lectures, length, speed, and topics to personalize future lectures. You can reset or turn this off anytime.</small>
                </span>
              </label>
              <label className={`choice ${consent === 'no' ? 'is-active' : ''}`}>
                <input type="radio" name="welcome-consent" checked={consent === 'no'} onChange={() => setConsent('no')} />
                <span>
                  <strong>No, only use my settings</strong>
                  <small>Lectures use the choices above and what you ask for.</small>
                </span>
              </label>
            </fieldset>
            {status === 'ready' && !profile?.hasExplicitProfile && (
              <p className="muted small-note">Skipping keeps learning from listening off. You can change it anytime in You.</p>
            )}
            {error && <p className="form-errors" role="alert">{error}</p>}
            <div className="welcome__actions">
              <button type="button" className="btn btn--text" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void skip()} disabled={saving}>
                Skip for now
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void finish()}
                disabled={saving || (status === 'ready' && consent === null)}
              >
                {saving ? 'Saving…' : 'Start learning'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
