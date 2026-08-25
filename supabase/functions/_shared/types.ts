/**
 * The dispatcher's copy of a contract that is defined in SQL.
 *
 * Every shape here mirrors `attendance.notification_outbox` and the payload
 * `attendance.evaluate_alerts()` writes into it. When the evaluator changes,
 * this file changes with it -- there is no code generation in between, on
 * purpose: the contract is small, and a generated file would hide the moment it
 * moved.
 *
 * Nothing here decides anything. Due time, attempt count, backoff and giving up
 * are the database's, and this function never forms an opinion about them.
 */

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

export type AlertSeverity = 'low' | 'medium' | 'high';

/**
 * Denormalised at enqueue time, which is what lets a message composed in
 * October still name the department the person was in when it was raised.
 */
export interface NotificationPayload {
  readonly alert_id: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly alert_date: string;
  readonly employee_id: string;
  readonly employee_name: string;
  readonly department: string | null;
  readonly time_zone: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/** One row as `attendance.claim_notifications()` returns it, already claimed. */
export interface ClaimedNotification {
  readonly id: string;
  readonly alert_id: string;
  readonly channel: string;
  readonly recipients: string | null;
  readonly payload: NotificationPayload;
  readonly attempts: number;
}

/**
 * The mail account, as the help desk already configures it in
 * `public.config_correo`. This system does not own it and must not write to it:
 * one mail configuration, one place to change it.
 */
export interface MailConfig {
  readonly method: string;
  readonly sender: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}
