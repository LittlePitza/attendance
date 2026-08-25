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
