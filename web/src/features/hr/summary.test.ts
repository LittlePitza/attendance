import { describe, expect, it } from 'vitest';
import type { OpenAlert, TeamMember, WorkdayState } from '../../lib/types';
import {
  countBySeverity,
  countable,
  cumulativeArrivals,
  departmentsOf,
  employeesWithAlerts,
  entryHistogram,
  filterAlerts,
  filterTeam,
  summarise,
} from './summary';

const ZONE = 'America/Mexico_City';

function member(over: Partial<TeamMember> & { employee_id: string }): TeamMember {
  return {
    employee_name: 'Ana Ruiz',
    department: 'Sistemas',
    work_date: '2026-08-24',
    state: 'working',
    opened_at: null,
    closed_at: null,
    worked_seconds: 0,
    break_seconds: 0,
    last_heartbeat: null,
    has_offline: false,
    needs_review: false,
    entry_expected: '09:00:00',
    exit_expected: '18:00:00',
    ...over,
  };
}

describe('summarise', () => {
  it('counts every state, including the ones nobody is in', () => {
    const summary = summarise([
      member({ employee_id: '1', state: 'working' }),
      member({ employee_id: '2', state: 'working' }),
      member({ employee_id: '3', state: 'on_break' }),
      member({ employee_id: '4', state: 'not_started' }),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.byState).toEqual({
      working: 2,
      on_break: 1,
      not_started: 1,
      // Present and zero: the bar and the legend both render every state, and a
      // missing key would render as blank rather than as none.
      finished: 0,
    });
  });

  it('adds up worked and break time across the team', () => {
    const summary = summarise([
      member({ employee_id: '1', worked_seconds: 3600, break_seconds: 900 }),
      member({ employee_id: '2', worked_seconds: 1800, break_seconds: 300 }),
    ]);

    expect(summary.workedSeconds).toBe(5400);
    expect(summary.breakSeconds).toBe(1200);
  });

  it('counts only the rows the database itself flagged', () => {
    const summary = summarise([
      member({ employee_id: '1', needs_review: true }),
      member({ employee_id: '2', has_offline: true }),
      member({ employee_id: '3', needs_review: true, has_offline: true }),
    ]);

    expect(summary.needsReview).toBe(2);
    expect(summary.withOffline).toBe(2);
  });

  it('has an answer for an empty team', () => {
    const summary = summarise([]);
    expect(summary.total).toBe(0);
    expect(summary.byState.working).toBe(0);
  });
});

describe('entryHistogram', () => {
  it('buckets entries by the hour they happened, in the board zone', () => {
    // 15:30 UTC is 09:30 in Mexico City. Bucketing in UTC would put this in the
    // afternoon and make the morning look empty.
    const buckets = entryHistogram(
      [member({ employee_id: '1', opened_at: '2026-08-24T15:30:00Z' })],
      ZONE,
    );

    expect(buckets.find((bucket) => bucket.hour === 9)?.count).toBe(1);
    expect(buckets.find((bucket) => bucket.hour === 15)?.count).toBe(0);
  });

  it('keeps the empty hours so the shape of the morning survives', () => {
    const buckets = entryHistogram([], ZONE, 6, 10);
    expect(buckets.map((bucket) => bucket.hour)).toEqual([6, 7, 8, 9, 10]);
    expect(buckets.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('folds anything outside the window into the nearest edge', () => {
    // 04:00 local is before the first bucket. Dropping it would quietly lose a
    // real entry from a chart that claims to show them all.
    const buckets = entryHistogram(
      [member({ employee_id: '1', opened_at: '2026-08-24T10:00:00Z' })],
      ZONE,
      5,
      22,
    );

    expect(buckets[0]?.hour).toBe(5);
    expect(buckets[0]?.count).toBe(1);
  });

  it('ignores a row with no entry rather than counting it as midnight', () => {
    const buckets = entryHistogram([member({ employee_id: '1', opened_at: null })], ZONE);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(0);
  });

  it('survives a timestamp it cannot parse', () => {
    const buckets = entryHistogram([member({ employee_id: '1', opened_at: 'not a date' })], ZONE);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(0);
  });
});

describe('filterTeam', () => {
  const team = [
    member({ employee_id: '1', employee_name: 'Ana Ruiz', department: 'Sistemas' }),
    member({
      employee_id: '2',
      employee_name: 'Beto Lara',
      department: 'Compras',
      state: 'on_break',
    }),
    member({ employee_id: '3', employee_name: 'Carla Sosa', department: null }),
  ];

  const all = { query: '', state: 'all', department: 'all', homeOfficeOnly: false } as const;

  it('keeps only people who registered an entry when the Home Office filter is on', () => {
    const homeOfficeTeam = [
      member({ employee_id: '1', opened_at: '2026-08-24T15:00:00Z' }),
      member({ employee_id: '2', opened_at: null, state: 'not_started' }),
      member({
        employee_id: '3',
        opened_at: '2026-08-24T14:50:00Z',
        closed_at: '2026-08-24T23:00:00Z',
        state: 'finished',
      }),
    ];

    expect(
      filterTeam(homeOfficeTeam, { ...all, homeOfficeOnly: true }).map(
        (candidate) => candidate.employee_id,
      ),
    ).toEqual(['1', '3']);
  });

  it('matches a name regardless of case or surrounding spaces', () => {
    expect(filterTeam(team, { ...all, query: '  beto ' }).map((m) => m.employee_id)).toEqual(['2']);
  });

  it('matches on department too, so a whole area can be pulled up at once', () => {
    expect(filterTeam(team, { ...all, query: 'sistemas' }).map((m) => m.employee_id)).toEqual(['1']);
  });

  it('combines the filters instead of replacing one with another', () => {
    const state: WorkdayState = 'working';
    expect(
      filterTeam(team, {
        query: 'a',
        state,
        department: 'Sistemas',
        homeOfficeOnly: false,
      }),
    ).toHaveLength(1);
    expect(
      filterTeam(team, {
        query: 'a',
        state: 'on_break',
        department: 'Sistemas',
        homeOfficeOnly: false,
      }),
    ).toHaveLength(0);
  });

  it('does not lose somebody who has no department when filtering by name', () => {
    expect(filterTeam(team, { ...all, query: 'carla' }).map((m) => m.employee_id)).toEqual(['3']);
  });
});

describe('departmentsOf', () => {
  it('lists each department once, sorted, and skips the ones nobody has', () => {
    expect(
      departmentsOf([
        member({ employee_id: '1', department: 'Sistemas' }),
        member({ employee_id: '2', department: 'Compras' }),
        member({ employee_id: '3', department: 'Sistemas' }),
        member({ employee_id: '4', department: null }),
        member({ employee_id: '5', department: '' }),
      ]),
    ).toEqual(['Compras', 'Sistemas']);
  });
});

describe('alert counting', () => {
  function alert(over: Partial<OpenAlert> & { id: string }): OpenAlert {
    return {
      employee_id: 'e1',
      employee_name: 'Ana Ruiz',
      alert_date: '2026-08-24',
      kind: 'late_entry',
      severity: 'medium',
      state: 'open',
      details: {},
      created_at: '2026-08-24T15:00:00Z',
      notified_at: null,
      ...over,
    };
  }

  it('counts every severity, including the ones with none', () => {
    expect(
      countBySeverity([
        alert({ id: '1', severity: 'high' }),
        alert({ id: '2', severity: 'high' }),
        alert({ id: '3', severity: 'low' }),
      ]),
    ).toEqual({ high: 2, medium: 0, low: 1 });
  });

  it('counts people, not alerts', () => {
    // Somebody who collected three alerts today is one person to talk to.
    expect(
      employeesWithAlerts([
        alert({ id: '1', employee_id: 'e1' }),
        alert({ id: '2', employee_id: 'e1' }),
        alert({ id: '3', employee_id: 'e2' }),
      ]),
    ).toBe(2);
  });

  it('never buries a tampered clock, which is evidence rather than an absence', () => {
    const raised = [
      alert({ id: '1', kind: 'late_entry' }),
      alert({ id: '2', kind: 'missing_entry' }),
      alert({ id: '3', kind: 'clock_tampered' }),
      alert({ id: '4', kind: 'break_exceeded' }),
      alert({ id: '5', kind: 'missing_exit' }),
    ];

    // A day nobody punched proves nothing when working from the office is an
    // option. A clock running a quarter of an hour off is not an absence at
    // all: it is the one thing here somebody had to do on purpose.
    expect(countable(raised).map((entry) => entry.id)).toEqual(['1', '3']);
  });
});

describe('cumulativeArrivals', () => {
  it('runs the total forward and never goes back down', () => {
    const points = cumulativeArrivals([
      { hour: 8, count: 1 },
      { hour: 9, count: 4 },
      { hour: 10, count: 0 },
      { hour: 11, count: 2 },
    ]);

    expect(points).toEqual([
      { hour: 8, arrived: 1 },
      { hour: 9, arrived: 5 },
      // An hour where nobody arrived holds the total rather than dropping it:
      // people who arrived at nine have not un-arrived at ten.
      { hour: 10, arrived: 5 },
      { hour: 11, arrived: 7 },
    ]);
  });

  it('stays flat at zero when nobody has arrived', () => {
    const points = cumulativeArrivals([
      { hour: 8, count: 0 },
      { hour: 9, count: 0 },
    ]);
    expect(points.every((point) => point.arrived === 0)).toBe(true);
  });
});

describe('filterAlerts', () => {
  const alerts: OpenAlert[] = [
    {
      id: '1',
      employee_id: 'e1',
      employee_name: 'Ana Ruiz',
      alert_date: '2026-08-24',
      kind: 'late_entry',
      severity: 'medium',
      state: 'open',
      details: { minutes_late: 18 },
      created_at: '2026-08-24T15:00:00Z',
      notified_at: null,
    },
    {
      id: '2',
      employee_id: 'e2',
      employee_name: 'Beto Lara',
      alert_date: '2026-08-24',
      kind: 'missing_entry',
      severity: 'high',
      state: 'open',
      details: { minutes_overdue: 42 },
      created_at: '2026-08-24T15:00:00Z',
      notified_at: null,
    },
  ];

  it('matches the person, not the description', () => {
    expect(filterAlerts(alerts, ' beto ').map((a) => a.id)).toEqual(['2']);
    // "min" appears in every detail sentence; matching it would filter nothing.
    expect(filterAlerts(alerts, 'min')).toHaveLength(0);
  });

  it('returns everything when nothing was typed', () => {
    expect(filterAlerts(alerts, '   ')).toHaveLength(2);
  });
});
