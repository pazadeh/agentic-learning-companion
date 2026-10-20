import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authBehavior: 'success' as 'success' | 'fail',
}));

vi.mock('amazon-cognito-identity-js', () => {
  class CognitoUserPool {
    constructor(public config: { UserPoolId: string; ClientId: string }) {}
    signUp(
      _email: string,
      _password: string,
      _attrs: unknown,
      _validation: unknown,
      callback: (error: unknown, result?: unknown) => void
    ) {
      callback(null, { user: {}, userConfirmed: false });
    }
    getCurrentUser() {
      return null;
    }
  }
  class CognitoUser {
    authenticateUser(
      _details: unknown,
      callbacks: { onSuccess: () => void; onFailure: (error: unknown) => void }
    ) {
      if (state.authBehavior === 'success') callbacks.onSuccess();
      else callbacks.onFailure({ code: 'NotAuthorizedException' });
    }
    confirmRegistration(_code: string, _force: boolean, callback: (error: unknown) => void) {
      callback(null);
    }
  }
  class AuthenticationDetails {
    constructor(public details: unknown) {}
  }
  class CognitoUserAttribute {
    constructor(public attribute: unknown) {}
  }
  return { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserAttribute };
});

beforeEach(() => {
  vi.stubEnv('VITE_USER_POOL_ID', 'us-east-1_test');
  vi.stubEnv('VITE_USER_POOL_CLIENT_ID', 'client123');
  state.authBehavior = 'success';
});

describe('signIn', () => {
  it('resolves on successful email/password authentication', async () => {
    const { signIn } = await import('./cognito-auth');
    await expect(signIn({ email: 'a@b.com', password: 'pw' })).resolves.toBeUndefined();
  });

  it('rejects with a generic message on bad credentials', async () => {
    state.authBehavior = 'fail';
    const { signIn } = await import('./cognito-auth');
    await expect(signIn({ email: 'a@b.com', password: 'wrong' })).rejects.toThrow(
      'Invalid email or password'
    );
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
