import { describe, expect, it } from 'vitest';
import type { MyDay, MySummary, SummaryDay } from '../../lib/types';
import { chartCeiling, liveCounters, recentDays, runningCounter, weekToDate } from './live';

const FETCHED_AT = 1_787_670_000_000;

function day(overrides: Partial<MyDay> = {}): MyDay {
  return {
    server_time: '2026-08-24T15:00:00Z',
    employee_id: '30000000-0000-4000-8000-000000000001',
    date: '2026-08-24',
    time_zone: 'America/Mexico_City',
    state: 'working',
    next_actions: ['break_start', 'clock_out'],
    worked_seconds: 3600,
    break_seconds: 600,
    counting: 'worked',
    counting_since: '2026-08-24T14:00:00Z',
    worked_seconds_live: 3600,
    break_seconds_live: 600,
    expected_seconds: 8 * 3600,
    opened_at: '2026-08-24T14:00:00Z',
    closed_at: null,
    last_heartbeat: null,
    has_offline: false,
    needs_review: false,
    schedule: null,
    punches: [],
    ...overrides,
  };
}

describe('liveCounters', () => {
  it('advances only the counter the database says is running', () => {
    const counters = liveCounters(day({ counting: 'worked' }), FETCHED_AT, FETCHED_AT + 90_000);

    expect(counters.worked).toBe(3600 + 90);
    expect(counters.paused).toBe(600);
  });

  it('advances the break instead when that is what is running', () => {
    const counters = liveCounters(
      day({ state: 'on_break', counting: 'break' }),
      FETCHED_AT,
      FETCHED_AT + 90_000,
    );

    expect(counters.worked).toBe(3600);
    expect(counters.paused).toBe(600 + 90);
  });

  it('moves neither when nothing is running', () => {
    // A finished day has an exact length. Nothing about it should keep growing
    // because the window was left open, and `counting: null` is the database
    // saying so -- the screen never works that out from the state itself.
    const counters = liveCounters(
      day({ state: 'finished', counting: null, counting_since: null }),
      FETCHED_AT,
      FETCHED_AT + 3_600_000,
    );

    expect(counters.worked).toBe(3600);
    expect(counters.paused).toBe(600);
  });

  it('never runs backwards when the device clock jumps', () => {
    // A machine that resynchronised its clock mid-shift can hand back a `now`
    // that is earlier than the moment the answer arrived. A counter that went
    // down would be read as the record being wrong.
    const counters = liveCounters(day(), FETCHED_AT, FETCHED_AT - 500_000);

    expect(counters.worked).toBe(3600);
  });

  it('measures from when the answer arrived, not from the server clock it carries', () => {
    // The device is an hour ahead of the server. Only the difference between
    // two readings of the device's own clock is used, so the counter is right
    // anyway -- which is the entire reason `fetchedAt` exists.
    const skewed = Date.parse('2026-08-24T15:00:00Z') + 3_600_000;
    const counters = liveCounters(day(), skewed, skewed + 120_000);

    expect(counters.worked).toBe(3600 + 120);
  });

  it('falls back to the settled counters when the database predates the fields', () => {
    // The window between a merged deploy and its migration. `my_day()` still
    // answers, without the five fields this screen was built around. Read as
    // present they arrive `undefined`, and `undefined + 0` is `NaN` -- on the
    // largest figure on the screen, in front of somebody about to clock in.
    const older = {
      server_time: '2026-08-24T15:00:00Z',
      employee_id: '30000000-0000-4000-8000-000000000001',
      date: '2026-08-24',
      time_zone: 'America/Mexico_City',
      state: 'working',
      next_actions: ['break_start', 'clock_out'],
      worked_seconds: 3600,
      break_seconds: 600,
      opened_at: '2026-08-24T14:00:00Z',
      closed_at: null,
      last_heartbeat: null,
      has_offline: false,
      needs_review: false,
      schedule: null,
      punches: [],
    } satisfies MyDay;

    const counters = liveCounters(older, FETCHED_AT, FETCHED_AT + 90_000);

    // Exactly the old behaviour: the counter holds still between punches. Wrong,
    // and readable, which is the trade worth making for the minutes it lasts.
    expect(counters.worked).toBe(3600);
    expect(counters.paused).toBe(600);
    expect(counters.progress).toBeNull();
    expect(Number.isNaN(counters.worked)).toBe(false);
  });

  it('reports nothing running when the field is absent, not something', () => {
    // `day.counting !== null` is true for `undefined`, which would show a
    // finished day a ticking second on a number that can never change again.
    const { counting, ...withoutCounting } = day();
    expect(runningCounter(withoutCounting)).toBeNull();
    expect(runningCounter(day({ counting: 'break' }))).toBe('break');
  });

  it('reports no progress on a day with no schedule', () => {
    expect(liveCounters(day({ expected_seconds: null }), FETCHED_AT, FETCHED_AT).progress).toBeNull();
  });

  it('reports progress past the target rather than capping it', () => {
    // The ring clamps what it draws. The figure itself stays true, because a
    // long day is a fact and rounding it down to "exactly enough" hides it.
    const counters = liveCounters(
      day({ worked_seconds_live: 10 * 3600, counting: null }),
      FETCHED_AT,
      FETCHED_AT,
    );

    expect(counters.progress).toBeCloseTo(1.25);
  });
});

function summaryDay(date: string, overrides: Partial<SummaryDay> = {}): SummaryDay {
  return {
    date,
    scheduled: true,
    state: 'finished',
    worked_seconds: 8 * 3600,
    break_seconds: 3600,
    expected_seconds: 8 * 3600,
    entry_expected: '09:00',
    opened_at: `${date}T15:00:00Z`,
    closed_at: `${date}T23:00:00Z`,
    has_offline: false,
    late: false,
    ...overrides,
  };
}

function summary(series: readonly SummaryDay[], to: string): MySummary {
  return {
    server_time: `${to}T15:00:00Z`,
    time_zone: 'America/Mexico_City',
    from: series[0]?.date ?? to,
    to,
    days: series.length,
    worked_seconds: 0,
    break_seconds: 0,
    expected_seconds: 0,
    days_scheduled: 0,
    days_worked: 0,
    days_complete: 0,
    late_days: 0,
    on_time_days: 0,
    absent_days: 0,
    punctuality_pct: null,
    average_entry: null,
    streak_days: 0,
    offline_days: 0,
    no_connection_alerts: 0,
    expired_sessions: 0,
    weeks: [],
    series,
  };
}

describe('weekToDate', () => {
  it('counts from Monday, and not from seven days ago', () => {
    // 2026-08-26 is a Wednesday. Monday is the 24th, so the Friday before it
    // is outside the week however recent it is.
    const week = weekToDate(
      summary(
        [
          summaryDay('2026-08-21'),
          summaryDay('2026-08-24'),
          summaryDay('2026-08-25'),
          summaryDay('2026-08-26', { worked_seconds: 4 * 3600, state: 'working' }),
        ],
        '2026-08-26',
      ),
    );

    expect(week.worked).toBe(20 * 3600);
    expect(week.expected).toBe(24 * 3600);
    expect(week.days).toBe(3);
  });

  it('treats Sunday as the end of its week, not the start of the next', () => {
    // 2026-08-30 is a Sunday. Its Monday is the 24th, six days earlier -- the
    // case a naive "day of week minus one" gets exactly backwards.
    const week = weekToDate(
      summary([summaryDay('2026-08-24'), summaryDay('2026-08-30')], '2026-08-30'),
    );

    expect(week.days).toBe(2);
  });

  it('counts a day as worked only once there is an entry on it', () => {
    const week = weekToDate(
      summary(
        [summaryDay('2026-08-24', { opened_at: null, worked_seconds: 0, state: 'not_started' })],
        '2026-08-24',
      ),
    );

    expect(week.days).toBe(0);
    // The expectation stands whether or not anybody turned up: that is what
    // makes an absence visible instead of quietly reducing the target.
    expect(week.expected).toBe(8 * 3600);
  });
});

describe('chartCeiling', () => {
  it('takes the taller of the two series, so a short day looks short', () => {
    expect(
      chartCeiling([
        summaryDay('2026-08-24', { worked_seconds: 2 * 3600 }),
        summaryDay('2026-08-25', { worked_seconds: 3 * 3600, expected_seconds: 9 * 3600 }),
      ]),
    ).toBe(9 * 3600);
  });

  it('never returns zero, so an empty fortnight is still divisible', () => {
    expect(
      chartCeiling([summaryDay('2026-08-24', { worked_seconds: 0, expected_seconds: 0 })]),
    ).toBeGreaterThan(0);
  });
});

describe('recentDays', () => {
  it('takes the end of the series, which is the recent end', () => {
    const series = ['2026-08-20', '2026-08-21', '2026-08-22'].map((date) => summaryDay(date));
    expect(recentDays(summary(series, '2026-08-22'), 2).map((day) => day.date)).toEqual([
      '2026-08-21',
      '2026-08-22',
    ]);
  });

  it('returns everything there is when the series is shorter than asked for', () => {
    const series = [summaryDay('2026-08-22')];
    expect(recentDays(summary(series, '2026-08-22'), 14)).toHaveLength(1);
  });
});
