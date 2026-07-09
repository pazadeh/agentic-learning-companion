import { describe, expect, it } from 'vitest';
import { formatDate, formatDuration, truncate } from './format';

describe('formatDuration', () => {
  it('formats sub-minute', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('formats hours', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('handles invalid input', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });
});

describe('truncate', () => {
  it('returns text shorter than max unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
  });

  it('handles non-positive max', () => {
    expect(truncate('hello', 0)).toBe('');
  });
});

describe('formatDate', () => {
  it('formats an ISO string', () => {
    expect(formatDate('2026-06-26T00:00:00Z')).not.toBe('');
  });

  it('returns empty for invalid', () => {
    expect(formatDate('not-a-date')).toBe('');
  });
});
