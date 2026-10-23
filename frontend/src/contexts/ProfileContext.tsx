import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, getProfile } from '../services/api-client';
import type { ProfileResponse } from '../types';

type ProfileStatus = 'loading' | 'ready' | 'error';

interface ProfileContextValue {
  profile: ProfileResponse | null;
  status: ProfileStatus;
  error: string;
  reload: () => Promise<ProfileResponse | null>;
  /** Replace the cached profile after a successful save. */
  setProfile: (profile: ProfileResponse) => void;
}

const ProfileContext = createContext<ProfileContextValue | undefined>(undefined);

/** One shared cloud-profile cache for defaults, onboarding, playback, and settings. */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<ProfileResponse | null>(null);
  const [status, setStatus] = useState<ProfileStatus>('loading');
  const [error, setError] = useState('');
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const next = await getProfile();
      if (!mounted.current) return null;
      setProfileState(next);
      setStatus('ready');
      return next;
    } catch (err) {
      if (!mounted.current) return null;
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'Could not load your profile.');
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const setProfile = useCallback((next: ProfileResponse) => {
    setProfileState(next);
    setStatus('ready');
    setError('');
  }, []);

  const value = useMemo(
    () => ({ profile, status, error, reload, setProfile }),
    [error, profile, reload, setProfile, status]
  );
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within a ProfileProvider');
  return ctx;
}
