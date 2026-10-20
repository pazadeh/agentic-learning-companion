import { useState, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorBanner } from '../components/common/ErrorBanner';
import {
  confirmNewPassword,
  confirmSignUp,
  forgotPassword,
  signIn,
  signUp,
} from '../services/cognito-auth';

type View = 'signin' | 'signup' | 'confirm-email' | 'forgot-password' | 'reset-password';

export function LoginPage() {
  const { refreshUser } = useAuth();
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = (next: View) => {
    setError('');
    setInfo('');
    setCode('');
    setView(next);
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const onSignIn = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await signIn({ email, password });
      await refreshUser();
    });
  };

  const onSignUp = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    void run(async () => {
      await signUp({ email, password });
      reset('confirm-email');
      setInfo('Check your email for a 6-digit confirmation code.');
    });
  };

  const onConfirmEmail = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await confirmSignUp({ email, code });
      reset('signin');
      setInfo('Email confirmed. Please sign in.');
    });
  };

  const onForgot = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await forgotPassword(email);
      reset('reset-password');
      setInfo('Enter the reset code and your new password.');
    });
  };

  const onReset = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    void run(async () => {
      await confirmNewPassword(email, code, password);
      reset('signin');
      setInfo('Password reset. Please sign in.');
    });
  };

  return (
    <div className="login">
      <div className="login__card">
        <h1 className="login__title">Audio Learning Companion</h1>
        {info && <p className="login__info">{info}</p>}
        <ErrorBanner message={error} onDismiss={() => setError('')} />

        {view === 'signin' && (
          <form onSubmit={onSignIn} className="login__form">
            <EmailField value={email} onChange={setEmail} />
            <PasswordField value={password} onChange={setPassword} autoComplete="current-password" />
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div className="login__links">
              <button type="button" className="link" onClick={() => reset('forgot-password')}>
                Forgot password?
              </button>
              <button type="button" className="link" onClick={() => reset('signup')}>
                Create account
              </button>
            </div>
          </form>
        )}

        {view === 'signup' && (
          <form onSubmit={onSignUp} className="login__form">
            <EmailField value={email} onChange={setEmail} />
            <PasswordField value={password} onChange={setPassword} autoComplete="new-password" />
            <PasswordField value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" label="Confirm password" />
            <p className="login__hint">Use 14+ characters with upper &amp; lower case, a number, and a symbol.</p>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
            <button type="button" className="link" onClick={() => reset('signin')}>Back to sign in</button>
          </form>
        )}

        {view === 'confirm-email' && (
          <form onSubmit={onConfirmEmail} className="login__form">
            <CodeField value={code} onChange={setCode} />
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Confirming…' : 'Confirm email'}
            </button>
          </form>
        )}

        {view === 'forgot-password' && (
          <form onSubmit={onForgot} className="login__form">
            <EmailField value={email} onChange={setEmail} />
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset code'}
            </button>
            <button type="button" className="link" onClick={() => reset('signin')}>Back to sign in</button>
          </form>
        )}

        {view === 'reset-password' && (
          <form onSubmit={onReset} className="login__form">
            <CodeField value={code} onChange={setCode} />
            <PasswordField value={password} onChange={setPassword} autoComplete="new-password" label="New password" />
            <PasswordField value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" label="Confirm new password" />
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function EmailField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>Email</span>
      <input type="email" inputMode="email" autoComplete="email" required value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PasswordField({ value, onChange, autoComplete, label = 'Password' }: { value: string; onChange: (value: string) => void; autoComplete: string; label?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="password" autoComplete={autoComplete} required value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>Confirmation code</span>
      <input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} required value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))} />
    </label>
  );
}
