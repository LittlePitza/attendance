import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Profile } from '../../lib/types';

export interface ProfileState {
  readonly profile: Profile | null;
  readonly loading: boolean;
  readonly failed: boolean;
}

/**
 * Who is signed in, and what they may see.
 *
 * The role decides which screen opens, and nothing more. It is not a
 * permission: every function this application calls is scoped by RLS in the
 * database, so a tampered role in the browser changes what is offered and never
 * what is returned.
 */
export function useProfile(): ProfileState {
  const [state, setState] = useState<ProfileState>({
    profile: null,
    loading: true,
    failed: false,
  });

  useEffect(() => {
    let active = true;

    void api
      .myProfile()
      .then((profile) => {
        if (active) {
          setState({ profile, loading: false, failed: false });
        }
      })
      .catch(() => {
        // Which screen to open is the only thing riding on this. Failing to a
        // usable punch screen beats a spinner that never resolves.
        if (active) {
          setState({ profile: null, loading: false, failed: true });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return state;
}
