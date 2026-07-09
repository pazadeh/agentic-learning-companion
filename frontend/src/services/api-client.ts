/** Authenticated API client for the backend.
 *
 * Attaches the Cognito ID token to every request, exposes typed helpers for each
 * endpoint, and provides a polling helper that resolves when a job finishes.
 */
import { getIdToken } from './cognito-auth';
import type { Job } from '../types';

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
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await getIdToken();
  if (!token) throw new ApiError('Not authenticated', 401, 'not_authenticated');

  const headers: Record<string, string> = {
    Authorization: token,
    'Content-Type': 'application/json',
  };

  const init: RequestInit = { method: options.method ?? 'GET', headers };
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
  lectures: Array<{
    lectureId: string;
    title: string;
    topic: string;
    s3Key: string;
    durationMinutes: number;
    createdAt: string;
  }>;
}

/** Fetch the signed-in user's saved lectures from the backend (cross-device). */
export function listLectures(): Promise<ListLecturesResponse> {
  return request<ListLecturesResponse>('/lectures');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a job until it completes or fails, reporting progress along the way. */
export async function pollJobUntilDone(
  jobId: string,
  onProgress?: (progress: number, status: Job['status']) => void,
  intervalMs = 2000
): Promise<Job> {
  // Guard against runaway polling (15 min worker timeout / 2s ≈ 450).
  const maxAttempts = 600;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await getJobStatus(jobId);
    onProgress?.(status.progress ?? 0, status.status);
    if (status.status === 'completed') {
      return getJobResult(jobId);
    }
    if (status.status === 'failed') {
      throw new ApiError('Lecture generation failed', 500, 'job_failed');
    }
    await sleep(intervalMs);
  }
  throw new ApiError('Timed out waiting for the lecture', 504, 'timeout');
}
