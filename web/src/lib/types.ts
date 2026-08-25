/**
 * The client's copy of a contract that is defined in SQL.
 *
 * Every shape here mirrors what a function in `public` returns. When one of
 * those functions changes, this file changes with it -- there is no code
 * generation in between, on purpose: the contract is small, and a generated
 * file would hide the moment it moved.
 *
 * Nothing in this file encodes a rule. `next_actions` in particular is a value
 * the database sends, not something derived here: the state machine lives in
 * `internal.record_punch()` and the client only renders what it is told.
 */

export const PUNCH_KINDS = ['clock_in', 'break_start', 'break_end', 'clock_out'] as const;
export type PunchKind = (typeof PUNCH_KINDS)[number];

export const WORKDAY_STATES = ['not_started', 'working', 'on_break', 'finished'] as const;
export type WorkdayState = (typeof WORKDAY_STATES)[number];

export type PunchSource = 'online' | 'offline';

/** Times are `HH:MM` in the employee's own zone, already formatted by Postgres. */
export interface DaySchedule {
  readonly name: string;
  readonly entry_from: string;
  readonly entry_until: string;
  readonly entry_expected: string;
  readonly exit_expected: string;
  readonly grace_minutes: number;
  readonly break_max_minutes: number;
}

export interface DayPunch {
  readonly id: string;
  readonly kind: PunchKind;
  readonly occurred_at: string;
  readonly source: PunchSource;
  readonly needs_review: boolean;
  readonly review_reason: string | null;
}

/** What `public.my_day()` returns: the whole punch screen in one answer. */
export interface MyDay {
  readonly server_time: string;
  readonly employee_id: string;
  readonly date: string;
  readonly time_zone: string;
  readonly state: WorkdayState;
  readonly next_actions: readonly PunchKind[];
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly opened_at: string | null;
  readonly closed_at: string | null;
  readonly last_heartbeat: string | null;
  readonly has_offline: boolean;
  readonly needs_review: boolean;
  readonly schedule: DaySchedule | null;
  readonly punches: readonly DayPunch[];
}

export interface ServerTime {
  readonly utc: string;
  readonly epoch_ms: number;
}

/**
 * A repeated punch answers with `repeated: true` and the original outcome, so
 * the fields describing a fresh write are optional here rather than assumed.
 */
export interface PunchResult {
  readonly repeated: boolean;
  readonly punch_id: string;
  readonly workday_id: string;
  readonly state: WorkdayState;
  readonly occurred_at: string;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly source?: PunchSource;
  readonly needs_review?: boolean;
  readonly review_reason?: string | null;
  readonly geo_saved?: boolean;
}

export interface HeartbeatResult {
  readonly recorded: boolean;
  readonly state: WorkdayState;
  readonly workday_id: string | null;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly server: string;
}

/**
 * One punch that happened while the device was offline, waiting to be sent.
 * The idempotency key is generated when it is queued, never when it is sent:
 * that is what makes a retry converge on one punch instead of several.
 */
export interface OfflinePunchEvent {
  readonly idempotency_key: string;
  readonly kind: PunchKind;
  readonly occurred_at: string;
  readonly client_reported_at: string;
  readonly clock_skew_ms: number;
  readonly device_id: string;
}

export interface SyncEventOutcome {
  readonly idempotency_key: string;
  readonly accepted: boolean;
  readonly result?: PunchResult;
  readonly error?: string;
  readonly code?: string;
}

export interface SyncResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly events: readonly SyncEventOutcome[];
}

/* ------------------------------------------------------------------ HR ---
 * `my_profile()`, `team_day()` and `open_alerts()` are `returns table`, so
 * PostgREST answers each of them with an array of rows -- unlike `my_day()`,
 * which returns a single jsonb object. The API module is where that difference
 * is absorbed, so nothing above it has to remember which is which.
 */

export const CALLER_ROLES = ['employee', 'manager', 'hr', 'admin', 'guest'] as const;
export type CallerRole = (typeof CALLER_ROLES)[number];

/**
 * `employee_id` is null for an account that is not a person: there is an
 * administrator that never punches. Anything that offers the punch screen has
 * to check it rather than assume every session belongs to an employee.
 */
export interface Profile {
  readonly role: CallerRole;
  readonly employee_id: string | null;
  readonly name: string | null;
  readonly department_id: string | null;
  readonly department: string | null;
}

export const ALERT_KINDS = [
  'late_entry',
  'missing_entry',
  'break_exceeded',
  'missing_exit',
  'no_connection',
  'review_offline',
  'clock_tampered',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ['high', 'medium', 'low'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** One employee's day, as `team_day()` reports it. Times are `HH:MM:SS`. */
export interface TeamMember {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly department: string | null;
  readonly work_date: string;
  readonly state: WorkdayState;
  readonly opened_at: string | null;
  readonly closed_at: string | null;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly last_heartbeat: string | null;
  readonly has_offline: boolean;
  readonly needs_review: boolean;
  readonly entry_expected: string | null;
  readonly exit_expected: string | null;
}

export interface OpenAlert {
  readonly id: string;
  readonly employee_id: string;
  readonly employee_name: string;
  readonly alert_date: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly state: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly notified_at: string | null;
}
