import type { LectureDesignBrief } from '../types';

/** The job API caps the `message` field at 2,000 characters. */
export const MAX_MESSAGE_LENGTH = 2000;

/** Readable restatement of a confirmed brief, sent as the lecture job message. */
export function lecturePrompt(brief: LectureDesignBrief): string {
  return [
    `Create a ${brief.durationMinutes}-minute ${brief.depth} lecture titled "${brief.title}" about ${brief.topic}.`,
    `Learning objective: ${brief.learningObjective || brief.topic}.`,
    `Audience level: ${brief.knowledgeLevel}. Teaching style: ${brief.learningStyle}. Tone: ${brief.tone}.`,
    brief.includeTopics.length ? `Must include: ${brief.includeTopics.join(', ')}.` : '',
    brief.excludeTopics.length ? `Exclude: ${brief.excludeTopics.join(', ')}.` : '',
    brief.exampleContext ? `Use this example context: ${brief.exampleContext}.` : '',
    `Finish with ${brief.reinforcement}. Use ${brief.language}. Source freshness: ${brief.sourceFreshness}.`,
  ]
    .filter(Boolean)
    .join(' ');
}
