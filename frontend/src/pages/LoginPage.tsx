import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { useAuth } from '../contexts/AuthContext';
import { ErrorBanner } from '../components/common/ErrorBanner';
import {
  buildTotpUri,
  completeMfaSetup,
  confirmNewPassword,
  confirmSignUp,
  forgotPassword,
  signIn,
  signUp,
  verifyMfa,
} from '../services/cognito-auth';

type View =
  | 'signin'
  | 'signup'
  | 'confirm-email'
  | 'mfa'
  | 'mfa-setup'
  | 'forgot-password'
  | 'reset-password';

export function LoginPage() {
  const { refreshUser } = useAuth();
  const [view, setView] = useState<View>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [secretCode, setSecretCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  // Generate the TOTP QR code locally (the secret never leaves the browser).
  useEffect(() => {
    if (!secretCode || !email) {
      setQrDataUrl('');
      return;
    }
    let active = true;
    QRCode.toDataURL(buildTotpUri(email, secretCode), { margin: 1, width: 200 })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [secretCode, email]);

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

  const onSignIn = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const result = await signIn({ email, password });
      if (result.mfaSetupRequired && result.secretCode) {
        setSecretCode(result.secretCode);
        reset('mfa-setup');
        setInfo('Set up two-factor authentication to finish signing in.');
      } else if (result.mfaRequired) {
        reset('mfa');
        setInfo('Enter the 6-digit code from your authenticator app.');
      } else {
        await refreshUser();
      }
    });
  };

  const onCompleteMfaSetup = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await completeMfaSetup(code);
      await refreshUser();
    });
  };

  const onSignUp = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    void run(async () => {
      await signUp({ email, password });
      setInfo('Check your email for a 6-digit confirmation code.');
      reset('confirm-email');
      setInfo('Check your email for a 6-digit confirmation code.');
    });
  };

  const onConfirmEmail = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await confirmSignUp({ email, code });
      setInfo('Email confirmed. Please sign in.');
      reset('signin');
      setInfo('Email confirmed. Please sign in to set up MFA.');
    });
  };

  const onVerifyMfa = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await verifyMfa({ code });
      await refreshUser();
    });
  };

  const onForgot = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await forgotPassword(email);
      setInfo('We sent a reset code to your email.');
      reset('reset-password');
      setInfo('Enter the reset code and your new password.');
    });
  };

  const onReset = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    void run(async () => {
      await confirmNewPassword(email, code, password);
      setInfo('Password reset. Please sign in.');
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
            <PasswordField
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              label="Confirm password"
            />
            <p className="login__hint">
              Use 14+ characters with upper &amp; lower case, a number, and a symbol.
            </p>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
            <button type="button" className="link" onClick={() => reset('signin')}>
              Back to sign in
            </button>
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

        {view === 'mfa' && (
          <form onSubmit={onVerifyMfa} className="login__form">
            <CodeField value={code} onChange={setCode} label="Authenticator code" />
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </form>
        )}

        {view === 'mfa-setup' && (
          <form onSubmit={onCompleteMfaSetup} className="login__form">
            <p className="login__hint">
              Add this account to an authenticator app (Google Authenticator, Authy,
              1Password…), then type the 6-digit code it shows.
            </p>
            {qrDataUrl && (
              <img className="totp-qr" src={qrDataUrl} alt="Scan with your authenticator app" />
            )}
            <label className="field">
              <span>Can't scan? Enter this key manually</span>
              <code className="totp-secret">{secretCode}</code>
            </label>
            <a className="link" href={buildTotpUri(email, secretCode)}>
              Open in authenticator app (mobile)
            </a>
            <CodeField value={code} onChange={setCode} label="Authenticator code" />
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Verifying…' : 'Enable & sign in'}
            </button>
          </form>
        )}

        {view === 'forgot-password' && (
          <form onSubmit={onForgot} className="login__form">
            <EmailField value={email} onChange={setEmail} />
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset code'}
            </button>
            <button type="button" className="link" onClick={() => reset('signin')}>
              Back to sign in
            </button>
          </form>
        )}

        {view === 'reset-password' && (
          <form onSubmit={onReset} className="login__form">
            <CodeField value={code} onChange={setCode} />
            <PasswordField value={password} onChange={setPassword} autoComplete="new-password" label="New password" />
            <PasswordField
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              label="Confirm new password"
            />
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function EmailField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>Email</span>
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function PasswordField({
  value,
  onChange,
  autoComplete,
  label = 'Password',
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  label?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="password"
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function CodeField({
  value,
  onChange,
  label = 'Confirmation code',
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        required
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      />
    </label>
  );
}
