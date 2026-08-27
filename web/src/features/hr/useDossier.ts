import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import type { EmployeeDossier } from '../../lib/types';

export interface DossierState {
  readonly dossier: EmployeeDossier | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

/**
 * Everything about one person, in one read.
 *
 * One call rather than six, and that is the point of `employee_dossier()`: six
 * requests would each fail on their own and leave the page half-drawn, with no
 * way for a reader to know whether an empty device list meant no devices or a
 * failed request. The database assembles it, so the page is whole or it is
 * honestly absent.
 *
 * The previous person is cleared as soon as another is picked. A page that kept
 * the last one on screen while the next loaded would show one person's name over
 * another person's hours, and for the two seconds that lasted it would be
 * completely believable.
 *
 * No refresh loop, for the reason `useAdminData` gives: nothing here changes
 * except when somebody changes it, and a timer would move rows underneath a
 * reader comparing two of them.
 */
export function useDossier(employeeId: string | null, days: number): DossierState {
  const [dossier, setDossier] = useState<EmployeeDossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback((): void => setNonce((current) => current + 1), []);

  useEffect(() => {
    if (employeeId === null) {
      setDossier(null);
      setError(null);
      return;
    }

    let live = true;
    setLoading(true);
    setDossier(null);

    void api
      .employeeDossier(employeeId, days)
      .then((answer) => {
        if (live) {
          setDossier(answer);
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (live) {
          setDossier(null);
          setError(describeReadFailure(failure));
        }
      })
      .finally(() => {
        if (live) {
          setLoading(false);
        }
      });

    return () => {
      live = false;
    };
  }, [employeeId, days, nonce]);

  return { dossier, error, loading, refresh };
}
