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

## Commands

No Docker is installed, and none is needed:

```bash
npx supabase db push                      # apply migrations (remote)
npx supabase functions deploy --use-api   # deploy functions without Docker
npx supabase gen types typescript --linked > web/src/shared/supabase/types.gen.ts

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
     -f supabase/tests/sql/punch_engine_test.sql
```

Docker is only needed for `supabase start` and `functions serve`, which emulate
everything locally. Optional.

## Applying a migration

`apply_migration` (Supabase MCP) assigns the version from the execution time and
ignores the filename. So:

1. Write the SQL in `supabase/migrations/_pendiente_<name>.sql`.
2. Apply it with `apply_migration`.
3. Read the assigned version with `list_migrations`.
4. **Rename the file to `<version>_<name>.sql`.**

Skip step 4 and the repository and the database drift apart silently.

## After every migration

Always run the advisors and leave them with no new findings:

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
