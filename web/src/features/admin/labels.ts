import type { AlertKind, AssignableRole, EmployeeState, ScheduleScope } from '../../lib/types';

/**
 * The words the administration screen uses.
 *
 * Separate from `features/hr/labels.ts` because these name configuration --
 * roles, scopes, days, thresholds -- and those name what happened on a day. The
 * two files would otherwise grow into one dictionary nobody can find anything
 * in.
 */

export const ROLE_LABELS: Readonly<Record<AssignableRole, string>> = {
  employee: 'Empleado',
  manager: 'Jefe de área',
  hr: 'Recursos Humanos',
  admin: 'Administrador',
};

/** What each role can actually reach, so the choice is not a guess. */
export const ROLE_SCOPES: Readonly<Record<AssignableRole, string>> = {
  employee: 'Solo su propia jornada',
  manager: 'Su departamento',
  hr: 'Toda la empresa, más revisión y alertas',
  admin: 'Todo, más esta pantalla',
};

export const SCOPE_LABELS: Readonly<Record<ScheduleScope, string>> = {
  global: 'Toda la empresa',
  department: 'Un departamento',
  employee: 'Una persona',
};

/** ISO order: 1 is Monday, which is what `attendance.schedules.days` stores. */
export const WEEKDAYS: readonly { readonly iso: number; readonly short: string; readonly long: string }[] = [
  { iso: 1, short: 'L', long: 'lunes' },
  { iso: 2, short: 'M', long: 'martes' },
  { iso: 3, short: 'M', long: 'miércoles' },
  { iso: 4, short: 'J', long: 'jueves' },
  { iso: 5, short: 'V', long: 'viernes' },
  { iso: 6, short: 'S', long: 'sábado' },
  { iso: 7, short: 'D', long: 'domingo' },
];

/**
 * What the threshold on each rule counts, because the number means something
 * different in every row and a bare "minutos" would be misleading.
 */
export const THRESHOLD_MEANING: Readonly<Record<AlertKind, string>> = {
  late_entry: 'minutos después de la hora esperada más la tolerancia',
  missing_entry: 'minutos después de que cierra la ventana de entrada',
  break_exceeded: 'minutos por encima de la pausa máxima',
  missing_exit: 'minutos después de la salida esperada con la jornada abierta',
  no_connection: 'minutos sin señal mientras la persona trabaja',
  review_offline: 'no usa umbral: se levanta en cuanto un marcaje llega marcado',
  clock_tampered: 'minutos de desfase del reloj del equipo',
};

/** `Lun a vie`, or `L M V` when the set is not a run. Read at a glance, not parsed. */
export function describeDays(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);

  if (sorted.length === 0) {
    return 'Ningún día';
  }
  if (sorted.length === 7) {
    return 'Todos los días';
  }

  const consecutive = sorted.every((day, index) => index === 0 || day === (sorted[index - 1] ?? 0) + 1);
  const first = WEEKDAYS.find((day) => day.iso === sorted[0]);
  const last = WEEKDAYS.find((day) => day.iso === sorted[sorted.length - 1]);

  if (consecutive && sorted.length > 2 && first !== undefined && last !== undefined) {
    return `${capitalise(first.long)} a ${last.long}`;
  }

  return sorted
    .map((iso) => WEEKDAYS.find((day) => day.iso === iso)?.long ?? String(iso))
    .map(capitalise)
    .join(', ');
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `hace 3 días`, or `Nunca`. An exact timestamp answers a question nobody asked. */
export function describeLastSignIn(isoTimestamp: string | null): string {
  if (isoTimestamp === null) {
    return 'Nunca ha entrado';
  }

  const days = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 86_400_000);

  if (days <= 0) {
    return 'Entró hoy';
  }
  if (days === 1) {
    return 'Entró ayer';
  }
  return `Entró hace ${String(days)} días`;
}

/**
 * The two states `empleados_estado_check` allows, in the words the screen uses.
 *
 * "Dado de baja" rather than "eliminado", because that is what happens: the row
 * stays, the punches stay, and the person stops being able to sign in. Calling
 * it deletion on screen would promise something the database refuses to do.
 */
export const EMPLOYEE_STATE_LABELS: Readonly<Record<EmployeeState, string>> = {
  activo: 'Activo',
  baja: 'Dado de baja',
};

/** `24 ago 2026`. Accepts a date or a timestamp: only the day is ever shown. */
export function formatDay(iso: string): string {
  // Pinned to midday UTC and read back in UTC, the same trick the board's date
  // labels use: a plain date is not an instant, and letting the browser's zone
  // touch it shifts it to the day before for anybody west of Greenwich.
  const at = new Date(`${iso.slice(0, 10)}T12:00:00Z`);

  if (Number.isNaN(at.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/**
 * `Semana del 24 ago`. The week starts on a Monday because Postgres grouped it
 * that way, in the employee's zone -- not because this file decided so.
 *
 * Formatted rather than trimmed out of `formatDay`: how a locale spells a date
 * is the locale's business, and a regular expression that strips the year from
 * one spelling mangles the next.
 */
export function describeWeekStart(isoDate: string): string {
  const at = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);

  if (Number.isNaN(at.getTime())) {
    return 'Semana';
  }

  return `Semana del ${new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(at)}`;
}
