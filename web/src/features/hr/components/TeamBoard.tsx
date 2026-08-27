import type { CSSProperties, JSX } from 'react';
import type { TeamMember, WorkdayState } from '../../../lib/types';
import { formatClock, formatScheduleTime, formatTime, plural, STATE_LABELS } from '../labels';
import { IconOffline, IconReview } from './icons';

const TONES: Readonly<Record<WorkdayState, string>> = {
  working: 'working',
  on_break: 'break',
  not_started: 'pending',
  finished: 'done',
};

/**
 * Everybody, and where each of them is.
 *
 * A list of rows rather than a `<table>`: there are four values per person and
 * one of them is a cluster of badges, which is a card, not a cell. On a narrow
 * screen the same markup restacks without the horizontal scroll a real table
 * would have needed.
 *
 * Rows are keyed by employee, so a filter change lets React reuse the row and
 * the browser animate it rather than flashing the whole list.
 */
export function TeamBoard({
  team,
  timeZone,
  alertsByEmployee,
  selectedId,
  onSelect,
  recordId,
}: {
  readonly team: readonly TeamMember[];
  readonly timeZone: string;
  readonly alertsByEmployee: ReadonlyMap<string, number>;
  /** Whose record is open below the board, if anybody's. */
  readonly selectedId: string | null;
  readonly onSelect: (employeeId: string) => void;
  readonly recordId: string;
}): JSX.Element {
  if (team.length === 0) {
    return (
      <p className="empty">
        Nadie coincide con este filtro. Prueba con otro estado o borra la búsqueda.
      </p>
    );
  }

  return (
    <ul className="rows">
      {team.map((member, index) => {
        const alerts = alertsByEmployee.get(member.employee_id) ?? 0;
        const open = selectedId === member.employee_id;

        return (
          <li
            key={member.employee_id}
            className={open ? 'row row--on' : 'row'}
            style={{ '--index': Math.min(index, 14) } as CSSProperties}
          >
            <button
              className="row__who row__select"
              type="button"
              data-employee={member.employee_id}
              aria-expanded={open}
              /* Only while the record exists: an IDREF pointing at an absent
                * id is a broken reference, and every collapsed row would be
                * claiming to control a region that is not in the document. */
              {...(open ? { 'aria-controls': recordId } : {})}
              /* The department is inside the button, so an aria-label naming
               * only the person would drop it from the accessibility tree --
               * and the row carries it nowhere else. */
              aria-label={`${open ? 'Cerrar' : 'Abrir'} ficha de ${member.employee_name}, ${
                member.department ?? 'sin departamento'
              }, ${STATE_LABELS[member.state].toLowerCase()}${
                alerts > 0 ? `, ${plural(alerts, 'alerta', 'alertas')}` : ''
              }`}
              onClick={() => onSelect(member.employee_id)}
            >
              <span className="row__avatar" aria-hidden="true">
                {initials(member.employee_name)}
              </span>
              <span className="row__ident">
                <span className="row__name">{member.employee_name}</span>
                <span className="row__dept">{member.department ?? 'Sin departamento'}</span>
              </span>
            </button>

            <span className={`state state--${TONES[member.state]}`}>
              <span className="dot" aria-hidden="true" />
              {STATE_LABELS[member.state]}
            </span>

            <span className="row__times">
              <span className="row__cell">
                <span className="row__cell-label">Entrada</span>
                <span className="row__cell-value">
                  {formatTime(member.opened_at, timeZone)}
                  <span className="row__expected">
                    /{formatScheduleTime(member.entry_expected)}
                  </span>
                </span>
              </span>
              <span className="row__cell">
                <span className="row__cell-label">Trabajado</span>
                <span className="row__cell-value">{formatClock(member.worked_seconds)}</span>
              </span>
              <span className="row__cell">
                <span className="row__cell-label">Pausa</span>
                <span className="row__cell-value">{formatClock(member.break_seconds)}</span>
              </span>
            </span>

            <span className="row__flags">
              {alerts > 0 && (
                <span className="pill pill--bad">{plural(alerts, 'alerta', 'alertas')}</span>
              )}
              {member.needs_review && (
                <span className="pill pill--warn" title="Tiene marcajes marcados para revisión">
                  <IconReview />
                  Por revisar
                </span>
              )}
              {member.has_offline && (
                <span className="pill pill--mute" title="Registró marcajes sin conexión">
                  <IconOffline />
                  Sin conexión
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Two letters, so a row reads as a person rather than a line of text. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}
