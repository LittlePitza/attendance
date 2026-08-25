import type { CSSProperties, JSX } from 'react';
import type { OpenAlert } from '../../../lib/types';
import { ALERT_LABELS, describeAlert, formatTime, SEVERITY_LABELS } from '../labels';

/**
 * What the evaluator raised and nobody has dealt with.
 *
 * There is no dismiss button, and that is the design. An alert is a record of
 * something that happened, not a notification to clear: somebody who missed the
 * entry window and arrived two hours later was still absent at 09:30. Deciding
 * what it was worth is HR's judgement, and it belongs somewhere that writes the
 * decision down -- not in a control that makes the row disappear from a screen.
 *
 * The order is the database's: most recent day first, then severity, then name.
 */
export function AlertsPanel({
  alerts,
  timeZone,
  boardDate,
}: {
  readonly alerts: readonly OpenAlert[];
  readonly timeZone: string;
  /** The day being looked at, so today's alerts can say when instead of which day. */
  readonly boardDate: string;
}): JSX.Element {
  if (alerts.length === 0) {
    return (
      <p className="muted alerts__empty">
        Sin alertas abiertas. Todo el mundo dentro de su horario.
      </p>
    );
  }

  return (
    <ul className="alerts">
      {alerts.map((alert, index) => (
        <li
          key={alert.id}
          className={`alerts__row alerts__row--${alert.severity}`}
          style={{ '--index': Math.min(index, 10) } as CSSProperties}
        >
          <span className={`alerts__severity alerts__severity--${alert.severity}`}>
            <span className="sr-only">Severidad {SEVERITY_LABELS[alert.severity]}</span>
          </span>

          <span className="alerts__body">
            <span className="alerts__title">
              <span className="alerts__kind">{ALERT_LABELS[alert.kind]}</span>
              <span className="alerts__who">{alert.employee_name}</span>
            </span>
            <span className="alerts__detail">{describeAlert(alert.kind, alert.details)}</span>
          </span>

          <span className="alerts__date">
            {/* On the day itself the date is on the header already; the hour it
              * was raised is the part somebody still does not know. */}
            {alert.alert_date === boardDate
              ? formatTime(alert.created_at, timeZone)
              : alert.alert_date.slice(5)}
          </span>
        </li>
      ))}
    </ul>
  );
}
