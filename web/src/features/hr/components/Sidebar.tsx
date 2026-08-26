import type { JSX } from 'react';
import type { Profile } from '../../../lib/types';
import { IconAlert, IconMark, IconReview, IconSelf, IconTeam } from './icons';

export type BoardView = 'team' | 'alerts' | 'review';

/**
 * Where you are, who you are, and whether what you are reading is current.
 *
 * Four destinations, and all four exist: the team, the open alerts, the
 * decisions waiting to be written down, and -- for somebody who is also an
 * employee -- their own day. Nothing here is a placeholder for a screen that
 * has not been built. A nav item that leads nowhere is worse than a short nav.
 *
 * The card above the profile is where the reference puts a promotion. It earns
 * the space instead by answering the question a board left open all day
 * actually raises: is this still current, and is the connection still up.
 */
export function Sidebar({
  view,
  onView,
  alertCount,
  reviewCount,
  profile,
  loadedAt,
  online,
  onOpenMyDay,
  onSignOut,
}: {
  readonly view: BoardView;
  readonly onView: (next: BoardView) => void;
  readonly alertCount: number;
  readonly reviewCount: number;
  readonly profile: Profile;
  readonly loadedAt: Date | null;
  readonly online: boolean;
  readonly onOpenMyDay: (() => void) | null;
  readonly onSignOut: () => void;
}): JSX.Element {
  return (
    <aside className="side">
      <div className="side__brand">
        <span className="side__mark">
          <IconMark />
        </span>
        Checador
      </div>

      {onOpenMyDay !== null && (
        <button className="btn btn--solid" type="button" onClick={onOpenMyDay}>
          <IconSelf />
          Mi jornada
        </button>
      )}

      <nav className="side__group" aria-label="Secciones">
        <span className="side__label">Tablero</span>

        <button
          className={`side__link${view === 'team' ? ' side__link--on' : ''}`}
          type="button"
          onClick={() => onView('team')}
          aria-current={view === 'team' ? 'page' : undefined}
        >
          <IconTeam />
          Equipo
        </button>

        <button
          className={`side__link${view === 'alerts' ? ' side__link--on' : ''}`}
          type="button"
          onClick={() => onView('alerts')}
          aria-current={view === 'alerts' ? 'page' : undefined}
        >
          <IconAlert />
          Alertas
          {alertCount > 0 && <span className="side__count">{alertCount}</span>}
        </button>

        <button
          className={`side__link${view === 'review' ? ' side__link--on' : ''}`}
          type="button"
          onClick={() => onView('review')}
          aria-current={view === 'review' ? 'page' : undefined}
        >
          <IconReview />
          Revisión
          {reviewCount > 0 && <span className="side__count">{reviewCount}</span>}
        </button>
      </nav>

      <div className="side__status">
        <span className="side__status-row">
          <span className={`live${online ? '' : ' live--off'}`} aria-hidden="true" />
          <span className="side__status-label">{online ? 'En línea' : 'Sin conexión'}</span>
        </span>
        <span className="side__status-row">
          <span className="side__status-label">Actualizado</span>
          <span className="side__status-value">
            {loadedAt === null
              ? '—'
              : new Intl.DateTimeFormat('es-MX', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
                }).format(loadedAt)}
          </span>
        </span>
      </div>

      <div className="side__foot">
        <div className="side__me">
          <span className="side__avatar" aria-hidden="true">
            {initials(profile.name)}
          </span>
          <span className="side__who">
            <span className="side__name">{profile.name ?? 'Cuenta administrativa'}</span>
            <span className="side__role">{profile.role}</span>
          </span>
        </div>

        <button className="btn" type="button" onClick={onSignOut}>
          Salir
        </button>
      </div>
    </aside>
  );
}

/** Two letters, so the avatar is a person rather than a grey circle. */
function initials(name: string | null): string {
  if (name === null || name.trim() === '') {
    return '··';
  }

  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}
