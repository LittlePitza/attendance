# Contributing

Working guide for this repository: where things live, the rules that are never
broken, and the workflow for changing the database. Read it before writing the
first migration.

Attendance tracking for remote staff. Everything runs on Supabase: there is no
application server.

## Where it lives

Supabase project **`pimsa_ti`** (`cyjpucvvekzfpvvonuld`, Postgres 17, us-east-1).
**This is not an empty project**: it shares the database with the IT help desk,
which is in production (tickets, inventory, handover forms, purchasing, petty
cash). Any change to `public` can break it.

- Time clock tables → schema **`attendance`**
- Shared catalogs (`empleados`, `departments`) → schema `public`
- Identity functions and triggers → schema **`internal`**

## The punch engine

The state machine lives in **one** function, `internal.record_punch()`. The two
public entry points are thin wrappers over it, and differ only in what they
hand it:

| Entry point | `occurred_at` it passes | `source` |
|---|---|---|
| `public.punch()` | `now()` -- the server's clock | `online` |
| `public.sync_punches(jsonb)` | the client's time, parsed | `offline` |

Two copies of the state machine would drift, and one would eventually accept a
transition the other rejects. That is why the wrappers hold no rules.

A workday moves `not_started -> working -> on_break -> working -> finished`.
Anything else raises, in Spanish, because the employee reads it.

`sync_punches()` sorts the batch chronologically before replaying it: a phone
that was offline sends events in whatever order it queued them, and out of
order almost all of them would be rejected as illegal transitions. The sort
uses `internal.parse_timestamptz()`, which returns null instead of raising, and
each event is applied inside its own `begin ... exception` block. Both exist so
one malformed event is rejected on its own instead of taking the batch with it.


## Language

**Code, structure and documentation in English. User-facing text in Spanish.**

- Schema, table, column, function, index, constraint, policy, file and folder
  names: **English**.
- Enum-style `CHECK` values (`'clock_in'`, `'working'`, `'hr'`): **English**.
- `README.md`, `docs/`, ADRs, commit messages: **English**.
- **Error messages that reach the employee's screen: Spanish.** They are read by
  people who do not speak English.

Two deliberate exceptions:

- **The 19 help desk tables keep their Spanish names** (`empleados`, `tickets`,
  `equipos`, `config_correo`, `responsivas`, `facturas`, `caja_movimientos`…).
  They are in production and consumed by `ti-hub`, which lives in a separate
  repository. Renaming them breaks that system. That is why the model is mixed
  on purpose: `attendance.punches.employee_id` points at `public.empleados.id`.
- **SQL comments inside `supabase/migrations/` are still in Spanish**, left over
  from an earlier decision. New SQL should be commented in English; converting
  the existing files is a separate, deliberate pass because it also means
  updating the `COMMENT ON` strings stored in the database.

## Rules that are never broken

1. **Postgres decides, not the client.** Business rules live in
   `SECURITY DEFINER` functions. Edge Functions only talk to the outside world
   (email, user provisioning, exports) and **never** hold business rules. The
   PWA has no logic: it calls functions and renders data.

2. **The client does not write tables.** `authenticated` gets `SELECT` (filtered
   by RLS) and never `INSERT`/`UPDATE`/`DELETE` on the time clock tables.
   Functions are the only write path.

3. **The server sets the time.** `occurred_at := now()`. Whatever time the
   client sends is stored separately, in `client_reported_at`, for auditing only.

4. **`employee_id` is derived from the token**, via
   `internal.caller_employee_id()`. Never accepted as a parameter: that is what
   stops anyone punching on someone else's behalf.

5. **`attendance.punches` is append-only.** Enforced by a trigger, not just by
   withheld privileges — the service role has them anyway. Corrections are new
   rows in `attendance.adjustments`, with a mandatory reason of at least 10
   characters.

6. **Every function carries `SET search_path = ''`** and fully qualified names.
   Without that, a manipulated `search_path` allows hijacking it.

7. **No loose functions in `public`.** Anything in `public` is published as a
   REST endpoint. Internal functions go in `internal`, which **must not be added
   to "Exposed schemas"**.

   What **does** live in `public` on purpose, because the client has to call it
   over REST: `my_profile()`, `server_time()`, `punch()`, `sync_punches()` and
   `heartbeat()`. The advisors flag the last three as "SECURITY DEFINER
   executable by authenticated": **that is the design**, not a finding. They are
   the only write path, so they must elevate privileges.

8. **Wrap calls in `(select ...)` inside RLS policies**:
   `using ((select internal.caller_role()) = 'admin')`. That way Postgres
   evaluates them once per statement instead of once per row.

## Code conventions

Following what `pimsa_ti` already used, so everything reads alike:

- `snake_case`, in English (see **Language** above).
- `id uuid primary key default gen_random_uuid()`.
- `num integer` with a sequence when a human-readable folio is needed.
- **`text` with a `CHECK`** instead of `enum` types.
- `created_at timestamptz not null default now()`.
- `jsonb` defaulting to `'{}'` or `'[]'` for flexible data.
- RLS enabled on **every** table.
- Audit log in the style of `ticket_eventos`, as `attendance.audit_events`
  (`kind`, `actor`, `before_data`, `after_data`).

## Roles

In `public.user_roles`, one per **account** (not per person: there is an
administrator account that is not an employee).

| Role | Scope |
|---|---|
| `employee` | Only their own records |
| `manager` | Their department |
| `hr` | Everyone, plus adjustments and alerts |
| `admin` | Everything, plus configuration |
| `guest` | Default when no role is assigned: **no access** |

`internal.can_view_employee()` is the single place that decides who sees whose
data. Keep it that way.

## Local development

Requirements: Node 24, npm, git and Docker Desktop with a running
Linux-container daemon. Install the pinned Supabase CLI and run the guarded
workflow:

```bash
npm ci
npm test
npm run db:verify
npm run db:stop
```

`npm test` verifies the assembler, command allowlist, local-only configuration,
portable CLI launcher and documentation guardrails. `npm run db:verify` then
builds `.local/supabase`, starts local Postgres, resets it from all migrations
and synthetic fixtures, and runs both SQL suites.

The wrapper accepts one known action and constructs every Supabase argument
itself. There is no `--db-url`, link command, project selector or remote fallback.
If Docker is unavailable, it stops before invoking Supabase. Full details are in
[docs/local-development.md](docs/local-development.md).

Never run `db push`, `migration up`, `db reset` or test SQL against a linked or
remote project as part of development. A transaction rollback is not a safety
boundary for an operating database.

### Focused commands

```bash
npm run db:prepare  # assemble the ignored local workspace
npm run db:start    # start only the local database service
npm run db:reset    # replay migrations and synthetic seed locally
npm run db:test     # run engine and security SQL suites locally
npm run db:verify   # start, reset and test in one command
npm run db:stop     # stop this repository's local stack
```

## Creating a migration

1. Never edit an applied migration.
2. Add a new canonical file named
   `supabase/migrations/YYYYMMDDHHMMSS_short_description.sql`.
3. Keep the filename, identifiers and technical comments in English. Keep
   employee-facing error messages in Spanish.
4. If the change depends on a new object owned by `ti-hub`, update only the
   minimal contract in `supabase/tests/fixtures/shared_schema_test_baseline.sql`.
   Never copy production data or move that fixture into canonical migrations.
5. Run `npm run db:verify` from a clean generated workspace.
6. Review the migration's blast radius, especially any object in `public`.

Remote application is not a contribution step. It is an authorized production
change and follows [docs/runbook.md](docs/runbook.md) only after local and CI
verification are green.

**An applied migration is immutable, comments included.** Supabase stores the
raw SQL of every migration in `supabase_migrations.schema_migrations.statements`
-- `--` comments and all. Editing a file that has already been applied does not
just fail to reach the database, it makes the file disagree with that ledger,
silently. Check before assuming:

```sql
select statements from supabase_migrations.schema_migrations
 where version = '<version>';
```

If a comment in an applied migration is genuinely wrong, fix both sides or
neither.

## After every approved production migration

After read-back confirms the expected migration version on the intended target,
run the advisors and leave them with no new findings:

```
get_advisors(project_id, type: "security")
get_advisors(project_id, type: "performance")
```

Note: the linter checks that RLS is **on**, not that policies are
**restrictive**. A `using (true)` policy passes the linter and leaves the table
wide open. Check by hand:

```sql
select tablename, policyname from pg_policies
 where schemaname = 'public' and permissive = 'PERMISSIVE'
   and (qual = 'true' or qual is null)
   and policyname <> 'departments_read';
-- Expected: 0 rows. departments_read is open on purpose.
```

## Known pending items

- **Free plan.** No automatic backups and the project pauses after 7 days of low
  activity. Compensated by `.github/workflows/backup.yml` (encrypted daily dump)
  and `keepalive.yml`. Leaked-password blocking is Pro only and cannot be
  enabled. See [docs/free-plan.md](docs/free-plan.md).
- **`public.config_correo`** stores `smtp_pass`, `azure_client_secret` and
  `oauth_refresh_token` in **plain text**. Move to Vault.
- **`empleados.departamento` (text)** is obsolete: it exists only so the help
  desk keeps working. A trigger keeps it in sync with `department_id`. It goes
  away when `ti-hub` uses the id.
- **8 of 31 employees have no department.** The global schedule covers them.
- **Spanish aliases inside 20 production policies**, reading as
  `(SELECT internal.caller_role() AS rol_actual)`: Postgres froze the output
  alias when the policy was created. The call resolves correctly and behavior is
  identical. Clean it up next time those policies need touching, not before.
- **The 31 user accounts do not exist yet.** The agreement was to create 2 or 3
  test accounts first. `public.empleados.auth_user_id` is at zero.
