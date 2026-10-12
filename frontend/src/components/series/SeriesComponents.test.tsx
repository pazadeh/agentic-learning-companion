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
    render(
      <EpisodeStatusList
        episodes={[stalledEpisode]}
        onPlay={vi.fn()}
        onRetry={onRetry}
      />
    );

    const retry = screen.getByRole('button', { name: 'Retry stalled episode' });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith(stalledEpisode);
  });
});

describe('SeriesPlanEditor', () => {
  const plan: SeriesPlan = {
    title: 'A'.repeat(201),
    description: 'A description',
    episodes: [
      { title: 'Foundations', summary: 'Basics', order: 1, durationMinutes: 10 },
      { title: 'Applications', summary: 'Practice', order: 2, durationMinutes: 10 },
    ],
  };

  it('matches backend title limits and blocks invalid approval', () => {
    render(
      <SeriesPlanEditor
        plan={plan}
        revision={1}
        isDirty={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onApprove={vi.fn()}
      />
    );

    expect(screen.getByText('Series title must be at most 200 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and generate' })).toBeDisabled();
    expect(screen.getByLabelText('Series title')).toHaveAttribute('maxLength', '200');
  });
});
