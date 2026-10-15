/** Authenticated API client for the backend.
 *
 * Attaches the Cognito ID token to every request, exposes typed helpers for each
 * endpoint, and provides bounded polling helpers for asynchronous work.
 */
import { getIdToken } from './cognito-auth';
import type {
  Job,
  Lecture,
  PlaybackUpdate,
  ProfileResponse,
  SeriesDetail,
  SeriesPlan,
  SeriesStatus,
  SeriesSummary,
  UserProfile,
} from '../types';

const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = 'api_error') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  keepalive?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await getIdToken();
  if (!token) throw new ApiError('Not authenticated', 401, 'not_authenticated');

  const headers: Record<string, string> = {
    Authorization: token,
    'Content-Type': 'application/json',
  };

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    keepalive: options.keepalive,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal) init.signal = options.signal;

  const response = await fetch(`${API_URL}${path}`, init);

  let data: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    const errData = data as { error?: string; message?: string } | null;
    throw new ApiError(
      errData?.message ?? `Request failed (${response.status})`,
      response.status,
      errData?.error ?? 'api_error'
    );
  }

  return data as T;
}

export interface StartJobResponse {
  job_id: string;
  status: string;
}

export function startJob(message: string, action: 'lecture' | 'chat' = 'lecture'): Promise<StartJobResponse> {
  return request<StartJobResponse>('/jobs/start', { method: 'POST', body: { message, action } });
}

export function getJobStatus(jobId: string): Promise<Job> {
  return request<Job>(`/jobs/${encodeURIComponent(jobId)}/status`);
}

export function getJobResult(jobId: string): Promise<Job> {
  return request<Job>(`/jobs/${encodeURIComponent(jobId)}/result`);
}

export interface RefreshAudioResponse {
  url: string;
  expires_in: number;
}

export function refreshAudioUrl(s3Key: string): Promise<RefreshAudioResponse> {
  return request<RefreshAudioResponse>('/audio/refresh', { method: 'POST', body: { s3_key: s3Key } });
}

export interface ListLecturesResponse {
  lectures: Lecture[];
}

/** Fetch the signed-in user's saved lectures from the backend (cross-device). */
export function listLectures(): Promise<ListLecturesResponse> {
  return request<ListLecturesResponse>('/lectures');
}

export function getProfile(): Promise<ProfileResponse> {
  return request<ProfileResponse>('/profile');
}

export function saveProfile(
  profile: Omit<UserProfile, 'email' | 'lecturesCompleted' | 'totalListeningTime'>,
  revision: number
): Promise<ProfileResponse> {
  return request<ProfileResponse>('/profile', {
    method: 'PUT',
    body: { ...profile, revision },
  });
}

export function resetProfileInferences(): Promise<{ ok: boolean; resetAt: string }> {
  return request('/profile/inferences', { method: 'DELETE' });
}

export interface PlaybackResponse {
  accepted: boolean;
  duplicate?: boolean;
  listenedSeconds?: number;
  completionPercent?: number;
  resumePositionSeconds?: number;
}

export function recordPlayback(
  lectureId: string,
  update: PlaybackUpdate
): Promise<PlaybackResponse> {
  return request<PlaybackResponse>(`/lectures/${encodeURIComponent(lectureId)}/playback`, {
    method: 'POST',
    body: update,
    keepalive: true,
  });
}

export interface CreateSeriesDraftRequest {
  message: string;
}

export interface ListSeriesResponse {
  series: SeriesSummary[];
}

export function createSeriesDraft(message: string, signal?: AbortSignal): Promise<SeriesDetail> {
  return request<SeriesDetail>('/series/drafts', {
    method: 'POST',
    body: { message } satisfies CreateSeriesDraftRequest,
    signal,
  });
}

export function listSeries(signal?: AbortSignal): Promise<ListSeriesResponse> {
  return request<ListSeriesResponse>('/series', { signal });
}

export function getSeries(seriesId: string, signal?: AbortSignal): Promise<SeriesDetail> {
  return request<SeriesDetail>(`/series/${encodeURIComponent(seriesId)}`, { signal });
}

export function saveSeriesPlan(
  seriesId: string,
  plan: SeriesPlan,
  revision: number,
  signal?: AbortSignal
): Promise<SeriesDetail> {
  return request<SeriesDetail>(`/series/${encodeURIComponent(seriesId)}/plan`, {
    method: 'POST',
    body: { plan, revision },
    signal,
  });
}

export function approveSeries(
  seriesId: string,
  revision: number,
  signal?: AbortSignal
): Promise<SeriesDetail> {
  return request<SeriesDetail>(`/series/${encodeURIComponent(seriesId)}/approve`, {
    method: 'POST',
    body: { revision },
    signal,
  });
}

export function retrySeriesEpisode(
  seriesId: string,
  episodeId: string,
  signal?: AbortSignal
): Promise<SeriesDetail> {
  return request<SeriesDetail>(
    `/series/${encodeURIComponent(seriesId)}/episodes/${encodeURIComponent(episodeId)}/retry`,
    { method: 'POST', signal }
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms) as Promise<void>;
  if (signal.aborted) return Promise.reject(new DOMException('Polling was cancelled', 'AbortError'));

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Polling was cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Poll a job until it completes or fails, reporting progress along the way. */
export async function pollJobUntilDone(
  jobId: string,
  onUpdate?: (job: Job) => void,
  intervalMs = 2000
): Promise<Job> {
  // Guard against runaway polling (20 minutes at the default interval).
  const maxAttempts = 600;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await getJobStatus(jobId);
    onUpdate?.(status);
    if (status.status === 'completed') {
      return getJobResult(jobId);
    }
    if (status.status === 'failed') {
      throw new ApiError(status.error ?? 'Lecture generation failed', 500, 'job_failed');
    }
    await sleep(intervalMs);
  }
  throw new ApiError('Timed out waiting for the lecture', 504, 'timeout');
}

export interface PollSeriesOptions {
  signal?: AbortSignal;
  onUpdate?: (series: SeriesDetail) => void;
  intervalMs?: number;
  /** Omit to poll until the series settles or the AbortSignal is cancelled. */
  maxAttempts?: number;
  pollWhile?: readonly SeriesStatus[];
}

/**
 * Poll a series while it is doing asynchronous planning or generation work.
 * Polling is bounded and aborts both in-flight requests and the delay between them.
 */
export async function pollSeriesUntilSettled(
  seriesId: string,
  options: PollSeriesOptions = {}
): Promise<SeriesDetail> {
  const {
    signal,
    onUpdate,
    intervalMs = 2000,
    maxAttempts,
    pollWhile = ['planning', 'generating'],
  } = options;

  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
    throw new ApiError('maxAttempts must be a positive integer', 400, 'invalid_poll_limit');
  }

  let attempt = 0;
  while (maxAttempts === undefined || attempt < maxAttempts) {
    if (signal?.aborted) throw new DOMException('Polling was cancelled', 'AbortError');
    const series = await getSeries(seriesId, signal);
    onUpdate?.(series);
    if (!pollWhile.includes(series.status)) return series;

    attempt += 1;
    if (maxAttempts === undefined || attempt < maxAttempts) {
      await cancellableSleep(intervalMs, signal);
    }
  }

  throw new ApiError('Timed out waiting for the series', 504, 'series_timeout');
}
