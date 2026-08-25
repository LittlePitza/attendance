import { useCallback, useState, type JSX } from 'react';
import { LoginScreen } from './features/auth/LoginScreen';
import { useProfile } from './features/auth/useProfile';
import { useSession } from './features/auth/useSession';
import { HrDashboard } from './features/hr/HrDashboard';
import { PunchScreen } from './features/punch/PunchScreen';
import { supabase } from './lib/supabase';
import type { CallerRole } from './lib/types';

/** Roles that are offered the team board. Everyone else lands on their own day. */
const BOARD_ROLES: readonly CallerRole[] = ['manager', 'hr', 'admin'];

export function App(): JSX.Element {
  const { session, loading } = useSession();

  const signOut = useCallback((): void => {
    void supabase.auth.signOut();
  }, []);

  if (loading) {
    return (
      <main className="screen screen--centered">
        <p className="muted">Abriendo tu sesión…</p>
      </main>
    );
  }

  if (session === null) {
    return <LoginScreen />;
  }

  return <SignedIn onSignOut={signOut} />;
}

/**
 * Which screen a signed-in account opens on.
 *
 * The role chooses the screen and nothing more. It is not a permission: every
 * function this application calls is scoped by RLS in the database, so a role
 * tampered with in the browser changes what is *offered* and never what comes
 * back. A manager who forced their way onto the board would see their own
 * department, because that is what `team_day()` returns them.
 */
function SignedIn({ onSignOut }: { readonly onSignOut: () => void }): JSX.Element {
  const { profile, loading, failed } = useProfile();
  const [viewingOwnDay, setViewingOwnDay] = useState(false);

  const openMyDay = useCallback((): void => setViewingOwnDay(true), []);
  const openBoard = useCallback((): void => setViewingOwnDay(false), []);

  if (loading) {
    return (
      <main className="screen screen--centered">
        <p className="muted">Cargando tu perfil…</p>
      </main>
    );
  }

  // A profile that would not load leaves the punch screen, which is the one
  // thing every account needs and the one that reports its own errors properly.
  if (profile === null || failed) {
    return <PunchScreen onSignOut={onSignOut} />;
  }

  // `guest` is the default when no role was assigned, and it grants nothing.
  // Saying so is better than a screen whose every call comes back empty.
  if (profile.role === 'guest') {
    return (
      <main className="screen screen--centered">
        <section className="card">
          <h1 className="card__title">Tu cuenta todavía no tiene acceso</h1>
          <p className="muted">
            Avisa a Recursos Humanos para que asignen tu rol. Mientras tanto no hay nada que
            mostrar aquí.
          </p>
          <p />
          <button className="button button--quiet" type="button" onClick={onSignOut}>
            Salir
          </button>
        </section>
      </main>
    );
  }

  const canSeeBoard = BOARD_ROLES.includes(profile.role);
  // There is an administrator account that is not a person. It has no workday
  // to show, so it is never offered one.
  const isEmployee = profile.employee_id !== null;

  if (canSeeBoard && !(viewingOwnDay && isEmployee)) {
    return (
      <HrDashboard
        profile={profile}
        onSignOut={onSignOut}
        onOpenMyDay={isEmployee ? openMyDay : null}
      />
    );
  }

  return (
    <PunchScreen onSignOut={onSignOut} onOpenBoard={canSeeBoard ? openBoard : null} />
  );
}
