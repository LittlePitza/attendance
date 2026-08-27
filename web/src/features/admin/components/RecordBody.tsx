import type { JSX } from 'react';
import type { AppSession, EmployeeSummary, SummaryWeek } from '../../../lib/types';
import type { EmployeeRecord } from '../useEmployeeRecord';
import { IconClock, IconOffline } from '../../hr/components/icons';
import { formatClock, formatTime, plural } from '../../hr/labels';
import { describeWeekStart, formatDay } from '../labels';

/** What `p_days` is clamped to at the other end is 7 and 92. These are inside it. */
export const RECORD_RANGES: readonly { readonly days: number; readonly label: string }[] = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
];

/** The most recent weeks, newest first. Older than this is what the range is for. */
const WEEKS_SHOWN = 6;

/** Recent accesses, not the whole range: the trail is evidence, not a total. */
const SESSIONS_SHOWN = 8;

/** The range picker both screens put in their panel head. */
export function RecordRange({
  days,
  onChange,
}: {
  readonly days: number;
  readonly onChange: (days: number) => void;
}): JSX.Element {
  return (
    <label>
      <span className="sr-only">Rango que se resume</span>
      <select
        className="field"
        value={days}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {RECORD_RANGES.map((range) => (
          <option key={range.days} value={range.days}>
            {range.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Everything the database knows about one person, read-only.
 *
 * **Not one figure of it is worked out here.** Hours against expected,
 * punctuality, the streak, which days were late and which weeks they fall in
 * are all decided by `internal.attendance_summary()` -- the same function that
 * answers the employee's own screen, so the two can never disagree about the
 * same person. This lays the answers out.
 *
 * It lives apart from `PersonBox` because two screens show it: Configuración,
 * where administrative actions sit underneath it, and Equipo, where they
 * deliberately do not. Keeping one copy is what stops the two drifting into
 * disagreeing about the same person.
 */
export function RecordBody({ record }: { readonly record: EmployeeRecord }): JSX.Element {
  return (
    <>
      {record.error !== null && (
        <p className="note note--warn" role="status">
          {record.error}
        </p>
      )}

      {record.summary === null ? (
        record.loading ? <div className="skeleton skeleton--panel" /> : null
      ) : (
        <>
          <Figures summary={record.summary} />
          <Weeks weeks={record.summary.weeks} />
          <Signals summary={record.summary} />
        </>
      )}

      <Trail
        sessions={record.sessions}
        error={record.sessionsError}
        timeZone={record.summary?.time_zone ?? 'America/Mexico_City'}
      />
    </>
  );
}

/** The four numbers somebody opens this box to read. */
function Figures({ summary }: { readonly summary: EmployeeSummary }): JSX.Element {
  return (
    <div className="admin__stats">
      <Figure
        label="Horas trabajadas"
        value={formatClock(summary.worked_seconds)}
        note={`de ${formatClock(summary.expected_seconds)} esperadas`}
      />
      <Figure
        label="Días en Home Office"
        value={String(summary.days_worked)}
        note={`${String(summary.days_complete)} completos · ${plural(
          summary.absent_days,
          'falta',
          'faltas',
        )}`}
      />
      <Figure
        label="Puntualidad"
        value={summary.punctuality_pct === null ? '—' : `${String(summary.punctuality_pct)}%`}
        note={
          summary.average_entry === null
            ? 'Sin entradas todavía'
            : `Entra en promedio ${summary.average_entry}`
        }
      />
      <Figure
        label="Racha"
        value={plural(summary.streak_days, 'día', 'días')}
        note={`${plural(summary.late_days, 'retardo', 'retardos')} en el rango`}
      />
    </div>
  );
}

function Figure({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}): JSX.Element {
  return (
    <div className="admin__stat">
      <span className="admin__stat-label">{label}</span>
      <span className="admin__stat-value">{value}</span>
      <span className="admin__stat-note">{note}</span>
    </div>
  );
}

/**
 * The weeks, as Postgres grouped them.
 *
 * ISO weeks in the employee's own zone, which is why they are not grouped here:
 * a browser doing it would use the reader's zone and, in some locales, start the
 * week on a Sunday. The first and last week of a range are partial, and that is
 * a fact about the range rather than something to hide.
 */
function Weeks({ weeks }: { readonly weeks: readonly SummaryWeek[] }): JSX.Element {
  const recent = [...weeks].reverse().slice(0, WEEKS_SHOWN);

  return (
    <div className="admin__section">
      <h3 className="admin__section-title">Semana por semana</h3>

      {recent.length === 0 ? (
        <p className="muted">Sin semanas en el rango.</p>
      ) : (
        <table className="admin__weeks" aria-label="Resumen semanal">
          <thead>
            <tr>
              <th scope="col">Semana</th>
              <th scope="col">Home Office</th>
              <th scope="col">Horas</th>
              <th scope="col">Retardos</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((week) => (
              <tr key={week.week_start}>
                <th scope="row">{describeWeekStart(week.week_start)}</th>
                <td>
                  {/* Nobody punches from the office, so a day with a registered
                    * entry *is* a Home Office day. The scheduled count stays
                    * beside it as the ceiling it is measured against. */}
                  {plural(week.days_worked, 'día', 'días')}{' '}
                  <span className="muted">de {week.days_scheduled}</span>
                </td>
                <td>
                  {formatClock(week.worked_seconds)}{' '}
                  <span className="muted">de {formatClock(week.expected_seconds)}</span>
                </td>
                <td>{week.late_days === 0 ? '—' : week.late_days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Whether the application lost them, and in which of the three ways it can.
 *
 * All three are counts of things that already happened: an alert the evaluator
 * raised and HR did not dismiss, a day some punch arrived by sync, and a session
 * that stopped reporting and was closed by the sweeper. None of them is this
 * screen deciding that somebody was disconnected.
 */
function Signals({ summary }: { readonly summary: EmployeeSummary }): JSX.Element {
  const quiet =
    summary.no_connection_alerts === 0 &&
    summary.offline_days === 0 &&
    summary.expired_sessions === 0;

  return (
    <div className="admin__section">
      <h3 className="admin__section-title">
        <IconOffline />
        Desconexiones
      </h3>

      {quiet ? (
        <p className="muted">Ninguna en el rango: ni alertas de señal, ni marcajes sin conexión.</p>
      ) : (
        <ul className="admin__signals">
          <li className="admin__signal">
            <span className="admin__signal-value">{summary.no_connection_alerts}</span>
            <span className="admin__signal-label">
              {plural(summary.no_connection_alerts, 'alerta de señal', 'alertas de señal')} mientras
              trabajaba
            </span>
          </li>
          <li className="admin__signal">
            <span className="admin__signal-value">{summary.offline_days}</span>
            <span className="admin__signal-label">
              {plural(summary.offline_days, 'día', 'días')} con marcajes sincronizados después
            </span>
          </li>
          <li className="admin__signal">
            <span className="admin__signal-value">{summary.expired_sessions}</span>
            <span className="admin__signal-label">
              {plural(summary.expired_sessions, 'sesión', 'sesiones')} que dejó de reportarse
            </span>
          </li>
        </ul>
      )}
    </div>
  );
}

/** The access log, as evidence. There is nothing to press on it. */
function Trail({
  sessions,
  error,
  timeZone,
}: {
  readonly sessions: readonly AppSession[];
  readonly error: string | null;
  readonly timeZone: string;
}): JSX.Element {
  return (
    <div className="trail">
      <h3 className="trail__title">
        <IconClock />
        Accesos recientes
      </h3>

      {error !== null ? (
        <p className="review__error">{error}</p>
      ) : sessions.length === 0 ? (
        <p className="muted">No ha abierto la aplicación.</p>
      ) : (
        <ul className="trail__list">
          {sessions.slice(0, SESSIONS_SHOWN).map((session) => (
            <li className="trail__row" key={session.id}>
              <span className="trail__span">
                {formatDay(session.started_at)} · {formatTime(session.started_at, timeZone)}
                {' → '}
                {session.ended_at === null ? 'abierta' : formatTime(session.ended_at, timeZone)}
              </span>
              <span className="trail__device">{session.platform ?? 'equipo sin identificar'}</span>
              {session.ip !== null && session.ip !== '' && (
                <span className="trail__ip">{session.ip}</span>
              )}
              {/* The sweeper's word, not a guess: the machine stopped reporting
                  and was closed at its last signal, which is not the same as
                  somebody signing out. */}
              {session.end_reason === 'expired' && <span className="pill pill--mute">sin cierre</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
