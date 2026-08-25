import type { AlertKind, AlertSeverity, NotificationPayload } from './types.ts';

/**
 * Turning one queued alert into the message HR reads.
 *
 * Spanish, because a person reads it. Plain text and not HTML, because the
 * values interpolated here come from a database and plain text cannot be made
 * to mean something else by a stray angle bracket.
 *
 * This is presentation, not judgement. Whether the alert exists at all was
 * decided by `attendance.evaluate_alerts()`; everything below only reads what it
 * already wrote.
 */

const KIND_LABELS: Readonly<Record<AlertKind, string>> = {
  late_entry: 'Entrada tardía',
  missing_entry: 'Sin registrar entrada',
  break_exceeded: 'Pausa excedida',
  missing_exit: 'Sin registrar salida',
  no_connection: 'Sin señal',
  review_offline: 'Marcajes por revisar',
  clock_tampered: 'Reloj fuera de hora',
};

const SEVERITY_LABELS: Readonly<Record<AlertSeverity, string>> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
};

const STATE_LABELS: Readonly<Record<string, string>> = {
  not_started: 'sin iniciar',
  working: 'trabajando',
  on_break: 'en pausa',
  finished: 'terminada',
};

export interface ComposedMessage {
  readonly subject: string;
  readonly text: string;
}

export function composeMessage(payload: NotificationPayload): ComposedMessage {
  const kind = KIND_LABELS[payload.kind] ?? payload.kind;
  const who = payload.department === null
    ? payload.employee_name
    : `${payload.employee_name} · ${payload.department}`;

  const subject = `[Checador] ${kind} — ${payload.employee_name} (${payload.alert_date})`;

  const text = [
    who,
    `Fecha: ${payload.alert_date}`,
    `Severidad: ${SEVERITY_LABELS[payload.severity] ?? payload.severity}`,
    '',
    describe(payload),
    '',
    '--',
    'Checador · mensaje automático. No respondas a este correo.',
  ].join('\n');

  return { subject, text };
}

/**
 * The one sentence that says what happened, per kind.
 *
 * A missing field renders as `?` rather than throwing. The evaluator always
 * writes every field of the kind it raised, so this should not happen -- but an
 * alert that arrives with an odd sentence in it is far better than one that is
 * never sent because a number was null, and the row would otherwise retry eight
 * times and fail.
 */
function describe(payload: NotificationPayload): string {
  const d = payload.details;

  switch (payload.kind) {
    case 'late_entry':
      return `Entró a las ${text(d.arrived_at)}, ${text(d.minutes_late)} min después de su hora` +
        ` (${text(d.expected_at)} más ${text(d.grace_minutes)} min de tolerancia).`;

    case 'missing_entry':
      return `No registró entrada. La ventana cerró a las ${text(d.entry_until)},` +
        ` hace ${text(d.minutes_overdue)} min.`;

    case 'break_exceeded':
      return `Lleva ${text(d.break_minutes)} min de pausa; el máximo es ${
        text(d.allowed_minutes)
      } min.` + (d.still_on_break === true ? ' Sigue en pausa.' : ' Ya regresó.');

    case 'missing_exit':
      return `No registró salida. Su hora era ${text(d.exit_expected)}, hace ${
        text(d.minutes_overdue)
      } min.` + ` La jornada quedó ${STATE_LABELS[String(d.state)] ?? text(d.state)}.`;

    case 'no_connection':
      return `Sin señal desde las ${text(d.last_signal_at)}, hace ${
        text(d.minutes_silent)
      } min, con la jornada abierta.`;

    case 'review_offline':
      return `${text(d.punches_flagged)} marcaje(s) llegaron marcados para revisión.` +
        ` Motivo: ${text(d.reason)}.`;

    case 'clock_tampered':
      return `El reloj de su equipo está ${text(d.skew_minutes)} min fuera de hora` +
        ` (el máximo tolerado es ${text(d.threshold_minutes)} min).`;
  }
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '?';
  }
  return String(value);
}
