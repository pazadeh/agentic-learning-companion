import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LectureDesignPanel } from './LectureDesignPanel';
import { DesignProgress, GenerationProgress } from './GenerationProgress';
import type { LectureDesign } from '../../types';

const brief = {
  topic: 'Kubernetes',
  title: 'Kubernetes foundations',
  learningObjective: 'Deploy an application',
  knowledgeLevel: 'beginner' as const,
  durationMinutes: 20,
  depth: 'standard' as const,
  learningStyle: 'step-by-step' as const,
  tone: 'conversational',
  includeTopics: ['Pods', 'Deployments'],
  excludeTopics: [],
  exampleContext: 'A web application',
  reinforcement: 'memory-hooks' as const,
  sourceFreshness: 'current' as const,
  language: 'English',
};

function props(design: LectureDesign, overrides: Partial<Parameters<typeof LectureDesignPanel>[0]> = {}) {
  return {
    design,
    onAnswer: vi.fn(),
    onGenerate: vi.fn(),
    onRefine: vi.fn(),
    onUpdateBrief: vi.fn(),
    onStartOver: vi.fn(),
    ...overrides,
  };
}

const questionDesign = (turn: number, selection: 'single' | 'multiple' = 'single'): LectureDesign => ({
  message: 'Choose',
  brief,
  readyForConfirmation: false,
  turn,
  question: {
    id: 'goal',
    prompt: 'What should this help you do?',
    selection,
    allowCustomAnswer: true,
    choices: [
      { id: 'deploy', label: 'Deploy an app', value: 'Deploy an application', recommended: true },
      { id: 'architecture', label: 'Understand architecture', value: 'Understand architecture' },
    ],
  },
});

const finalDesign = (turn: number): LectureDesign => ({
  message: 'Ready',
  brief,
  readyForConfirmation: true,
  turn,
  question: null,
});

describe('LectureDesignPanel questions', () => {
  it('shows step progress and a live brief preview, and submits a quick choice', () => {
    const p = props(questionDesign(1));
    render(<LectureDesignPanel {...p} />);
    expect(screen.getByText('Step 1 of up to 3')).toBeInTheDocument();
    expect(screen.getByText(/20 min · Beginner · Step by step · Standard/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Deploy an app/ }));
    expect(p.onAnswer).toHaveBeenCalledWith('Deploy an application');
    expect(screen.getByText(/type a different answer/i)).toBeInTheDocument();
  });

  it('combines multiple selections and disables actions offline', () => {
    const p = props(questionDesign(2, 'multiple'));
    const { rerender } = render(<LectureDesignPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Deploy an app/ }));
    fireEvent.click(screen.getByRole('button', { name: /Understand architecture/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use 2 selected' }));
    expect(p.onAnswer).toHaveBeenCalledWith('Deploy an application, Understand architecture');
    rerender(<LectureDesignPanel {...p} disabled />);
    expect(screen.getByRole('button', { name: /Deploy an app/ })).toBeDisabled();
  });

  it('offers start over during questions', () => {
    const p = props(questionDesign(2));
    render(<LectureDesignPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(p.onStartOver).toHaveBeenCalledOnce();
  });
});

describe('LectureDesignPanel confirmation', () => {
  it('shows every generation field with human labels and a duration-specific CTA', () => {
    const p = props(finalDesign(3));
    render(<LectureDesignPanel {...p} />);
    expect(screen.getByText('Memory hooks')).toBeInTheDocument();
    expect(screen.getByText('Step by step')).toBeInTheDocument();
    expect(screen.getByText('Language')).toBeInTheDocument();
    expect(screen.getByText('Use current sources')).toBeInTheDocument();
    expect(screen.queryByText('memory-hooks')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refine with AI' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate 20-minute lecture' }));
    expect(p.onGenerate).toHaveBeenCalledOnce();
  });

  it('keeps the final brief editable after the last AI turn', () => {
    const p = props(finalDesign(3));
    render(<LectureDesignPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit brief/ }));
    fireEvent.change(screen.getByLabelText('Length (minutes)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Exclude (comma-separated)'), { target: { value: 'Helm, helm, Operators' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(p.onUpdateBrief).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: 10, excludeTopics: ['Helm', 'Operators'] })
    );
  });

  it('blocks invalid edits with explanations', () => {
    const p = props(finalDesign(2));
    render(<LectureDesignPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit brief/ }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Title is required.')).toBeInTheDocument();
    expect(p.onUpdateBrief).not.toHaveBeenCalled();
  });

  it('offers AI refinement only while turns remain', () => {
    const p = props(finalDesign(2));
    render(<LectureDesignPanel {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refine with AI' }));
    expect(p.onRefine).toHaveBeenCalledOnce();
    expect(screen.getByText(/1 AI turn left/)).toBeInTheDocument();
  });
});

describe('progress components', () => {
  it('announces lecture stage transitions, not raw percentages', () => {
    render(
      <GenerationProgress
        job={{ job_id: 'j', status: 'processing', progress: 37, stage: 'researching', stage_message: 'Researching' }}
      />
    );
    expect(screen.getByText('Step 2 of 5: Research')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Lecture generation' })).toHaveAttribute('aria-valuenow', '37');
    expect(screen.getByText(/You can leave this screen/)).toBeInTheDocument();
  });

  it('keeps design turns separate from the generation pipeline', () => {
    render(<DesignProgress turn={2} />);
    expect(screen.getByText('Updating your lecture brief…')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is generated until you confirm/)).toBeInTheDocument();
    expect(screen.queryByText('Research')).not.toBeInTheDocument();
  });
});
