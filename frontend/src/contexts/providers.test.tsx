import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ToastProvider, useToast } from './ToastContext';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import type { Lecture } from '../types';

const SUB = '44444444-4444-4444-8444-444444444444';

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { sub: SUB, email: 'u@example.com', emailVerified: true }, logout: vi.fn() }),
}));
vi.mock('./ProfileContext', () => ({
  useProfile: () => ({ profile: null, status: 'ready', error: '', reload: vi.fn(), setProfile: vi.fn() }),
}));
vi.mock('../services/api-client', () => ({
  ApiError: class ApiError extends Error {},
  getLecture: vi.fn(),
  refreshAudioUrl: vi.fn(async () => ({ url: 'https://audio.example/a.wav', expires_in: 3600 })),
  recordPlayback: vi.fn(async () => ({ accepted: true })),
}));

const lecture: Lecture = {
  lectureId: '55555555-5555-4555-8555-555555555555',
  title: 'Tides',
  topic: 'Tides',
  s3Key: 'audio/k.wav',
  durationMinutes: 5,
  createdAt: '2026-07-01T00:00:00Z',
};

const record = {
  key: `${SUB}:${lecture.lectureId}`,
  ownerSub: SUB,
  lectureId: lecture.lectureId,
  lecture,
  script: 'Text',
  audio: new Blob(['x']),
  mimeType: 'audio/wav',
  bytes: 1,
  savedAt: '2026-07-01T00:00:00Z',
  schemaVersion: 1,
};

vi.mock('../services/offline-lectures', () => ({
  OfflineStorageError: class OfflineStorageError extends Error {},
  listOfflineLectures: vi.fn(async () => [record]),
  getOfflineLecture: vi.fn(async () => null),
  getOfflineAudioUrl: vi.fn(() => 'blob:offline'),
  removeOfflineLecture: vi.fn(async () => undefined),
  saveOfflineLecture: vi.fn(),
  downloadAudio: vi.fn(),
  revokeAllOfflineAudioUrls: vi.fn(),
  revokeOfflineAudioUrlValue: vi.fn(),
  formatOfflineBytes: () => '1 KB',
}));

import * as offline from '../services/offline-lectures';
import * as api from '../services/api-client';
import { AppStateProvider } from './AppStateContext';
import { DownloadsProvider } from './DownloadsContext';
import { PlayerProvider, usePlayer } from './PlayerContext';
import { DownloadButton } from '../components/audio/DownloadButton';

function Harness({ children }: { children: ReactNode }) {
  return (
    <AppStateProvider>
      <ToastProvider>
        <PlayerProvider>
          <DownloadsProvider>{children}</DownloadsProvider>
        </PlayerProvider>
      </ToastProvider>
    </AppStateProvider>
  );
}

describe('ToastProvider', () => {
  it('runs expiry callbacks for toasts pushed out of the visible queue', () => {
    const onExpire = vi.fn();
    let show: ReturnType<typeof useToast>['showToast'] = () => 0;
    function Grab() {
      show = useToast().showToast;
      return null;
    }
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>
    );
    act(() => {
      show({ message: 'first', onExpire });
      show({ message: 'second' });
      show({ message: 'third' });
      show({ message: 'fourth' });
    });
    expect(onExpire).toHaveBeenCalledOnce();
    expect(screen.queryByText('first')).not.toBeInTheDocument();
  });
});

describe('DownloadsProvider deferred removal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits the removal even when its toast is evicted', async () => {
    let show: ReturnType<typeof useToast>['showToast'] = () => 0;
    function Grab() {
      show = useToast().showToast;
      return null;
    }
    render(
      <Harness>
        <Grab />
        <DownloadButton lecture={lecture} />
      </Harness>
    );
    fireEvent.click(await screen.findByRole('button', { name: /Remove offline copy of Tides/ }));
    expect(screen.getByRole('button', { name: /Undo removing/ })).toBeInTheDocument();
    act(() => {
      show({ message: 'a' });
      show({ message: 'b' });
      show({ message: 'c' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    expect(offline.removeOfflineLecture).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Tides offline/ })).toBeInTheDocument());
  });

  it('keeps the existing copy when the learner saves again during the undo window', async () => {
    render(
      <Harness>
        <DownloadButton lecture={lecture} />
      </Harness>
    );
    fireEvent.click(await screen.findByRole('button', { name: /Remove offline copy of Tides/ }));
    fireEvent.click(screen.getByRole('button', { name: /Undo removing/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(offline.removeOfflineLecture).not.toHaveBeenCalled();
    expect(offline.downloadAudio).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Remove offline copy of Tides/ })).toBeInTheDocument();
  });
});

describe('PlayerProvider teardown', () => {
  it('saves the position and reports unsent listening when it unmounts (sign-out)', async () => {
    function Start() {
      const player = usePlayer();
      return (
        <button type="button" onClick={() => void player.playLecture(lecture)}>
          start
        </button>
      );
    }
    const { unmount } = render(
      <Harness>
        <Start />
      </Harness>
    );
    fireEvent.click(screen.getByRole('button', { name: 'start' }));
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement;
    await waitFor(() => expect(audio).toHaveAttribute('src'));
    Object.defineProperty(audio, 'duration', { configurable: true, value: 300 });
    fireEvent.loadedMetadata(audio);
    fireEvent.play(audio);
    audio.currentTime = 40;
    fireEvent.timeUpdate(audio);
    audio.currentTime = 42.5;
    fireEvent.timeUpdate(audio);
    unmount();
    const positions = JSON.parse(localStorage.getItem(`alc.positions.${SUB}`) ?? '{}');
    expect(positions[lecture.lectureId].seconds).toBe(43);
    await waitFor(() =>
      expect(api.recordPlayback).toHaveBeenCalledWith(
        lecture.lectureId,
        expect.objectContaining({ playedSeconds: 2.5, eventType: 'pause' })
      )
    );
  });
});

describe('ConfirmDialog focus containment', () => {
  it('cycles Tab inside the dialog and restores focus on close', () => {
    function Host({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">opener</button>
          <ConfirmDialog open={open} title="Sure?" message="m" confirmLabel="Yes" onConfirm={vi.fn()} onCancel={vi.fn()} />
        </>
      );
    }
    const { rerender } = render(<Host open={false} />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    rerender(<Host open />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const yes = screen.getByRole('button', { name: 'Yes' });
    expect(cancel).toHaveFocus();
    yes.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    rerender(<Host open={false} />);
    expect(opener).toHaveFocus();
  });
});
