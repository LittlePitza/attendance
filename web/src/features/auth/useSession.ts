import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

export interface SessionState {
  readonly session: Session | null;
  readonly loading: boolean;
}

/**
 * The current session, kept in step with the auth client.
 *
 * `loading` exists so the application does not flash the login form at somebody
 * who is already signed in while the stored session is being read back.
 */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ session: null, loading: true });

  useEffect(() => {
    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setState({ session: data.session, loading: false });
      }
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, loading: false });
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return state;
}
