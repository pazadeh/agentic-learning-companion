import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LectureDesignPanel } from './LectureDesignPanel';
import type { LectureDesign } from '../../types';

const brief = {
  topic: 'Kubernetes',
  title: 'Kubernetes foundations',
  learningObjective: 'Deploy an application',
  knowledgeLevel: 'beginner' as const,
  durationMinutes: 20,
  depth: 'standard' as const,
  learningStyle: 'examples' as const,
  tone: 'conversational',
  includeTopics: ['Pods', 'Deployments'],
  excludeTopics: [],
  exampleContext: 'A web application',
  reinforcement: 'recap' as const,
  sourceFreshness: 'current' as const,
  language: 'English',
};

describe('LectureDesignPanel', () => {
  it('submits a quick-choice answer while preserving custom-answer guidance', () => {
    const onAnswer = vi.fn();
    const design: LectureDesign = {
      message: 'Choose a goal',
      brief,
      readyForConfirmation: false,
      turn: 1,
      question: {
        id: 'goal',
        prompt: 'What should this help you do?',
        selection: 'single',
        allowCustomAnswer: true,
        choices: [
          { id: 'deploy', label: 'Deploy an app', value: 'Deploy an application', recommended: true },
          { id: 'architecture', label: 'Understand architecture', value: 'Understand architecture' },
        ],
      },
    };
    render(<LectureDesignPanel design={design} onAnswer={onAnswer} onGenerate={vi.fn()} onRefine={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Deploy an app/ }));
    expect(onAnswer).toHaveBeenCalledWith('Deploy an application');
    expect(screen.getByText(/type a different answer/i)).toBeInTheDocument();
  });

  it('combines multiple selections and disables offline actions', () => {
    const onAnswer = vi.fn();
    const design: LectureDesign = {
      message: 'Choose scope',
      brief,
      readyForConfirmation: false,
      turn: 2,
      question: {
        id: 'scope',
        prompt: 'What should be included?',
        selection: 'multiple',
        allowCustomAnswer: true,
        choices: [
          { id: 'pods', label: 'Pods', value: 'Pods' },
          { id: 'services', label: 'Services', value: 'Services' },
        ],
      },
    };
    const { rerender } = render(
      <LectureDesignPanel design={design} onAnswer={onAnswer} onGenerate={vi.fn()} onRefine={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pods' }));
    fireEvent.click(screen.getByRole('button', { name: 'Services' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use selected topics' }));
    expect(onAnswer).toHaveBeenCalledWith('Pods, Services');

    rerender(
      <LectureDesignPanel design={design} disabled onAnswer={onAnswer} onGenerate={vi.fn()} onRefine={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Pods' })).toBeDisabled();
  });

  it('shows the final brief and requires explicit generation', () => {
    const onGenerate = vi.fn();
    const design: LectureDesign = {
      message: 'Ready',
      brief,
      readyForConfirmation: true,
      turn: 3,
      question: null,
    };
    render(<LectureDesignPanel design={design} onAnswer={vi.fn()} onGenerate={onGenerate} onRefine={vi.fn()} />);
    expect(screen.getByText('Deploy an application')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue refining' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate lecture' }));
    expect(onGenerate).toHaveBeenCalledOnce();
  });
});
