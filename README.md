# Home Office Time Clock

Attendance tracking for remote staff. Employees clock in,
start and end breaks, and clock out from home; **the official timestamp comes
from the server, not from their computer**; HR sees who is working in real time
and gets alerts when someone misses their window.

The record has to hold up: if a payroll dispute comes up tomorrow, the log must
stand on its own.

| | |
|---|---|
| **Status** | Backend SQL implemented · Local safety harness added · Client not started |
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

There is no application server. A Python engine was ruled out because Supabase
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
├── .env.example                 variables; secrets do NOT go here
│
├── docs/
│   ├── local-development.md      isolated database workflow and safety guarantees
│   ├── free-plan.md             Free plan quotas and how they are compensated
│   ├── runbook.md               operations, incidents, first-time setup
│   ├── original-plan.md         the initial architecture plan (Spanish, historical)
│   └── decisions/               ADRs
│
├── supabase/
│   ├── config.toml              CLI configuration
│   ├── migrations/              11 migrations, all applied
│   └── tests/sql/               engine verification (23 checks)
│
└── .github/
    ├── workflows/
    │   ├── backup.yml           daily encrypted backup
    │   ├── keepalive.yml        prevents pausing for inactivity
    │   └── ci.yml               tests + security invariants
    ├── dependabot.yml           keeps the pinned actions current
    └── PULL_REQUEST_TEMPLATE.md blast radius + migration checklist
```

Still to be created, when the time comes: `web/` (the PWA) and
`supabase/functions/` (the Edge Functions). There are no empty folders waiting
for them because git does not track empty directories — they would vanish on
clone.

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
loads synthetic seed data, and runs the engine and security SQL suites. It does
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

Run it only through `npm run db:verify` against the disposable local database.
The final `ROLLBACK` is defense in depth, not permission to test a live system.
Verification is complete only when the generated database applies every
migration and both SQL suites pass from a clean reset.

### Not verified yet

The tests simulate the token inside the database. **The end-to-end `curl` test
is still missing**: with a real employee session and the publishable key,
attempt a direct `INSERT` into `attendance.punches` through the REST API, and
call `punch()` with a forged timestamp. Both must fail. Until that is done,
rule 2 is verified by construction but not by experiment.

---

## Status and what is next

| | |
|---|---|
| ✅ | Department catalog, roles, link to `auth` |
| ✅ | RLS hardening of the help desk tables |
| ✅ | `attendance` schema, RLS and privileges |
| ✅ | Punch engine: state machine, idempotency, append-only, offline |
| ✅ | Free plan maintenance and backups |
| ⬜ | User accounts and Auth hardening |
| ⬜ | Per-department schedules and the alert evaluator |
| ⬜ | Email Edge Function (on top of `config_correo`) |
| ⬜ | PWA: login, punch screen, offline queue, service worker |
| ⬜ | HR dashboard and administration |

### Known debt

- **SQL comments in the 11 migrations are still in Spanish.** They date from an
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
