import type { JSX } from 'react';
import { useTick } from '../../../hooks/useTick';
import type { MyDay, PunchKind, WorkdayState } from '../../../lib/types';
import { IconCoffee, IconPlay, IconStop } from '../../shell/icons';
import { Mesh } from '../../shell/Mesh';
import {
  PUNCH_LABELS,
  STATE_CAPTIONS,
  STATE_LABELS,
  formatClock,
  formatLongDate,
  formatStopwatch,
  formatTimeOfDay,
  formatWallClock,
  greeting,
} from '../labels';
import { liveCounters, runningCounter } from '../live';
import { ProgressRing } from './ProgressRing';

/**
 * The top of the screen, and the only part that matters if somebody reads
 * nothing else: who they are, what time it is, what state their day is in and
 * the buttons that change it.
 *
 * **Every button here comes from `day.next_actions`.** The screen does not know
 * that a break follows an entry or that a finished day accepts nothing: it
 * renders what it is offered, in the order it is offered, and the first one is
 * the solid one. That is the reason the read API returns those actions at all,
 * and it is why adding a fifth punch kind is a migration and a label rather
 * than a condition in this file.
 *
 * The counter moves because `useTick` re-renders it, not because anything here
 * decides what is being counted. `my_day().counting` says which of the two
 * totals is running and `liveCounters` adds the seconds since the answer
 * arrived to that one.
 */
export function DayHero({
  day,
  fetchedAt,
  name,
  busyKind,
  onPunch,
}: {
  readonly day: MyDay;
  readonly fetchedAt: number;
  readonly name: string | null;
  readonly busyKind: PunchKind | null;
  readonly onPunch: (kind: PunchKind) => void;
}): JSX.Element {
  const now = useTick(1000);
  const { worked, paused, progress } = liveCounters(day, fetchedAt, now);

  const tone = RING_TONES[day.state];
  // `runningCounter` and not `day.counting !== null`: an absent field is
  // `undefined`, which is not null, so the plain comparison reports a finished
  // day as running and shows it a ticking second on a figure that will never
  // change again. One helper answers it for both this and the counters above.
  const running = runningCounter(day) !== null;
  const expected = day.expected_seconds ?? null;

  return (
    <section className="hero" aria-live="polite">
      <Mesh variant="wash" />

      <header className="hero__head">
        <div>
          <h1 className="hero__greeting">
            {greeting(day.server_time, day.time_zone)}
            {name === null ? '' : `, ${name}`}
          </h1>
          <p className="hero__date">{formatLongDate(day.date)}</p>
        </div>

        <div className="hero__clock">
          <span className="hero__time">{formatWallClock(now, day.time_zone)}</span>
          <span className="hero__zone">{zoneNote(day.time_zone)}</span>
        </div>
      </header>

      <div className="hero__body">
        <ProgressRing
          progress={progress}
          tone={tone}
          label={ringLabel(day, worked)}
        >
          {/* The running counter shows seconds; a settled one does not. A day
              that has finished has an exact length, and a ticking second on a
              number that will never change again reads as a fault. */}
          <span className="ring__value">
            {running ? formatStopwatch(worked) : formatClock(worked)}
          </span>
          <span className="ring__of">
            {expected === null ? 'sin horario hoy' : `de ${formatClock(expected)} h`}
          </span>
        </ProgressRing>

        <div className="hero__state">
          <p className={`status status--${tone}`}>
            <span className="status__dot" aria-hidden="true" />
            {STATE_LABELS[day.state]}
          </p>
          <p className="hero__caption">{STATE_CAPTIONS[day.state]}</p>

          <dl className="hero__facts">
            <div>
              <dt>Entrada</dt>
              <dd>
                {day.opened_at === null
                  ? '—'
                  : formatTimeOfDay(day.opened_at, day.time_zone)}
              </dd>
            </div>
            <div>
              <dt>En pausa</dt>
              <dd>{formatClock(paused)}</dd>
            </div>
            <div>
              <dt>Salida</dt>
              <dd>
                {day.closed_at !== null
                  ? formatTimeOfDay(day.closed_at, day.time_zone)
                  : (day.schedule?.exit_expected ?? '—')}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="hero__actions">
        {day.next_actions.length === 0 ? (
          <p className="hero__closed">Tu jornada de hoy ya está cerrada.</p>
        ) : (
          day.next_actions.map((kind, index) => (
            <button
              key={kind}
              className={`button button--action ${
                index === 0 ? 'button--primary' : 'button--outline'
              }`}
              type="button"
              disabled={busyKind !== null}
              onClick={() => onPunch(kind)}
            >
              <span className="button__icon">{ACTION_ICONS[kind]}</span>
              {busyKind === kind ? 'Registrando…' : PUNCH_LABELS[kind]}
            </button>
          ))
        )}
      </div>
    </section>
  );
}

/**
 * Typed as a complete `Record` so a new workday state has to be given a look
 * before this compiles. A state that fell through to a default would be an
 * unstyled ring nobody noticed until it was in front of somebody.
 */
const RING_TONES: Readonly<Record<WorkdayState, 'run' | 'rest' | 'done' | 'idle'>> = {
  not_started: 'idle',
  working: 'run',
  on_break: 'rest',
  finished: 'done',
};

const ACTION_ICONS: Readonly<Record<PunchKind, JSX.Element>> = {
  clock_in: <IconPlay />,
  break_start: <IconCoffee />,
  break_end: <IconPlay />,
  clock_out: <IconStop />,
};

/** What a screen reader is told the ring means, since it cannot see it fill. */
function ringLabel(day: MyDay, worked: number): string {
  const soFar = `Llevas ${formatClock(worked)} horas trabajadas`;
  const expected = day.expected_seconds ?? null;

  return expected === null
    ? `${soFar}. Hoy no tienes horario asignado.`
    : `${soFar} de ${formatClock(expected)} esperadas.`;
}

/**
 * What to say under the clock.
 *
 * The hour shown is always the employee's own -- their department's zone, which
 * is what every alert and every schedule is measured in. Almost always that is
 * also the zone the machine is in, and saying "hora local" is both true and
 * uninteresting.
 *
 * The case worth naming is the other one: somebody working from a state an hour
 * away, whose laptop says one thing and whose schedule is written in another.
 * Then the zone is spelled out, because a clock that disagrees with the corner
 * of their screen needs to explain itself. That comparison is the whole reason
 * this is not a static string.
 */
function zoneNote(timeZone: string): string {
  try {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === timeZone) {
      return 'hora local';
    }
  } catch {
    // A browser with no ICU data cannot be compared against. Naming the zone is
    // the safe answer: it is never wrong, only sometimes redundant.
  }

  return `hora de ${timeZone.split('/').at(-1)?.replace(/_/g, ' ') ?? timeZone}`;
}
