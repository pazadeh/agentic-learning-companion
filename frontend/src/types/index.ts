export type AppPage = 'conversation' | 'history' | 'profile';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  jobId?: string;
}

export interface Lecture {
  lectureId: string;
  title: string;
  topic: string;
  s3Key: string;
  durationMinutes: number;
  createdAt: string;
  completionPercent?: number;
  isFavorite?: boolean;
}

export interface UserProfile {
  email: string;
  profession: string;
  expertiseAreas: string[];
  learningGoals: string[];
  learningStyle: 'examples' | 'theory' | 'practical';
  preferredDuration: number;
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
}

export interface Job {
  job_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  result?: { response: string; lecture?: LectureResult };
}

export interface AppState {
  currentPage: AppPage;
  messages: ChatMessage[];
  currentLecture: Lecture | null;
  audioUrl: string | null;
  isOnline: boolean;
  drivingMode: boolean;
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
