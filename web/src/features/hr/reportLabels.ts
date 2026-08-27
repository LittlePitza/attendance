import type { ComplianceReason, ComplianceVerdict, ReportScope } from '../../lib/types';

/**
 * The Spanish the report is read in.
 *
 * It lives apart from `labels.ts` for the reason the two stylesheets live apart:
 * these words belong to one screen, and a shared label file is where "Días"
 * starts meaning two things. The codes they translate are decided in
 * `attendance_report()`; nothing here reaches a verdict, it only says one out
 * loud.
 */

export const SCOPE_LABELS: Readonly<Record<ReportScope, string>> = {
  day: 'Día',
  week: 'Semana',
  month: 'Mes',
};

export const VERDICT_LABELS: Readonly<Record<ComplianceVerdict, string>> = {
  met: 'Cumplió',
  partial: 'Cumplió parcialmente',
  missed: 'No cumplió',
  pending: 'En curso',
  not_scheduled: 'Sin horario',
};

/**
 * The tone each verdict is drawn in. `pending` and `not_scheduled` are
 * deliberately neutral: neither is a result, and colouring them like one would
 * make a period nobody has worked yet look either passed or failed.
 */
export const VERDICT_TONES: Readonly<Record<ComplianceVerdict, 'good' | 'warn' | 'bad' | 'mute'>> =
  {
    met: 'good',
    partial: 'warn',
    missed: 'bad',
    pending: 'mute',
    not_scheduled: 'mute',
  };

/** What each verdict is actually claiming, spelled out where it is shown. */
export const VERDICT_MEANING: Readonly<Record<ComplianceVerdict, string>> = {
  met: 'Asistió todos los días programados que ya pasaron, y ninguno con retardo.',
  partial: 'Estuvo todos los días, pero con retardo o con una jornada que no cerró.',
  missed: 'Al menos un día programado que ya pasó no tiene ninguna entrada.',
  pending: 'Los días programados del periodo todavía no ocurren. No hay nada que juzgar.',
  not_scheduled: 'Ningún horario cubre este periodo, así que no se le pidió nada.',
};

const REASON_LABELS: Readonly<Record<ComplianceReason['code'], readonly [string, string]>> = {
  absent: ['día sin entrada', 'días sin entrada'],
  late: ['entrada tardía', 'entradas tardías'],
  incomplete: ['jornada sin cerrar', 'jornadas sin cerrar'],
  tampered: ['reloj fuera de hora', 'relojes fuera de hora'],
};

/** "2 días sin entrada". The count comes from the database; the wording is here. */
export function describeReason(reason: ComplianceReason): string {
  const [one, many] = REASON_LABELS[reason.code];
  return `${String(reason.count)} ${reason.count === 1 ? one : many}`;
}

/**
 * The period, named the way somebody would say it.
 *
 * Built from the bounds the database returned, never from a date computed here:
 * the whole reason the scope and anchor go to SQL is that "this week" has a
 * wrong answer available in the browser.
 */
export function describePeriod(scope: ReportScope, from: string, to: string): string {
  if (scope === 'day') {
    return capitalise(
      new Intl.DateTimeFormat('es-MX', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${from}T00:00:00Z`)),
    );
  }

  if (scope === 'month') {
    return capitalise(
      new Intl.DateTimeFormat('es-MX', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${from}T00:00:00Z`)),
    );
  }

  const short = new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const year = new Intl.DateTimeFormat('es-MX', { year: 'numeric', timeZone: 'UTC' });
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);

  return `${short.format(start)} – ${short.format(end)} de ${year.format(end)}`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
