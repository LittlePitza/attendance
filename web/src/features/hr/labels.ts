import type {
  AlertDecision,
  AlertKind,
  AlertSeverity,
  AlertState,
  PunchDecision,
  PunchKind,
  SessionEndReason,
  SessionEventKind,
  WorkdayState,
} from '../../lib/types';

/**
 * Spanish for everything HR reads on the board.
 *
 * Typed as complete `Record`s so that adding a state or an alert kind to the
 * database and not to this file fails the build. A chip with no text is exactly
 * the kind of gap that reaches production otherwise.
 *
 * These are deliberately short. The dispatcher writes the same alerts out as
 * full sentences for email, where the reader has no screen to look at; here
 * they sit beside the row they describe and a sentence would be noise.
 */
export const STATE_LABELS: Readonly<Record<WorkdayState, string>> = {
  not_started: 'Sin iniciar',
  working: 'Trabajando',
  on_break: 'En pausa',
  finished: 'Terminada',
};

export const SEVERITY_LABELS: Readonly<Record<AlertSeverity, string>> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

/**
 * Deliberately a second copy of what `features/punch/labels.ts` calls
 * `PUNCH_HISTORY_LABELS`, for the same reason `STATE_LABELS` above is: the two
 * screens share `lib/` and nothing else. Four short strings are a cheaper price
 * than a feature reaching into another feature's presentation.
 */
export const PUNCH_LABELS: Readonly<Record<PunchKind, string>> = {
  clock_in: 'Entrada',
  break_start: 'Inicio de pausa',
  break_end: 'Fin de pausa',
  clock_out: 'Salida',
};

/** What a recorded decision is called once it is on the punch. */
export const DECISION_LABELS: Readonly<Record<PunchDecision, string>> = {
  approve_offline: 'Aprobado',
  reject_offline: 'Rechazado',
};

/** What HR is choosing when it closes an alert. */
export const ALERT_DECISION_LABELS: Readonly<Record<AlertDecision, string>> = {
  acknowledged: 'Enterada',
  resolved: 'Resuelta',
  dismissed: 'Descartada',
};

export const ALERT_LABELS: Readonly<Record<AlertKind, string>> = {
  late_entry: 'Entrada tardía',
  missing_entry: 'Sin entrada',
  break_exceeded: 'Pausa excedida',
  missing_exit: 'Sin salida',
  early_exit: 'Salida temprana',
  no_connection: 'Sin señal',
  review_offline: 'Por revisar',
  clock_tampered: 'Reloj fuera de hora',
};

/** `27000` becomes `7:30`, which is how a working day is read at a glance. */
/**
 * How a session ended, in words.
 *
 * `expired` is the careful one. It means nothing was heard from the device
 * again, and the sweeper stamped the row at the last report -- which is
 * compatible with a closed lid, a dead battery, a lost network and somebody
 * killing the application, and distinguishes none of them. The label says what
 * is known rather than guessing at intent.
 */
export const END_REASON_LABELS: Readonly<Record<SessionEndReason, string>> = {
  sign_out: 'Cerró sesión',
  app_closed: 'Cerró la aplicación',
  expired: 'Dejó de reportarse',
};

export const END_REASON_MEANING: Readonly<Record<SessionEndReason, string>> = {
  sign_out: 'Pulsó salir. La hora es exacta.',
  app_closed: 'La ventana se cerró y alcanzó a avisar.',
  expired:
    'No se volvió a saber del equipo. La hora es la del último reporte, no la del cierre: ' +
    'puede ser una tapa cerrada, una batería agotada, la red caída o la aplicación detenida.',
};

/** What the device observed during a session. */
export const SESSION_EVENT_LABELS: Readonly<Record<SessionEventKind, string>> = {
  connection_lost: 'Perdió la conexión',
  connection_back: 'Recuperó la conexión',
  backgrounded: 'Pasó a segundo plano',
  foregrounded: 'Volvió al frente',
  request_failed: 'Un reporte falló',
};

export const ALERT_STATE_LABELS: Readonly<Record<AlertState, string>> = {
  open: 'Abierta',
  acknowledged: 'Vista',
  resolved: 'Resuelta',
  dismissed: 'Descartada',
};

/**
 * The adjustment kinds. Two of the five are not implemented -- `correct_time`
 * and `add_punch` invent a timestamp nobody punched -- and they are named here
 * anyway, because a row of one could exist in a record written before this
 * screen did, and an unlabelled kind is worse than an unused label.
 */
export const ADJUSTMENT_LABELS: Readonly<Record<string, string>> = {
  void_punch: 'Marcaje anulado',
  approve_offline: 'Marcaje sin conexión aprobado',
  reject_offline: 'Marcaje sin conexión rechazado',
  correct_time: 'Hora corregida',
  add_punch: 'Marcaje agregado',
};

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return `${String(hours)}:${String(minutes).padStart(2, '0')}`;
}

/** The hour of a timestamp, in the zone the whole board is read in. */
export function formatTime(isoTimestamp: string | null, timeZone: string): string {
  if (isoTimestamp === null) {
    return '—';
  }

  const at = new Date(isoTimestamp);
  if (Number.isNaN(at.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
}

/** `09:00:00` from Postgres, shown as `09:00`. */
export function formatScheduleTime(time: string | null): string {
  return time === null ? '—' : time.slice(0, 5);
}

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

/**
 * One short line describing an alert, from the details the evaluator recorded.
 *
 * A missing field renders as `?` rather than throwing: the evaluator writes
 * every field of the kind it raised, and an odd-looking chip is a far better
 * outcome than a dashboard that will not render because one number was null.
 */
export function describeAlert(kind: AlertKind, details: Readonly<Record<string, unknown>>): string {
  switch (kind) {
    case 'late_entry':
      return `${show(details.minutes_late)} min tarde · llegó ${show(details.arrived_at)}`;
    case 'missing_entry':
      return `La ventana cerró ${show(details.entry_until)} · ${show(details.minutes_overdue)} min`;
    case 'break_exceeded':
      return `${show(details.break_minutes)} min de ${show(details.allowed_minutes)} permitidos`;
    case 'missing_exit':
      return `Salida esperada ${show(details.exit_expected)} · ${show(details.minutes_overdue)} min`;
    case 'early_exit':
      return `${show(details.minutes_early)} min antes · salió ${show(details.left_at)} de ${show(details.expected_at)}`;
    case 'no_connection':
      return `Sin señal desde ${show(details.last_signal_at)} · ${show(details.minutes_silent)} min`;
    case 'review_offline':
      return `${show(details.punches_flagged)} marcaje(s) · ${show(details.reason)}`;
    case 'clock_tampered':
      return `${show(details.skew_minutes)} min de desfase · máximo ${show(details.threshold_minutes)}`;
  }
}

function show(value: unknown): string {
  return value === null || value === undefined || value === '' ? '?' : String(value);
}

/**
 * Spanish agreement, for the counts that appear beside a noun.
 *
 * "1 altas" is the kind of thing a reader notices immediately and quietly
 * stops trusting the rest of the screen over.
 */
export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}
