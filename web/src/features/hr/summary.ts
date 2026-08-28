import type { AlertKind, AlertSeverity, OpenAlert, TeamMember, WorkdayState } from '../../lib/types';
import { WORKDAY_STATES } from '../../lib/types';

/**
 * Everything the board displays that is not a field of a row.
 *
 * All of it is grouping and counting -- facts the database already decided,
 * arranged for the eye. Nothing here judges anything. In particular **the
 * dashboard never works out who was late**: whether an arrival counted as late
 * depends on the schedule, the grace and the department's threshold, and
 * `attendance.evaluate_alerts()` is the only place that resolves those. What
 * the board shows about lateness comes back as a `late_entry` alert.
 *
 * Pure on purpose. This is the part of the screen worth testing, and it can be
 * tested without a database, a network or a DOM.
 */

export type StateCounts = Readonly<Record<WorkdayState, number>>;

export interface TeamSummary {
  readonly total: number;
  readonly byState: StateCounts;
  /** Rows the database flagged, not rows this module decided to flag. */
  readonly needsReview: number;
  readonly withOffline: number;
  readonly workedSeconds: number;
  readonly breakSeconds: number;
}

export function summarise(team: readonly TeamMember[]): TeamSummary {
  const byState: Record<WorkdayState, number> = {
    not_started: 0,
    working: 0,
    on_break: 0,
    finished: 0,
  };

  let needsReview = 0;
  let withOffline = 0;
  let workedSeconds = 0;
  let breakSeconds = 0;

  for (const member of team) {
    byState[member.state] += 1;
    if (member.needs_review) {
      needsReview += 1;
    }
    if (member.has_offline) {
      withOffline += 1;
    }
    workedSeconds += member.worked_seconds;
    breakSeconds += member.break_seconds;
  }

  return { total: team.length, byState, needsReview, withOffline, workedSeconds, breakSeconds };
}

/** The order the segmented bar and the filter chips both read in. */
export const STATE_ORDER: readonly WorkdayState[] = WORKDAY_STATES;

export interface HourBucket {
  readonly hour: number;
  readonly count: number;
}

/**
 * When the day actually started, hour by hour.
 *
 * A distribution of a recorded fact, not a verdict about any of them. The zone
 * is the reader's, matching `team_day()`, which resolves its date the same way:
 * one person reads this board, in one place, and a column that shifted zone per
 * row would be unreadable.
 *
 * Empty hours are kept so the shape of the morning is visible instead of being
 * compressed away.
 */
export function entryHistogram(
  team: readonly TeamMember[],
  timeZone: string,
  from = 6,
  to = 20,
): HourBucket[] {
  const counts = new Map<number, number>();

  for (const member of team) {
    if (member.opened_at === null) {
      continue;
    }

    const hour = hourIn(member.opened_at, timeZone);
    if (hour === null) {
      continue;
    }

    const clamped = Math.min(Math.max(hour, from), to);
    counts.set(clamped, (counts.get(clamped) ?? 0) + 1);
  }

  const buckets: HourBucket[] = [];
  for (let hour = from; hour <= to; hour += 1) {
    buckets.push({ hour, count: counts.get(hour) ?? 0 });
  }
  return buckets;
}

function hourIn(isoTimestamp: string, timeZone: string): number | null {
  const at = new Date(isoTimestamp);
  if (Number.isNaN(at.getTime())) {
    return null;
  }

  // `hourCycle: 'h23'` so midnight is 0 and not 24, which would fall outside
  // every bucket and silently vanish from the chart.
  const formatted = new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);

  const hour = Number.parseInt(formatted, 10);
  return Number.isFinite(hour) ? hour : null;
}

/**
 * Whether this person could have punched at all.
 *
 * Thirty-two people are on the roster and nine have an account. The other
 * twenty-three have no way to clock in, so the board showed them at
 * `not_started` all day, every day -- rows that look like absence and are
 * evidence of nothing. It is the same cut the report already makes: somebody who
 * cannot punch cannot be late.
 *
 * **Absent is not false.** `has_account` arrives only once `team_day()` reports
 * it, and a bundle and a migration never deploy together. Testing for `!== false`
 * means the deploy window shows everybody -- exactly today's board -- instead of
 * emptying the screen for the minutes in between. Comparing to `true` would have
 * made the board read "nobody can punch" the moment it shipped.
 */
export function canPunch(member: TeamMember): boolean {
  return member.has_account !== false;
}

/** The board's population: everybody who has a way in. */
export function punchable(team: readonly TeamMember[]): TeamMember[] {
  return team.filter(canPunch);
}

/**
 * How many the board is not showing. Counted rather than dropped, for the same
 * reason the hidden alert kinds are counted: twenty-three people vanishing
 * without trace is how a roster of thirty-two silently becomes nine.
 */
export function withoutAccount(team: readonly TeamMember[]): number {
  return team.filter((member) => member.has_account === false).length;
}

export interface BoardFilter {
  readonly query: string;
  readonly state: WorkdayState | 'all';
  readonly department: string | 'all';
  /** Home Office is a recorded fact: the person clocked in on the shown day. */
  readonly homeOfficeOnly: boolean;
}

export function filterTeam(
  team: readonly TeamMember[],
  filter: BoardFilter,
): TeamMember[] {
  const needle = filter.query.trim().toLowerCase();

  return team.filter((member) => {
    if (filter.homeOfficeOnly && member.opened_at === null) {
      return false;
    }
    if (filter.state !== 'all' && member.state !== filter.state) {
      return false;
    }
    if (filter.department !== 'all' && (member.department ?? '') !== filter.department) {
      return false;
    }
    if (needle === '') {
      return true;
    }
    return `${member.employee_name} ${member.department ?? ''}`.toLowerCase().includes(needle);
  });
}

/** Every department present today, so the filter offers only what exists. */
export function departmentsOf(team: readonly TeamMember[]): string[] {
  const names = new Set<string>();
  for (const member of team) {
    if (member.department !== null && member.department !== '') {
      names.add(member.department);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'es-MX'));
}

export function countBySeverity(
  alerts: readonly OpenAlert[],
): Readonly<Record<AlertSeverity, number>> {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const alert of alerts) {
    counts[alert.severity] += 1;
  }
  return counts;
}

/**
 * How many people this alert list is actually about. Somebody who collected
 * three alerts today is one person to talk to, not three.
 */
export function employeesWithAlerts(alerts: readonly OpenAlert[]): number {
  return new Set(alerts.map((alert) => alert.employee_id)).size;
}

export interface ArrivalPoint {
  readonly hour: number;
  readonly arrived: number;
}

/**
 * How many people had arrived by each hour.
 *
 * A running total, and the reason the chart is a line rather than the bars this
 * is derived from: "people who have arrived" is a quantity that genuinely holds
 * a value between one hour and the next, so joining the points describes
 * something real. A line drawn between counts *within* each hour would slope
 * through values that never existed.
 */
export function cumulativeArrivals(buckets: readonly HourBucket[]): ArrivalPoint[] {
  let running = 0;
  return buckets.map((bucket) => {
    running += bucket.count;
    return { hour: bucket.hour, arrived: running };
  });
}

/**
 * The four events this Home Office tool can act on without inferring absence.
 *
 * Every kind is backed by a recorded timestamp or heartbeat: somebody arrived,
 * left, accumulated break time, or stopped reporting while their day was open.
 * Other alerts remain available through the explicit "other types" control;
 * they are not silently discarded.
 */
export const OPERATIONAL_ALERT_KINDS: readonly AlertKind[] = [
  'late_entry',
  'early_exit',
  'break_exceeded',
  'no_connection',
];

export function operational(alerts: readonly OpenAlert[]): OpenAlert[] {
  return alerts.filter((alert) => OPERATIONAL_ALERT_KINDS.includes(alert.kind));
}

/** @deprecated Use `operational`; kept during the view migration. */
export function countable(alerts: readonly OpenAlert[]): OpenAlert[] {
  return operational(alerts);
}

/**
 * The same search box narrows the alert list too. Only the name is matched:
 * the kind already has its own filter in the sidebar, and matching the detail
 * sentence would make "min" pull up half the list.
 */
export function filterAlerts(
  alerts: readonly OpenAlert[],
  query: string,
  countableOnly = false,
): OpenAlert[] {
  const needle = query.trim().toLowerCase();
  const scoped = countableOnly ? countable(alerts) : [...alerts];
  if (needle === '') {
    return scoped;
  }
  return scoped.filter((alert) => alert.employee_name.toLowerCase().includes(needle));
}
