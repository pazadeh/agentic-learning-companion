import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EpisodeStatusList } from './EpisodeStatusList';
import { SeriesPlanEditor } from './SeriesPlanEditor';
import type { SeriesEpisode, SeriesPlan } from '../../types';

const stalledEpisode: SeriesEpisode = {
  episodeId: '11111111-1111-4111-8111-111111111111',
  title: 'Consensus',
  summary: 'How nodes agree.',
  order: 1,
  durationMinutes: 10,
  status: 'processing',
  progress: 10,
  attemptCount: 1,
  retryable: true,
};

describe('EpisodeStatusList', () => {
  it('makes a server-designated stalled episode retryable', () => {
    const onRetry = vi.fn();
    render(<EpisodeStatusList episodes={[stalledEpisode]} onPlay={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /Retry stalled episode/ }));
    expect(onRetry).toHaveBeenCalledWith(stalledEpisode);
  });

  it('labels the episode that is currently playing', () => {
    const ready: SeriesEpisode = { ...stalledEpisode, status: 'completed', progress: 100, retryable: false, s3Key: 'k' };
    render(<EpisodeStatusList episodes={[ready]} activeEpisodeId={ready.episodeId} onPlay={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Now playing/ })).toBeInTheDocument();
  });
});

describe('SeriesPlanEditor', () => {
  const plan: SeriesPlan = {
    title: 'Distributed systems',
    description: 'A description',
    episodes: [
      { title: 'Foundations', summary: 'Basics', order: 1, durationMinutes: 10 },
      { title: 'Applications', summary: 'Practice', order: 2, durationMinutes: 25 },
    ],
  };

  const render_ = (overrides: Partial<Parameters<typeof SeriesPlanEditor>[0]> = {}) => {
    const p = {
      plan,
      isDirty: false,
      onChange: vi.fn(),
      onSave: vi.fn(),
      onGenerate: vi.fn(),
      ...overrides,
    };
    render(<SeriesPlanEditor {...p} />);
    return p;
  };

  it('summarizes the plan and hides internal revision numbers', () => {
    render_();
    expect(screen.getByText('2 episodes · 35 min total')).toBeInTheDocument();
    expect(screen.queryByText(/Revision/)).not.toBeInTheDocument();
  });

  it('matches backend title limits and explains why generation is blocked', () => {
    render_({ plan: { ...plan, title: 'A'.repeat(201) } });
    expect(screen.getByText('Series title must be at most 200 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate 2 episodes' })).toBeDisabled();
    expect(screen.getByText('Fix the issues above to continue.')).toBeInTheDocument();
    expect(screen.getByLabelText('Series title')).toHaveAttribute('maxLength', '200');
  });

  it('combines save and generate when there are unsaved edits', () => {
    const p = render_({ isDirty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save and generate 2 episodes' }));
    expect(p.onGenerate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Distributed systems' }));
  });

  it('collapses episodes and expands one for editing', () => {
    render_();
    expect(screen.queryByLabelText('What this episode covers')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Foundations/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('What this episode covers')).toHaveValue('Basics');
  });
});
