import { describe, expect, it } from 'vitest';
import { firstName, formatClock, formatDuration, formatStopwatch, greeting } from './labels';

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

describe('formatClock', () => {
  it('pads the minutes, so a column of times lines up', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9 * 60)).toBe('0:09');
    expect(formatClock(8 * 3600 + 5 * 60)).toBe('8:05');
  });
});

describe('formatStopwatch', () => {
  it('carries the seconds, padded', () => {
    expect(formatStopwatch(0)).toBe('0:00:00');
    expect(formatStopwatch(3600 + 62)).toBe('1:01:02');
  });

  it('never shows a negative counter', () => {
    expect(formatStopwatch(-5)).toBe('0:00:00');
  });
});

describe('greeting', () => {
  /** 09:00, 14:00 and 21:00 in Mexico City, which is UTC-6. */
  const MORNING = '2026-08-24T15:00:00Z';
  const AFTERNOON = '2026-08-24T20:00:00Z';
  const NIGHT = '2026-08-25T03:00:00Z';

  it('follows the hour of the employee zone, not the machine', () => {
    expect(greeting(MORNING, 'America/Mexico_City')).toBe('Buenos días');
    expect(greeting(AFTERNOON, 'America/Mexico_City')).toBe('Buenas tardes');
    expect(greeting(NIGHT, 'America/Mexico_City')).toBe('Buenas noches');
  });

  it('greets the same instant differently in a different zone', () => {
    // The whole reason the zone is a parameter: 15:00 UTC is the morning in
    // Mexico City and the afternoon in Madrid.
    expect(greeting(MORNING, 'Europe/Madrid')).toBe('Buenas tardes');
  });

  it('does not greet the night shift with good morning', () => {
    // Midnight is hour 0, which falls before the morning boundary rather than
    // past every boundary -- the case an `h12` format would get wrong by
    // reporting it as 12.
    expect(greeting('2026-08-24T06:00:00Z', 'America/Mexico_City')).toBe('Buenas noches');
  });

  it('says good morning rather than nothing when the timestamp is unusable', () => {
    expect(greeting('not a date', 'America/Mexico_City')).toBe('Buenos días');
  });
});

describe('firstName', () => {
  it('takes the first name out of a full one', () => {
    expect(firstName('Luis Eduardo Hernández Cruz')).toBe('Luis');
  });

  it('keeps a compound first name together', () => {
    expect(firstName('José Luis Ramírez')).toBe('José Luis');
    expect(firstName('maria fernanda soto')).toBe('maria fernanda');
  });

  it('does not invent a compound out of a name that is not one', () => {
    expect(firstName('Carlos Alberto Núñez')).toBe('Carlos');
  });

  it('does not turn a lone compound name into a surname', () => {
    expect(firstName('José')).toBe('José');
  });

  it('answers null when there is no name to use', () => {
    // The greeting drops the name rather than saying "Buenos días, null".
    expect(firstName(null)).toBeNull();
    expect(firstName('   ')).toBeNull();
  });
});
