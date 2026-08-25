import type { PunchKind, WorkdayState } from '../../lib/types';

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

/** The hour of a punch, in the employee's own zone rather than the browser's. */
export function formatTimeOfDay(isoTimestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(isoTimestamp));
}
