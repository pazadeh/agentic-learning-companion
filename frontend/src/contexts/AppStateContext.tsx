import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { AppPage, AppState, ChatMessage, Lecture } from '../types';
import { getItem, setItem, STORAGE_KEYS } from '../utils/storage';

type Action =
  | { type: 'SET_PAGE'; page: AppPage }
  | { type: 'ADD_MESSAGE'; message: ChatMessage }
  | { type: 'SET_MESSAGES'; messages: ChatMessage[] }
  | { type: 'SET_LECTURE'; lecture: Lecture | null }
  | { type: 'SET_AUDIO_URL'; url: string | null }
  | { type: 'SET_SELECTED_SERIES'; seriesId: string | null }
  | { type: 'SET_ONLINE'; online: boolean }
  | { type: 'TOGGLE_DRIVING_MODE' };

const initialState: AppState = {
  currentPage: 'conversation',
  messages: [],
  currentLecture: null,
  audioUrl: null,
  selectedSeriesId: null,
  isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
  drivingMode: getItem<boolean>(STORAGE_KEYS.drivingMode, false),
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_PAGE':
      return { ...state, currentPage: action.page };
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages };
    case 'SET_LECTURE':
      return { ...state, currentLecture: action.lecture };
    case 'SET_AUDIO_URL':
      return { ...state, audioUrl: action.url };
    case 'SET_SELECTED_SERIES':
      return { ...state, selectedSeriesId: action.seriesId };
    case 'SET_ONLINE':
      return { ...state, isOnline: action.online };
    case 'TOGGLE_DRIVING_MODE': {
      const drivingMode = !state.drivingMode;
      setItem(STORAGE_KEYS.drivingMode, drivingMode);
      return { ...state, drivingMode };
    }
    default:
      return state;
  }
}

interface AppStateContextValue {
  state: AppState;
  dispatch: Dispatch<Action>;
}

const AppStateContext = createContext<AppStateContextValue | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

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

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
