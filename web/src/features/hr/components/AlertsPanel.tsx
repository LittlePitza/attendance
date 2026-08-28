import { useState, type CSSProperties, type JSX } from 'react';
import type { AlertKind, OpenAlert } from '../../../lib/types';
import { ALERT_LABELS, describeAlert, formatTime, SEVERITY_LABELS } from '../labels';
import { OPERATIONAL_ALERT_KINDS, operational } from '../summary';

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
  query = '',
  timeZone,
  boardDate,
}: {
  readonly alerts: readonly OpenAlert[];
  readonly query?: string;
  readonly timeZone: string;
  /** The day being looked at, so today's alerts can say when instead of which day. */
  readonly boardDate: string;
}): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [kind, setKind] = useState<AlertKind | 'all'>('all');
  const [includeOtherKinds, setIncludeOtherKinds] = useState(false);

  if (alerts.length === 0) {
    return <p className="empty">Sin alertas abiertas. Todo el mundo dentro de su horario.</p>;
  }

  const operationalAlerts = operational(alerts);
  const otherKindCount = alerts.length - operationalAlerts.length;
  const scopedAlerts = includeOtherKinds ? alerts : operationalAlerts;
  const kindAlerts = kind === 'all'
    ? scopedAlerts
    : scopedAlerts.filter((alert) => alert.kind === kind);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleAlerts = normalizedQuery === ''
    ? kindAlerts
    : kindAlerts.filter((alert) => alert.employee_name.toLowerCase().includes(normalizedQuery));

  const chooseKind = (next: AlertKind | 'all'): void => {
    setKind(next);
    setExpandedId(null);
  };

  return (
    <div className="alerts-workspace">
      <div className="alert-filters">
        <div className="alert-filters__kinds" role="group" aria-label="Filtrar por tipo">
          <AlertFilter
            label="Todas"
            count={operationalAlerts.length}
            pressed={kind === 'all'}
            onClick={() => chooseKind('all')}
          />
          {OPERATIONAL_ALERT_KINDS.map((alertKind) => (
            <AlertFilter
              key={alertKind}
              label={ALERT_LABELS[alertKind]}
              count={operationalAlerts.filter((alert) => alert.kind === alertKind).length}
              pressed={kind === alertKind}
              onClick={() => chooseKind(alertKind)}
            />
          ))}
        </div>

        {otherKindCount > 0 && (
          <button
            className={includeOtherKinds ? 'btn btn--on' : 'btn'}
            type="button"
            aria-pressed={includeOtherKinds}
            onClick={() => {
              setIncludeOtherKinds((included) => !included);
              setExpandedId(null);
            }}
          >
            Incluir otros tipos {otherKindCount}
          </button>
        )}
      </div>

      {otherKindCount > 0 && (
        <p className="note alert-filters__note" role="status" aria-live="polite">
          {includeOtherKinds
            ? `Mostrando ${String(otherKindCount)} ${otherKindCount === 1 ? 'alerta' : 'alertas'} de otros tipos junto con las operativas.`
            : `${String(otherKindCount)} ${otherKindCount === 1 ? 'alerta de otro tipo está' : 'alertas de otros tipos están'} fuera de esta vista. Puedes incluirlas sin perder las cuatro categorías operativas.`}
        </p>
      )}

      {visibleAlerts.length === 0 ? (
        <p className="empty">
          {normalizedQuery === ''
            ? 'No hay alertas abiertas de este tipo.'
            : `Ninguna alerta coincide con “${query.trim()}”.`}
        </p>
      ) : (
        <ul className="rows">
          {visibleAlerts.map((alert, index) => {
            const expanded = expandedId === alert.id;
            const detailId = `alert-detail-${alert.id}`;
            const detailLabel = `Detalle de ${ALERT_LABELS[alert.kind]} de ${alert.employee_name}`;

            return (
              <li
                key={alert.id}
                className={`alert${expanded ? ' alert--expanded' : ''}`}
                style={{ '--index': Math.min(index, 14) } as CSSProperties}
              >
                <span className={`alert__stripe alert__stripe--${alert.severity}`}>
                  <span className="sr-only">Severidad {SEVERITY_LABELS[alert.severity]}</span>
                </span>

                <button
                  className="alert__summary"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={expanded ? detailId : undefined}
                  onClick={() => setExpandedId((current) => (current === alert.id ? null : alert.id))}
                >
                  <span className="alert__body">
                    <span className="alert__title">
                      <span className="alert__kind">{ALERT_LABELS[alert.kind]}</span>
                      <span className="alert__who">{alert.employee_name}</span>
                    </span>
                    <span className="alert__detail">{describeAlert(alert.kind, alert.details)}</span>
                  </span>

                  <span className="alert__when">
                    {alert.alert_date === boardDate
                      ? formatTime(alert.created_at, timeZone)
                      : alert.alert_date.slice(5)}
                  </span>
                  <span className="alert__disclosure" aria-hidden="true">
                    {expanded ? '−' : '+'}
                  </span>
                  <span className="sr-only">{expanded ? 'Ocultar detalle' : 'Ver detalle'}</span>
                </button>

                {expanded && (
                  <div id={detailId} className="alert__evidence" role="region" aria-label={detailLabel}>
                    <p className="alert__explanation">{describeAlert(alert.kind, alert.details)}</p>
                    <AlertEvidence alert={alert} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AlertFilter({
  label,
  count,
  pressed,
  onClick,
}: {
  readonly label: string;
  readonly count: number;
  readonly pressed: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      className={pressed ? 'alert-filter alert-filter--active' : 'alert-filter'}
      type="button"
      aria-label={`${label} ${String(count)}`}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span>{label}</span>
      <strong>{count}</strong>
    </button>
  );
}

function AlertEvidence({ alert }: { readonly alert: OpenAlert }): JSX.Element {
  const details = alert.details;

  switch (alert.kind) {
    case 'late_entry':
      return (
        <dl className="alert__facts">
          <AlertFact label="Hora esperada" value={detailString(details, 'expected_at')} />
          <AlertFact label="Tolerancia" value={`${detailNumber(details, 'grace_minutes')} min`} />
          <AlertFact label="Entrada registrada" value={detailString(details, 'arrived_at')} />
          <AlertFact
            label="Retraso"
            value={`${detailNumber(details, 'minutes_late')} min pasada la tolerancia`}
          />
        </dl>
      );

    case 'early_exit':
      return (
        <dl className="alert__facts">
          <AlertFact label="Salida esperada" value={detailString(details, 'expected_at')} />
          <AlertFact label="Salida registrada" value={detailString(details, 'left_at')} />
          <AlertFact
            label="Anticipación"
            value={`${detailNumber(details, 'minutes_early')} min antes de la hora esperada`}
          />
        </dl>
      );

    case 'break_exceeded': {
      const used = detailNumberValue(details, 'break_minutes');
      const allowed = detailNumberValue(details, 'allowed_minutes');
      const excess = used === null || allowed === null ? '—' : String(Math.max(0, used - allowed));

      return (
        <dl className="alert__facts">
          <AlertFact label="Pausa permitida" value={`${allowed ?? '—'} min`} />
          <AlertFact label="Pausa registrada" value={`${used ?? '—'} min`} />
          <AlertFact label="Exceso" value={`${excess} min sobre lo permitido`} />
        </dl>
      );
    }

    case 'no_connection':
      return (
        <dl className="alert__facts">
          <AlertFact label="Última conexión" value={detailString(details, 'last_signal_at')} />
          <AlertFact
            label="Tiempo sin conexión"
            value={`${detailNumber(details, 'minutes_silent')} min sin conexión`}
          />
        </dl>
      );

    default:
      return <p className="alert__evidence-empty">No hay más evidencia registrada para esta alerta.</p>;
  }
}

function AlertFact({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div className="alert__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function detailString(details: Readonly<Record<string, unknown>>, key: string): string {
  const value = details[key];
  return typeof value === 'string' && value !== '' ? value.slice(0, 5) : 'No registrado';
}

function detailNumber(details: Readonly<Record<string, unknown>>, key: string): string {
  return String(detailNumberValue(details, key) ?? '—');
}

function detailNumberValue(
  details: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = details[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
