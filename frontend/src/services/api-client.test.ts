import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getJobStatus, pollJobUntilDone, refreshAudioUrl, startJob } from './api-client';

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
