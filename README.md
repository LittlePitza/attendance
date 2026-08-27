# Home Office Time Clock

Attendance tracking for remote staff. Employees clock in,
start and end breaks, and clock out from home; **the official timestamp comes
from the server, not from their computer**; HR sees who is working in real time
and gets alerts when someone misses their window.

The record has to hold up: if a payroll dispute comes up tomorrow, the log must
stand on its own.

| | |
|---|---|
| **Status** | Backend SQL implemented · Employee PWA and HR board built · Alert dispatcher built |
| **Migrations** | 13 applied · none pending |
| **Database** | Supabase `pimsa_ti` (`cyjpucvvekzfpvvonuld`), Postgres 17, us-east-1 |
| **Plan** | Free — see [docs/free-plan.md](docs/free-plan.md) |
| **People** | 31 employees · 15 departments |
| **Time zone** | `America/Mexico_City` |

---

## Read this first

**This database is not empty.** It is shared with the IT help desk, which is in
production: 45 tickets, an inventory of 18 machines, equipment handover forms,
purchasing and petty cash. That system is
[`ti-hub`](https://github.com/LittlePitza/ti-hub), it lives in a separate
repository, and it deploys to Vercel.

The practical consequence: **any change to the `public` schema can break a
production system that is not in this repository.** That is why the help desk
tables keep their Spanish names and are left alone.

---

## How it is built

Three layers with a boundary that is never crossed:

| Layer | Responsibility | Rule |
|---|---|---|
| **Postgres** | Business rules, timestamping, invariants | The only one that decides |
| **Edge Functions** (Deno) | Talk to the outside world: email, user provisioning, exports | **Never** holds business rules |
| **PWA** (React) | Interface | No logic: calls functions and renders data |

There is no application server. The PWA is static files, served from Vercel in
the same account that already hosts `ti-hub` — Vercel runs no code for this
project, so there is nowhere on that side for a rule to be written by accident.
See [ADR-0003](docs/decisions/ADR-0003-serve-the-pwa-from-vercel.md).

A Python engine was ruled out because Supabase
Edge Functions only run TypeScript on Deno — and the result came out stronger,
not weaker: a rule written in a `SECURITY DEFINER` function cannot be bypassed
with a valid token or by hitting the REST API directly, because **the client
has no write privilege on any table**.

### The five rules that hold everything up

1. **The server sets the time.** `occurred_at := now()`. Whatever the client
   sends is stored separately, in `client_reported_at`, for auditing only.
2. **The client does not write tables.** `authenticated` gets `SELECT` filtered
   by RLS and **zero** `INSERT`/`UPDATE`/`DELETE`. Functions are the only way in.
3. **`employee_id` comes from the token**, never from a parameter. Nobody can
   punch on someone else's behalf.
4. **Punches are append-only**, enforced by a trigger and not just by
   privileges — the service role has those anyway. Corrections are new rows in
   `adjustments`, with a mandatory reason.
5. **Coordinates are not readable.** They are not revoked; they are never
   granted in the first place.

### Offline punching

This is the awkward case, and it was solved without pretending it does not
exist. The PWA queues punches in IndexedDB and, on reconnect, sends the batch to
`sync_punches()`, which:

- **sorts it chronologically** before processing, not by arrival order;
- processes **each event in its own subtransaction**, so one invalid event does
  not take down the batch;
- stores the client's time **labelled as such** (`source = 'offline'`), with the
  real clock skew and sync delay.

If the clock is off by more than 2 minutes, or the punch arrives more than 12
hours late, it lands with `needs_review = true` and shows up flagged for HR to
approve. **An offline punch is the employee's word**: the system accepts it,
labels it, and puts it in plain sight. Hiding that would make the whole record
worthless.

---

## Data model

### Schema `attendance` — the time clock

| Table | What it holds |
|---|---|
| `schedules` | Schedule windows. Precedence: employee > department > global |
| `workdays` | One row per person per day. The state the dashboard reads |
| `punches` | The punches. **Append-only** |
| `adjustments` | HR corrections, with a mandatory reason |
| `alerts` | Alerts for HR. Unique `(employee, date, kind)` makes them idempotent |
| `alert_rules` | Which alerts are active and at what threshold, per department |
| `devices` | Devices each person punches from. Revocable |
| `consents` | Privacy notice consent, per person and version |
| `audit_events` | Audit log: every administrative action, including each lookup of coordinates |
| `notification_outbox` | Queued alert notifications. Sending happens outside the transaction, and is retried |

### Schema `internal` — identity and triggers

Not exposed through the API, and **must not be added to "Exposed schemas"**.
Holds `caller_role()`, `caller_employee_id()`, `caller_department_id()`,
`can_view_employee()`, `record_punch()`, `resolve_schedule()` and the triggers.

### Schema `public` — shared ground

The 19 help desk tables (Spanish, untouchable) plus:

- `departments` — normalized catalog
- `user_roles` — role per **account**, not per person
- `empleados` — pre-existing; this project added `department_id` and
  `auth_user_id` to it

### The state machine

```
not_started ──clock_in──▶ working ◀──break_end── on_break
                          │    │                     ▲
                          │    └────break_start──────┘
                          │
                          └──clock_out──▶ finished
```

`clock_out` from `on_break` closes the break: forgetting to end a break is a
common slip, and rejecting it would only leave the workday hanging. Everything
else out of order is rejected with a message meant to be read on screen.

---

## The API

The client does not write tables; it calls functions.

| Function | Who | What it does |
|---|---|---|
| `my_profile()` | authenticated | Their role and employee record. The only identity RPC published |
| `server_time()` | authenticated | Official time, so the client can compute its clock skew |
| `punch(...)` | authenticated | Records a punch with the server's time |
| `sync_punches(jsonb)` | authenticated | Offline ingestion in chronological order |
| `heartbeat()` | authenticated | Liveness signal every 5 min while a workday is open |
| `my_day()` | authenticated | The punch screen in one call: state, legal next actions, counters, schedule, punches |
| `my_history(from, to)` | authenticated | The caller's own workdays, at most 92 days |
| `team_day(date)` | authenticated | Every employee the caller may see, with their state that day |
| `open_alerts(since, limit)` | authenticated | Open alerts within the caller's scope |
| `employee_day(employee, date)` | authenticated | One person's punches and the decision recorded against each |
| `employee_summary(employee, days)` | authenticated | The same figures `my_summary()` gives, about somebody else |
| `list_employees()` | hr, admin | The whole roster, people on baja included |
| `review_punch(punch, decision, reason)` | hr, admin | Records what HR decided about a punch that arrived flagged |
| `decide_alert(alert, state, note)` | hr, admin | Records what HR decided an alert was worth |
| `reset_day(employee, reason, date)` | hr, admin | Voids a day's punches and rebuilds its counters. Deletes nothing |
| `save_employee(...)` | hr, admin | Adds or edits somebody in the shared roster |
| `retire_employee(employee, reason)` | hr, admin | Baja, and their access with it. Never a `DELETE` |
| `restore_employee(employee, reason)` | hr, admin | Back to activo. Not back to having an account |

The table is the core the client is written against, not the whole surface: the
session writers, the summaries and the rest of the administration API are named
in `security_invariants_test.sql`, which is where the rule below is enforced.

**Writes elevate; reads do not.** `punch`, `sync_punches`, `heartbeat`,
`review_punch`, `decide_alert`, `reset_day` and the roster writers are
`SECURITY DEFINER`, because they are the only write path and have to hold
privileges the caller does not. Everything else
is `SECURITY INVOKER`, and that is deliberate: `internal.can_view_employee()`
already decides who sees whom, and the column grants already withhold
coordinates. A read function that elevated would have to reimplement both and
could get either wrong. As it stands, a bug in a read function is a bug in what
is displayed — it cannot become a leak. `security_invariants_test.sql` asserts
the mode of all thirty-four published functions, not only the ones named above,
so the rule is enforced rather than remembered. `list_accounts()` is the single
exception and says why in its own migration: the answer lives in `auth.users`
and `public.user_roles`, which no ordinary caller can reach.

Every writer HR calls takes a mandatory reason of at least ten characters and
lands a row in `attendance.audit_events`. None of them ever edits a punch:
`attendance.punches` is append-only, so approving one writes a decision beside
it rather than changing how it arrived — and so does discarding one.
`reset_day()` is the strongest case: it takes a whole day out of the counters
and every punch of it is still there afterwards, each with the hour it stopped
counting and the reason recorded next to it.

### Roles

In `public.user_roles`, one per **account** — not per person, because there is
an administrator account that is not an employee.

| Role | Scope |
|---|---|
| `employee` | Only their own records |
| `manager` | Their department |
| `hr` | Everyone, plus adjustments and alerts |
| `admin` | Everything, plus configuration |
| `guest` | Default when no role is assigned: **no access** |

A single function, `internal.can_view_employee()`, decides who can see whose
data. It lives in one place on purpose: when the rule was duplicated across
several policies, they could drift apart without anyone noticing.

---

## Repository layout

```
attendance/
├── README.md                    this file
├── CONTRIBUTING.md              working guide: rules, conventions, workflow
├── SECURITY.md                  what counts as a vulnerability, how to report
├── LICENSE                      proprietary; internal use only
├── package.json                 the pinned CLI and the db:* commands
├── .env.example                 variables; secrets do NOT go here
│
├── docs/
│   ├── local-development.md     isolated database workflow and safety guarantees
│   ├── free-plan.md             Free plan quotas and how they are compensated
│   ├── runbook.md               operations, incidents, first-time setup
│   ├── original-plan.md         the initial architecture plan (Spanish, historical)
│   └── decisions/               ADRs
│
├── scripts/
│   └── local-supabase.mjs       the guarded workflow: one action, no remote path
│
├── tests/
│   └── local-supabase.test.mjs  proves that workflow cannot reach production
│
├── web/                         the PWA: React, TypeScript, Vite
│   ├── src/lib/                 the database contract, offline queue, sync
│   ├── src/features/punch/      the employee's own day
│   ├── src/features/hr/         the team board managers and HR read
│   ├── vite.config.ts           build, service worker and installable manifest
│   └── vercel.json              static hosting: cache headers and the CSP
│
├── supabase/
│   ├── config.toml              local CLI configuration
│   ├── functions/
│   │   ├── alerts-notify/       drains the notification outbox over Graph
│   │   └── _shared/             the SQL contract, message, recipients, mail
│   ├── migrations/              13 migrations, all applied
│   └── tests/
│       ├── sql/                 punch engine, alerts, read API, security
│       └── fixtures/            synthetic baseline and seed; never real data
│
└── .github/
    ├── workflows/
    │   ├── backup.yml           daily encrypted backup
    │   ├── keepalive.yml        prevents pausing for inactivity
    │   └── ci.yml               database, PWA and Edge Function verification
    ├── dependabot.yml           keeps the pinned actions current
    └── PULL_REQUEST_TEMPLATE.md blast radius + migration checklist
```

Everything the architecture calls for now exists in the repository, and the
whole migration history is applied to the shared project. What is missing is
still not code: no employee has an account yet, so nothing can sign in and the
evaluator has nobody to evaluate, and nothing schedules the dispatcher. See
**Status and what is next**.

---

## Language

**Code, structure and documentation in English. User-facing text in Spanish.**

- Schemas, tables, columns, functions, indexes, policies, filenames: English.
- Enum-style values (`'clock_in'`, `'working'`, `'hr'`): English.
- Documentation in `docs/` and this README: English.
- **Error messages the employee sees: Spanish.** They are read by people who do
  not speak English, so `punch()` raises `'Ya registraste tu entrada hoy'`, not
  an English string.

Two deliberate exceptions:

- The 19 help desk tables keep their Spanish names because `ti-hub` depends on
  them. That is why the model is mixed on purpose —
  `attendance.punches.employee_id` points at `public.empleados.id`. It is not
  sloppiness, it is the boundary with what was already there.
- SQL comments inside `supabase/migrations/` are still in Spanish, left over
  from an earlier decision. See *Known debt* below.

---

## Getting started

Requirements: Node 24, npm, git and Docker Desktop with a running Linux-container
daemon. Docker is mandatory for database verification because development never
falls back to the shared remote project.

```bash
git clone <repo> && cd attendance
npm ci
npm test
npm run db:verify
npm run db:stop
```

`db:verify` assembles `.local/supabase`, starts an isolated Postgres container,
replays the immutable migration history over a synthetic shared-schema baseline,
loads synthetic seed data, and runs the eight SQL suites. It does
not accept a database URL or a project ref. See
[docs/local-development.md](docs/local-development.md) for the complete workflow.

The production-only setup still missing before rollout is tracked in
[docs/runbook.md](docs/runbook.md). Those operations are deliberately separate
from development and require explicit target verification and authorization.

### Commands

```bash
# Fast safety and orchestration tests; does not start a database
npm test

# Build the generated local workspace without starting Docker
npm run db:prepare

# Rebuild the disposable database and run every SQL verification
npm run db:verify

# Stop the local stack when finished
npm run db:stop
```

No routine development command deploys migrations, links a Supabase project or
reads `SUPABASE_DB_URL`. Remote deployment is an explicit production change
procedure, never a pull-request or local-test step.

---

## Free plan

Decision made: **this project stays on Supabase's Free plan.** Full detail is in
[docs/free-plan.md](docs/free-plan.md); the essentials:

**Volume quotas are not the problem.** The database uses 14 MB of 500. With 31
people punching four times a day, no limit on size, egress, invocations or
Realtime comes close.

**The two real problems cannot be solved by using less:**

| Problem | Compensation |
|---|---|
| No backups at all, automatic or downloadable | `backup.yml`: daily **encrypted** dump as an artifact |
| Paused after 7 days of low activity | `keepalive.yml`: one query per day |

**And what grows without a ceiling is already pruned**, because at 500 MB
"we'll see" is not a strategy: `cron.job_run_details` at 7 days, `audit_events`
at 24 months, coordinates at 90 days. **`punches`, `workdays` and `adjustments`
are never pruned** — they are the labor record.

**What has no substitute:** leaked-password blocking (HaveIBeenPwned) is Pro
only. It is compensated with a 12-character minimum, closed signup and MFA for
HR — but it is not equivalent, and that is worth knowing.

---

## Verification

The engine suite (`supabase/tests/sql/punch_engine_test.sql`) defines the checks
that actually matter:

- The official time is the server's, even when the client sends a date in 2001.
- An `UPDATE` or `DELETE` on a punch fails, even from the service role.
- Replaying the same idempotency key neither duplicates nor errors.
- An offline batch sent in reverse order is accepted in full — only possible if
  it reorders — and the malformed event is rejected on its own.
- A clock running 10 minutes fast lands flagged for review, not silently.
- Without recorded consent, coordinates are discarded.
- Employee, manager, HR, admin and a role-less account each see exactly what
  they should.

The alert suite (`supabase/tests/sql/alert_engine_test.sql`) pins the evaluator
against a chosen instant, because "was this person late" is a question about a
moment and cannot be tested against whatever time the suite happens to run:

- Each of the seven kinds fires on the day it describes, with the minutes it
  claims — late by 15, overdue by 90, 75 minutes of break against 60.
- A break inside the threshold, a day with no schedule and a disabled rule all
  stay silent.
- Running the evaluator again — which production does every five minutes —
  raises nothing new and queues no second notification.
- An alert HR has already acknowledged is never reopened.
- A department threshold overrides the global one.
- Someone with no account raises nothing: they cannot punch, so they cannot be
  late. The same fixture with an account raises the alert, so the silence means
  something.

Run them only through `npm run db:verify` against the disposable local database.
The final `ROLLBACK` is defense in depth, not permission to test a live system.
Verification is complete only when the generated database applies every
migration and all eight SQL suites pass from a clean reset.

Five of the eight switch role: the read, review, administration, sessions and
workforce suites. The other three run as `postgres`, which owns the tables and
so bypasses RLS — a policy that filtered nothing would pass every check made
that way, which is why anything about who may do what is checked as the client.
Each of the five does `set role authenticated`, sets the token claims, and calls
the function under test. The read-API suite calls:

- An employee sees themselves and nobody else; a manager sees their department
  and not the one next to it; HR sees everyone. Each scope is checked against a
  case that must come back **empty**, because a scope that returns everything
  looks identical to a working one until you ask it for something it should
  refuse.
- `select geo_lat` is refused, an `INSERT` into `attendance.punches` is refused,
  and an `UPDATE` of the caller's own workday is refused.
- Every state of the workday is walked, and at each one all four punch kinds are
  attempted against the live engine. What it accepts has to be exactly what
  `my_day()` offered — so the buttons the client draws cannot drift from the
  rules that judge them.

### Not verified yet

**The end-to-end `curl` test is still missing.** The suite above proves the
policies hold against the `authenticated` role inside the database; it does not
prove that PostgREST, the publishable key and a real session compose the same
way. With a genuine employee token: attempt a direct `INSERT` into
`attendance.punches` over the REST API, and call `punch()` with a forged
timestamp. Both must fail. Until that runs, the boundary is verified one layer
short of where the client actually stands.

---

## Status and what is next

| | |
|---|---|
| ✅ | Department catalog, roles, link to `auth` |
| ✅ | RLS hardening of the help desk tables |
| ✅ | `attendance` schema, RLS and privileges |
| ✅ | Punch engine: state machine, idempotency, append-only, offline |
| ✅ | Free plan maintenance and backups |
| ✅ | Account provisioning: create, reset, revoke, with the reason on the record |
| ✅ | Alert evaluator, thresholds per department, notification outbox |
| ✅ | Dispatcher Edge Function: drains the outbox over `config_correo` |
| ✅ | Read API: the contract the PWA is written against |
| ✅ | PWA: login, punch screen, offline queue, service worker |
| ✅ | HR board: live team status, open alerts, filters |
| ✅ | Review: decide a flagged punch or an alert, with the reason on the record |
| ✅ | Administration: accounts, schedules and alert rules |
| ✅ | Roster: add, edit and retire people; the box behind each name; reset a day |
| ⬜ | Pilot: the PWA deployed, installed on a machine and starting at sign-in |

### Known debt

- **There is no leave or absence table.** The evaluator has no way to know that
  somebody is on holiday, so they collect a `missing_entry` every day until HR
  dismisses it. Closing the gap is one extra condition inside
  `evaluate_alerts()`, not a second evaluator — but until then the alert list
  has predictable noise in it, and that is worth knowing before HR sees it.
- **`anon` still holds write privileges on 21 `public` tables.** INSERT,
  UPDATE, DELETE and TRUNCATE, `empleados` among them. Nothing exploits it
  today because no RLS policy grants the anonymous role anything — but RLS is
  the only thing stopping it, and `TRUNCATE` does not go through RLS at all.
  Revoking them is its own migration with its own blast radius over `ti-hub`.
- **Nothing schedules the dispatcher yet.** `alerts-notify` exists and drains
  the outbox when it is called, but no cron job calls it. Scheduling it means
  storing the function URL and a key for `pg_net` to use, which is a decision
  about where a credential lives -- so it is its own change, made deliberately,
  not a line appended to this one.
- **No rule names its recipients yet.** The seven global rows exist -- the alert
  evaluation migration seeds them -- but `recipients` is null on every one, so
  each alert falls back to the dispatcher's `ALERTS_DEFAULT_RECIPIENTS` setting,
  and with that unset the dispatcher refuses to guess and records the failure.
  The durable fix is now one field on **Configuración → Alertas**; the screen
  warns on any active rule that names nobody.
- **Two applied migrations still describe the old fallback.** The `COMMENT ON`
  for `alert_rules.recipients` says a null uses the defaults in
  `config_correo`, which was written before anyone checked that the only list
  there belongs to the help desk. The dispatcher deliberately does not borrow
  it. Correcting the comment means a migration that touches the stored string,
  so it waits for the next change in that area rather than a drive-by edit.
- **SQL comments in the first 11 migrations are still in Spanish.** They date from an
  earlier language decision. Converting them is mechanical but also means
  updating the `COMMENT ON` strings already stored in the database, so it should
  be one deliberate pass rather than a drive-by edit.
- **`docs/original-plan.md` is kept in Spanish on purpose.** It is the original
  planning document, superseded by this README — it still describes the old
  Spanish schema names. It is preserved as a historical record, not as current
  guidance.
- **Spanish aliases inside 20 production policies.** They read as
  `(SELECT internal.caller_role() AS rol_actual)`: Postgres froze the output
  alias when the policy was created. The call resolves correctly and behavior is
  identical. Clean it up next time those policies need touching, not before.
- **`config_correo` stores secrets in plain text** (`smtp_pass`,
  `azure_client_secret`, `oauth_refresh_token`). With RLS only `admin` reads
  them, but they travel in every backup. Move to Vault.
- **`empleados.departamento` (text) is obsolete.** It exists only so `ti-hub`
  keeps working; a trigger keeps it in sync with `department_id`. It goes away
  when that code migrates.
- **8 of 31 employees have no department.** The global schedule covers them —
  that is exactly why it exists.
