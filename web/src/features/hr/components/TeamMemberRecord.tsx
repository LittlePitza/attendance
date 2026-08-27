import { useEffect, useRef, useState, type JSX } from 'react';
import type { TeamMember } from '../../../lib/types';
import { RecordBody, RecordRange } from '../../admin/components/RecordBody';
import { useEmployeeRecord } from '../../admin/useEmployeeRecord';

export const TEAM_RECORD_ID = 'team-employee-record';

/**
 * The same box Configuración shows, opened from the board.
 *
 * It reuses `RecordBody` rather than restating it, so the figures somebody
 * reads here are the ones they would read in Configuración. What it leaves out
 * is deliberate: editing the roster, resetting a day and retiring somebody are
 * administrative writes, and the board is a place to look at a day, not to
 * change somebody's record from.
 *
 * It takes focus when it opens. The record renders after the whole board, so a
 * keyboard user who activated row two of forty would otherwise have to tab past
 * every remaining row to reach what they just asked for; `aria-controls` is no
 * help, because following it is a JAWS-only affordance. Escape closes it and
 * hands focus back to the row.
 */
export function TeamMemberRecord({
  member,
  onClose,
}: {
  readonly member: TeamMember;
  readonly onClose: () => void;
}): JSX.Element {
  const [days, setDays] = useState(30);
  const record = useEmployeeRecord(member.employee_id, days);
  const box = useRef<HTMLElement>(null);

  // On open only: `member` is keyed by employee upstream, so this component is
  // a fresh instance per person and the effect cannot re-steal focus mid-read.
  useEffect(() => {
    box.current?.focus();
  }, []);

  return (
    <section
      className="panel"
      id={TEAM_RECORD_ID}
      ref={box}
      tabIndex={-1}
      aria-labelledby="team-employee-record-title"
      aria-busy={record.loading}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="panel__head">
        <div>
          <h2 className="panel__title" id="team-employee-record-title">
            {member.employee_name}
          </h2>
          <p className="panel__subtitle">
            {member.department ?? 'Sin departamento'} · Información de asistencia y accesos
          </p>
        </div>
        <div className="panel__tools">
          <RecordRange days={days} onChange={setDays} />
          <button className="btn" type="button" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
      <div className="panel__body admin__form">
        <RecordBody record={record} />
      </div>
    </section>
  );
}
