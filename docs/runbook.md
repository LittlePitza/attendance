# Runbook

Day-to-day operation. What to do, in what order, and how to check it worked.

---

## First-time setup (once)

These steps are **still missing** and are required before the system can be used
for real.

### 1. GitHub Actions secrets

`Settings → Secrets and variables → Actions`:

| Secret | Where it comes from |
|---|---|
| `SUPABASE_DB_URL` | Supabase dashboard → Project Settings → Database → Connection string (**Session** mode) |
| `BACKUP_PASSPHRASE` | `openssl rand -base64 48`. **Also store it outside GitHub** |

Without the first, backup, keepalive and CI all fail. Without the second, the
backup refuses to upload anything rather than upload it unencrypted.

### 2. Harden Auth in the dashboard

`Authentication → Providers → Email` and `Authentication → Policies`. What is in
`supabase/config.toml` describes the local environment; **it is not applied
automatically to the remote project**.

- Minimum length: **12**.
- Required characters: uppercase, lowercase, digit and symbol.
- Open signup: **disabled**. HR creates the accounts.
- Email confirmation: disabled (accounts are created internally).
- MFA for the `hr` and `admin` accounts.

Leaked-password blocking cannot be enabled on the Free plan. See
[free-plan.md](free-plan.md).

### 3. Create the test accounts

The agreement was to start with **2 or 3**, not all 31. For each one:

```sql
-- 1. Create the account in the dashboard (Authentication → Users → Add user),
--    with a random password and "Auto Confirm User" checked.

-- 2. Link it to the employee record and assign a role.
update public.empleados
   set auth_user_id = '<account-uuid>'
 where correo = 'person@plasticospimsa.com';

insert into public.user_roles (auth_user_id, role, note)
values ('<account-uuid>', 'employee', 'Test account');
```

Check that it landed correctly:

```sql
select e.nombre, e.correo, ur.role
  from public.empleados e
  join public.user_roles ur on ur.auth_user_id = e.auth_user_id
 where e.auth_user_id is not null;
```

### 4. Do a restore drill

Against a different Supabase project, not production. A backup that has never
been restored is a hypothesis.

---

## Weekly check (5 minutes)

```sql
-- 1. Consumption against the Free plan quotas.
select * from attendance.free_plan_usage;

-- 2. Scheduled jobs are alive and not failing.
select jobname, schedule, active from cron.job order by jobname;

select j.jobname, d.status, d.start_time, d.return_message
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where d.status <> 'succeeded'
 order by d.start_time desc
 limit 20;

-- 3. Punches waiting on HR review.
select count(*) from attendance.punches where needs_review;
```

And in GitHub, under `Actions`: **Respaldo diario** and **Latido** should be
green. A red heartbeat several days running means the project may get paused.

---

## After every migration

Mandatory, no exceptions:

```
get_advisors(project_id, type: "security")
get_advisors(project_id, type: "performance")
```

Findings that **are the design** and are not to be "fixed":

- `punch`, `sync_punches` and `heartbeat` flagged as *SECURITY DEFINER
  executable by authenticated*. They are the only write path; they have to
  elevate privileges.
- *Leaked password protection disabled*: Pro only.
- `unused_index` on new tables: they simply have not been queried yet.

And one check the linter does **not** do, because it only verifies that RLS is
switched on, not that the policies are restrictive:

```sql
select tablename, policyname from pg_policies
 where schemaname = 'public' and permissive = 'PERMISSIVE'
   and (qual = 'true' or qual is null)
   and policyname <> 'departments_read';
-- Expected: 0 rows. departments_read is open on purpose.
```

---

## Running the tests

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
     -f supabase/tests/sql/punch_engine_test.sql
```

Safe against the live database: everything happens inside a transaction that
ends in `ROLLBACK`, and the block also restores state on its own before
finishing. It leaves no punches, no workdays and no account links behind.

---

## Incidents

### The project got paused

Supabase dashboard → select the project → **Resume project**. There is a 90-day
window from the pause to do this with all data intact. Afterwards, find out why
the heartbeat failed.

### An employee cannot punch

In order of likelihood:

```sql
-- 1. Is the account linked to an active employee record?
select e.nombre, e.estado, ur.role
  from public.empleados e
  left join public.user_roles ur on ur.auth_user_id = e.auth_user_id
 where e.auth_user_id = '<uuid>';
-- No row, or estado <> 'activo': that is it. punch() rejects them on purpose.

-- 2. Is their device revoked?
select device_id, revoked_at from attendance.devices
 where employee_id = '<employee-uuid>' and revoked_at is not null;

-- 3. What state did their workday end up in?
select work_date, state, opened_at, closed_at
  from attendance.workdays
 where employee_id = '<employee-uuid>'
 order by work_date desc limit 5;
```

The error the employee sees already names the current state — that is why those
messages are written in Spanish.

### A punch needs correcting

**It does not get edited.** `attendance.punches` is append-only and the trigger
rejects any `UPDATE`, even from the service role. The correction is a new row in
`attendance.adjustments`, with a mandatory reason of at least 10 characters.
That is what makes the record defensible: nothing changes silently.

### Revoking the device of someone who lost their laptop

```sql
update attendance.devices
   set revoked_at = now(), revoked_by = auth.uid()
 where employee_id = '<employee-uuid>' and device_id = '<device-id>';
```

Blocks that device without closing the account. From then on `punch()` rejects
it.

---

## Applying a migration

There is no CLI set up (no linked `config.toml`, no database password), so
migrations are applied through the Supabase MCP.

1. Write the SQL in `supabase/migrations/_pendiente_<name>.sql`.
2. Apply it with `apply_migration` (name in `snake_case`, no timestamp).
3. Read the assigned version with `list_migrations`.
4. **Rename the file to `<version>_<name>.sql`.**

Step 4 is not cosmetic: `apply_migration` assigns the version from the execution
time, ignoring the filename. Skip it and the repository and the database drift
apart silently. It has already happened once.
