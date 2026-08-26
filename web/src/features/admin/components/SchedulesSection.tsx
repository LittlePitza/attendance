import { useCallback, useMemo, useState, type JSX } from 'react';
import { api } from '../../../lib/api';
import { describeReadFailure } from '../../../lib/errors';
import {
  SCHEDULE_SCOPES,
  type AccountRow,
  type DepartmentRow,
  type ScheduleDraft,
  type ScheduleRow,
  type ScheduleScope,
} from '../../../lib/types';
import { IconClock } from '../../hr/components/icons';
import { SCOPE_LABELS, WEEKDAYS, describeDays } from '../labels';

const MIN_REASON = 10;

/** What a new schedule starts as: the working day this company already keeps. */
const BLANK: ScheduleDraft = {
  scope: 'global',
  name: '',
  days: [1, 2, 3, 4, 5],
  entryFrom: '07:00',
  entryUntil: '10:00',
  entryExpected: '09:00',
  exitExpected: '18:00',
  graceMinutes: 10,
  breakMaxMinutes: 60,
};

/**
 * The hours everything else is measured against.
 *
 * Worth knowing before changing one: this is what `evaluate_alerts()` compares
 * arrivals to. Moving the expected entry back an hour changes what "late" meant
 * for today and yesterday, which are the two days it still re-reads. Anything
 * older is already written down as an alert and does not move.
 *
 * Precedence when more than one could apply is the database's and is not
 * re-implemented here: a person's own schedule wins over their department's,
 * which wins over the company's.
 */
export function SchedulesSection({
  schedules,
  departments,
  accounts,
  onChanged,
}: {
  readonly schedules: readonly ScheduleRow[];
  readonly departments: readonly DepartmentRow[];
  readonly accounts: readonly AccountRow[];
  readonly onChanged: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState<ScheduleRow | 'new' | null>(null);

  const live = schedules.filter((schedule) => schedule.active);
  const retired = schedules.filter((schedule) => !schedule.active);

  return (
    <div className="admin__split">
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Horarios</h2>
            <p className="panel__subtitle">
              Manda el más específico: el de la persona sobre el del departamento, y ése sobre el de
              la empresa.
            </p>
          </div>
          <div className="panel__tools">
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => setEditing(editing === 'new' ? null : 'new')}
              aria-pressed={editing === 'new'}
            >
              Nuevo horario
            </button>
          </div>
        </div>

        <ul className="admin__list">
          {live.map((schedule) => (
            <li key={schedule.id}>
              <button
                type="button"
                className={`admin__pick${
                  editing !== null && editing !== 'new' && editing.id === schedule.id
                    ? ' admin__pick--on'
                    : ''
                }`}
                onClick={() =>
                  setEditing(
                    editing !== null && editing !== 'new' && editing.id === schedule.id
                      ? null
                      : schedule,
                  )
                }
              >
                <span className="admin__pick-main">
                  <span className="admin__pick-name">{schedule.name}</span>
                  <span className="muted">
                    {schedule.applies_to} · {describeDays(schedule.days)} ·{' '}
                    {schedule.entry_expected}–{schedule.exit_expected}
                  </span>
                </span>
                <span className="pill pill--info">{SCOPE_LABELS[schedule.scope]}</span>
              </button>
            </li>
          ))}
        </ul>

        {retired.length > 0 && (
          <div className="panel__body">
            <p className="admin__label">Retirados</p>
            <ul className="admin__retired">
              {retired.map((schedule) => (
                <li key={schedule.id}>
                  <span>{schedule.name}</span>
                  <span className="muted">{schedule.applies_to}</span>
                </li>
              ))}
            </ul>
            <p className="admin__hint">
              No se borran: la jornada de cada día guarda contra qué horario se midió.
            </p>
          </div>
        )}
      </section>

      {editing === null ? (
        <section className="panel">
          <div className="panel__body">
            <p className="muted">
              Elige un horario para cambiarlo o retirarlo, o crea uno nuevo para un departamento o
              una persona.
            </p>
          </div>
        </section>
      ) : (
        <ScheduleForm
          key={editing === 'new' ? 'new' : editing.id}
          schedule={editing === 'new' ? null : editing}
          departments={departments}
          accounts={accounts}
          onDone={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function ScheduleForm({
  schedule,
  departments,
  accounts,
  onDone,
}: {
  readonly schedule: ScheduleRow | null;
  readonly departments: readonly DepartmentRow[];
  readonly accounts: readonly AccountRow[];
  readonly onDone: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ScheduleDraft>(() => toDraft(schedule));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const patch = useCallback(
    (change: Partial<ScheduleDraft>): void => setDraft((current) => ({ ...current, ...change })),
    [],
  );

  const toggleDay = useCallback((iso: number): void => {
    setDraft((current) => ({
      ...current,
      days: current.days.includes(iso)
        ? current.days.filter((day) => day !== iso)
        : [...current.days, iso].sort((a, b) => a - b),
    }));
  }, []);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await api.saveSchedule(draft);
      onDone();
    } catch (error) {
      // The database's own words: it names the field that is wrong, in Spanish.
      setFailure(describeReadFailure(error));
    } finally {
      setBusy(false);
    }
  }, [draft, onDone]);

  const retire = useCallback(async (): Promise<void> => {
    if (schedule === null) {
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      await api.retireSchedule(schedule.id, reason);
      onDone();
    } catch (error) {
      setFailure(describeReadFailure(error));
    } finally {
      setBusy(false);
    }
  }, [schedule, reason, onDone]);

  // Only people with an account can punch, so only they can be measured against
  // a schedule of their own. Offering the rest would create a rule for somebody
  // the evaluator does not look at.
  const withAccount = useMemo(
    () => accounts.filter((account) => account.has_account),
    [accounts],
  );

  const ready =
    draft.name.trim().length >= 3 &&
    draft.days.length > 0 &&
    (draft.scope !== 'department' || draft.departmentId !== undefined) &&
    (draft.scope !== 'employee' || draft.employeeId !== undefined);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">
            <IconClock />
            {schedule === null ? 'Nuevo horario' : schedule.name}
          </h2>
          <p className="panel__subtitle">
            {schedule === null
              ? 'Sólo puede haber un horario vigente por alcance.'
              : 'El alcance no se cambia: retira este horario y crea el nuevo.'}
          </p>
        </div>
      </div>

      <div className="panel__body admin__form">
        <label className="admin__field">
          <span className="admin__label">Aplica a</span>
          <select
            className="field"
            value={draft.scope}
            disabled={schedule !== null}
            onChange={(event) => {
              const scope = event.target.value as ScheduleScope;
              setDraft((current) => ({
                ...current,
                scope,
                // Cleared, not carried: a department id left on an employee-scoped
                // draft is exactly what the database's coherence check refuses.
                departmentId: undefined,
                employeeId: undefined,
              }));
            }}
          >
            {SCHEDULE_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {SCOPE_LABELS[scope]}
              </option>
            ))}
          </select>
        </label>

        {draft.scope === 'department' && (
          <label className="admin__field">
            <span className="admin__label">Departamento</span>
            <select
              className="field"
              value={draft.departmentId ?? ''}
              onChange={(event) => patch({ departmentId: event.target.value || undefined })}
            >
              <option value="">Elige uno…</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name} ({String(department.employee_count)})
                </option>
              ))}
            </select>
          </label>
        )}

        {draft.scope === 'employee' && (
          <div className="admin__field">
            <label className="admin__labelled">
              <span className="admin__label">Persona</span>
              <select
                className="field"
                value={draft.employeeId ?? ''}
                onChange={(event) => patch({ employeeId: event.target.value || undefined })}
              >
                <option value="">Elige a una…</option>
                {withAccount.map((account) => (
                  <option key={account.employee_id} value={account.employee_id}>
                    {account.employee_name}
                  </option>
                ))}
              </select>
            </label>
            <span className="admin__hint">
              Solo aparece quien ya tiene cuenta: sin cuenta no hay marcajes que medir.
            </span>
          </div>
        )}

        <label className="admin__field">
          <span className="admin__label">Nombre</span>
          <input
            className="field"
            type="text"
            value={draft.name}
            placeholder="Jornada general de oficina"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>

        <fieldset className="admin__field admin__days">
          <legend className="admin__label">Días</legend>
          {WEEKDAYS.map((day) => (
            <button
              key={day.iso}
              type="button"
              className={`admin__day${draft.days.includes(day.iso) ? ' admin__day--on' : ''}`}
              aria-pressed={draft.days.includes(day.iso)}
              onClick={() => toggleDay(day.iso)}
            >
              <span aria-hidden="true">{day.short}</span>
              <span className="sr-only">{day.long}</span>
            </button>
          ))}
          <span className="admin__hint">{describeDays(draft.days)}</span>
        </fieldset>

        <div className="admin__grid">
          <TimeField
            label="Entrada esperada"
            hint="La hora a la que se espera que empiece"
            value={draft.entryExpected}
            onChange={(entryExpected) => patch({ entryExpected })}
          />
          <TimeField
            label="Salida esperada"
            hint="Pasada esta hora con la jornada abierta se avisa"
            value={draft.exitExpected}
            onChange={(exitExpected) => patch({ exitExpected })}
          />
          <TimeField
            label="Ventana desde"
            hint="Antes de esta hora marcar no genera nada"
            value={draft.entryFrom}
            onChange={(entryFrom) => patch({ entryFrom })}
          />
          <TimeField
            label="Ventana hasta"
            hint="Pasada esta hora sin entrada se levanta la alerta"
            value={draft.entryUntil}
            onChange={(entryUntil) => patch({ entryUntil })}
          />
          <NumberField
            label="Tolerancia"
            unit="minutos"
            value={draft.graceMinutes}
            max={120}
            onChange={(graceMinutes) => patch({ graceMinutes })}
          />
          <NumberField
            label="Pausa máxima"
            unit="minutos"
            value={draft.breakMaxMinutes}
            max={480}
            onChange={(breakMaxMinutes) => patch({ breakMaxMinutes })}
          />
        </div>

        <div className="admin__actions">
          <button
            type="button"
            className="btn btn--solid"
            disabled={busy || !ready}
            onClick={() => void save()}
          >
            {schedule === null ? 'Crear horario' : 'Guardar cambios'}
          </button>
        </div>

        {schedule !== null && (
          <>
            <label className="admin__field">
              <span className="admin__label">Motivo para retirarlo</span>
              <textarea
                className="admin__reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Por qué deja de aplicar. Queda en la bitácora."
              />
            </label>
            <div className="admin__actions">
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy || reason.trim().length < MIN_REASON}
                onClick={() => void retire()}
              >
                Retirar horario
              </button>
            </div>
          </>
        )}

        {failure !== null && <p className="review__error">{failure}</p>}
      </div>
    </section>
  );
}

function TimeField({
  label,
  hint,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}): JSX.Element {
  return (
    <div className="admin__field">
      <label className="admin__labelled">
        <span className="admin__label">{label}</span>
        <input
          className="field"
          type="time"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <span className="admin__hint">{hint}</span>
    </div>
  );
}

function NumberField({
  label,
  unit,
  value,
  max,
  onChange,
}: {
  readonly label: string;
  readonly unit: string;
  readonly value: number;
  readonly max: number;
  readonly onChange: (next: number) => void;
}): JSX.Element {
  return (
    <div className="admin__field">
      <label className="admin__labelled">
        <span className="admin__label">{label}</span>
        <input
          className="field"
          type="number"
          min={0}
          max={max}
          value={value}
          onChange={(event) => {
          // An emptied number input reads as NaN, which would travel to the
          // database as null and be refused. Zero is a legal tolerance, so it is
          // the honest reading of an empty box.
            const parsed = Number.parseInt(event.target.value, 10);
            onChange(Number.isNaN(parsed) ? 0 : parsed);
          }}
        />
      </label>
      <span className="admin__hint">{unit}</span>
    </div>
  );
}

/** `HH:MM:SS` comes back from Postgres for a bare time; the input wants `HH:MM`. */
function toDraft(schedule: ScheduleRow | null): ScheduleDraft {
  if (schedule === null) {
    return BLANK;
  }

  return {
    id: schedule.id,
    scope: schedule.scope,
    ...(schedule.department_id === null ? {} : { departmentId: schedule.department_id }),
    ...(schedule.employee_id === null ? {} : { employeeId: schedule.employee_id }),
    name: schedule.name,
    days: schedule.days,
    entryFrom: schedule.entry_from.slice(0, 5),
    entryUntil: schedule.entry_until.slice(0, 5),
    entryExpected: schedule.entry_expected.slice(0, 5),
    exitExpected: schedule.exit_expected.slice(0, 5),
    graceMinutes: schedule.grace_minutes,
    breakMaxMinutes: schedule.break_max_minutes,
  };
}
