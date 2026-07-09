import { useAuth } from './contexts/AuthContext';
import { AppStateProvider, useAppState } from './contexts/AppStateContext';
import { LoginPage } from './pages/LoginPage';
import { ConversationPage } from './pages/ConversationPage';
import { HistoryPage } from './pages/HistoryPage';
import { ProfilePage } from './pages/ProfilePage';
import { LoadingSpinner } from './components/common/LoadingSpinner';
import type { AppPage } from './types';

const NAV: { page: AppPage; label: string }[] = [
  { page: 'conversation', label: 'Chat' },
  { page: 'history', label: 'History' },
  { page: 'profile', label: 'Profile' },
];

function Shell() {
  const { state, dispatch } = useAppState();

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Audio Learning Companion</h1>
        <button
          type="button"
          className={`driving-toggle ${state.drivingMode ? 'is-on' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_DRIVING_MODE' })}
          aria-pressed={state.drivingMode}
        >
          🚗 Driving
        </button>
      </header>

      {!state.isOnline && <div className="banner banner--offline">You are offline. Cached lectures still play.</div>}
      {state.drivingMode && <div className="banner banner--driving">Driving mode: larger controls enabled.</div>}

      <main className="app__main">
        {state.currentPage === 'conversation' && <ConversationPage />}
        {state.currentPage === 'history' && <HistoryPage />}
        {state.currentPage === 'profile' && <ProfilePage />}
      </main>

      <nav className="app__nav" aria-label="Primary">
        {NAV.map(({ page, label }) => (
          <button
            key={page}
            className={`nav-btn ${state.currentPage === page ? 'is-active' : ''}`}
            onClick={() => dispatch({ type: 'SET_PAGE', page })}
            aria-current={state.currentPage === page ? 'page' : undefined}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="app app--centered">
        <LoadingSpinner label="Loading your companion…" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}
