import type { CountingKind, MyDay, MySummary, SummaryDay } from '../../lib/types';

/**
 * Everything the punch screen shows that is not a field of an answer.
 *
 * All of it is arithmetic over facts the database already decided, in exactly
 * the sense the board's `summary.ts` is: no judgement is made here. In
 * particular **nothing in this file decides which counter is running**. That is
 * `my_day().counting`, because whether a break counts as worked time is a
 * question for the state machine and not for a component.
 *
 * Pure on purpose. This is the part of the screen worth testing, and it can be
 * tested without a database, a network or a DOM.
 */

export interface LiveCounters {
  readonly worked: number;
  readonly paused: number;
  /**
   * Worked against what today's schedule asks for. Null on a day with no
   * schedule, so the screen says so rather than drawing progress towards a
   * target nobody set. Uncapped: a long day reads over 1, which is a fact.
   */
  readonly progress: number | null;
}

/**
 * The two counters, moved forward to now.
 *
 * The database sends the totals as they stood at `server_time` and says which
 * one is still running. All that happens here is that the seconds since the
 * answer arrived are added to that one.
 *
 * `fetchedAtMs` is the device's clock at the moment the answer landed, not the
 * server's `server_time`. That is what makes the counter immune to a device
 * whose clock is minutes out: only the *difference* between two readings of the
 * same clock is used, and every clock is accurate about elapsed time even when
 * it is wrong about the hour. Measuring from `server_time` instead would show a
 * badly-set laptop a counter that starts hours ahead.
 */
export function liveCounters(day: MyDay, fetchedAtMs: number, nowMs: number): LiveCounters {
  const elapsed = Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000));

  // A database that predates these fields sends none of them, which happens for
  // as long as it takes a merged deploy to be followed by its migration. Falling
  // back to the settled counters is the behaviour this screen had before they
  // existed: the figure stops moving between punches, which is wrong but
  // readable. Reading them as present would put `NaN` in the middle of the ring.
  const counting = runningCounter(day);
  const worked = (day.worked_seconds_live ?? day.worked_seconds)
    + (counting === 'worked' ? elapsed : 0);
  const paused = (day.break_seconds_live ?? day.break_seconds)
    + (counting === 'break' ? elapsed : 0);

  const expected = day.expected_seconds ?? null;
  const progress = expected === null || expected <= 0 ? null : worked / expected;

  return { worked, paused, progress };
}

/**
 * Which counter the database says is running, or nothing.
 *
 * The one place that answers the question, so the fallback above and the display
 * below cannot disagree about it. `??` rather than a truthiness check: `null`
 * from the database and an absent field both mean "nothing is running", and
 * neither is the screen deciding.
 */
export function runningCounter(day: MyDay): CountingKind | null {
  return day.counting ?? null;
}

/**
 * The last `count` days of the summary, oldest first.
 *
 * The series arrives covering the whole range the caller asked for, because the
 * totals are computed over all of it. The chart shows a fortnight of it: enough
 * to see a shape, few enough that a bar is still wide enough to read on a phone.
 */
export function recentDays(summary: MySummary, count = 14): SummaryDay[] {
  return summary.series.slice(-Math.max(1, count));
}

export interface WeekTotals {
  readonly worked: number;
  readonly expected: number;
  readonly days: number;
}

/**
 * This week so far, Monday to today.
 *
 * Derived from the same series rather than asked for separately: it is a slice
 * of days the database already reported on, and a second round trip to have
 * them added up elsewhere would be a second answer that could disagree with the
 * first.
 */
export function weekToDate(summary: MySummary): WeekTotals {
  const monday = mondayOf(summary.to);

  let worked = 0;
  let expected = 0;
  let days = 0;

  for (const day of summary.series) {
    if (day.date < monday) {
      continue;
    }
    worked += day.worked_seconds;
    expected += day.expected_seconds;
    if (day.opened_at !== null) {
      days += 1;
    }
  }

  return { worked, expected, days };
}

/**
 * The Monday of the week a plain date falls in, as a plain date.
 *
 * Pinned to midday UTC and read back in UTC, the same trick the date labels
 * use: a plain date is not an instant, and letting the browser's zone touch it
 * shifts it to the day before for anybody west of Greenwich.
 */
function mondayOf(isoDate: string): string {
  const at = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) {
    return isoDate;
  }

  // getUTCDay is 0 for Sunday; the week starts on Monday here, so Sunday is
  // six days after its Monday rather than one day before the next.
  const offset = (at.getUTCDay() + 6) % 7;
  at.setUTCDate(at.getUTCDate() - offset);

  return at.toISOString().slice(0, 10);
}

/**
 * The tallest thing a chart of these days has to fit.
 *
 * Both series share one scale, so a bar that fell short of its target looks
 * short. Scaling each bar to itself would make every day look identical, which
 * is the one thing this chart exists not to do.
 */
export function chartCeiling(days: readonly SummaryDay[]): number {
  let tallest = 0;
  for (const day of days) {
    tallest = Math.max(tallest, day.worked_seconds, day.expected_seconds);
  }
  // Never zero: a chart of an empty fortnight still has to divide by this.
  return tallest === 0 ? 3600 : tallest;
}
