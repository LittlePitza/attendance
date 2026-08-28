import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import type {
  AccountRow,
  AlertRuleRow,
  AttendanceSettings,
  DepartmentRow,
  EmployeeRow,
  ScheduleRow,
} from '../../lib/types';

export interface AdminData {
  readonly accounts: readonly AccountRow[];
  readonly employees: readonly EmployeeRow[];
  readonly departments: readonly DepartmentRow[];
  readonly schedules: readonly ScheduleRow[];
  readonly rules: readonly AlertRuleRow[];
  /**
   * Null for a caller the `settings_read` policy does not admit, and null is not
   * an error: a manager reaching this screen sees the sections their policies
   * allow rather than a failure they cannot act on.
   */
  readonly settings: AttendanceSettings | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
}

/**
 * The configuration, in one read.
 *
 * Six calls rather than six hooks, and no refresh loop -- deliberately, and
 * for the opposite reasons to `useTeamDay`. Configuration changes when somebody
 * on this screen changes it, so a timer would only ever reload what the reader
 * just wrote, and would do it underneath a half-filled form. It reloads when
 * asked and after every write.
 *
 * `Promise.all` because a partly loaded screen is worse than a slow one: the
 * account list is read against the department list and the schedule list, and
 * showing one without the others invites a decision made on half the picture.
 * The roster joins them for the same reason -- it is the list the other four
 * hang off, and giving somebody access before their record loads is exactly the
 * decision made on half the picture.
 */
export function useAdminData(): AdminData {
  const [accounts, setAccounts] = useState<readonly AccountRow[]>([]);
  const [employees, setEmployees] = useState<readonly EmployeeRow[]>([]);
  const [departments, setDepartments] = useState<readonly DepartmentRow[]>([]);
  const [schedules, setSchedules] = useState<readonly ScheduleRow[]>([]);
  const [rules, setRules] = useState<readonly AlertRuleRow[]>([]);
  const [settings, setSettings] = useState<AttendanceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [
        nextAccounts,
        nextEmployees,
        nextDepartments,
        nextSchedules,
        nextRules,
        nextSettings,
      ] = await Promise.all([
        api.listAccounts(),
        api.listEmployees(),
        api.listDepartments(),
        api.listSchedules(),
        api.listAlertRules(),
        api.attendanceSettings(),
      ]);

      setAccounts(nextAccounts);
      setEmployees(nextEmployees);
      setDepartments(nextDepartments);
      setSchedules(nextSchedules);
      setRules(nextRules);
      setSettings(nextSettings);
      setError(null);
    } catch (failure) {
      // Reported, never re-thrown: this runs in a detached promise, and an error
      // thrown into one becomes a rejection nobody reads while the screen goes
      // on showing the previous answer as though it were current.
      setError(describeReadFailure(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    accounts,
    employees,
    departments,
    schedules,
    rules,
    settings,
    error,
    loading,
    refresh,
  };
}
