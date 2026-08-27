import { useCallback, useState, type JSX } from 'react';
import { api } from '../../../lib/api';
import { describeReadFailure } from '../../../lib/errors';
import type {
  AppSession,
  EmployeeRow,
  EmployeeSummary,
  ResetDayResult,
  SummaryWeek,
} from '../../../lib/types';
import { IconClock, IconOffline } from '../../hr/components/icons';
import { formatClock, formatTime, plural } from '../../hr/labels';
import { EMPLOYEE_STATE_LABELS, describeWeekStart, formatDay } from '../labels';
import { useEmployeeRecord } from '../useEmployeeRecord';

/** The database refuses anything shorter, and says so. Saying so first is kinder. */
const MIN_REASON = 10;

/** What `p_days` is clamped to at the other end is 7 and 92. These are inside it. */
const RANGES: readonly { readonly days: number; readonly label: string }[] = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
];

/** The most recent weeks, newest first. Older than this is what the range is for. */
const WEEKS_SHOWN = 6;

/** Recent accesses, not the whole range: the trail is evidence, not a total. */
const SESSIONS_SHOWN = 8;

/**
 * Everything the database knows about one person, on one screen.
 *
 * **Not one figure of it is worked out here.** Hours against expected,
 * punctuality, the streak, which days were late and which weeks they fall in
 * are all decided by `internal.attendance_summary()` -- the same function that
 * answers the employee's own screen, so the two can never disagree about the
 * same person. This lays the answers out.
 *
 * That matters most for the thing this box makes easy to do: reset somebody's
 * day. The button sends a reason and a date and prints what came back. It does
 * not predict the new counters, does not decide which punches stop counting,
 * and does not touch the day's alerts -- they are a record of what happened,
 * and the answer says how many are still open so nobody assumes otherwise.
 */
export function PersonBox({
  person,
  onEdit,
  onChanged,
}: {
  readonly person: EmployeeRow;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
}): JSX.Element {
  const [days, setDays] = useState(30);
  const record = useEmployeeRecord(person.employee_id, days);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">
            {person.employee_name}
            {person.state === 'baja' && (
              <span className="pill pill--mute">{EMPLOYEE_STATE_LABELS.baja}</span>
            )}
          </h2>
          <p className="panel__subtitle">
            {person.employee_email} · {person.job_title ?? 'Sin puesto'} ·{' '}
            {person.department ?? 'Sin departamento'}
          </p>
        </div>

        <div className="panel__tools">
          <label>
            <span className="sr-only">Rango que se resume</span>
            <select
              className="field"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {RANGES.map((range) => (
                <option key={range.days} value={range.days}>
                  {range.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="panel__body admin__form">
        <dl className="admin__facts">
          <div>
            <dt>En la empresa desde</dt>
            <dd>{formatDay(person.created_at)}</dd>
          </div>
          <div>
            <dt>Departamento</dt>
            <dd>{person.department ?? 'Sin departamento'}</dd>
          </div>
          <div>
            <dt>Acceso</dt>
            <dd>{person.has_account ? 'Tiene cuenta' : 'Sin cuenta'}</dd>
          </div>
        </dl>

        {record.error !== null && (
          <p className="note note--warn" role="status">
            {record.error}
          </p>
        )}

        {record.summary === null ? (
          record.loading && <div className="skeleton skeleton--panel" />
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

        <Actions person={person} onEdit={onEdit} onChanged={onChanged} onReloaded={record.refresh} />
      </div>
    </section>
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
        label="Días trabajados"
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
        <table className="admin__weeks">
          <thead>
            <tr>
              <th scope="col">Semana</th>
              <th scope="col">Días</th>
              <th scope="col">Horas</th>
              <th scope="col">Retardos</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((week) => (
              <tr key={week.week_start}>
                <th scope="row">{describeWeekStart(week.week_start)}</th>
                <td>
                  {week.days_worked} <span className="muted">de {week.days_scheduled}</span>
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

/**
 * The three things somebody can do from here, and the reason each of them takes.
 *
 * One place runs every action, so the busy flag, the failure and the reason box
 * cannot get out of step -- the same shape `AccessCard` settled on. Each write
 * re-reads rather than predicting: the roster reloads through `onChanged` and
 * the box's own figures through `onReloaded`.
 */
function Actions({
  person,
  onEdit,
  onChanged,
  onReloaded,
}: {
  readonly person: EmployeeRow;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
  readonly onReloaded: () => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [reset, setReset] = useState<ResetDayResult | null>(null);

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setFailure(null);
      setReset(null);
      try {
        const result = await action();
        setReset(
          typeof result === 'object' && result !== null && 'punches_voided' in result
            ? (result as ResetDayResult)
            : null,
        );
        setReason('');
        onChanged();
        onReloaded();
      } catch (error) {
        setFailure(describeReadFailure(error));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onReloaded],
  );

  const ready = reason.trim().length >= MIN_REASON;

  return (
    <>
      <label className="admin__field admin__labelled">
        <span className="admin__label">Motivo</span>
        <textarea
          className="admin__reason"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Por qué se reinicia la jornada o cambia su situación. Queda en la bitácora."
        />
      </label>

      <div className="admin__field admin__field--narrow">
        <label className="admin__labelled">
          <span className="admin__label">Día que se reinicia</span>
          <input
            className="field"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <span className="admin__hint">
          Vacío reinicia el día de hoy en la zona horaria de la persona.
        </span>
      </div>

      <div className="admin__actions">
        <button type="button" className="btn" disabled={busy} onClick={onEdit}>
          Editar ficha
        </button>

        <button
          type="button"
          className="btn"
          disabled={busy || !ready}
          onClick={() =>
            void run(() =>
              api.resetDay(person.employee_id, reason, date === '' ? undefined : date),
            )
          }
        >
          Reiniciar jornada
        </button>

        {person.state === 'activo' ? (
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy || !ready}
            onClick={() => void run(() => api.retireEmployee(person.employee_id, reason))}
          >
            Dar de baja
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--solid"
            disabled={busy || !ready}
            onClick={() => void run(() => api.restoreEmployee(person.employee_id, reason))}
          >
            Reactivar
          </button>
        )}
      </div>

      {!ready && (
        <p className="admin__hint">
          El motivo debe tener al menos {MIN_REASON} caracteres: queda escrito junto al cambio.
        </p>
      )}

      <p className="admin__hint admin__hint--warn">
        Dar de baja no borra a nadie. Conserva sus marcajes y su historial, y le retira el acceso;
        borrar de verdad se llevaría en silencio sus alertas y sus sesiones.
      </p>

      {reset !== null && (
        <p className="note note--warn" role="status">
          Se anularon {plural(reset.punches_voided, 'marcaje', 'marcajes')} del{' '}
          {formatDay(reset.date)}. No se borró ninguno: cada uno queda con el motivo al lado.
          {reset.open_alerts > 0 &&
            ` Quedan ${plural(reset.open_alerts, 'alerta abierta', 'alertas abiertas')} de ese día, que se resuelven en Revisión.`}
        </p>
      )}

      {failure !== null && <p className="review__error">{failure}</p>}
    </>
  );
}
