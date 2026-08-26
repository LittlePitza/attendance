import { NetworkUnavailableError, RpcError, isTransportFailure } from './errors';
import { supabase } from './supabase';
import type {
  AccountRow,
  AlertDecision,
  AlertDecisionResult,
  AlertKind,
  AlertRuleRow,
  AssignableRole,
  DepartmentRow,
  EmployeeDay,
  HeartbeatResult,
  MyDay,
  OfflinePunchEvent,
  OpenAlert,
  Profile,
  ProvisionResult,
  PunchDecision,
  PunchKind,
  PunchResult,
  ReviewResult,
  SaveResult,
  ScheduleDraft,
  ScheduleRow,
  ServerTime,
  SyncResult,
  TeamMember,
} from './types';

/**
 * The only module that names a database function.
 *
 * Everything above this line works with typed values; everything below it is
 * PostgREST. Keeping the names in one place means a renamed function is one
 * edit, and means no component can quietly invent a call of its own.
 */
async function rpc<T>(name: string, args?: Readonly<Record<string, unknown>>): Promise<T> {
  // Asking while the browser already knows it is offline wastes a timeout the
  // employee has to wait through before the punch reaches the queue.
  if (!navigator.onLine) {
    throw new NetworkUnavailableError();
  }

  const { data, error } = await supabase.rpc(name, args);

  if (error !== null) {
    throw isTransportFailure(error)
      ? new NetworkUnavailableError(error.message)
      : new RpcError(error.message, error.code);
  }

  return data as T;
}

/**
 * The one Edge Function the browser calls.
 *
 * `invoke` reports a non-2xx as a `FunctionsHttpError` carrying the raw
 * `Response`, which means the function's own sentence -- often the database's,
 * in Spanish -- is one `await` away and would otherwise be replaced by
 * "Edge Function returned a non-2xx status code". Unwrapping it here keeps every
 * failure in this module the same shape: an `RpcError` the screen can print.
 */
async function invokeFunction<T>(
  name: string,
  body: Readonly<Record<string, unknown>>,
): Promise<T> {
  if (!navigator.onLine) {
    throw new NetworkUnavailableError();
  }

  const { data, error } = await supabase.functions.invoke<T>(name, { body });

  if (error !== null) {
    throw new RpcError(await sentenceFrom(error));
  }
  if (data === null) {
    throw new RpcError('La función no devolvió nada');
  }

  return data;
}

async function sentenceFrom(error: unknown): Promise<string> {
  const response = (error as { context?: unknown }).context;

  if (response instanceof Response) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error !== '') {
      return body.error;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

export interface OnlinePunchInput {
  readonly kind: PunchKind;
  readonly idempotencyKey: string;
  readonly clientReportedAt: string;
  readonly clockSkewMs: number;
  readonly deviceId: string;
}

export const api = {
  /** The punch screen, in one round trip. */
  myDay: (): Promise<MyDay> => rpc<MyDay>('my_day'),

  /** The official clock, used to measure how far this device has drifted. */
  serverTime: (): Promise<ServerTime> => rpc<ServerTime>('server_time'),

  /**
   * The timestamp that counts is the server's. What is sent here is stored
   * beside it as `client_reported_at`, for auditing only.
   */
  punch: (input: OnlinePunchInput): Promise<PunchResult> =>
    rpc<PunchResult>('punch', {
      p_kind: input.kind,
      p_idempotency_key: input.idempotencyKey,
      p_client_reported_at: input.clientReportedAt,
      p_clock_skew_ms: input.clockSkewMs,
      p_device_id: input.deviceId,
    }),

  /** Offline punches, replayed. The database sorts them; arrival order is not trusted. */
  syncPunches: (events: readonly OfflinePunchEvent[]): Promise<SyncResult> =>
    rpc<SyncResult>('sync_punches', { p_events: events }),

  /** Proof of life while a workday is open. Feeds the `no_connection` alert. */
  heartbeat: (): Promise<HeartbeatResult> => rpc<HeartbeatResult>('heartbeat'),

  /**
   * Who is signed in, and what they are allowed to see. One row, or none at
   * all when the account is not linked to an employee.
   */
  myProfile: async (): Promise<Profile | null> =>
    (await rpc<Profile[]>('my_profile'))[0] ?? null,

  /**
   * The board: every employee the caller may see, on one date. Who that is
   * comes from RLS, never from a role check written in the browser.
   */
  teamDay: (date?: string): Promise<TeamMember[]> =>
    rpc<TeamMember[]>('team_day', date === undefined ? {} : { p_date: date }),

  /** What the evaluator raised and nobody has dealt with. */
  openAlerts: (since?: string): Promise<OpenAlert[]> =>
    rpc<OpenAlert[]>('open_alerts', since === undefined ? {} : { p_since: since }),

  /**
   * The evidence behind a flagged day: one employee's punches and the decision
   * already recorded against each. Scope comes from RLS, so asking about
   * somebody outside it is refused by the database, not by this call.
   */
  employeeDay: (employeeId: string, date?: string): Promise<EmployeeDay> =>
    rpc<EmployeeDay>('employee_day', {
      p_employee_id: employeeId,
      ...(date === undefined ? {} : { p_date: date }),
    }),

  /**
   * HR's decision about a punch that arrived flagged. The punch is append-only
   * and never changes; this writes the decision beside it.
   */
  reviewPunch: (
    punchId: string,
    decision: PunchDecision,
    reason: string,
  ): Promise<ReviewResult> =>
    rpc<ReviewResult>('review_punch', {
      p_punch_id: punchId,
      p_decision: decision,
      p_reason: reason,
    }),

  /** What HR decided an alert was worth. Never deletes it, never reopens it. */
  decideAlert: (
    alertId: string,
    state: AlertDecision,
    note: string,
  ): Promise<AlertDecisionResult> =>
    rpc<AlertDecisionResult>('decide_alert', {
      p_alert_id: alertId,
      p_state: state,
      p_note: note,
    }),

  /* --------------------------------------------------- Administration --- */

  /** Every active person and the state of their access. HR and admin only. */
  listAccounts: (): Promise<AccountRow[]> => rpc<AccountRow[]>('list_accounts'),

  /** The department catalogue, as something to choose from. */
  listDepartments: (): Promise<DepartmentRow[]> => rpc<DepartmentRow[]>('list_departments'),

  listSchedules: (): Promise<ScheduleRow[]> => rpc<ScheduleRow[]>('list_schedules'),

  listAlertRules: (): Promise<AlertRuleRow[]> => rpc<AlertRuleRow[]>('list_alert_rules'),

  /**
   * Creates or edits a schedule. The database refuses a second live schedule for
   * the same scope, and refuses to move an existing one to a different scope --
   * both with a sentence, rather than a constraint name.
   */
  saveSchedule: (draft: ScheduleDraft): Promise<SaveResult> =>
    rpc<SaveResult>('save_schedule', {
      p_scope: draft.scope,
      p_name: draft.name,
      p_entry_from: draft.entryFrom,
      p_entry_until: draft.entryUntil,
      p_entry_expected: draft.entryExpected,
      p_exit_expected: draft.exitExpected,
      p_days: draft.days,
      p_grace_minutes: draft.graceMinutes,
      p_break_max_minutes: draft.breakMaxMinutes,
      ...(draft.id === undefined ? {} : { p_id: draft.id }),
      ...(draft.departmentId === undefined ? {} : { p_department_id: draft.departmentId }),
      ...(draft.employeeId === undefined ? {} : { p_employee_id: draft.employeeId }),
    }),

  /** Deactivates a schedule. Nothing here deletes one: a workday points at it. */
  retireSchedule: (scheduleId: string, reason: string): Promise<unknown> =>
    rpc<unknown>('retire_schedule', { p_schedule_id: scheduleId, p_reason: reason }),

  /**
   * One alert rule, including the addresses the dispatcher sends to. A null
   * department is the rule for the whole company.
   */
  saveAlertRule: (rule: {
    readonly kind: AlertKind;
    readonly active: boolean;
    readonly thresholdMinutes: number;
    readonly recipients: string | null;
    readonly departmentId: string | null;
  }): Promise<SaveResult> =>
    rpc<SaveResult>('save_alert_rule', {
      p_kind: rule.kind,
      p_active: rule.active,
      p_threshold_minutes: rule.thresholdMinutes,
      p_recipients: rule.recipients,
      p_department_id: rule.departmentId,
    }),

  /** Changes what an account may see, with the reason on the record. */
  setAccountRole: (
    employeeId: string,
    role: AssignableRole,
    reason: string,
  ): Promise<unknown> =>
    rpc<unknown>('set_account_role', {
      p_employee_id: employeeId,
      p_role: role,
      p_reason: reason,
    }),

  /**
   * Enrolls somebody: an account in Auth, then the link and the role in the
   * database. The temporary password comes back once and is never readable
   * again.
   */
  createAccount: (employeeId: string, role: AssignableRole): Promise<ProvisionResult> =>
    invokeFunction<ProvisionResult>('admin-accounts', {
      action: 'create',
      employee_id: employeeId,
      role,
    }),

  /** A new temporary password for somebody who cannot get in. */
  resetPassword: (employeeId: string): Promise<ProvisionResult> =>
    invokeFunction<ProvisionResult>('admin-accounts', {
      action: 'reset_password',
      employee_id: employeeId,
    }),

  /** Takes access away. The auth account survives; the link and the role do not. */
  revokeAccount: (employeeId: string, reason: string): Promise<ProvisionResult> =>
    invokeFunction<ProvisionResult>('admin-accounts', {
      action: 'revoke',
      employee_id: employeeId,
      reason,
    }),

  /**
   * The person's own password, chosen by them. Not an administrative action and
   * not in the Edge Function: it changes the caller's own account, which Auth
   * already allows a signed-in session to do.
   *
   * Clearing `must_change_password` in the same call is what ends the state
   * where HR still knows how to sign in as them.
   */
  chooseOwnPassword: async (password: string): Promise<void> => {
    const { error } = await supabase.auth.updateUser({
      password,
      data: { must_change_password: false },
    });

    if (error !== null) {
      throw new RpcError(error.message);
    }
  },
} as const;
