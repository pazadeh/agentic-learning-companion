/** Format a number of seconds as m:ss (or h:mm:ss for long audio). */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** Truncate text to `max` characters, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Format an ISO date string (or epoch ms) as a short human date. */
export function formatDate(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Human total length for minute counts: "45 min", "2 h", "1 h 30 min". */
export function formatMinutes(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return '0 min';
  const rounded = Math.round(totalMinutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** Listening-progress copy that a learner can scan without decoding a bar. */
export function describeProgress(completionPercent: number | undefined, durationMinutes: number): string {
  const percent = Math.max(0, Math.min(100, Math.round(completionPercent ?? 0)));
  if (percent >= 95) return 'Completed';
  if (percent <= 0) return 'Not started';
  const remaining = Math.max(1, Math.round(durationMinutes * (1 - percent / 100)));
  return `${percent}% complete · ${remaining} min left`;
}

/** Stable, pleasant per-topic hue so lectures are recognizable at a glance. */
export function topicHue(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 360;
  }
  return hash;
}

export function topicInitial(text: string): string {
  const match = text.trim().match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? '•').toUpperCase();
}
