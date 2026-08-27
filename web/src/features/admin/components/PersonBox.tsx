import { useCallback, useState, type JSX } from 'react';
import { api } from '../../../lib/api';
import { describeReadFailure } from '../../../lib/errors';
import type { EmployeeRow, ResetDayResult } from '../../../lib/types';
import { plural } from '../../hr/labels';
import { EMPLOYEE_STATE_LABELS, formatDay } from '../labels';
import { useEmployeeRecord } from '../useEmployeeRecord';
import { RecordBody, RecordRange } from './RecordBody';

/** The database refuses anything shorter, and says so. Saying so first is kinder. */
const MIN_REASON = 10;

/**
 * Everything the database knows about one person, plus what can be done about it.
 *
 * The figures themselves live in `RecordBody`, shared with the board's own
 * copy of this box so the two can never disagree about the same person. What
 * belongs to this screen alone is underneath it: the actions.
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
          <RecordRange days={days} onChange={setDays} />
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

        <RecordBody record={record} />

        <Actions person={person} onEdit={onEdit} onChanged={onChanged} onReloaded={record.refresh} />
      </div>
    </section>
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
