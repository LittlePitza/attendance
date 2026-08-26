import type { CSSProperties, JSX } from 'react';
import type { AppSession } from '../../../lib/types';
import { IconDevice, IconPin } from '../../shell/icons';
import { SESSION_END_LABELS, formatClock, formatSessionMoment } from '../labels';

/**
 * Where this account has been signed in from, and for how long.
 *
 * It is shown to the person it is about, and that is the point rather than a
 * feature. The application records the machine, the address it connected from
 * and the hours between opening and closing; somebody being recorded should not
 * have to ask anybody to find out what was recorded. A log only management can
 * read is a log the people in it have no way to check.
 *
 * The machine currently in front of them is named, because the one row worth
 * recognising instantly is a row that is *not* this machine.
 */
export function SessionList({
  sessions,
  deviceId,
  timeZone,
}: {
  readonly sessions: readonly AppSession[];
  readonly deviceId: string;
  readonly timeZone: string;
}): JSX.Element {
  if (sessions.length === 0) {
    return <p className="blank">Este es tu primer acceso registrado.</p>;
  }

  return (
    <ul className="access">
      {sessions.map((session, index) => (
        <li className="access__row" key={session.id} style={{ '--index': index } as CSSProperties}>
          <span className="access__icon">
            <IconDevice />
          </span>

          <span className="access__what">
            <span className="access__where">
              {session.device_id === deviceId ? 'Este equipo' : 'Otro equipo'}
              {session.platform !== null && session.platform !== '' && (
                <span className="access__platform"> · {session.platform}</span>
              )}
              {session.active && <span className="tag tag--live">ahora</span>}
            </span>

            <span className="access__when">
              {formatSessionMoment(session.started_at, timeZone)}
              {' → '}
              {session.ended_at === null
                ? 'sigue abierta'
                : formatSessionMoment(session.ended_at, timeZone)}
              {session.end_reason !== null && (
                <span className="access__reason"> · {SESSION_END_LABELS[session.end_reason]}</span>
              )}
            </span>
          </span>

          <span className="access__meta">
            <span className="access__length">{lengthOf(session)}</span>
            {session.ip !== null && session.ip !== '' && (
              <span className="access__ip">
                <IconPin />
                {session.ip}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * How long the session lasted.
 *
 * An open one is measured to its last report rather than to now: `last_seen_at`
 * is the last moment anything is actually known about, and a figure that
 * climbed on its own while the row said nothing new would be an invention. It
 * is at most five minutes behind, which is the reporting interval.
 */
function lengthOf(session: AppSession): string {
  const from = Date.parse(session.started_at);
  const to = Date.parse(session.ended_at ?? session.last_seen_at);

  if (Number.isNaN(from) || Number.isNaN(to)) {
    return '—';
  }

  return formatClock(Math.max(0, (to - from) / 1000));
}
