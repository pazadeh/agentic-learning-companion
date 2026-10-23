import { describe, expect, it } from 'vitest';
import { parseTopicList, validateBrief } from './briefLabels';
import type { LectureDesignBrief } from '../types';

const brief: LectureDesignBrief = {
  topic: 'Kubernetes',
  title: 'Kubernetes foundations',
  learningObjective: 'Deploy an application',
  knowledgeLevel: 'beginner',
  durationMinutes: 20,
  depth: 'standard',
  learningStyle: 'examples',
  tone: 'conversational',
  includeTopics: [],
  excludeTopics: [],
  exampleContext: '',
  reinforcement: 'recap',
  sourceFreshness: 'current',
  language: 'English',
};

describe('validateBrief', () => {
  it('accepts a valid brief', () => {
    expect(validateBrief(brief)).toEqual([]);
  });

  it('mirrors API limits for required text, duration, and topic lists', () => {
    const errors = validateBrief({
      ...brief,
      title: ' ',
      durationMinutes: 61,
      includeTopics: Array.from({ length: 13 }, (_, index) => `t${index}`),
    });
    expect(errors).toContain('Title is required.');
    expect(errors).toContain('Length must be a whole number from 1 to 60 minutes.');
    expect(errors).toContain('Include can list at most 12 topics.');
  });
});

describe('validateBrief against the job message cap', () => {
  it('requires a topic and rejects briefs whose generated prompt exceeds 2000 characters', () => {
    expect(validateBrief({ ...brief, topic: '' })).toContain('Topic is required.');
    const long = validateBrief({
      ...brief,
      learningObjective: 'o'.repeat(900),
      includeTopics: Array.from({ length: 6 }, (_, index) => `${index}${'i'.repeat(150)}`),
    });
    expect(long.join(' ')).toMatch(/too long to send \(\d+ of 2000 characters\)/);
  });
});

describe('parseTopicList', () => {
  it('splits, trims, and de-duplicates case-insensitively', () => {
    expect(parseTopicList('Pods, services,\n pods , ,Ingress')).toEqual(['Pods', 'services', 'Ingress']);
  });
});
