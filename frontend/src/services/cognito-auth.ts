/** Cognito authentication wrapper around amazon-cognito-identity-js.
 *
 * Exposes a Promise-based API for the multi-step flows the UI needs: sign-up,
 * email confirmation, sign-in (with TOTP MFA), TOTP enrollment, password reset,
 * and session/token access. Error messages are deliberately generic so we never
 * reveal whether an email is registered.
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  CognitoUserSession,
  type ISignUpResult,
} from 'amazon-cognito-identity-js';
import type { AuthUser } from '../types';

const USER_POOL_ID = import.meta.env.VITE_USER_POOL_ID;
const CLIENT_ID = import.meta.env.VITE_USER_POOL_CLIENT_ID;

let cachedPool: CognitoUserPool | null = null;

function pool(): CognitoUserPool {
  if (!cachedPool) {
    if (!USER_POOL_ID || !CLIENT_ID) {
      throw new Error('Auth is not configured');
    }
    cachedPool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
  }
  return cachedPool;
}

function newUser(email: string): CognitoUser {
  return new CognitoUser({ Username: email, Pool: pool() });
}

// Holds the user mid-flow (between authenticateUser and the MFA code submission,
// or during TOTP enrollment).
let pendingUser: CognitoUser | null = null;

const GENERIC_AUTH_ERROR = 'Invalid email or password';

function friendlyError(err: unknown): Error {
  const code = (err as { code?: string })?.code ?? '';
  const message = (err as { message?: string })?.message ?? 'Something went wrong';
  switch (code) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return new Error(GENERIC_AUTH_ERROR);
    case 'CodeMismatchException':
      return new Error('That code is incorrect. Please try again.');
    case 'ExpiredCodeException':
      return new Error('That code has expired. Request a new one.');
    case 'UsernameExistsException':
      return new Error('That email is already registered. Try signing in.');
    case 'InvalidPasswordException':
      return new Error('Password does not meet the requirements.');
    case 'LimitExceededException':
      return new Error('Too many attempts. Please wait and try again.');
    default:
      return new Error(message);
  }
}

export interface SignInResult {
  mfaRequired: boolean;
  /** True when the user has no MFA yet and must enroll a TOTP device now. */
  mfaSetupRequired?: boolean;
  /** The TOTP secret to show the user when mfaSetupRequired is true. */
  secretCode?: string;
}

export function signUp(params: { email: string; password: string }): Promise<ISignUpResult> {
  const { email, password } = params;
  const attributes = [new CognitoUserAttribute({ Name: 'email', Value: email })];
  return new Promise((resolve, reject) => {
    pool().signUp(email, password, attributes, [], (err, result) => {
      if (err || !result) return reject(friendlyError(err));
      resolve(result);
    });
  });
}

export function confirmSignUp(params: { email: string; code: string }): Promise<void> {
  const { email, code } = params;
  const user = newUser(email);
  return new Promise((resolve, reject) => {
    user.confirmRegistration(code, true, (err) => {
      if (err) return reject(friendlyError(err));
      resolve();
    });
  });
}

export function signIn(params: { email: string; password: string }): Promise<SignInResult> {
  const { email, password } = params;
  const user = newUser(email);
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: () => {
        pendingUser = null;
        resolve({ mfaRequired: false });
      },
      onFailure: (err) => {
        pendingUser = null;
        reject(friendlyError(err));
      },
      totpRequired: () => {
        pendingUser = user;
        resolve({ mfaRequired: true });
      },
      mfaRequired: () => {
        pendingUser = user;
        resolve({ mfaRequired: true });
      },
      // First-time sign-in for a user with no MFA yet: Cognito issues an
      // MFA_SETUP challenge. Associate a TOTP secret and hand it to the UI so the
      // user can enroll an authenticator, then finish with completeMfaSetup().
      mfaSetup: () => {
        pendingUser = user;
        user.associateSoftwareToken({
          associateSecretCode: (secretCode: string) => {
            resolve({ mfaRequired: false, mfaSetupRequired: true, secretCode });
          },
          onFailure: (err: unknown) => {
            pendingUser = null;
            reject(friendlyError(err));
          },
        });
      },
    });
  });
}

/** Build an otpauth:// URI so authenticator apps can add the account by QR or link. */
export function buildTotpUri(email: string, secretCode: string): string {
  const issuer = 'AudioLearningCompanion';
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretCode}&issuer=${issuer}`;
}

/** Complete first-time TOTP enrollment during sign-in. Resolves once authenticated. */
export function completeMfaSetup(code: string): Promise<void> {
  const user = pendingUser;
  if (!user) return Promise.reject(new Error('No sign-in in progress'));
  return new Promise((resolve, reject) => {
    user.verifySoftwareToken(code, 'Authenticator', {
      onSuccess: () => {
        pendingUser = null;
        resolve();
      },
      onFailure: (err: unknown) => reject(friendlyError(err)),
    });
  });
}

export function verifyMfa(params: { code: string }): Promise<void> {
  const user = pendingUser;
  if (!user) return Promise.reject(new Error('No sign-in in progress'));
  return new Promise((resolve, reject) => {
    user.sendMFACode(
      params.code,
      {
        onSuccess: () => {
          pendingUser = null;
          resolve();
        },
        onFailure: (err) => reject(friendlyError(err)),
      },
      'SOFTWARE_TOKEN_MFA'
    );
  });
}

export function setupTotp(): Promise<string> {
  const user = pool().getCurrentUser();
  if (!user) return Promise.reject(new Error('Not authenticated'));
  return new Promise((resolve, reject) => {
    user.getSession((err: Error | null) => {
      if (err) return reject(friendlyError(err));
      user.associateSoftwareToken({
        associateSecretCode: (secretCode: string) => resolve(secretCode),
        onFailure: (e: unknown) => reject(friendlyError(e)),
      });
    });
  });
}

export function verifyTotpSetup(code: string): Promise<void> {
  const user = pool().getCurrentUser();
  if (!user) return Promise.reject(new Error('Not authenticated'));
  return new Promise((resolve, reject) => {
    user.getSession((err: Error | null) => {
      if (err) return reject(friendlyError(err));
      user.verifySoftwareToken(code, 'Authenticator', {
        onSuccess: () => {
          user.setUserMfaPreference(
            null,
            { PreferredMfa: true, Enabled: true },
            (e) => (e ? reject(friendlyError(e)) : resolve())
          );
        },
        onFailure: (e: unknown) => reject(friendlyError(e)),
      });
    });
  });
}

export function getSession(): Promise<CognitoUserSession | null> {
  const user = pool().getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) return resolve(null);
      resolve(session);
    });
  });
}

export async function getIdToken(): Promise<string | null> {
  const session = await getSession();
  return session ? session.getIdToken().getJwtToken() : null;
}

export function getCurrentUser(): Promise<AuthUser | null> {
  const user = pool().getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) return resolve(null);
      user.getUserAttributes((attrErr, attributes) => {
        if (attrErr || !attributes) return resolve(null);
        const map: Record<string, string> = {};
        for (const attr of attributes) map[attr.getName()] = attr.getValue();
        resolve({
          sub: map.sub ?? '',
          email: map.email ?? '',
          emailVerified: map.email_verified === 'true',
        });
      });
    });
  });
}

export function signOut(): void {
  const user = pool().getCurrentUser();
  if (user) user.signOut();
  pendingUser = null;
}

export function forgotPassword(email: string): Promise<void> {
  const user = newUser(email);
  return new Promise((resolve, reject) => {
    user.forgotPassword({
      onSuccess: () => resolve(),
      onFailure: (err) => reject(friendlyError(err)),
    });
  });
}

export function confirmNewPassword(
  email: string,
  code: string,
  newPassword: string
): Promise<void> {
  const user = newUser(email);
  return new Promise((resolve, reject) => {
    user.confirmPassword(code, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err) => reject(friendlyError(err)),
    });
  });
}
