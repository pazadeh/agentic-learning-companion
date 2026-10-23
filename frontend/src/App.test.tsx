import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import type { Job, Lecture } from './types';

vi.mock('./services/cognito-auth', () => ({
  getCurrentUser: vi.fn(),
  signOut: vi.fn(),
  getIdToken: vi.fn(async () => 'token'),
}));

const lecture: Lecture = {
  lectureId: '22222222-2222-4222-8222-222222222222',
  title: 'Black holes 101',
  topic: 'Black holes',
  s3Key: 'audio/u/l/lecture.wav',
  durationMinutes: 12,
  createdAt: '2026-07-01T10:00:00Z',
  completionPercent: 40,
};

vi.mock('./services/api-client', () => ({
  ApiError: class ApiError extends Error {
    status = 500;
    code = 'api_error';
  },
  startJob: vi.fn(),
  getJobStatus: vi.fn(),
  getJobResult: vi.fn(),
  refreshAudioUrl: vi.fn(async () => ({ url: 'https://audio.example/lecture.wav', expires_in: 3600 })),
  recordPlayback: vi.fn(async () => ({ accepted: true })),
  getProfile: vi.fn(async () => ({
    explicit: {
      profession: '',
      expertiseAreas: [],
      learningGoals: [],
      learningStyle: 'examples',
      preferredDuration: 15,
      behavioralPersonalizationEnabled: true,
    },
    inferred: { enabled: true, topicInterests: [] },
    stats: { lecturesCompleted: 0, totalListeningSeconds: 0 },
    revision: 3,
    hasExplicitProfile: false,
  })),
  saveProfile: vi.fn(),
  resetProfileInferences: vi.fn(),
  pollJobUntilDone: vi.fn(),
  createSeriesDraft: vi.fn(),
  listLectures: vi.fn(async () => ({ lectures: [] })),
  getLecture: vi.fn(async () => ({ ...lecture, script: 'First paragraph.\n\nSecond paragraph.' })),
  listSeries: vi.fn(async () => ({ series: [] })),
  getSeries: vi.fn(),
  saveSeriesPlan: vi.fn(),
  approveSeries: vi.fn(),
  retrySeriesEpisode: vi.fn(),
  pollSeriesUntilSettled: vi.fn(),
}));

import { getCurrentUser } from './services/cognito-auth';
import * as api from './services/api-client';

const SUB = '11111111-1111-4111-8111-111111111111';
const mockedGetCurrentUser = vi.mocked(getCurrentUser);

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}

async function renderAuthed() {
  renderApp();
  await screen.findByRole('navigation', { name: 'Primary' });
}

const nav = (name: string) => within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('button', { name });

beforeEach(() => {
  vi.mocked(api.listLectures).mockResolvedValue({ lectures: [] });
});

describe('unauthenticated', () => {
  it('shows the login page', async () => {
    mockedGetCurrentUser.mockResolvedValue(null);
    renderApp();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });
});

describe('first use', () => {
  it('introduces the modes and asks for an explicit personalization choice', async () => {
    mockedGetCurrentUser.mockResolvedValue({ sub: SUB, email: 'user@example.com', emailVerified: true });
    vi.mocked(api.saveProfile).mockImplementation(async (explicit, revision) => ({
      explicit,
      inferred: { enabled: false, topicInterests: [] },
      stats: { lecturesCompleted: 0, totalListeningSeconds: 0 },
      revision: revision + 1,
      hasExplicitProfile: true,
    }));
    await renderAuthed();
    const dialog = screen.getByRole('dialog', { name: /personalized audio lesson/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    const start = await screen.findByRole('button', { name: 'Start learning' });
    await waitFor(() => expect(start).toBeDisabled());
    fireEvent.click(screen.getByLabelText(/No, only use my settings/));
    fireEvent.click(start);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ behavioralPersonalizationEnabled: false }),
      3
    );
  });
});

describe('authenticated', () => {
  beforeEach(() => {
    localStorage.setItem(`alc.onboarded.${SUB}`, 'true');
    mockedGetCurrentUser.mockResolvedValue({ sub: SUB, email: 'user@example.com', emailVerified: true });
  });

  it('opens on Create with clear modes and starter prompts', async () => {
    await renderAuthed();
    expect(nav('Create')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'What do you want to understand?' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Quick lecture/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Guided lecture/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Plan a series/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate lecture' })).toBeDisabled();
    expect(await screen.findByText('15 min · Examples')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Explain how mRNA vaccines work/ }));
    expect(screen.getByRole('textbox')).toHaveValue('Explain how mRNA vaccines work');
  });

  it('gives My series a direct way to start planning', async () => {
    await renderAuthed();
    fireEvent.click(nav('My series'));
    expect(screen.getByRole('heading', { name: 'My series' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Plan your first series' }));
    expect(nav('Create')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('radio', { name: /Plan a series/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Plan series' })).toBeInTheDocument();
  });

  it('shows filter-specific empty states in Library', async () => {
    await renderAuthed();
    fireEvent.click(nav('Library'));
    expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
    expect(await screen.findByText(/No lectures yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(screen.getByText(/No favorites yet/)).toBeInTheDocument();
    expect(screen.getByText('Favorites are saved on this device only.')).toBeInTheDocument();
  });

  it('keeps playback alive across navigation with a persistent mini player', async () => {
    vi.mocked(api.listLectures).mockResolvedValue({ lectures: [lecture] });
    await renderAuthed();
    fireEvent.click(nav('Library'));
    // Shown in both the Continue listening card and the lecture row.
    expect(await screen.findAllByText('40% complete · 7 min left')).toHaveLength(2);
    expect(screen.getByText('Continue listening')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume: Black holes 101' }));
    await waitFor(() =>
      expect(screen.getByTestId('audio-element')).toHaveAttribute('src', 'https://audio.example/lecture.wav')
    );
    expect(screen.getByRole('region', { name: 'Mini player' })).toBeInTheDocument();

    fireEvent.click(nav('You'));
    expect(await screen.findByRole('heading', { name: 'You' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Mini player' })).toBeInTheDocument();
    expect(screen.getByTestId('audio-element')).toHaveAttribute('src', 'https://audio.example/lecture.wav');

    fireEvent.click(screen.getByRole('button', { name: /Open player for Black holes 101/ }));
    const sheet = screen.getByRole('dialog', { name: 'Now playing' });
    expect(await within(sheet).findByText('Second paragraph.')).toBeInTheDocument();
  });

  it('asks before leaving You with unsaved changes', async () => {
    await renderAuthed();
    fireEvent.click(nav('You'));
    fireEvent.change(await screen.findByLabelText('Profession'), { target: { value: 'Pilot' } });
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();

    fireEvent.click(nav('Library'));
    const dialog = screen.getByRole('alertdialog', { name: 'Leave without saving?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Profession')).toHaveValue('Pilot');

    fireEvent.click(nav('Library'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
  });

  it('confirms before resetting learned preferences', async () => {
    await renderAuthed();
    fireEvent.click(nav('You'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('alertdialog', { name: 'Reset learned preferences?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.resetProfileInferences).not.toHaveBeenCalled();
  });

  it('shows a lightweight design state, not the generation pipeline, for guided turns', async () => {
    let finish: (job: Job) => void = () => undefined;
    vi.mocked(api.startJob).mockResolvedValue({ job_id: 'design-job', status: 'pending' });
    vi.mocked(api.pollJobUntilDone).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await renderAuthed();
    fireEvent.click(screen.getByRole('radio', { name: /Guided lecture/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Kubernetes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start designing' }));

    expect(await screen.findByText('Updating your lecture brief…')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Lecture generation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Updating your brief/ })).toBeInTheDocument();

    await act(async () => {
      finish({
        job_id: 'design-job',
        status: 'completed',
        progress: 100,
        result: {
          response: 'ok',
          design: {
            message: 'What is your goal?',
            readyForConfirmation: false,
            turn: 1,
            brief: {
              topic: 'Kubernetes',
              title: 'Kubernetes',
              learningObjective: '',
              knowledgeLevel: 'beginner',
              durationMinutes: 15,
              depth: 'standard',
              learningStyle: 'examples',
              tone: 'conversational',
              includeTopics: [],
              excludeTopics: [],
              exampleContext: '',
              reinforcement: 'recap',
              sourceFreshness: 'timeless',
              language: 'English',
            },
            question: {
              id: 'goal',
              prompt: 'What should you be able to do?',
              selection: 'single',
              allowCustomAnswer: true,
              choices: [
                { id: 'a', label: 'Understand', value: 'Understand it' },
                { id: 'b', label: 'Apply', value: 'Apply it' },
              ],
            },
          },
        },
      });
    });
    expect(await screen.findByRole('heading', { name: 'What should you be able to do?' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of up to 3')).toBeInTheDocument();
  });

  it('resumes an in-flight lecture after a reload and loads the result into the player', async () => {
    localStorage.setItem(
      `alc.create.${SUB}`,
      JSON.stringify({
        mode: 'quick',
        input: '',
        messages: [{ id: 'm1', role: 'user', content: 'Teach me about black holes', timestamp: 1 }],
        design: null,
        designRequest: '',
        designHistory: [],
        activeJob: { jobId: 'lecture-job', kind: 'lecture', prompt: 'Teach me about black holes', startedAt: 1 },
      })
    );
    let finish: (job: Job) => void = () => undefined;
    vi.mocked(api.pollJobUntilDone).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await renderAuthed();

    expect(screen.getByRole('progressbar', { name: 'Lecture generation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Creating lecture/ })).toBeInTheDocument();
    expect(api.pollJobUntilDone).toHaveBeenCalledWith('lecture-job', expect.any(Function), undefined, expect.any(AbortSignal));

    await act(async () => {
      finish({
        job_id: 'lecture-job',
        status: 'completed',
        progress: 100,
        result: { response: 'Here is your lecture.', lecture },
      });
    });
    expect(await screen.findByText('“Black holes 101” is ready.')).toBeInTheDocument();
    expect(screen.getByText('Here is your lecture.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Mini player' })).toBeInTheDocument();
  });

  it('starts exactly one job when Generate is activated twice quickly', async () => {
    vi.mocked(api.startJob).mockImplementation(() => new Promise(() => undefined));
    await renderAuthed();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain DNS' } });
    const generate = screen.getByRole('button', { name: 'Generate lecture' });
    fireEvent.click(generate);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(generate);
    expect(api.startJob).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Guided lecture/ })).toBeDisabled());
  });

  it('guards the series back link and the work pill against unsaved edits', async () => {
    vi.mocked(api.listSeries).mockResolvedValue({
      series: [
        {
          seriesId: 'series-1',
          title: 'Distributed systems',
          topic: 'Distributed systems',
          status: 'ready_for_approval',
          revision: 2,
          episodeCount: 2,
          completedEpisodeCount: 0,
          createdAt: '2026-07-01T00:00:00Z',
          updatedAt: '2026-07-01T00:00:00Z',
        },
      ],
    });
    vi.mocked(api.getSeries).mockResolvedValue({
      seriesId: 'series-1',
      title: 'Distributed systems',
      topic: 'Distributed systems',
      status: 'ready_for_approval',
      revision: 2,
      episodeCount: 2,
      completedEpisodeCount: 0,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
      prompt: 'Distributed systems',
      description: '',
      plan: {
        title: 'Distributed systems',
        description: '',
        episodes: [
          { title: 'Foundations', summary: '', order: 1, durationMinutes: 10 },
          { title: 'Consensus', summary: '', order: 2, durationMinutes: 10 },
        ],
      },
      episodes: [],
    });
    await renderAuthed();
    fireEvent.click(nav('My series'));
    fireEvent.click(await screen.findByRole('button', { name: /Distributed systems/ }));
    fireEvent.change(await screen.findByLabelText('Series title'), { target: { value: 'Edited title' } });

    fireEvent.click(screen.getByRole('button', { name: '← All series' }));
    expect(screen.getByRole('alertdialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Series title')).toHaveValue('Edited title');
  });

  it('records an opt-out when onboarding is skipped', async () => {
    localStorage.removeItem(`alc.onboarded.${SUB}`);
    vi.mocked(api.saveProfile).mockImplementation(async (explicit, revision) => ({
      explicit,
      inferred: { enabled: false, topicInterests: [] },
      stats: { lecturesCompleted: 0, totalListeningSeconds: 0 },
      revision: revision + 1,
      hasExplicitProfile: true,
    }));
    await renderAuthed();
    const dialog = screen.getByRole('dialog', { name: /personalized audio lesson/ });
    await waitFor(() => expect(api.getProfile).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ behavioralPersonalizationEnabled: false }), 3);
    expect(localStorage.getItem(`alc.onboarded.${SUB}`)).toBe('true');
  });

  it('fails a data export visibly instead of downloading partial data', async () => {
    vi.mocked(api.listSeries).mockRejectedValueOnce(new Error('down'));
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    await renderAuthed();
    fireEvent.click(nav('You'));
    fireEvent.click(await screen.findByRole('button', { name: /Export my data/ }));
    expect(await screen.findByText(/could not be exported completely/)).toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('attributes positions to the right lecture and reports listening when switching lectures', async () => {
    const second: Lecture = { ...lecture, lectureId: '33333333-3333-4333-8333-333333333333', title: 'Quasars', completionPercent: 0 };
    vi.mocked(api.listLectures).mockResolvedValue({ lectures: [lecture, second] });
    await renderAuthed();
    fireEvent.click(nav('Library'));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume: Black holes 101' }));
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement;
    await waitFor(() => expect(audio).toHaveAttribute('src'));
    Object.defineProperty(audio, 'duration', { configurable: true, value: 600 });
    fireEvent.loadedMetadata(audio);
    fireEvent.play(audio);
    audio.currentTime = 100;
    fireEvent.timeUpdate(audio);
    audio.currentTime = 102;
    fireEvent.timeUpdate(audio);

    fireEvent.click(screen.getByRole('button', { name: 'Play: Quasars' }));
    await waitFor(() => expect(api.refreshAudioUrl).toHaveBeenCalledTimes(2));
    const positions = JSON.parse(localStorage.getItem(`alc.positions.${SUB}`) ?? '{}');
    expect(positions[lecture.lectureId].seconds).toBe(102);
    expect(positions[second.lectureId]).toBeUndefined();
    await waitFor(() =>
      expect(api.recordPlayback).toHaveBeenCalledWith(
        lecture.lectureId,
        expect.objectContaining({ playedSeconds: 2, eventType: 'pause' })
      )
    );
  });

  it('keeps a failed request recoverable without polluting the conversation', async () => {
    vi.mocked(api.startJob).mockRejectedValueOnce(new Error('network'));
    await renderAuthed();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain DNS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate lecture' }));
    expect(await screen.findByText('The lecture could not start.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getAllByText('Explain DNS')).toHaveLength(1);
  });
});
