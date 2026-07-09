import { describe, expect, it } from 'vitest';
import { getItem, removeItem, setItem } from './storage';

describe('storage', () => {
  it('round-trips a value', () => {
    setItem('k', { a: 1, b: 'two' });
    expect(getItem('k', null)).toEqual({ a: 1, b: 'two' });
  });

  it('returns fallback when missing', () => {
    expect(getItem('missing', 'fallback')).toBe('fallback');
  });

  it('returns fallback on malformed JSON', () => {
    localStorage.setItem('bad', '{not json');
    expect(getItem('bad', 42)).toBe(42);
  });

  it('removes a value', () => {
    setItem('k2', 'v');
    removeItem('k2');
    expect(getItem('k2', 'gone')).toBe('gone');
  });

  it('handles arrays', () => {
    setItem('list', [1, 2, 3]);
    expect(getItem<number[]>('list', [])).toEqual([1, 2, 3]);
  });
});
