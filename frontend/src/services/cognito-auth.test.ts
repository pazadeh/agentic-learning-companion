import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, test-controllable mock state for amazon-cognito-identity-js.
const state = vi.hoisted(() => ({
  authBehavior: 'success' as 'success' | 'mfa' | 'fail',
}));

vi.mock('amazon-cognito-identity-js', () => {
  class CognitoUserPool {
    constructor(public config: { UserPoolId: string; ClientId: string }) {}
    signUp(
      _email: string,
      _password: string,
      _attrs: unknown,
      _v: unknown,
      cb: (err: unknown, result?: unknown) => void
    ) {
      cb(null, { user: {}, userConfirmed: false });
    }
    getCurrentUser() {
      return null;
    }
  }
  class CognitoUser {
    authenticateUser(
      _details: unknown,
      callbacks: {
        onSuccess: () => void;
        onFailure: (e: unknown) => void;
        totpRequired?: () => void;
      }
    ) {
      if (state.authBehavior === 'success') callbacks.onSuccess();
      else if (state.authBehavior === 'mfa') callbacks.totpRequired?.();
      else callbacks.onFailure({ code: 'NotAuthorizedException' });
    }
    confirmRegistration(_code: string, _force: boolean, cb: (err: unknown) => void) {
      cb(null);
    }
    sendMFACode(_code: string, callbacks: { onSuccess: () => void }, _type: string) {
      callbacks.onSuccess();
    }
  }
  class AuthenticationDetails {
    constructor(public d: unknown) {}
  }
  class CognitoUserAttribute {
    constructor(public a: unknown) {}
  }
  return { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserAttribute };
});

beforeEach(async () => {
  vi.stubEnv('VITE_USER_POOL_ID', 'us-east-1_test');
  vi.stubEnv('VITE_USER_POOL_CLIENT_ID', 'client123');
  state.authBehavior = 'success';
  // Clear any pending MFA user carried over from a previous test.
  const { signOut } = await import('./cognito-auth');
  signOut();
});

describe('signIn', () => {
  it('resolves with mfaRequired=false on success', async () => {
    const { signIn } = await import('./cognito-auth');
    const result = await signIn({ email: 'a@b.com', password: 'pw' });
    expect(result.mfaRequired).toBe(false);
  });

  it('resolves with mfaRequired=true when TOTP is needed', async () => {
    state.authBehavior = 'mfa';
    const { signIn } = await import('./cognito-auth');
    const result = await signIn({ email: 'a@b.com', password: 'pw' });
    expect(result.mfaRequired).toBe(true);
  });

  it('rejects with a generic message on bad credentials', async () => {
    state.authBehavior = 'fail';
    const { signIn } = await import('./cognito-auth');
    await expect(signIn({ email: 'a@b.com', password: 'wrong' })).rejects.toThrow(
      'Invalid email or password'
    );
  });
});

describe('verifyMfa', () => {
  it('rejects if no sign-in is in progress', async () => {
    const { verifyMfa } = await import('./cognito-auth');
    await expect(verifyMfa({ code: '123456' })).rejects.toThrow('No sign-in in progress');
  });

  it('resolves after an MFA-required sign-in', async () => {
    state.authBehavior = 'mfa';
    const { signIn, verifyMfa } = await import('./cognito-auth');
    await signIn({ email: 'a@b.com', password: 'pw' });
    await expect(verifyMfa({ code: '123456' })).resolves.toBeUndefined();
  });
});

describe('signUp / confirmSignUp', () => {
  it('signUp resolves', async () => {
    const { signUp } = await import('./cognito-auth');
    await expect(signUp({ email: 'a@b.com', password: 'pw' })).resolves.toBeTruthy();
  });

  it('confirmSignUp resolves', async () => {
    const { confirmSignUp } = await import('./cognito-auth');
    await expect(confirmSignUp({ email: 'a@b.com', code: '123456' })).resolves.toBeUndefined();
  });
});
