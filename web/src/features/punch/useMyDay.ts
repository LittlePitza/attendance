import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { NetworkUnavailableError, RpcError } from '../../lib/errors';
import type { MyDay } from '../../lib/types';

export interface MyDayState {
  readonly day: MyDay | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
}

/**
 * The day as the database sees it.
 *
 * There is no optimistic update here on purpose. After a punch the screen asks
 * again rather than guessing what the new state must be -- guessing would mean
 * the state machine living in two places, and the browser's copy would be the
 * one that is wrong when they disagree.
 *
 * A previously loaded day is kept when a refresh fails, so going offline mid
 * shift leaves the screen showing the last known truth instead of blanking.
 */
export function useMyDay(): MyDayState {
  const [day, setDay] = useState<MyDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDay(await api.myDay());
      setError(null);
    } catch (failure) {
      if (failure instanceof NetworkUnavailableError) {
        setError('Sin conexión. Se muestra lo último que se pudo consultar.');
      } else if (failure instanceof RpcError) {
        setError(failure.message);
      } else {
        throw failure;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Coming back to a tab that sat open all afternoon should not show the
    // morning. Visibility rather than focus: a phone waking up counts too.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  return { day, error, loading, refresh };
}
