import { useMemo, useState, type JSX } from 'react';
import type { DepartmentRow, EmployeeRow } from '../../../lib/types';
import { IconSearch } from '../../hr/components/icons';
import { plural } from '../../hr/labels';
import { EMPLOYEE_STATE_LABELS } from '../labels';
import { EmployeeForm } from './EmployeeForm';
import { PersonBox } from './PersonBox';

/**
 * The roster, and the box behind each name.
 *
 * It is a different list from `Accesos`, which shows who can sign in and only
 * ever shows active people. This one is who is on the payroll, so somebody who
 * has left is still reachable: their days are in the record, and a screen that
 * hid them would make their own attendance unreadable the moment they left.
 * They are out of the list by default, because the everyday question is about
 * people who are here.
 *
 * Nothing here decides anything. The list comes from `list_employees()`, which
 * refuses anybody who is not HR or admin; every write is gated again in the
 * database and prints the database's own Spanish sentence when refused.
 */
export function PeopleSection({
  employees,
  departments,
  onChanged,
}: {
  readonly employees: readonly EmployeeRow[];
  readonly departments: readonly DepartmentRow[];
  readonly onChanged: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<'none' | 'new' | 'selected'>('none');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return employees.filter((person) => {
      if (!showRetired && person.state === 'baja') {
        return false;
      }
      if (needle === '') {
        return true;
      }
      return (
        person.employee_name.toLowerCase().includes(needle) ||
        (person.department ?? '').toLowerCase().includes(needle) ||
        person.employee_email.toLowerCase().includes(needle)
      );
    });
  }, [employees, query, showRetired]);

  const retired = employees.filter((person) => person.state === 'baja').length;
  const active = employees.length - retired;
  const person = employees.find((candidate) => candidate.employee_id === selected) ?? null;

  return (
    <div className="admin__split">
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Personal</h2>
            <p className="panel__subtitle">
              {plural(active, 'persona activa', 'personas activas')}
              {retired > 0 && ` · ${plural(retired, 'baja', 'bajas')}`}
            </p>
          </div>

          <div className="panel__tools">
            <label className="search">
              <span className="search__icon">
                <IconSearch />
              </span>
              <span className="sr-only">Buscar persona</span>
              <input
                className="field"
                type="search"
                value={query}
                placeholder="Buscar…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={showRetired ? 'btn btn--solid' : 'btn'}
              aria-pressed={showRetired}
              onClick={() => setShowRetired((shown) => !shown)}
            >
              Ver bajas
            </button>
            <button
              type="button"
              className="btn btn--solid"
              onClick={() => {
                setSelected(null);
                setEditing('new');
              }}
            >
              Agregar
            </button>
          </div>
        </div>

        <ul className="admin__list">
          {visible.map((candidate) => (
            <li key={candidate.employee_id}>
              <button
                type="button"
                className={`admin__pick${selected === candidate.employee_id ? ' admin__pick--on' : ''}`}
                aria-pressed={selected === candidate.employee_id}
                onClick={() => {
                  setEditing('none');
                  setSelected(
                    selected === candidate.employee_id ? null : candidate.employee_id,
                  );
                }}
              >
                <span className="admin__pick-main">
                  <span className="admin__pick-name">{candidate.employee_name}</span>
                  <span className="muted">
                    {candidate.job_title ?? 'Sin puesto'} ·{' '}
                    {candidate.department ?? 'Sin departamento'}
                  </span>
                </span>
                <RosterBadge person={candidate} />
              </button>
            </li>
          ))}
          {visible.length === 0 && <li className="empty">Nadie coincide con esa búsqueda.</li>}
        </ul>
      </section>

      {editing === 'new' ? (
        <EmployeeForm
          person={null}
          departments={departments}
          onSaved={(employeeId) => {
            setEditing('none');
            setSelected(employeeId);
            onChanged();
          }}
          onCancel={() => setEditing('none')}
        />
      ) : person === null ? (
        <section className="panel">
          <div className="panel__body">
            <p className="muted">
              Elige a una persona para ver sus horas, su semana, sus desconexiones y sus accesos, o
              para reiniciar su jornada.
            </p>
          </div>
        </section>
      ) : editing === 'selected' ? (
        <EmployeeForm
          key={person.employee_id}
          person={person}
          departments={departments}
          onSaved={() => {
            setEditing('none');
            onChanged();
          }}
          onCancel={() => setEditing('none')}
        />
      ) : (
        <PersonBox
          key={person.employee_id}
          person={person}
          onEdit={() => setEditing('selected')}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

/** Two states, and the one worth spotting in a list is the person who has left. */
function RosterBadge({ person }: { readonly person: EmployeeRow }): JSX.Element {
  if (person.state === 'baja') {
    return <span className="pill pill--mute">{EMPLOYEE_STATE_LABELS.baja}</span>;
  }
  return person.has_account ? (
    <span className="pill pill--good">Con acceso</span>
  ) : (
    <span className="pill pill--warn">Sin cuenta</span>
  );
}
