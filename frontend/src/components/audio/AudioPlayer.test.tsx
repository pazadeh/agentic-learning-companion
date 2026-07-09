import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AudioPlayer } from './AudioPlayer';

describe('AudioPlayer', () => {
  it('renders an audio element with the given source', () => {
    render(<AudioPlayer src="https://example.com/lecture.mp3" />);
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement;
    expect(audio).toBeInTheDocument();
    expect(audio.getAttribute('src')).toBe('https://example.com/lecture.mp3');
  });

  it('shows a title when provided', () => {
    render(<AudioPlayer src="x.mp3" title="Black Holes 101" />);
    expect(screen.getByText('Black Holes 101')).toBeInTheDocument();
  });

  it('toggles play and pause', () => {
    render(<AudioPlayer src="x.mp3" />);
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement;
    const playBtn = screen.getByLabelText('Play');
    fireEvent.click(playBtn);
    expect(audio.play).toHaveBeenCalled();
    // Simulate the media firing 'play', which flips the button to Pause.
    fireEvent.play(audio);
    fireEvent.click(screen.getByLabelText('Pause'));
    expect(audio.pause).toHaveBeenCalled();
  });

  it('skips forward and back by 15s', () => {
    render(<AudioPlayer src="x.mp3" />);
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { configurable: true, value: 100 });
    audio.currentTime = 20;
    fireEvent.click(screen.getByLabelText('Forward 15 seconds'));
    expect(audio.currentTime).toBe(35);
    fireEvent.click(screen.getByLabelText('Back 15 seconds'));
    expect(audio.currentTime).toBe(20);
  });

  it('changes playback speed', () => {
    render(<AudioPlayer src="x.mp3" />);
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement;
    const select = screen.getByLabelText('Playback speed') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1.5' } });
    expect(audio.playbackRate).toBe(1.5);
  });

  it('applies driving-mode styling', () => {
    const { container } = render(<AudioPlayer src="x.mp3" drivingMode />);
    expect(container.querySelector('.audio-player--driving')).not.toBeNull();
  });

  it('reports progress on time updates', () => {
    const onProgress = vi.fn();
    render(<AudioPlayer src="x.mp3" onProgress={onProgress} />);
    const audio = screen.getByTestId('audio-element') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { configurable: true, value: 100 });
    audio.currentTime = 50;
    fireEvent.timeUpdate(audio);
    expect(onProgress).toHaveBeenCalledWith(50);
  });
});
