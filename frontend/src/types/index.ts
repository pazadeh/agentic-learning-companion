export type AppPage = 'create' | 'series' | 'library' | 'you';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  jobId?: string;
}

export interface ResolvedPreference<T = string | number> {
  value: T;
  source: 'current_request' | 'explicit' | 'inferred' | 'default';
  confidencePercent: number;
}

export interface PersonalizationUsed {
  learningStyle?: ResolvedPreference<'examples' | 'theory' | 'practical'>;
  knowledgeLevel?: ResolvedPreference<'beginner' | 'intermediate' | 'advanced'>;
  durationMinutes?: ResolvedPreference<number>;
  researchDepth?: ResolvedPreference<'standard' | 'deep'>;
}

export interface Lecture {
  lectureId: string;
  title: string;
  topic: string;
  s3Key: string;
  durationMinutes: number;
  createdAt: string;
  completionPercent?: number;
  listenedSeconds?: number;
  resumePositionSeconds?: number;
  lastListenedAt?: string;
  personalizationUsed?: PersonalizationUsed;
  audioProvider?: string;
  audioFormat?: 'wav' | 'mp3' | string;
  transcriptAvailable?: boolean;
  script?: string | null;
  seriesId?: string;
  episodeId?: string;
  episodeOrder?: number;
  offlineAvailable?: boolean;
  offlineBytes?: number;
  isFavorite?: boolean;
  /** Playable audio without a lecture record (no telemetry or detail lookups). */
  untracked?: boolean;
}

export interface UserProfile {
  email: string;
  profession: string;
  expertiseAreas: string[];
  learningGoals: string[];
  learningStyle: 'examples' | 'theory' | 'practical';
  preferredDuration: number;
  behavioralPersonalizationEnabled: boolean;
  lecturesCompleted: number;
  totalListeningTime: number;
}

export interface LectureResult {
  lectureId: string;
  title: string;
  topic?: string;
  s3Key: string;
  durationMinutes: number;
  createdAt?: string;
  personalizationUsed?: PersonalizationUsed;
  audioProvider?: string;
  audioFormat?: 'wav' | 'mp3' | string;
}

export interface LectureDesignBrief {
  topic: string;
  title: string;
  learningObjective: string;
  knowledgeLevel: 'beginner' | 'intermediate' | 'advanced';
  durationMinutes: number;
  depth: 'overview' | 'standard' | 'deep';
  learningStyle: 'examples' | 'theory' | 'practical' | 'story' | 'step-by-step';
  tone: string;
  includeTopics: string[];
  excludeTopics: string[];
  exampleContext: string;
  reinforcement: 'recap' | 'reflection' | 'memory-hooks' | 'none';
  sourceFreshness: 'current' | 'timeless';
  language: string;
  _designFinalized?: boolean;
}

export interface LectureDesignChoice {
  id: string;
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
}

export interface LectureDesignQuestion {
  id: string;
  prompt: string;
  selection: 'single' | 'multiple';
  allowCustomAnswer: boolean;
  choices: LectureDesignChoice[];
}

export interface LectureDesign {
  message: string;
  brief: LectureDesignBrief;
  readyForConfirmation: boolean;
  question: LectureDesignQuestion | null;
  turn: number;
}

export type GenerationStage =
  | 'queued'
  | 'preparing'
  | 'personalizing'
  | 'validating'
  | 'recalling'
  | 'profiling'
  | 'researching'
  | 'planning'
  | 'writing'
  | 'synthesizing'
  | 'uploading'
  | 'saving'
  | 'finalizing'
  | 'completed';

export interface Job {
  job_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  stage?: GenerationStage;
  stage_message?: string;
  stage_detail?: string;
  updated_at?: number;
  error?: string;
  result?: { response: string; lecture?: LectureResult; design?: LectureDesign };
}

export type SeriesStatus =
  | 'draft'
  | 'planning'
  | 'ready_for_approval'
  | 'generating'
  | 'attention'
  | 'completed'
  | 'failed';

export type SeriesEpisodeStatus =
  | 'planned'
  | 'pending'
  | 'queued'
  | 'researching'
  | 'writing'
  | 'synthesizing'
  | 'processing'
  | 'completed'
  | 'failed';

export interface SeriesPlanEpisode {
  episodeId?: string;
  title: string;
  summary: string;
  order: number;
  durationMinutes: number;
}

export interface SeriesPlan {
  title: string;
  description: string;
  episodes: SeriesPlanEpisode[];
}

export interface SeriesPlanUpdate {
  revision: number;
  plan: SeriesPlan;
}

export interface SeriesSummary {
  seriesId: string;
  title: string;
  topic: string;
  status: SeriesStatus;
  revision: number;
  episodeCount: number;
  completedEpisodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SeriesEpisode {
  episodeId: string;
  title: string;
  summary: string;
  order: number;
  durationMinutes: number;
  status: SeriesEpisodeStatus;
  progress: number;
  stage?: GenerationStage;
  stageMessage?: string;
  stageDetail?: string;
  attemptCount?: number;
  lectureId?: string;
  s3Key?: string;
  error?: string;
  retryable: boolean;
}

export interface SeriesDetail extends SeriesSummary {
  prompt: string;
  description: string;
  plan: SeriesPlan | null;
  episodes: SeriesEpisode[];
}

export interface InferredTrait<T = string | number> {
  value: T;
  confidencePercent: number;
  sampleCount: number;
}

export interface TopicInterest {
  topic: string;
  confidencePercent: number;
  sampleCount: number;
  lastObservedAt: string;
}

export interface InferredProfile {
  enabled: boolean;
  topicInterests: TopicInterest[];
  preferredDuration?: InferredTrait<number>;
  preferredPlaybackRate?: InferredTrait<number>;
  learningStyle?: InferredTrait<'examples' | 'theory' | 'practical'>;
  knowledgeLevel?: InferredTrait<'beginner' | 'intermediate' | 'advanced'>;
  stats?: {
    lecturesCompleted: number;
    totalListeningSeconds: number;
  };
}

export interface ProfileResponse {
  explicit: Omit<UserProfile, 'email' | 'lecturesCompleted' | 'totalListeningTime'> & {
    knowledgeLevels?: Record<string, string>;
  };
  inferred: InferredProfile;
  stats: {
    lecturesCompleted: number;
    totalListeningSeconds: number;
  };
  revision: number;
  hasExplicitProfile: boolean;
}

export interface PlaybackUpdate {
  playbackSessionId: string;
  sequence: number;
  playedSeconds: number;
  positionSeconds: number;
  mediaDurationSeconds: number;
  playbackRate: number;
  eventType: 'heartbeat' | 'pause' | 'ended';
  occurredAt: string;
}

export type ThemePreference = 'system' | 'light' | 'dark';

/** User-facing creation modes: generate now, shape it first, or plan several episodes. */
export type CreateMode = 'quick' | 'guided' | 'series';

export interface AppState {
  currentPage: AppPage;
  selectedSeriesId: string | null;
  isOnline: boolean;
  drivingMode: boolean;
  theme: ThemePreference;
  /** A page with unsaved edits asks before primary navigation discards them. */
  hasUnsavedChanges: boolean;
}

export interface AuthUser {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  error: string | null;
}
