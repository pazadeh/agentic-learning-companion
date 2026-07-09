import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';

// Mock auth so we control authentication state without real Cognito.
vi.mock('./services/cognito-auth', () => ({
  getCurrentUser: vi.fn(),
  signOut: vi.fn(),
  getIdToken: vi.fn(async () => 'token'),
}));
// Mock the API so pages never hit the network.
vi.mock('./services/api-client', () => ({
  ApiError: class ApiError extends Error {},
  startJob: vi.fn(),
  getJobStatus: vi.fn(),
  getJobResult: vi.fn(),
  refreshAudioUrl: vi.fn(),
  pollJobUntilDone: vi.fn(),
}));

import { getCurrentUser } from './services/cognito-auth';
const mockedGetCurrentUser = vi.mocked(getCurrentUser);

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('unauthenticated', () => {
  it('shows the login page', async () => {
    mockedGetCurrentUser.mockResolvedValue(null);
    renderApp();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('authenticated', () => {
  beforeEach(() => {
    mockedGetCurrentUser.mockResolvedValue({
      sub: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      emailVerified: true,
    });
  });

  async function renderAuthed() {
    renderApp();
    // Wait for the auth loading spinner to disappear.
    await screen.findByRole('navigation', { name: 'Primary' });
  }

  it('renders the nav and conversation page by default', async () => {
    await renderAuthed();
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('What would you like to learn?')).toBeInTheDocument();
  });

  it('navigates to history', async () => {
    await renderAuthed();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(
      screen.getByText('No lectures yet. Head to Chat and ask to learn something.')
    ).toBeInTheDocument();
  });

  it('navigates to profile', async () => {
    await renderAuthed();
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    expect(screen.getByText('Profession')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});
