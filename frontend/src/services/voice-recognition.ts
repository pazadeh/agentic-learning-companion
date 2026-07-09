/** Thin wrapper around the browser SpeechRecognition API for voice input. */

interface SpeechRecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getCtor() !== null;
}

export interface VoiceCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}

export interface VoiceController {
  start: () => void;
  stop: () => void;
}

export function createSpeechRecognition(callbacks: VoiceCallbacks): VoiceController | null {
  const Ctor = getCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result) continue;
      callbacks.onTranscript(result[0].transcript, result.isFinal);
    }
  };
  recognition.onerror = (event) => callbacks.onError?.(event.error);
  recognition.onend = () => callbacks.onEnd?.();

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
  };
}
