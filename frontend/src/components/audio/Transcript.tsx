import { memo, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { usePlayer, usePlayerTime } from '../../contexts/PlayerContext';

interface Paragraph {
  text: string;
  start: number;
  end: number;
}

const ParagraphItem = memo(function ParagraphItem({
  paragraph,
  index,
  isCurrent,
  isTabStop,
  disabled,
  onSeek,
  onKeyDown,
  register,
}: {
  paragraph: Paragraph;
  index: number;
  isCurrent: boolean;
  isTabStop: boolean;
  disabled: boolean;
  onSeek: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
  register: (index: number, element: HTMLButtonElement | null) => void;
}) {
  return (
    <li>
      <button
        ref={(element) => register(index, element)}
        type="button"
        className={`transcript__paragraph ${isCurrent ? 'is-current' : ''}`}
        aria-current={isCurrent ? 'true' : undefined}
        tabIndex={isTabStop ? 0 : -1}
        onClick={() => onSeek(index)}
        onKeyDown={(event) => onKeyDown(event, index)}
        disabled={disabled}
      >
        {paragraph.text}
      </button>
    </li>
  );
});

/**
 * Follow-along transcript: highlights the estimated paragraph and seeks on activation.
 * One roving tab stop (↑/↓ between paragraphs) keeps long transcripts keyboard-friendly.
 */
export function Transcript({ script }: { script: string }) {
  const { seek } = usePlayer();
  const { currentTime, duration } = usePlayerTime();
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  const paragraphs = useMemo<Paragraph[]>(() => {
    const parts = script
      .split(/\n\s*\n|\n/)
      .map((part) => part.trim())
      .filter(Boolean);
    const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    let offset = 0;
    return parts.map((text) => {
      const start = offset / total;
      offset += text.length;
      return { text, start, end: offset / total };
    });
  }, [script]);

  const position = duration > 0 ? currentTime / duration : 0;
  const currentIndex = duration > 0 ? paragraphs.findIndex((p) => position >= p.start && position < p.end) : -1;
  const tabStop = focusIndex ?? Math.max(0, currentIndex);

  const onSeek = useMemo(
    () => (index: number) => {
      const paragraph = paragraphs[index];
      if (paragraph && duration > 0) seek(paragraph.start * duration);
    },
    [duration, paragraphs, seek]
  );

  const onKeyDown = useMemo(
    () => (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? paragraphs.length - 1 : index + delta;
      if ((delta === 0 && event.key !== 'Home' && event.key !== 'End') || target < 0 || target >= paragraphs.length) return;
      event.preventDefault();
      setFocusIndex(target);
      items.current[target]?.focus();
    },
    [paragraphs.length]
  );

  const register = useMemo(
    () => (index: number, element: HTMLButtonElement | null) => {
      items.current[index] = element;
    },
    []
  );

  return (
    <div className="transcript">
      <p className="transcript__hint">
        Select a paragraph to jump there (↑/↓ to move). Positions are estimated from the text.
      </p>
      <ol className="transcript__list">
        {paragraphs.map((paragraph, index) => (
          <ParagraphItem
            key={index}
            paragraph={paragraph}
            index={index}
            isCurrent={index === currentIndex}
            isTabStop={index === tabStop}
            disabled={!duration}
            onSeek={onSeek}
            onKeyDown={onKeyDown}
            register={register}
          />
        ))}
      </ol>
    </div>
  );
}
