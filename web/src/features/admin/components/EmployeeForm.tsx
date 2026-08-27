import { useCallback, useState, type JSX } from 'react';
import { api } from '../../../lib/api';
import { describeReadFailure } from '../../../lib/errors';
import type { DepartmentRow, EmployeeRow } from '../../../lib/types';

/** The database asks for three characters and says so. Saying it first is kinder. */
const MIN_NAME = 3;

/**
 * The four things about a person this screen may change.
 *
 * Not five. `estado` is missing on purpose: moving somebody between activo and
 * baja is a decision that takes a reason, so it lives on the two buttons below
 * the box and not in a form field somebody can flip while editing a job title.
 * `extension` is missing for a different reason -- it belongs to the help desk,
 * and `save_employee()` does not write it either.
 *
 * Every field here is validated again by the database, and what a refusal prints
 * is the database's own Spanish sentence rather than a kinder one invented here.
 */
export function EmployeeForm({
  person,
  departments,
  onSaved,
  onCancel,
}: {
  readonly person: EmployeeRow | null;
  readonly departments: readonly DepartmentRow[];
  readonly onSaved: (employeeId: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState(person?.employee_name ?? '');
  const [email, setEmail] = useState(person?.employee_email ?? '');
  const [jobTitle, setJobTitle] = useState(person?.job_title ?? '');
  const [departmentId, setDepartmentId] = useState(person?.department_id ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const saved = await api.saveEmployee({
        ...(person === null ? {} : { id: person.employee_id }),
        name: name.trim(),
        email: email.trim(),
        jobTitle: jobTitle.trim() === '' ? undefined : jobTitle.trim(),
        departmentId: departmentId === '' ? undefined : departmentId,
      });
      onSaved(saved.employee_id);
    } catch (error) {
      setFailure(describeReadFailure(error));
    } finally {
      setBusy(false);
    }
  }, [person, name, email, jobTitle, departmentId, onSaved]);

  const ready = name.trim().length >= MIN_NAME && email.trim() !== '';

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">
            {person === null ? 'Agregar a alguien' : `Editar a ${person.employee_name}`}
          </h2>
          <p className="panel__subtitle">
            Es la misma ficha que usa la mesa de ayuda. Su departamento decide la zona horaria y
            el horario que le aplica.
          </p>
        </div>
      </div>

      <form
        className="panel__body admin__form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="admin__field admin__labelled">
          <span className="admin__label">Nombre</span>
          <input
            className="field"
            type="text"
            value={name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        {/* The hint is a sibling of the label, never inside it: a label's text
            is its whole content, and a sentence swallowed into it becomes part
            of the field's accessible name. */}
        <div className="admin__field">
          <label className="admin__labelled">
            <span className="admin__label">Correo</span>
            <input
              className="field"
              type="email"
              value={email}
              autoComplete="off"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <span className="admin__hint">
            Es la dirección con la que se crea su acceso, en Accesos. No puede repetirse.
          </span>
        </div>

        <div className="admin__grid">
          <label className="admin__field admin__labelled">
            <span className="admin__label">Puesto</span>
            <input
              className="field"
              type="text"
              value={jobTitle}
              autoComplete="off"
              onChange={(event) => setJobTitle(event.target.value)}
            />
          </label>

          <label className="admin__field admin__labelled">
            <span className="admin__label">Departamento</span>
            <select
              className="field"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">Sin departamento</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="admin__actions">
          <button type="submit" className="btn btn--solid" disabled={busy || !ready}>
            {person === null ? 'Agregar persona' : 'Guardar cambios'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancelar
          </button>
        </div>

        {!ready && (
          <p className="admin__hint">El nombre necesita al menos {MIN_NAME} caracteres y falta el correo.</p>
        )}

        {failure !== null && <p className="review__error">{failure}</p>}
      </form>
    </section>
  );
}
