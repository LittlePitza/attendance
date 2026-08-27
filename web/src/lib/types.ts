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

/**
 * Which of the two counters is running, if either.
 *
 * The database says so rather than the screen working it out from the state.
 * It is the same question as "does a break count as worked time", and that is
 * the state machine's to answer, not a component's.
 */
export type CountingKind = 'worked' | 'break';

/** What `public.my_day()` returns: the whole punch screen in one answer. */
export interface MyDay {
  readonly server_time: string;
  readonly employee_id: string;
  readonly date: string;
  readonly time_zone: string;
  readonly state: WorkdayState;
  readonly next_actions: readonly PunchKind[];
  /** As the engine accumulated them: they only move when a punch closes an interval. */
  readonly worked_seconds: number;
  readonly break_seconds: number;
  /**
   * The same totals with the stretch that is still running included, and the
   * instant it has been running from. The screen ticks forward from
   * `server_time` between refreshes; it never decides which counter is running.
   *
   * **Optional, and not because the contract is vague.** A deploy and a
   * migration are never atomic: between the bundle going live and the migration
   * being applied there is a window in which a browser running this code is
   * talking to a database whose `my_day()` predates these five fields. Typed as
   * present, that window renders `NaN` on the largest figure on the screen.
   * Typed as absent, `liveCounters` falls back to the settled counters above --
   * which is exactly the old behaviour, and a counter that does not move is a
   * far better thing to ship for ten minutes than a counter that says `NaN`.
   *
   * They are not optional in the database. Nothing here should treat the
   * fallback as a supported state to design against.
   */
  readonly counting?: CountingKind | null;
  readonly counting_since?: string | null;
  readonly worked_seconds_live?: number;
  readonly break_seconds_live?: number;
  /** Working seconds today's schedule asks for. Null on a day it does not cover. */
  readonly expected_seconds?: number | null;
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

/** What HR may record about a punch that arrived flagged. */
export const PUNCH_DECISIONS = ['approve_offline', 'reject_offline'] as const;
export type PunchDecision = (typeof PUNCH_DECISIONS)[number];

/** What HR may record an alert was worth. Never back to `open`. */
export const ALERT_DECISIONS = ['acknowledged', 'resolved', 'dismissed'] as const;
export type AlertDecision = (typeof ALERT_DECISIONS)[number];

/** The decision in force on a punch, or null while nobody has made one. */
export interface PunchVerdict {
  readonly kind: PunchDecision;
  readonly reason: string;
  readonly created_at: string;
}

/**
 * One punch as a reviewer sees it: not only when it landed, but the evidence of
 * how it got here. `occurred_at` is what the record says; `client_reported_at`,
 * `clock_skew_ms` and `sync_delay_seconds` are what the device claimed, and
 * `review_reason` is the engine's own words for why it was not trusted.
 *
 * There are no coordinates here and there is no room for them: `authenticated`
 * was never granted those columns.
 */
export interface ReviewPunch {
  readonly id: string;
  readonly kind: PunchKind;
  readonly occurred_at: string;
  readonly source: PunchSource;
  readonly client_reported_at: string | null;
  readonly clock_skew_ms: number | null;
  readonly sync_delay_seconds: number | null;
  readonly needs_review: boolean;
  readonly review_reason: string | null;
  readonly decision: PunchVerdict | null;
}

/** One employee's day, as `employee_day()` reports it to whoever may see it. */
export interface EmployeeDay {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly date: string;
  readonly time_zone: string;
  readonly workday_id: string | null;
  readonly state: WorkdayState;
  readonly opened_at: string | null;
  readonly closed_at: string | null;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly has_offline: boolean;
  readonly needs_review: boolean;
  readonly punches: readonly ReviewPunch[];
}

export interface ReviewResult {
  readonly adjustment_id: string;
  readonly punch_id: string;
  readonly decision: PunchDecision;
  readonly workday_needs_review: boolean;
}

export interface AlertDecisionResult {
  readonly alert_id: string;
  readonly state: AlertDecision;
  readonly kind: AlertKind;
}

/* ------------------------------------------------------- Administration ---
 * `list_accounts()`, `list_departments()`, `list_schedules()` and
 * `list_alert_rules()` are `returns table`, so each arrives as an array of
 * rows. The writers return a single jsonb object, like `punch()` does.
 *
 * These shapes are read only on the administration screen, which HR and admin
 * reach. Nothing here encodes who may see it: `list_accounts()` refuses anybody
 * else outright, and the three others answer through RLS.
 */

/** The roles an account can be given. `guest` is absent: it is the default, not a choice. */
export const ASSIGNABLE_ROLES = ['employee', 'manager', 'hr', 'admin'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * One person and the state of their access.
 *
 * `role` and `account_email` are null while `has_account` is false, which is the
 * ordinary state of somebody who has not been enrolled yet.
 * `must_change_password` stays true from the moment HR hands over a temporary
 * password until the person chooses their own -- so while it is true, HR still
 * knows how to sign in as them.
 */
export interface AccountRow {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly employee_email: string;
  readonly job_title: string | null;
  readonly department_id: string | null;
  readonly department: string | null;
  readonly has_account: boolean;
  readonly role: AssignableRole | null;
  readonly account_email: string | null;
  readonly last_sign_in_at: string | null;
  readonly must_change_password: boolean;
  readonly schedule_scope: ScheduleScope | null;
  readonly schedule_name: string | null;
}

export interface DepartmentRow {
  readonly id: string;
  readonly name: string;
  readonly time_zone: string;
  readonly active: boolean;
  readonly employee_count: number;
}

export const SCHEDULE_SCOPES = ['global', 'department', 'employee'] as const;
export type ScheduleScope = (typeof SCHEDULE_SCOPES)[number];

/** Times are `HH:MM`, the same shape `my_day()` sends. Days are ISO: 1 = Monday. */
export interface ScheduleRow {
  readonly id: string;
  readonly scope: ScheduleScope;
  readonly applies_to: string;
  readonly department_id: string | null;
  readonly employee_id: string | null;
  readonly name: string;
  readonly days: readonly number[];
  readonly entry_from: string;
  readonly entry_until: string;
  readonly entry_expected: string;
  readonly exit_expected: string;
  readonly grace_minutes: number;
  readonly break_max_minutes: number;
  readonly valid_from: string;
  readonly valid_until: string | null;
  readonly active: boolean;
}

/**
 * What `save_schedule()` is given. `id` present means edit, absent means create.
 *
 * The three optional fields spell out `| undefined` because `tsconfig` sets
 * `exactOptionalPropertyTypes`: a form that clears a department when the scope
 * changes assigns `undefined`, which without this is a different thing from
 * absent. Both mean "no department" here, and the API module drops either one
 * rather than sending a null the database would refuse.
 */
export interface ScheduleDraft {
  readonly id?: string | undefined;
  readonly scope: ScheduleScope;
  readonly departmentId?: string | undefined;
  readonly employeeId?: string | undefined;
  readonly name: string;
  readonly days: readonly number[];
  readonly entryFrom: string;
  readonly entryUntil: string;
  readonly entryExpected: string;
  readonly exitExpected: string;
  readonly graceMinutes: number;
  readonly breakMaxMinutes: number;
}

export interface AlertRuleRow {
  readonly id: string;
  readonly department_id: string | null;
  readonly department: string;
  readonly kind: AlertKind;
  readonly active: boolean;
  readonly threshold_minutes: number;
  readonly recipients: string | null;
  readonly updated_at: string;
}

export interface SaveResult {
  readonly created: boolean;
}

/**
 * What the provisioning function answers with.
 *
 * `temporary_password` is present on a creation and on a reset, and is the only
 * time it is ever readable: it is not stored anywhere the client can ask again.
 * `recorded` is false when the password was changed but the audit row could not
 * be written -- worth showing, and not a failed reset.
 */
export interface ProvisionResult {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly email?: string;
  readonly role?: AssignableRole;
  readonly temporary_password?: string;
  readonly recorded?: boolean;
  readonly locked_out?: boolean;
}

/* --------------------------------------------------------------- The roster ---
 * `list_employees()` answers who is on the payroll; `list_accounts()` answers
 * who can sign in. They are not two versions of one list: this one includes
 * somebody who has left, because their days are still in the record and the box
 * that shows them has to be reachable.
 */

/** The two states `empleados_estado_check` allows. There is no third, and no delete. */
export const EMPLOYEE_STATES = ['activo', 'baja'] as const;
export type EmployeeState = (typeof EMPLOYEE_STATES)[number];

export interface EmployeeRow {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly employee_email: string;
  readonly job_title: string | null;
  readonly department_id: string | null;
  readonly department: string | null;
  readonly state: EmployeeState;
  readonly has_account: boolean;
  readonly created_at: string;
}

/**
 * What `save_employee()` is given. `id` present means edit, absent means create.
 *
 * The optional fields spell out `| undefined` for the reason `ScheduleDraft`
 * does: `exactOptionalPropertyTypes` makes an assigned `undefined` a different
 * thing from an absent key, and a form that clears a department assigns one.
 *
 * There is no `state` here, and that is the point: moving somebody between
 * activo and baja takes a reason, so it belongs to `retireEmployee` and
 * `restoreEmployee` and not to a form field.
 */
export interface EmployeeDraft {
  readonly id?: string | undefined;
  readonly name: string;
  readonly email: string;
  readonly jobTitle?: string | undefined;
  readonly departmentId?: string | undefined;
}

export interface SavedEmployee {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly created: boolean;
}

/**
 * What retiring or restoring somebody answers with.
 *
 * `access_revoked` says their account was unlinked along with it; `open_alerts`
 * is what is left on Revisión for HR, because retiring somebody closes nothing.
 * `needs_account` comes back from a restore and is true whenever coming back
 * did not give them a way in -- which is always, on purpose.
 */
export interface EmployeeStateResult {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly state: EmployeeState;
  readonly access_revoked?: boolean;
  readonly open_alerts?: number;
  readonly needs_account?: boolean;
}

/**
 * What `reset_day()` answers with.
 *
 * `punches_voided` is how many stopped counting -- nothing was deleted -- and
 * `open_alerts` is the day's alerts, which a reset deliberately leaves alone.
 */
export interface ResetDayResult {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly workday_id: string;
  readonly date: string;
  readonly punches_voided: number;
  readonly state: WorkdayState;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly open_alerts: number;
}

/* --------------------------------------------------------- The access log ---
 * One row per stretch of the application being open on one device. The three
 * writers are `SECURITY DEFINER` and derive the account from the token, like
 * every other write in this system; `my_sessions()` is the reader.
 */

/**
 * How a session ended. `expired` is the sweeper's word and the client can never
 * send it: it means nobody heard from the device again, which a client
 * reporting in contradicts.
 */
export const SESSION_END_REASONS = ['sign_out', 'app_closed', 'expired'] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** What the client may claim. The database narrows anything else to `sign_out`. */
export type ClosableReason = Extract<SessionEndReason, 'sign_out' | 'app_closed'>;

/** What the device says about itself. Evidence, not proof -- so it is optional. */
export interface DeviceDescription {
  readonly deviceId: string;
  readonly platform: string | null;
  readonly timeZone: string | null;
  readonly locale: string | null;
  readonly appVersion: string | null;
}

export interface OpenSessionResult {
  readonly session_id: string;
  readonly started_at: string;
  /** True when this call rejoined a session rather than starting one. */
  readonly resumed: boolean;
  /** HR revoked this machine. The engine refuses its punches; the screen says so. */
  readonly device_revoked: boolean;
  readonly server_time: string;
}

export interface TouchSessionResult {
  /** False once the session was closed. The client opens a new one rather than reporting into it. */
  readonly active: boolean;
  readonly server_time: string;
}

export interface CloseSessionResult {
  readonly closed: boolean;
  readonly ended_at: string | null;
  readonly end_reason: SessionEndReason | null;
  readonly server_time: string;
}

/** One access, as `my_sessions()` reports it. `ip` is text: Postgres holds it as `inet`. */
export interface AppSession {
  readonly id: string;
  readonly device_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly end_reason: SessionEndReason | null;
  readonly last_seen_at: string;
  readonly active: boolean;
  readonly ip: string | null;
  readonly platform: string | null;
  readonly time_zone: string | null;
  readonly user_agent: string | null;
}

/* ------------------------------------------------------------ The summary ---
 * `my_summary()` decides every figure here. Hours against expected,
 * punctuality, the streak and the average entry are all judgements about
 * somebody's attendance, and this client makes none of them: it lays out what
 * it is handed, the way the board does.
 */

export interface SummaryDay {
  readonly date: string;
  /** False on a day the schedule does not cover -- a weekend, most of the time. */
  readonly scheduled: boolean;
  readonly state: WorkdayState;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly expected_seconds: number;
  readonly entry_expected: string | null;
  readonly opened_at: string | null;
  readonly closed_at: string | null;
  /** Some punch of that day arrived by sync, so the device was offline for part of it. */
  readonly has_offline: boolean;
  /** Carries a `late_entry` alert the evaluator raised and HR did not dismiss. */
  readonly late: boolean;
}

/**
 * One ISO week of the range, grouped by Postgres rather than by the browser.
 *
 * "Days worked this week" has a wrong answer available -- a week that starts on
 * Sunday, or one bounded by the reader's zone instead of the employee's -- so
 * `date_trunc('week', ...)` decides it where the zone is known. The first and
 * last week of a range are partial by construction.
 */
export interface SummaryWeek {
  readonly week_start: string;
  readonly days_scheduled: number;
  readonly days_worked: number;
  readonly days_complete: number;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly expected_seconds: number;
  readonly late_days: number;
}

/**
 * What `internal.attendance_summary()` answers, whichever wrapper asked it.
 *
 * `my_summary()` asks about the caller and `employee_summary()` asks about
 * somebody else; the figures are the same figures, decided once. The three
 * disconnection counts are counts of facts rather than judgements:
 * `no_connection_alerts` is what the evaluator raised and HR did not dismiss,
 * `offline_days` is days some punch arrived by sync, and `expired_sessions` is
 * sessions that stopped reporting and were closed by the sweeper.
 */
export interface AttendanceSummary {
  readonly server_time: string;
  readonly time_zone: string;
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly expected_seconds: number;
  readonly days_scheduled: number;
  readonly days_worked: number;
  readonly days_complete: number;
  readonly late_days: number;
  readonly on_time_days: number;
  readonly absent_days: number;
  /** Null until there is a day with an entry to work it out from. */
  readonly punctuality_pct: number | null;
  readonly average_entry: string | null;
  readonly streak_days: number;
  readonly offline_days: number;
  readonly no_connection_alerts: number;
  readonly expired_sessions: number;
  readonly weeks: readonly SummaryWeek[];
  readonly series: readonly SummaryDay[];
}

export type MySummary = AttendanceSummary;

/** The same answer about somebody else. Includes people on baja: their days are still in the record. */
export interface EmployeeSummary extends AttendanceSummary {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly employee_state: EmployeeState;
}

/* ------------------------------------------------------------- The report ---
 * `attendance_report()` decides every figure here, including the one judgement
 * in the whole feature: whether somebody met the period. This client renders
 * the verdict and never reaches it -- the rule lives in the function, written
 * down, so there is one answer to "cumplió" rather than one per screen.
 */

export const REPORT_SCOPES = ['day', 'week', 'month'] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

/**
 * The verdict on one person's period.
 *
 * `pending` is not a variant of `met`. A period whose scheduled days are all
 * still to come has produced no evidence either way, and reporting it as met
 * would quietly certify a week nobody has worked yet.
 */
export const COMPLIANCE_VERDICTS = [
  'met',
  'partial',
  'missed',
  'pending',
  'not_scheduled',
] as const;
export type ComplianceVerdict = (typeof COMPLIANCE_VERDICTS)[number];

/**
 * Why a period was not met, as a code and a count.
 *
 * Codes rather than sentences, so the wording stays in the screen and anything
 * else reading the report does not have to parse Spanish to learn why. Only the
 * reasons that actually happened are present -- a zero here would read as a
 * reason.
 */
export interface ComplianceReason {
  readonly code: 'absent' | 'late' | 'incomplete' | 'tampered';
  readonly count: number;
}

/** One person's period. Alert counts arrive keyed by kind, dismissed ones excluded. */
export interface ReportPerson {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly department: string | null;
  readonly employee_state: EmployeeState;
  readonly days_scheduled: number;
  /** The scheduled days already past. What the period is actually judged on. */
  readonly days_scheduled_past: number;
  /** Days with an entry. Nobody punches from the office, so this is the Home Office count. */
  readonly days_worked: number;
  readonly days_complete: number;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly expected_seconds: number;
  /** What the elapsed part of the period asked for. The deficit is measured against this. */
  readonly expected_seconds_elapsed: number;
  readonly deficit_seconds: number;
  readonly late_days: number;
  /** Scheduled past days with no entry. Without a leave table, holiday looks identical. */
  readonly absent_days: number;
  readonly incomplete_days: number;
  readonly offline_days: number;
  readonly punctuality_pct: number | null;
  readonly average_entry: string | null;
  readonly alerts_total: number;
  readonly alerts: Readonly<Partial<Record<AlertKind, number>>>;
  readonly compliance: ComplianceVerdict;
  readonly reasons: readonly ComplianceReason[];
}

export interface ReportAlertKind {
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  /** Not dismissed. The number that counts. */
  readonly total: number;
  readonly dismissed: number;
  readonly open: number;
  readonly people: number;
}

export interface ReportTotals {
  /** People with an account. The roster is larger; most of it does not punch. */
  readonly people: number;
  readonly people_home_office: number;
  readonly people_met: number;
  readonly people_partial: number;
  readonly people_missed: number;
  readonly people_pending: number;
  readonly people_not_scheduled: number;
  readonly days_scheduled: number;
  readonly days_scheduled_past: number;
  readonly days_worked: number;
  readonly days_complete: number;
  readonly worked_seconds: number;
  readonly break_seconds: number;
  readonly expected_seconds: number;
  readonly expected_seconds_elapsed: number;
  readonly late_days: number;
  readonly absent_days: number;
  readonly incomplete_days: number;
  readonly offline_days: number;
  readonly alerts_total: number;
  readonly punctuality_pct: number | null;
}

/** One person on a standout list, with whatever figure put them there. */
export interface ReportStandout {
  readonly employee_id: string;
  readonly employee_name: string;
  readonly value: number;
}

export interface ReportStandouts {
  readonly punctual: readonly ReportStandout[];
  readonly most_late: readonly ReportStandout[];
  readonly most_absent: readonly ReportStandout[];
  readonly most_hours: readonly ReportStandout[];
}

export interface AttendanceReport {
  readonly server_time: string;
  readonly time_zone: string;
  readonly scope: ReportScope;
  readonly anchor: string;
  readonly from: string;
  readonly to: string;
  readonly days: number;
  /** The period has finished. A week still running is not a week anybody failed. */
  readonly closed: boolean;
  readonly totals: ReportTotals;
  readonly alerts_by_kind: readonly ReportAlertKind[];
  readonly people: readonly ReportPerson[];
  readonly standouts: ReportStandouts;
}
