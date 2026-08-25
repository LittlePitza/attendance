import { describe, expect, it } from 'vitest';
import { formatDuration } from './labels';

describe('formatDuration', () => {
  it('reads a working day the way a person would say it', () => {
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(59)).toBe('0 min');
    expect(formatDuration(90 * 60)).toBe('1 h 30 min');
    expect(formatDuration(8 * 3600)).toBe('8 h 0 min');
  });

  it('never shows a negative duration', () => {
    // Counters come from the database and cannot go negative, but a clock that
    // jumped is not a reason to render "-1 h" at somebody.
    expect(formatDuration(-120)).toBe('0 min');
  });
});
