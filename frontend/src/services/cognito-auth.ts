/** Cognito authentication wrapper around amazon-cognito-identity-js.
 *
 * Exposes Promise-based email/password sign-up, confirmation, session refresh, and
 * password-reset flows. Error messages deliberately avoid account enumeration.
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

export function signIn(params: { email: string; password: string }): Promise<void> {
  const { email, password } = params;
  const user = newUser(email);
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: () => resolve(),
      onFailure: (err) => reject(friendlyError(err)),
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

export async function getCurrentUser(): Promise<AuthUser | null> {
  const session = await getSession();
  if (!session) return null;
  const claims = session.getIdToken().payload as Record<string, unknown>;
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email : '';
  if (!sub) return null;
  return {
    sub,
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
  };
}

export function signOut(): void {
  const user = pool().getCurrentUser();
  if (user) user.signOut();
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
