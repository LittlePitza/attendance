import { NetworkUnavailableError, RpcError, isTransportFailure } from './errors';
import { supabase } from './supabase';
import type {
  AlertDecision,
  AlertDecisionResult,
  EmployeeDay,
  HeartbeatResult,
  MyDay,
  OfflinePunchEvent,
  OpenAlert,
  Profile,
  PunchDecision,
  PunchKind,
  PunchResult,
  ReviewResult,
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
} as const;
