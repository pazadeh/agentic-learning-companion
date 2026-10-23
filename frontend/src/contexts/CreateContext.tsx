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
import { useAppState } from './AppStateContext';
import { useAuth } from './AuthContext';
import { usePlayer } from './PlayerContext';
import { useToast } from './ToastContext';
import {
  ApiError,
  createSeriesDraft,
  getLecture,
  pollJobUntilDone,
  startJob,
} from '../services/api-client';
import { hasSeriesPotential, isExplicitSeriesRequest } from '../utils/seriesSuggestion';
import { lecturePrompt } from '../utils/lecturePrompt';
import { validateBrief } from '../utils/briefLabels';
import { getItem, removeItem, setItem, userKey } from '../utils/storage';
import type {
  ChatMessage,
  CreateMode,
  Job,
  Lecture,
  LectureDesign,
  LectureDesignBrief,
  LectureResult,
} from '../types';

type DesignTurn = { role: 'user' | 'assistant'; content: string };

export interface ActiveJob {
  jobId: string;
  kind: 'lecture' | 'design';
  prompt: string;
  startedAt: number;
  confirmedBrief?: LectureDesignBrief;
  designRequest?: string;
  designHistory?: DesignTurn[];
}

interface PersistedCreate {
  mode: CreateMode;
  input: string;
  messages: ChatMessage[];
  design: LectureDesign | null;
  designRequest: string;
  designHistory: DesignTurn[];
  activeJob: ActiveJob | null;
}

export interface CreateError {
  message: string;
  detail?: string;
  retry?: () => void;
}

export interface SeriesSuggestion {
  prompt: string;
  topic: string;
  /** `explicit`: several lectures requested in Quick mode; nothing started yet. */
  kind: 'explicit' | 'after_lecture';
}

interface SendOptions {
  forceSingle?: boolean;
  skipUserMessage?: boolean;
  forceMode?: CreateMode;
  confirmedBrief?: LectureDesignBrief;
}

interface CreateContextValue extends PersistedCreate {
  jobState: Job | null;
  busy: boolean;
  creatingSeries: boolean;
  error: CreateError | null;
  seriesSuggestion: SeriesSuggestion | null;
  setMode: (mode: CreateMode) => void;
  setInput: (value: string) => void;
  send: (text: string, options?: SendOptions) => Promise<void>;
  generateFromDesign: () => void;
  updateBrief: (brief: LectureDesignBrief) => void;
  startOver: () => void;
  clearConversation: () => void;
  createSuggestedSeries: () => Promise<void>;
  dismissSuggestion: () => void;
  dismissError: () => void;
}

const MAX_MESSAGES = 40;
const LEASE_MS = 15000;
const EMPTY: PersistedCreate = {
  mode: 'quick',
  input: '',
  messages: [],
  design: null,
  designRequest: '',
  designHistory: [],
  activeJob: null,
};

const CreateContext = createContext<CreateContextValue | undefined>(undefined);

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function toLecture(result: LectureResult): Lecture {
  return {
    lectureId: result.lectureId,
    title: result.title,
    topic: result.topic ?? '',
    s3Key: result.s3Key,
    durationMinutes: result.durationMinutes,
    createdAt: result.createdAt ?? new Date().toISOString(),
    audioProvider: result.audioProvider,
    audioFormat: result.audioFormat,
    personalizationUsed: result.personalizationUsed,
    completionPercent: 0,
  };
}

function notifySystem(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    new Notification(title, { body, icon: '/icon-192.png', tag: 'alc-lecture-ready' });
  } catch {
    // Notifications are optional.
  }
}

/**
 * Durable creation state: the conversation, guided-design brief, and in-flight
 * job survive navigation and reloads, and polling resumes automatically.
 */
export function CreateProvider({ children }: { children: ReactNode }) {
  const { state: appState, navigate } = useAppState();
  const { user } = useAuth();
  const player = usePlayer();
  const { showToast } = useToast();
  const storageKey = userKey(user?.sub ?? '', 'create');

  const [persisted, setPersisted] = useState<PersistedCreate>(() => ({
    ...EMPTY,
    ...getItem<Partial<PersistedCreate>>(storageKey, {}),
  }));
  const [jobState, setJobState] = useState<Job | null>(null);
  const [creatingSeries, setCreatingSeries] = useState(false);
  const [error, setError] = useState<CreateError | null>(null);
  const [seriesSuggestion, setSeriesSuggestion] = useState<SeriesSuggestion | null>(null);

  const [starting, setStarting] = useState(false);
  const stateRef = useRef(persisted);
  stateRef.current = persisted;
  const mounted = useRef(true);
  const watchToken = useRef(0);
  const watchAbort = useRef<AbortController | null>(null);
  // Synchronous lock: a second tap before startJob returns must not create another job.
  const startingRef = useRef(false);
  const playerRef = useRef(player);
  playerRef.current = player;
  const tabId = useRef(newId());
  const watchingJob = useRef<string | null>(null);
  const leaseKey = userKey(user?.sub ?? '', 'createLease');

  const update = useCallback((patch: Partial<PersistedCreate>) => {
    setPersisted((previous) => ({ ...previous, ...patch }));
  }, []);

  // Debounced persistence: typing doesn't serialize the conversation on every keystroke.
  const writeTimer = useRef<number | null>(null);
  const flushWrite = useCallback(() => {
    if (writeTimer.current !== null) {
      window.clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    setItem(storageKey, stateRef.current);
  }, [storageKey]);
  useEffect(() => {
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current);
    writeTimer.current = window.setTimeout(flushWrite, 300);
  }, [flushWrite, persisted]);
  useEffect(() => {
    window.addEventListener('pagehide', flushWrite);
    return () => {
      window.removeEventListener('pagehide', flushWrite);
      flushWrite();
    };
  }, [flushWrite]);

  const addMessage = useCallback((role: ChatMessage['role'], content: string, jobId?: string) => {
    setPersisted((previous) => ({
      ...previous,
      messages: [
        ...previous.messages,
        { id: newId(), role, content, timestamp: Date.now(), jobId },
      ].slice(-MAX_MESSAGES),
    }));
  }, []);

  const openSeries = useCallback(
    (seriesId: string) => navigate({ page: 'series', seriesId }),
    [navigate]
  );

  // Late-bound so retries inside watchJob always use the latest implementation.
  const sendRef = useRef<(text: string, options?: SendOptions) => Promise<void>>(async () => undefined);

  const finishLecture = useCallback(
    async (job: ActiveJob, result: Job) => {
      const response = result.result?.response ?? 'Your lecture is ready.';
      addMessage('assistant', response, job.jobId);
      const lectureResult = result.result?.lecture;
      if (!lectureResult?.s3Key) return;
      let lecture = toLecture(lectureResult);
      try {
        const detail = await getLecture(lectureResult.lectureId);
        lecture = { ...lecture, ...detail };
      } catch {
        // The transcript can load later from the player.
      }
      if (!mounted.current) return;
      // Never interrupt something the learner is already listening to.
      const busyListening = ['playing', 'buffering'].includes(playerRef.current.status);
      if (!busyListening) await playerRef.current.playLecture(lecture, { autoplay: false });
      const title = lecture.title || lecture.topic || 'Your lecture';
      showToast({
        message: `“${title}” is ready.`,
        tone: 'success',
        actionLabel: 'Play',
        onAction: () => void playerRef.current.playLecture(lecture, { autoplay: true }),
      });
      notifySystem('Your lecture is ready', title);
      if (job.confirmedBrief) {
        update({ design: null, designRequest: '', designHistory: [], mode: 'quick' });
      } else if (hasSeriesPotential(job.prompt)) {
        setSeriesSuggestion({ prompt: job.prompt, topic: lecture.topic || title, kind: 'after_lecture' });
      }
    },
    [addMessage, showToast, update]
  );

  const finishDesign = useCallback(
    (job: ActiveJob, result: Job) => {
      const nextDesign = result.result?.design;
      if (!nextDesign) throw new Error('The lecture designer returned no brief.');
      const history = job.designHistory ?? [];
      const assistantContext = nextDesign.question
        ? `${nextDesign.message}\nQuestion: ${nextDesign.question.prompt}\nChoices: ${nextDesign.question.choices
            .map((choice) => `${choice.label} (${choice.value})`)
            .join('; ')}`
        : nextDesign.message;
      update({
        design: nextDesign,
        designRequest: job.designRequest ?? job.prompt,
        designHistory: [...history, { role: 'assistant' as const, content: assistantContext.slice(0, 1000) }].slice(-6),
      });
      addMessage('assistant', nextDesign.message, job.jobId);
    },
    [addMessage, update]
  );

  // One tab owns polling for a job (lease); other tabs follow via storage events, so
  // completion toasts and player handoff happen exactly once.
  const tryLease = useCallback(
    (jobId: string, force = false) => {
      const lease = getItem<{ jobId: string; tabId: string; at: number } | null>(leaseKey, null);
      const heldElsewhere =
        lease && lease.jobId === jobId && lease.tabId !== tabId.current && Date.now() - lease.at < LEASE_MS;
      if (heldElsewhere && !force) return false;
      setItem(leaseKey, { jobId, tabId: tabId.current, at: Date.now() });
      return true;
    },
    [leaseKey]
  );

  const watchJob = useCallback(
    async (job: ActiveJob, options: { force?: boolean } = {}) => {
      if (!tryLease(job.jobId, options.force)) {
        watchingJob.current = null;
        setJobState({
          job_id: job.jobId,
          status: 'processing',
          progress: 0,
          stage: 'preparing',
          stage_message: 'Creating in another open tab',
          stage_detail: 'Progress and the result will appear here when it finishes.',
        });
        return;
      }
      watchingJob.current = job.jobId;
      watchToken.current += 1;
      const token = watchToken.current;
      watchAbort.current?.abort();
      const controller = new AbortController();
      watchAbort.current = controller;
      const current = () => mounted.current && token === watchToken.current && !controller.signal.aborted;
      try {
        const result = await pollJobUntilDone(
          job.jobId,
          (status) => {
            if (current()) setJobState(status);
          },
          undefined,
          controller.signal
        );
        if (!current()) return;
        if (job.kind === 'design') finishDesign(job, result);
        else await finishLecture(job, result);
      } catch (err) {
        if (!current()) return;
        const reason = err instanceof ApiError && err.code !== 'job_failed' ? ` ${err.message}` : '';
        setError({
          message:
            job.kind === 'design'
              ? `This design step did not finish.${reason}`
              : `The lecture could not be created.${reason}`,
          detail:
            job.kind === 'design'
              ? 'Your answers and brief are preserved.'
              : job.confirmedBrief
                ? 'Your confirmed brief is preserved, so you can retry without starting over.'
                : 'Your request is preserved.',
          retry: () =>
            void sendRef.current(job.prompt, {
              skipUserMessage: true,
              forceSingle: true,
              forceMode: job.kind === 'design' ? 'guided' : 'quick',
              confirmedBrief: job.confirmedBrief,
            }),
        });
        if (job.kind === 'lecture' && job.confirmedBrief) {
          showToast({ message: 'Lecture generation failed. Your brief is still in Create.', tone: 'error' });
        }
      } finally {
        if (token === watchToken.current && mounted.current) {
          watchingJob.current = null;
          removeItem(leaseKey);
          stateRef.current = { ...stateRef.current, activeJob: null };
          update({ activeJob: null });
          setJobState(null);
        }
      }
    },
    [finishDesign, finishLecture, leaseKey, showToast, tryLease, update]
  );

  // Keep the lease fresh while watching; take over a job whose owner tab went away.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const job = stateRef.current.activeJob;
      if (!job) return;
      if (watchingJob.current === job.jobId) tryLease(job.jobId, true);
      else void watchJob(job);
    }, LEASE_MS / 3);
    return () => window.clearInterval(interval);
  }, [tryLease, watchJob]);

  // Follow changes another tab makes to the same account's creation state.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey || !event.newValue) return;
      try {
        const next = { ...EMPTY, ...(JSON.parse(event.newValue) as Partial<PersistedCreate>) };
        if (watchingJob.current && next.activeJob?.jobId !== watchingJob.current) {
          // Never drop a job this tab is actively finishing.
          next.activeJob = stateRef.current.activeJob;
        }
        stateRef.current = next;
        setPersisted(next);
        if (!next.activeJob) setJobState(null);
      } catch {
        // Ignore malformed state from another tab.
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  // Resume an in-flight job after navigation, reload, or reopening the app.
  useEffect(() => {
    mounted.current = true;
    const job = stateRef.current.activeJob;
    if (job) {
      setJobState({ job_id: job.jobId, status: 'processing', progress: 0, stage: 'preparing' });
      void watchJob(job);
    }
    return () => {
      mounted.current = false;
      // Stop network polling and hand the job back; it resumes on the next mount or tab.
      watchAbort.current?.abort();
      if (watchingJob.current) removeItem(leaseKey);
      watchingJob.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = Boolean(persisted.activeJob) || creatingSeries || starting;

  const send = useCallback(
    async (text: string, options: SendOptions = {}) => {
      const trimmed = text.trim();
      const snapshot = stateRef.current;
      if (!trimmed || snapshot.activeJob || startingRef.current) return;
      if (!appState.isOnline) {
        setError({
          message: 'You are offline.',
          detail: 'Connect to the internet to create something new. Downloaded lectures still play from Library.',
        });
        return;
      }
      const mode = options.forceMode ?? (options.confirmedBrief ? 'quick' : snapshot.mode);
      setError(null);
      setSeriesSuggestion(null);
      if (!options.skipUserMessage) {
        addMessage('user', trimmed);
        update({ input: '' });
      }

      if (mode === 'quick' && !options.forceSingle && isExplicitSeriesRequest(trimmed)) {
        addMessage(
          'assistant',
          'That sounds like several lectures. I can plan an editable series for you to review first, or make a single lecture.'
        );
        setSeriesSuggestion({ prompt: trimmed, topic: trimmed, kind: 'explicit' });
        return;
      }

      startingRef.current = true;
      setStarting(true);
      const release = () => {
        startingRef.current = false;
        setStarting(false);
      };

      if (mode === 'series') {
        setCreatingSeries(true);
        try {
          const draft = await createSeriesDraft(trimmed);
          addMessage('assistant', `Started planning “${draft.title || draft.topic}”. Review the plan in My series.`);
          openSeries(draft.seriesId);
        } catch (err) {
          update({ input: trimmed });
          setError({
            message: err instanceof ApiError ? err.message : 'The series draft could not be created.',
            detail: 'Your request is back in the box.',
            retry: () => void sendRef.current(trimmed, { skipUserMessage: true, forceMode: 'series' }),
          });
        } finally {
          setCreatingSeries(false);
          release();
        }
        return;
      }

      try {
        let job: ActiveJob;
        if (mode === 'guided') {
          const designRequest = snapshot.designRequest || trimmed;
          const turn = Math.min(3, (snapshot.design?.turn ?? 0) + 1);
          const designHistory = [...snapshot.designHistory, { role: 'user' as const, content: trimmed.slice(0, 1000) }].slice(-6);
          const { job_id } = await startJob(trimmed, 'design', {
            request: designRequest,
            answer: trimmed,
            brief: snapshot.design?.brief,
            history: designHistory,
            turn,
          });
          job = { jobId: job_id, kind: 'design', prompt: trimmed, startedAt: Date.now(), designRequest, designHistory };
        } else {
          const { job_id } = await startJob(trimmed, 'lecture', undefined, options.confirmedBrief);
          job = { jobId: job_id, kind: 'lecture', prompt: trimmed, startedAt: Date.now(), confirmedBrief: options.confirmedBrief };
        }
        // Persist the job synchronously so the lock hands over to activeJob without a gap.
        stateRef.current = { ...stateRef.current, activeJob: job };
        update({ activeJob: job });
        setJobState({ job_id: job.jobId, status: 'pending', progress: 0, stage: 'queued' });
        release();
        await watchJob(job, { force: true });
      } catch (err) {
        release();
        setError({
          message:
            err instanceof ApiError
              ? err.message
              : mode === 'guided'
                ? 'This design step could not start.'
                : 'The lecture could not start.',
          detail: options.confirmedBrief ? 'Your confirmed brief is preserved.' : 'Nothing was lost.',
          retry: () =>
            void sendRef.current(trimmed, {
              ...options,
              skipUserMessage: true,
              forceSingle: true,
              forceMode: mode,
            }),
        });
      }
    },
    [addMessage, appState.isOnline, openSeries, update, watchJob]
  );
  sendRef.current = send;

  const generateFromDesign = useCallback(() => {
    const design = stateRef.current.design;
    if (!design?.readyForConfirmation) return;
    const problems = validateBrief(design.brief);
    if (problems.length) {
      setError({ message: problems[0] ?? 'This brief needs changes before generating.', detail: 'Use Edit brief to fix it.' });
      return;
    }
    addMessage('user', `Generate “${design.brief.title || design.brief.topic}”.`);
    void send(lecturePrompt(design.brief), {
      forceSingle: true,
      forceMode: 'quick',
      skipUserMessage: true,
      confirmedBrief: design.brief,
    });
  }, [addMessage, send]);

  const updateBrief = useCallback(
    (brief: LectureDesignBrief) => {
      const design = stateRef.current.design;
      if (design) update({ design: { ...design, brief } });
    },
    [update]
  );

  const startOver = useCallback(() => {
    if (stateRef.current.activeJob) return;
    update({ design: null, designRequest: '', designHistory: [], input: '' });
    setError(null);
  }, [update]);

  const clearConversation = useCallback(() => {
    if (stateRef.current.activeJob) return;
    update({ messages: [], design: null, designRequest: '', designHistory: [], input: '' });
    setError(null);
    setSeriesSuggestion(null);
  }, [update]);

  const createSuggestedSeries = useCallback(async () => {
    if (!seriesSuggestion || creatingSeries) return;
    setCreatingSeries(true);
    setError(null);
    try {
      const draft = await createSeriesDraft(seriesSuggestion.prompt);
      setSeriesSuggestion(null);
      openSeries(draft.seriesId);
    } catch (err) {
      setError({ message: err instanceof ApiError ? err.message : 'The series draft could not be created.' });
    } finally {
      setCreatingSeries(false);
    }
  }, [creatingSeries, openSeries, seriesSuggestion]);

  const dismissSuggestion = useCallback(() => {
    const suggestion = seriesSuggestion;
    setSeriesSuggestion(null);
    if (suggestion?.kind === 'explicit') {
      void send(suggestion.prompt, { forceSingle: true, skipUserMessage: true, forceMode: 'quick' });
    }
  }, [send, seriesSuggestion]);

  const value = useMemo<CreateContextValue>(
    () => ({
      ...persisted,
      jobState,
      busy,
      creatingSeries,
      error,
      seriesSuggestion,
      setMode: (mode) => update({ mode }),
      setInput: (input) => update({ input }),
      send,
      generateFromDesign,
      updateBrief,
      startOver,
      clearConversation,
      createSuggestedSeries,
      dismissSuggestion,
      dismissError: () => setError(null),
    }),
    [
      busy,
      clearConversation,
      createSuggestedSeries,
      creatingSeries,
      dismissSuggestion,
      error,
      generateFromDesign,
      jobState,
      persisted,
      send,
      seriesSuggestion,
      startOver,
      update,
      updateBrief,
    ]
  );

  return <CreateContext.Provider value={value}>{children}</CreateContext.Provider>;
}

export function useCreate(): CreateContextValue {
  const ctx = useContext(CreateContext);
  if (!ctx) throw new Error('useCreate must be used within a CreateProvider');
  return ctx;
}
