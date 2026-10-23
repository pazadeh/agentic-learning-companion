import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { AppPage, AppState, ThemePreference } from '../types';
import { getItem, setItem, STORAGE_KEYS } from '../utils/storage';

export interface NavigationTarget {
  page: AppPage;
  /** `undefined` keeps the current series selection; `null` returns to the series list. */
  seriesId?: string | null;
}

type Action =
  | { type: 'SET_PAGE'; page: AppPage }
  | { type: 'SET_SELECTED_SERIES'; seriesId: string | null }
  | { type: 'NAVIGATE'; target: NavigationTarget }
  | { type: 'CONFIRM_NAVIGATION' }
  | { type: 'CANCEL_NAVIGATION' }
  | { type: 'SET_ONLINE'; online: boolean }
  | { type: 'TOGGLE_DRIVING_MODE' }
  | { type: 'SET_THEME'; theme: ThemePreference }
  | { type: 'SET_UNSAVED'; value: boolean };

interface InternalState extends AppState {
  pendingNavigation: NavigationTarget | null;
}

function initialState(): InternalState {
  return {
    currentPage: 'create',
    selectedSeriesId: null,
    isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    drivingMode: getItem<boolean>(STORAGE_KEYS.drivingMode, false),
    theme: getItem<ThemePreference>(STORAGE_KEYS.theme, 'system'),
    hasUnsavedChanges: false,
    pendingNavigation: null,
  };
}

function apply(state: InternalState, target: NavigationTarget): InternalState {
  return {
    ...state,
    currentPage: target.page,
    selectedSeriesId: target.seriesId === undefined ? state.selectedSeriesId : target.seriesId,
    pendingNavigation: null,
  };
}

function reducer(state: InternalState, action: Action): InternalState {
  switch (action.type) {
    case 'SET_PAGE':
      return { ...state, currentPage: action.page };
    case 'SET_SELECTED_SERIES':
      return { ...state, selectedSeriesId: action.seriesId };
    case 'NAVIGATE': {
      const { target } = action;
      const unchanged =
        target.page === state.currentPage &&
        (target.seriesId === undefined || target.seriesId === state.selectedSeriesId);
      if (unchanged) return state;
      // Every page/selection change passes this boundary so unsaved edits are never dropped.
      if (state.hasUnsavedChanges) return { ...state, pendingNavigation: target };
      return apply(state, target);
    }
    case 'CONFIRM_NAVIGATION':
      return state.pendingNavigation
        ? { ...apply(state, state.pendingNavigation), hasUnsavedChanges: false }
        : state;
    case 'CANCEL_NAVIGATION':
      return { ...state, pendingNavigation: null };
    case 'SET_ONLINE':
      return { ...state, isOnline: action.online };
    case 'TOGGLE_DRIVING_MODE': {
      const drivingMode = !state.drivingMode;
      setItem(STORAGE_KEYS.drivingMode, drivingMode);
      return { ...state, drivingMode };
    }
    case 'SET_THEME':
      setItem(STORAGE_KEYS.theme, action.theme);
      return { ...state, theme: action.theme };
    case 'SET_UNSAVED':
      return state.hasUnsavedChanges === action.value ? state : { ...state, hasUnsavedChanges: action.value };
    default:
      return state;
  }
}

interface AppStateContextValue {
  state: InternalState;
  dispatch: Dispatch<Action>;
  /** Guarded navigation: asks before discarding unsaved edits. */
  navigate: (target: NavigationTarget) => void;
}

const AppStateContext = createContext<AppStateContextValue | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    const goOnline = () => dispatch({ type: 'SET_ONLINE', online: true });
    const goOffline = () => dispatch({ type: 'SET_ONLINE', online: false });
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (state.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.theme);
  }, [state.theme]);

  // Browser close/reload uses the same app-wide dirty signal as in-app navigation.
  useEffect(() => {
    if (!state.hasUnsavedChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [state.hasUnsavedChanges]);

  const navigate = useCallback((target: NavigationTarget) => dispatch({ type: 'NAVIGATE', target }), []);
  const value = useMemo(() => ({ state, dispatch, navigate }), [navigate, state]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
