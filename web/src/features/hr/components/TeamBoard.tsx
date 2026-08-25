import type { CSSProperties, JSX } from 'react';
import type { TeamMember, WorkdayState } from '../../../lib/types';
import { formatClock, formatScheduleTime, formatTime, plural, STATE_LABELS } from '../labels';
import { IconOffline } from './icons';

const TONES: Readonly<Record<WorkdayState, string>> = {
  working: 'working',
  on_break: 'break',
  not_started: 'pending',
  finished: 'done',
};

/**
 * Everybody, and where each of them is.
 *
 * A list of rows rather than a `<table>`: there are five values per person and
 * one of them is a cluster of badges, which is a card, not a cell. On a phone
 * the same markup stacks without a horizontal scroll, which a real table would
 * have needed.
 *
 * Rows re-stagger whenever the filter changes -- keyed by employee, so React
 * reuses the row and the browser animates it, instead of the whole list
 * flashing.
 */
export function TeamBoard({
  team,
  timeZone,
  alertsByEmployee,
}: {
  readonly team: readonly TeamMember[];
  readonly timeZone: string;
  readonly alertsByEmployee: ReadonlyMap<string, number>;
}): JSX.Element {
  if (team.length === 0) {
    return (
      <p className="muted board__empty">
        Nadie coincide con este filtro. Prueba con otro estado o borra la búsqueda.
      </p>
    );
  }

  return (
    <ul className="board">
      {team.map((member, index) => {
        const alerts = alertsByEmployee.get(member.employee_id) ?? 0;

        return (
          <li
            key={member.employee_id}
            className={`board__row board__row--${TONES[member.state]}`}
            style={{ '--index': Math.min(index, 12) } as CSSProperties}
          >
            <span className="board__who">
              <span className={`dot dot--${TONES[member.state]}`} />
              <span className="board__name">{member.employee_name}</span>
              <span className="board__dept">{member.department ?? 'Sin departamento'}</span>
            </span>

            <span className={`chip chip--${TONES[member.state]}`}>
              {STATE_LABELS[member.state]}
            </span>

            <span className="board__times">
              <span className="board__time">
                <span className="board__time-label">Entrada</span>
                <span className="board__time-value">
                  {formatTime(member.opened_at, timeZone)}
                  <span className="board__expected">
                    /{formatScheduleTime(member.entry_expected)}
                  </span>
                </span>
              </span>
              <span className="board__time">
                <span className="board__time-label">Trabajado</span>
                <span className="board__time-value">{formatClock(member.worked_seconds)}</span>
              </span>
              <span className="board__time">
                <span className="board__time-label">Pausa</span>
                <span className="board__time-value">{formatClock(member.break_seconds)}</span>
              </span>
            </span>

            <span className="board__flags">
              {alerts > 0 && (
                <span className="tag tag--alert">{plural(alerts, 'alerta', 'alertas')}</span>
              )}
              {member.needs_review && <span className="tag tag--review">Por revisar</span>}
              {member.has_offline && (
                <span className="tag tag--offline" title="Registró marcajes sin conexión">
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
