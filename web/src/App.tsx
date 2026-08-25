import { useCallback, type JSX } from 'react';
import { LoginScreen } from './features/auth/LoginScreen';
import { useSession } from './features/auth/useSession';
import { PunchScreen } from './features/punch/PunchScreen';
import { supabase } from './lib/supabase';

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

  return session === null ? <LoginScreen /> : <PunchScreen onSignOut={signOut} />;
}
