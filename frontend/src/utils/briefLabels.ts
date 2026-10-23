import type { LectureDesignBrief } from '../types';
import { MAX_MESSAGE_LENGTH, lecturePrompt } from './lecturePrompt';

/** Human-readable labels for every value the lecture brief can carry. */
export const LEVEL_LABELS: Record<LectureDesignBrief['knowledgeLevel'], string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export const DEPTH_LABELS: Record<LectureDesignBrief['depth'], string> = {
  overview: 'Overview',
  standard: 'Standard',
  deep: 'Deep dive',
};

export const STYLE_LABELS: Record<LectureDesignBrief['learningStyle'], string> = {
  examples: 'Examples',
  theory: 'Theory',
  practical: 'Practical',
  story: 'Storytelling',
  'step-by-step': 'Step by step',
};

export const REINFORCEMENT_LABELS: Record<LectureDesignBrief['reinforcement'], string> = {
  recap: 'Recap at the end',
  reflection: 'Reflection questions',
  'memory-hooks': 'Memory hooks',
  none: 'No wrap-up',
};

export const FRESHNESS_LABELS: Record<LectureDesignBrief['sourceFreshness'], string> = {
  current: 'Use current sources',
  timeless: 'Timeless fundamentals',
};

export const PROFILE_STYLE_LABELS: Record<'examples' | 'theory' | 'practical', string> = {
  examples: 'Examples',
  theory: 'Theory',
  practical: 'Practical',
};

export function capitalize(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

/** Validate an edited brief against the same contract the API enforces. */
export function validateBrief(brief: LectureDesignBrief): string[] {
  const errors: string[] = [];
  const required: Array<[keyof LectureDesignBrief, string, number]> = [
    ['topic', 'Topic', 500],
    ['title', 'Title', 200],
    ['learningObjective', 'Goal', 1000],
    ['tone', 'Tone', 100],
    ['language', 'Language', 100],
  ];
  for (const [key, label, limit] of required) {
    const value = String(brief[key] ?? '').trim();
    if (!value) errors.push(`${label} is required.`);
    else if (value.length > limit) errors.push(`${label} must be at most ${limit} characters.`);
  }
  if (!Number.isInteger(brief.durationMinutes) || brief.durationMinutes < 1 || brief.durationMinutes > 60) {
    errors.push('Length must be a whole number from 1 to 60 minutes.');
  }
  for (const [key, label] of [
    ['includeTopics', 'Include'],
    ['excludeTopics', 'Exclude'],
  ] as const) {
    if (brief[key].length > 12) errors.push(`${label} can list at most 12 topics.`);
    if (brief[key].some((item) => item.length > 200)) errors.push(`${label} topics must be at most 200 characters.`);
  }
  if (brief.exampleContext.length > 500) errors.push('Example context must be at most 500 characters.');
  // Field limits allow more than the API accepts once combined into the job message.
  const promptLength = lecturePrompt(brief).length;
  if (errors.length === 0 && promptLength > MAX_MESSAGE_LENGTH) {
    errors.push(
      `This brief is too long to send (${promptLength} of ${MAX_MESSAGE_LENGTH} characters). Shorten the goal, example, or topic lists.`
    );
  }
  return errors;
}

/** Split a comma/newline list into the brief's clean topic array. */
export function parseTopicList(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const item = raw.trim();
    if (item && !seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      result.push(item);
    }
  }
  return result;
}
