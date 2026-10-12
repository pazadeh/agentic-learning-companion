import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  approveSeries,
  createSeriesDraft,
  getJobStatus,
  pollJobUntilDone,
  pollSeriesUntilSettled,
  refreshAudioUrl,
  retrySeriesEpisode,
  saveSeriesPlan,
  startJob,
} from './api-client';

// Mock the auth module so api-client gets a deterministic token (or none).
vi.mock('./cognito-auth', () => ({
  getIdToken: vi.fn(),
}));
import { getIdToken } from './cognito-auth';

const mockedGetIdToken = vi.mocked(getIdToken);

function mockFetchOnce(status: number, body: unknown) {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
  mockedGetIdToken.mockResolvedValue('test-id-token');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth header', () => {
  it('attaches the id token', async () => {
    mockFetchOnce(202, { job_id: 'j1', status: 'pending' });
    await startJob('Teach me about Mars');
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const init = call![1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('test-id-token');
    expect(init.method).toBe('POST');
  });

  it('throws when not authenticated', async () => {
    mockedGetIdToken.mockResolvedValueOnce(null);
    await expect(getJobStatus('j1')).rejects.toMatchObject({
      code: 'not_authenticated',
      status: 401,
    });
  });
});

describe('error handling', () => {
  it('throws ApiError with code from body', async () => {
    mockFetchOnce(403, { error: 'content_blocked', message: 'nope' });
    await expect(startJob('bad')).rejects.toMatchObject({
      code: 'content_blocked',
      status: 403,
      message: 'nope',
    });
  });

  it('ApiError is an Error', () => {
    const err = new ApiError('x', 500, 'y');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
  });
});

describe('refreshAudioUrl', () => {
  it('posts the s3 key and returns the url', async () => {
    mockFetchOnce(200, { url: 'https://signed', expires_in: 3600 });
    const result = await refreshAudioUrl('audio/u/l/lecture.mp3');
    expect(result.url).toBe('https://signed');
  });
});

describe('pollJobUntilDone', () => {
  it('polls until completed then fetches result', async () => {
    mockFetchOnce(200, { job_id: 'j1', status: 'processing', progress: 50 });
    mockFetchOnce(200, { job_id: 'j1', status: 'completed', progress: 100 });
    mockFetchOnce(200, { job_id: 'j1', status: 'completed', progress: 100, result: { response: 'done' } });
    const onProgress = vi.fn();
    const job = await pollJobUntilDone('j1', onProgress, 0);
    expect(job.result?.response).toBe('done');
    expect(onProgress).toHaveBeenCalled();
  });

  it('throws when the job fails', async () => {
    mockFetchOnce(200, { job_id: 'j1', status: 'failed', progress: 100 });
    await expect(pollJobUntilDone('j1', undefined, 0)).rejects.toMatchObject({ code: 'job_failed' });
  });
});


describe('series lifecycle', () => {
  const seriesId = '11111111-1111-4111-8111-111111111111';
  const episodeId = '22222222-2222-4222-8222-222222222222';
  const plan = {
    title: 'Distributed Systems',
    description: 'A short series.',
    episodes: [
      { episodeId, title: 'Foundations', summary: 'Failure and time.', order: 1, durationMinutes: 10 },
      { title: 'Consensus', summary: 'Agreement.', order: 2, durationMinutes: 10 },
    ],
  };

  function series(status: 'planning' | 'generating' | 'completed') {
    return {
      seriesId,
      title: plan.title,
      topic: plan.title,
      status,
      revision: 1,
      episodeCount: 2,
      completedEpisodeCount: status === 'completed' ? 2 : 0,
      createdAt: '2026-07-14T00:00:00Z',
      updatedAt: '2026-07-14T00:00:00Z',
      prompt: plan.title,
      description: plan.description,
      plan,
      episodes: [],
    };
  }

  it('posts draft, plan, approval, and retry requests with the expected contracts', async () => {
    mockFetchOnce(202, series('planning'));
    await createSeriesDraft('Teach me distributed systems');

    mockFetchOnce(200, series('planning'));
    await saveSeriesPlan(seriesId, plan, 3);

    mockFetchOnce(202, series('generating'));
    await approveSeries(seriesId, 4);

    mockFetchOnce(202, series('generating'));
    await retrySeriesEpisode(seriesId, episodeId);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/series/drafts',
      `/series/${seriesId}/plan`,
      `/series/${seriesId}/approve`,
      `/series/${seriesId}/episodes/${episodeId}/retry`,
    ].map((path) => `${(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')}${path}`));

    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      message: 'Teach me distributed systems',
    });
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      plan,
      revision: 3,
    });
    expect(JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)).toEqual({ revision: 4 });
  });

  it('polls through planning and generation until the whole series completes', async () => {
    mockFetchOnce(200, series('planning'));
    mockFetchOnce(200, series('generating'));
    mockFetchOnce(200, series('completed'));
    const onUpdate = vi.fn();

    const result = await pollSeriesUntilSettled(seriesId, {
      intervalMs: 0,
      maxAttempts: 3,
      onUpdate,
    });

    expect(result.status).toBe('completed');
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it('supports bounded polling for callers that require a deadline', async () => {
    mockFetchOnce(200, series('generating'));
    mockFetchOnce(200, series('generating'));

    await expect(
      pollSeriesUntilSettled(seriesId, { intervalMs: 0, maxAttempts: 2 })
    ).rejects.toMatchObject({ code: 'series_timeout', status: 504 });
  });

  it('cancels before issuing a request when the page unmounts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pollSeriesUntilSettled(seriesId, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
