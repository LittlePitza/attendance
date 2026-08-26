import { useCallback, useState, type JSX } from 'react';
import { ChoosePasswordScreen } from './features/auth/ChoosePasswordScreen';
import { LoginScreen } from './features/auth/LoginScreen';
import { useProfile } from './features/auth/useProfile';
import { useSession } from './features/auth/useSession';
import { HrDashboard } from './features/hr/HrDashboard';
import { PunchScreen } from './features/punch/PunchScreen';
import { useAppSession } from './features/session/useAppSession';
import { supabase } from './lib/supabase';
import type { CallerRole } from './lib/types';

/** Roles that are offered the team board. Everyone else lands on their own day. */
const BOARD_ROLES: readonly CallerRole[] = ['manager', 'hr', 'admin'];

export function App(): JSX.Element {
  const { session, loading } = useSession();

  // The access log runs for as long as somebody is signed in, which includes
  // the temporary-password screen: they are signed in, on a machine, from an
  // address, and that is exactly what the log is for. It is enabled by a flag
  // rather than by where the hook is called, because a hook cannot be
  // conditional and the alternative is duplicating it on three branches.
  const { end: endSession, deviceRevoked } = useAppSession(session !== null);

  const signOut = useCallback((): void => {
    void (async () => {
      // Awaited, so the log records the hour they actually left rather than the
      // hour the sweeper noticed. It swallows its own failures: signing out is
      // never blocked by bookkeeping.
      await endSession('sign_out');
      await supabase.auth.signOut();
    })();
  }, [endSession]);

  if (loading) {
    return (
      <main className="app app--centered">
        <p className="muted">Abriendo tu sesión…</p>
      </main>
    );
  }

  if (session === null) {
    return <LoginScreen />;
  }

  // Set when HR hands out a temporary password, cleared when the person chooses
  // their own. Read from the session rather than from `my_profile()` because it
  // is a fact about the account, not about the employee -- and because it has to
  // hold before any other call is made: while it is true, somebody else knows
  // this password.
  if (session.user.user_metadata['must_change_password'] === true) {
    return <ChoosePasswordScreen onSignOut={signOut} />;
  }

  return <SignedIn onSignOut={signOut} deviceRevoked={deviceRevoked} />;
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
function SignedIn({
  onSignOut,
  deviceRevoked,
}: {
  readonly onSignOut: () => void;
  readonly deviceRevoked: boolean;
}): JSX.Element {
  const { profile, loading, failed } = useProfile();
  const [viewingOwnDay, setViewingOwnDay] = useState(false);

  const openMyDay = useCallback((): void => setViewingOwnDay(true), []);
  const openBoard = useCallback((): void => setViewingOwnDay(false), []);

  if (loading) {
    return (
      <main className="app app--centered">
        <p className="muted">Cargando tu perfil…</p>
      </main>
    );
  }

  // A profile that would not load leaves the punch screen, which is the one
  // thing every account needs and the one that reports its own errors properly.
  if (profile === null || failed) {
    return <PunchScreen onSignOut={onSignOut} deviceRevoked={deviceRevoked} />;
  }

  // `guest` is the default when no role was assigned, and it grants nothing.
  // Saying so is better than a screen whose every call comes back empty.
  if (profile.role === 'guest') {
    return (
      <main className="app app--centered">
        <section className="card card--message">
          <h1 className="card__title">Tu cuenta todavía no tiene acceso</h1>
          <p className="muted">
            Avisa a Recursos Humanos para que asignen tu rol. Mientras tanto no hay nada que
            mostrar aquí.
          </p>
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
    <PunchScreen
      onSignOut={onSignOut}
      onOpenBoard={canSeeBoard ? openBoard : null}
      name={profile.name}
      deviceRevoked={deviceRevoked}
    />
  );
}
