import { topicHue, topicInitial } from '../../utils/format';

/** Small generated cover so each lecture is recognizable without decoration noise. */
export function TopicArt({ text, size = 'md' }: { text: string; size?: 'sm' | 'md' | 'lg' }) {
  const hue = topicHue(text || 'lecture');
  return (
    <span
      className={`topic-art topic-art--${size}`}
      style={{ ['--topic-hue' as string]: String(hue) }}
      aria-hidden="true"
    >
      {topicInitial(text || 'Lecture')}
    </span>
  );
}
