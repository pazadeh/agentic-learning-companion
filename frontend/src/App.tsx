import { useState } from 'react';
import { useAuth } from './contexts/AuthContext';
import { AppStateProvider, useAppState } from './contexts/AppStateContext';
import { CreateProvider, useCreate } from './contexts/CreateContext';
import { DownloadsProvider } from './contexts/DownloadsContext';
import { PlayerProvider, usePlayer } from './contexts/PlayerContext';
import { ProfileProvider } from './contexts/ProfileContext';
import { ToastProvider } from './contexts/ToastContext';
import { LoginPage } from './pages/LoginPage';
import { CreatePage } from './pages/CreatePage';
import { SeriesPage } from './pages/SeriesPage';
import { LibraryPage } from './pages/LibraryPage';
import { YouPage } from './pages/YouPage';
import { LoadingSpinner } from './components/common/LoadingSpinner';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { Icon, type IconName } from './components/common/Icon';
import { MiniPlayer, NowPlaying } from './components/audio/NowPlaying';
import { WelcomeFlow } from './components/onboarding/WelcomeFlow';
import { useMediaQuery } from './hooks/useMediaQuery';
import { getItem, setItem, userKey } from './utils/storage';
import type { AppPage } from './types';

const NAV: Array<{ page: AppPage; label: string; icon: IconName }> = [
  { page: 'create', label: 'Create', icon: 'sparkle' },
  { page: 'series', label: 'My series', icon: 'layers' },
  { page: 'library', label: 'Library', icon: 'library' },
  { page: 'you', label: 'You', icon: 'user' },
];

function ActiveWorkIndicator() {
  const { activeJob, jobState, creatingSeries } = useCreate();
  const { state, navigate } = useAppState();
  if (!activeJob && !creatingSeries) return null;
  const label = creatingSeries
    ? 'Creating series draft'
    : activeJob?.kind === 'design'
      ? 'Updating your brief'
      : `Creating lecture · ${Math.round(jobState?.progress ?? 0)}%`;
  return (
    <button
      type="button"
      className="work-pill"
      onClick={() => navigate({ page: 'create' })}
      aria-label={`${label}. Open Create`}
      aria-current={state.currentPage === 'create' ? 'page' : undefined}
    >
      <span className="work-pill__pulse" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function Shell() {
  const { state, dispatch, navigate } = useAppState();
  const { user } = useAuth();
  const player = usePlayer();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const onboardedKey = userKey(user?.sub ?? '', 'onboarded');
  const [onboarded, setOnboarded] = useState(() => getItem<boolean>(onboardedKey, false));
  // Dismissed for this session without a recorded choice: ask again next launch.
  const [welcomeDeferred, setWelcomeDeferred] = useState(false);

  const goTo = (page: AppPage) => navigate({ page, seriesId: page === 'series' ? null : undefined });

  const showPanel = isDesktop && Boolean(player.lecture);

  return (
    <div className={`app ${showPanel ? 'app--with-panel' : ''} ${player.lecture && !isDesktop ? 'app--with-mini' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="app__header">
        <h1 className="app__title">
          <span className="app__logo" aria-hidden="true">
            <Icon name="sparkle" size={18} />
          </span>
          Audio Learning Companion
        </h1>
        <div className="app__header-actions">
          <ActiveWorkIndicator />
          <button
            type="button"
            className={`header-toggle ${state.drivingMode ? 'is-on' : ''}`}
            onClick={() => dispatch({ type: 'TOGGLE_DRIVING_MODE' })}
            aria-pressed={state.drivingMode}
          >
            <Icon name="car" size={18} />
            <span>Driving</span>
          </button>
        </div>
      </header>

      {!state.isOnline && (
        <div className="banner banner--offline" role="status">
          You’re offline. Downloaded lectures still play from Library.
        </div>
      )}
      {state.drivingMode && (
        <div className="banner banner--driving" role="status">
          Driving mode: larger controls. Keep your eyes on the road.
        </div>
      )}

      <div className="app__body">
        <main id="main" className="app__main" tabIndex={-1}>
          {state.currentPage === 'create' && <CreatePage />}
          {state.currentPage === 'series' && <SeriesPage />}
          {state.currentPage === 'library' && <LibraryPage />}
          {state.currentPage === 'you' && <YouPage />}
        </main>
        {showPanel && <NowPlaying variant="panel" />}
      </div>

      {!isDesktop && player.lecture && <MiniPlayer />}
      {!isDesktop && player.expanded && player.lecture && <NowPlaying variant="sheet" />}

      <nav className="app__nav" aria-label="Primary">
        {NAV.map(({ page, label, icon }) => (
          <button
            key={page}
            type="button"
            className={`nav-btn ${state.currentPage === page ? 'is-active' : ''}`}
            onClick={() => goTo(page)}
            aria-current={state.currentPage === page ? 'page' : undefined}
          >
            <Icon name={icon} size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <ConfirmDialog
        open={state.pendingNavigation !== null}
        title="Leave without saving?"
        message="You have unsaved changes on this page. If you leave now, they will be lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => dispatch({ type: 'CONFIRM_NAVIGATION' })}
        onCancel={() => dispatch({ type: 'CANCEL_NAVIGATION' })}
      />

      {!onboarded && !welcomeDeferred && (
        <WelcomeFlow
          onDone={(recorded) => {
            if (recorded) {
              setItem(onboardedKey, true);
              setOnboarded(true);
            } else {
              setWelcomeDeferred(true);
            }
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  const { isAuthenticated, isLoading, user } = useAuth();

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

  // Keyed by user so no state leaks between accounts on a shared browser.
  return (
    <AppStateProvider key={user?.sub}>
      <ToastProvider>
        <ProfileProvider>
          <PlayerProvider>
            <DownloadsProvider>
              <CreateProvider>
                <Shell />
              </CreateProvider>
            </DownloadsProvider>
          </PlayerProvider>
        </ProfileProvider>
      </ToastProvider>
    </AppStateProvider>
  );
}
