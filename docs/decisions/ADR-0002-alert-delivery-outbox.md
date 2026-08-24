# ADR-0002 — Alerts are queued in an outbox, not sent from the database

- **Date:** 2026-08-24
- **Status:** Accepted
- **Scope:** `attendance.evaluate_alerts()`, `attendance.notification_outbox`,
  the dispatcher Edge Function

## Context

The alert evaluator runs inside Postgres on `pg_cron`, decided in
[ADR-0001](ADR-0001-all-in-supabase.md). The alerts it raises are useless if
nobody is told, so something has to send email.

`pg_net` is already installed — it was added with the Free plan maintenance
migration — so the shortest path exists and is tempting: have the evaluator
`POST` to the mail Edge Function, or to the provider, in the same statement that
raises the alert.

Three facts argue against it.

**A `pg_net` call is fire-and-forget.** It queues an HTTP request and returns
immediately; the response lands in `net._http_response`, which **pg_net purges
after six hours**. Six hours later there is no way to answer "was HR actually
told?" — and that is exactly the question somebody asks after an incident.

**An external call inside the evaluator's transaction couples attendance state
to a mail provider.** If the call is synchronous and the provider is slow, the
evaluator's transaction is held open behind it. If it fails, either the alert
rolls back with it — losing the record of something that genuinely happened —
or the failure is swallowed, which is the same as not knowing.

**Sending needs credentials and provider logic.** `public.config_correo` holds
SMTP and OAuth secrets, and composing a message means templates and encoding.
That is talking to the outside world, which rule 1 puts in an Edge Function and
keeps out of Postgres.

## Decision

The evaluator writes rows into `attendance.notification_outbox` and stops there.
Delivery is a separate dispatcher Edge Function that:

1. claims due work with `attendance.claim_notifications()`,
2. calls the mail provider,
3. reports the outcome with `attendance.complete_notification()`.

The database owns everything about *when* and *whether*: due time, attempt
count, exponential backoff capped at an hour, giving up after eight attempts,
and stamping `alerts.notified_at` only when a send actually succeeded. The
dispatcher owns only *how* to talk to the provider.

Enqueueing is idempotent through a unique `idempotency_key` derived from the
alert id, so the evaluator running every five minutes queues one message per
alert regardless of how many times it sees it.

## Rationale

**The record survives.** A queued notification is a row in a table that is
backed up, not an HTTP response that expires in six hours. `status`, `attempts`
and `last_error` answer the incident question directly.

**Failure is contained.** A provider that is down delays email. It does not roll
back a workday, lose an alert or block the next evaluation.

**Retry is written once, in the place that can be trusted.** Retry logic in the
Edge Function would run only while the function runs; in the table it survives
deploys, restarts and the Free plan's pauses.

## Accepted cost

**Delivery is at-least-once, not exactly-once.** A dispatcher that dies after
calling the provider but before reporting back leaves a row claimed; after
fifteen minutes another run reclaims it and may send a second copy of the same
email. The alternative — treating a claimed row as sent — loses notifications
silently. A duplicate email is visible and harmless; a missing one is neither.

**There is one more moving part.** A queue that nobody drains is a queue that
fills up, so the weekly check in [the runbook](../runbook.md) looks at rows
stuck in `sending` and rows that reached `failed`.

**Nothing is delivered until the dispatcher exists.** That is deliberate: the
cron job that evaluates is scheduled, the one that would call a missing Edge
Function is not.

## Consequences

- `attendance.notification_outbox` is granted to nobody: not even `SELECT` for
  `authenticated`. It holds recipient addresses, and the dispatcher reaches it
  with the service role over a direct connection, because `attendance` is not an
  exposed schema.
- Delivered notifications are pruned after 90 days. Failed ones are kept — they
  are evidence that somebody was not told. The alerts themselves are never
  pruned.
- The payload is denormalised at enqueue time, so a message composed in October
  still names the department the person was in when the alert was raised.
