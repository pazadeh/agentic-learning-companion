import type { Lecture } from '../types';

const DB_NAME = 'audio-learning-companion-offline';
const STORE_NAME = 'lectures';
const DB_VERSION = 1;
const SCHEMA_VERSION = 1;

export interface OfflineLectureRecord {
  key: string;
  ownerSub: string;
  lectureId: string;
  lecture: Lecture;
  script: string | null;
  audio: Blob;
  mimeType: string;
  bytes: number;
  savedAt: string;
  schemaVersion: number;
}

export class OfflineStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineStorageError';
  }
}

const objectUrls = new Map<string, string>();

function recordKey(ownerSub: string, lectureId: string): string {
  return `${ownerSub}:${lectureId}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('ownerSub', 'ownerSub', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new OfflineStorageError('Offline storage is unavailable.'));
  });
}

async function runRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result: T | undefined;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new OfflineStorageError('Offline storage failed.'));
      transaction.oncomplete = () => resolve(result as T);
      transaction.onabort = () => reject(transaction.error ?? new OfflineStorageError('Offline storage failed.'));
      transaction.onerror = () => reject(transaction.error ?? new OfflineStorageError('Offline storage failed.'));
    });
  } finally {
    db.close();
  }
}

export async function saveOfflineLecture(
  ownerSub: string,
  lecture: Lecture,
  script: string | null,
  audio: Blob
): Promise<OfflineLectureRecord> {
  if (!ownerSub || !lecture.lectureId || audio.size === 0) {
    throw new OfflineStorageError('The lecture audio could not be saved.');
  }
  const estimate = await navigator.storage?.estimate?.();
  if (
    estimate?.quota !== undefined &&
    estimate.usage !== undefined &&
    estimate.quota - estimate.usage < audio.size * 1.1
  ) {
    throw new OfflineStorageError('There is not enough browser storage for this lecture.');
  }
  const record: OfflineLectureRecord = {
    key: recordKey(ownerSub, lecture.lectureId),
    ownerSub,
    lectureId: lecture.lectureId,
    lecture: { ...lecture, script, transcriptAvailable: Boolean(script) },
    script,
    audio,
    mimeType: audio.type || (lecture.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav'),
    bytes: audio.size,
    savedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
  };
  try {
    await runRequest('readwrite', (store) => store.put(record));
    await navigator.storage?.persist?.();
    return record;
  } catch (error) {
    if ((error as DOMException)?.name === 'QuotaExceededError') {
      throw new OfflineStorageError('There is not enough browser storage for this lecture.');
    }
    throw error;
  }
}

export async function getOfflineLecture(
  ownerSub: string,
  lectureId: string
): Promise<OfflineLectureRecord | null> {
  const result = await runRequest<OfflineLectureRecord | undefined>('readonly', (store) =>
    store.get(recordKey(ownerSub, lectureId))
  );
  return result?.ownerSub === ownerSub && result.schemaVersion === SCHEMA_VERSION ? result : null;
}

export async function listOfflineLectures(ownerSub: string): Promise<OfflineLectureRecord[]> {
  const records = await runRequest<OfflineLectureRecord[]>('readonly', (store) =>
    store.index('ownerSub').getAll(ownerSub)
  );
  return records
    .filter((record) => record.ownerSub === ownerSub && record.schemaVersion === SCHEMA_VERSION)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function removeOfflineLecture(ownerSub: string, lectureId: string): Promise<void> {
  await runRequest('readwrite', (store) => store.delete(recordKey(ownerSub, lectureId)));
  revokeOfflineAudioUrl(ownerSub, lectureId);
}

export function getOfflineAudioUrl(record: OfflineLectureRecord): string {
  const existing = objectUrls.get(record.key);
  if (existing) return existing;
  const url = URL.createObjectURL(record.audio);
  objectUrls.set(record.key, url);
  return url;
}

export function revokeOfflineAudioUrl(ownerSub: string, lectureId: string): void {
  const key = recordKey(ownerSub, lectureId);
  const url = objectUrls.get(key);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(key);
}

export function revokeOfflineAudioUrlValue(url: string | null): void {
  if (!url?.startsWith('blob:')) return;
  for (const [key, value] of objectUrls) {
    if (value === url) {
      URL.revokeObjectURL(value);
      objectUrls.delete(key);
      return;
    }
  }
}

export function revokeAllOfflineAudioUrls(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

export function formatOfflineBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
