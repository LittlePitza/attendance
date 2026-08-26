import type { PunchKind, SessionEndReason, WorkdayState } from '../../lib/types';

/**
 * Spanish for everything an employee reads. These are labels, not decisions:
 * which of them is offered comes from `next_actions`, which the database sends.
 *
 * Typing them as a complete `Record` means adding a punch kind to the contract
 * will not compile until it has a label. A button with no text is exactly the
 * kind of gap that reaches production otherwise.
 */
export const PUNCH_LABELS: Readonly<Record<PunchKind, string>> = {
  clock_in: 'Registrar entrada',
  break_start: 'Iniciar pausa',
  break_end: 'Terminar pausa',
  clock_out: 'Registrar salida',
};

export const PUNCH_HISTORY_LABELS: Readonly<Record<PunchKind, string>> = {
  clock_in: 'Entrada',
  break_start: 'Inicio de pausa',
  break_end: 'Fin de pausa',
  clock_out: 'Salida',
};

export const STATE_LABELS: Readonly<Record<WorkdayState, string>> = {
  not_started: 'Sin iniciar',
  working: 'Trabajando',
  on_break: 'En pausa',
  finished: 'Jornada terminada',
};

/**
 * One line under the status, so the screen says what is happening rather than
 * only naming it. `not_started` gets an invitation; the other three get a fact.
 */
export const STATE_CAPTIONS: Readonly<Record<WorkdayState, string>> = {
  not_started: 'Marca tu entrada cuando empieces.',
  working: 'Tu tiempo está corriendo.',
  on_break: 'La pausa está corriendo. Vuelve cuando quieras.',
  finished: 'Terminaste por hoy. Nos vemos mañana.',
};

/** How a session in the access log ended, in the words the person would use. */
export const SESSION_END_LABELS: Readonly<Record<SessionEndReason, string>> = {
  sign_out: 'Cerraste sesión',
  app_closed: 'Cerraste la aplicación',
  expired: 'El equipo dejó de responder',
};

/**
 * The greeting, from the hour of the day in the employee's own zone.
 *
 * The boundaries are the ones Spanish actually uses -- "buenas tardes" starts
 * at midday and not at some translated notion of afternoon -- and the zone is
 * theirs rather than the browser's, so somebody working from another state is
 * greeted by their own clock.
 */
export function greeting(isoTimestamp: string, timeZone: string): string {
  const hour = hourIn(isoTimestamp, timeZone);

  // An unreadable timestamp greets the morning rather than nothing: it is the
  // most likely hour for somebody to be opening a time clock, and a screen with
  // a blank where the greeting goes looks broken in a way a wrong greeting does
  // not.
  if (hour === null) {
    return 'Buenos días';
  }
  if (hour >= 5 && hour < 12) {
    return 'Buenos días';
  }
  // Both bounds, not just the upper one. The small hours are below the morning
  // rather than above the evening, and testing `hour < 19` alone greets
  // somebody signing in at one in the morning with "buenas tardes".
  if (hour >= 12 && hour < 19) {
    return 'Buenas tardes';
  }
  return 'Buenas noches';
}

function hourIn(isoTimestamp: string, timeZone: string): number | null {
  const at = new Date(isoTimestamp);
  if (Number.isNaN(at.getTime())) {
    return null;
  }

  try {
    // `hourCycle: 'h23'` so midnight is 0 and not 24, which would fall past
    // every boundary above and greet the night shift with "buenos días".
    const shown = new Intl.DateTimeFormat('es-MX', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(at);

    const hour = Number.parseInt(shown, 10);
    return Number.isFinite(hour) ? hour : null;
  } catch {
    // An unknown zone is not a reason to fail to say good morning.
    return null;
  }
}

/**
 * The part of a name a greeting uses.
 *
 * "Buenos días, Luis" and not "Buenos días, Luis Eduardo Hernández Cruz". Two
 * words are kept for the compound first names that are ordinary here -- José
 * Luis, María Fernanda -- but only when the second is short enough to be one,
 * which a surname very rarely is.
 */
export function firstName(fullName: string | null): string | null {
  const parts = (fullName ?? '').trim().split(/\s+/).filter((part) => part !== '');
  const [first, second] = parts;

  if (first === undefined) {
    return null;
  }
  if (second !== undefined && COMPOUND_FIRST_NAMES.has(first.toLocaleLowerCase('es-MX'))) {
    return `${first} ${second}`;
  }
  return first;
}

/**
 * The handful of first names that are almost never used alone here. Kept short
 * on purpose: guessing wrong turns a greeting into a surname, and the plain
 * first name is never wrong, only sometimes less natural.
 */
const COMPOUND_FIRST_NAMES = new Set(['jose', 'josé', 'maria', 'maría', 'juan', 'luz', 'ana']);

/** `27000` becomes `7 h 30 min`, which is how a person reads a working day. */
export function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);

  if (hours === 0) {
    return `${String(minutes)} min`;
  }
  return `${String(hours)} h ${String(minutes)} min`;
}

/**
 * The same duration as a clock: `7:30`.
 *
 * Used where a figure sits beside another figure -- a counter, a column of
 * totals -- and the words would be noise. `formatDuration` is for prose.
 */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return `${String(hours)}:${String(minutes).padStart(2, '0')}`;
}

/** The running counter, down to the second: `3:42:09`. */
export function formatStopwatch(totalSeconds: number): string {
  const safe = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** The hour of a punch, in the employee's own zone rather than the browser's. */
export function formatTimeOfDay(isoTimestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(isoTimestamp));
}

/** The wall clock, with seconds, in the employee's own zone. */
export function formatWallClock(atMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(atMs));
}

/** `2026-08-26` as `miércoles, 26 de agosto`. */
export function formatLongDate(isoDate: string): string {
  // Pinned to midday UTC and formatted as UTC so a browser in another zone
  // cannot shift a plain date to the day before.
  return new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

/** `2026-08-26` as `mié 26`, for a bar in a fortnight of them. */
export function formatShortDate(isoDate: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    weekday: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

/** When a session opened, said the way somebody would say it out loud. */
export function formatSessionMoment(isoTimestamp: string, timeZone: string): string {
  const at = new Date(isoTimestamp);
  if (Number.isNaN(at.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
}

/**
 * Spanish agreement, for the counts that appear beside a noun. "1 marcajes" is
 * the kind of thing a reader notices and quietly stops trusting the screen over.
 */
export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}
