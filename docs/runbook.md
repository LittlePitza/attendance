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

Without the first, backup and keepalive fail. CI intentionally never receives
it: pull requests run only against a disposable local database. Without the
second, the backup refuses to upload anything rather than upload it unencrypted.

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

### 5. Create the Vercel project

The PWA is served from Vercel; the reasoning is in
[ADR-0003](decisions/ADR-0003-serve-the-pwa-from-vercel.md). This is done once,
in the same account that already hosts `ti-hub`.

Import the repository and set **one** project setting by hand -- everything else
is read from `web/vercel.json`, which is committed:

| Setting | Value |
|---|---|
| Root Directory | `web` |

Then add the two environment variables, under
`Settings → Environment Variables`:

| Variable | Value | Environments |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://cyjpucvvekzfpvvonuld.supabase.co` | **Production only** |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Dashboard → Project Settings → API Keys → publishable | **Production only** |

**Production only is deliberate.** A preview deployment given these values is a
working attendance application, on a public URL, pointing at real employee
records. Without them the bundle builds and then refuses to start, which is
`requireEnv()` doing its job. Never add the secret key or `SUPABASE_DB_URL`
here: nothing in `web/` reads them and anything in this project reaches the
browser.

No redirect URL has to be allow-listed in Supabase Auth. Sign-in is email and
password, `detectSessionInUrl` is off and there is no OAuth provider, so nothing
ever comes back through a URL. That changes the day password recovery is added.

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

-- 4. Alerts nobody has looked at, oldest first.
select kind, severity, count(*), min(alert_date) as oldest
  from attendance.alerts
 where state = 'open'
 group by kind, severity
 order by oldest;

-- 5. Notifications that are not moving. Both cases are worth a look: 'failed'
--    gave up after eight attempts, and a row claimed for over 15 minutes means
--    a dispatcher died mid-send.
select id, status, attempts, next_attempt_at, left(last_error, 120) as last_error
  from attendance.notification_outbox
 where status = 'failed'
    or (status = 'sending' and updated_at < now() - interval '15 minutes')
 order by updated_at;
```

And in GitHub, under `Actions`: **Respaldo diario** and **Latido** should be
green. A red heartbeat several days running means the project may get paused.

---

## After every approved production migration

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
select tablename, policyname, cmd from pg_policies
 where schemaname = 'public' and permissive = 'PERMISSIVE'
   -- An INSERT policy restricts through with_check and always has a null qual,
   -- so testing qual alone reports every one of them as wide open. Falling back
   -- to with_check reads whichever clause actually governs the command.
   and coalesce(qual, with_check, 'true') = 'true'
   and policyname <> 'departments_read';
-- Expected: 0 rows. departments_read is open on purpose.
```

---

## Running the tests

```bash
npm ci
npm test
npm run db:verify
npm run db:stop
```

Tests run only against the ignored workspace under `.local/supabase`. The
wrapper rejects extra arguments, constructs local-only CLI flags, and stops if
Docker is unavailable; it has no remote fallback. Never paste the engine suite
into the dashboard or pass `SUPABASE_DB_URL` to a test command. See
[local-development.md](local-development.md) for the complete safety model.

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

### HR is getting alerts that should not exist

Do not delete the alert and do not stop the cron job. Alerts are dismissed
(`state = 'dismissed'`), which keeps the record of what the system saw, and the
rule behind them is turned off or widened where it lives:

```sql
-- Widen the threshold for one department, in minutes.
insert into attendance.alert_rules (department_id, kind, threshold_minutes)
values ('<department-uuid>', 'missing_exit', 240)
-- The unique index on (department_id, kind) is partial -- global rules keep a
-- null department -- so the WHERE has to be repeated here or Postgres cannot
-- match the index.
on conflict (department_id, kind) where department_id is not null do update
   set threshold_minutes = excluded.threshold_minutes, active = true;

-- Or switch the kind off globally, which is a decision, not a workaround.
update attendance.alert_rules
   set active = false
 where kind = 'no_connection' and department_id is null;
```

Two causes account for most of the noise. The first is somebody on holiday:
there is no leave table yet, so they collect a `missing_entry` every day until
one exists. The second is an employee whose account was provisioned before they
started using the system -- the evaluator only looks at people with an account,
so linking an account is what puts somebody under watch.

### Nobody is receiving alert email

The alert and the email are separate on purpose, so check which half is broken:

```sql
-- Are alerts being raised at all? If not, the evaluator or its cron job.
select max(created_at) from attendance.alerts;

-- Are they queued? If they are and nothing is sent, it is the dispatcher.
select status, count(*), max(created_at) from attendance.notification_outbox
 group by status;
```

`last_error` says which half it is. Two answers are common enough to name:

- **`No recipients: ...`** -- no alert rule names an address and
  `ALERTS_DEFAULT_RECIPIENTS` is unset. The dispatcher refuses to guess rather
  than borrow the help desk's list. Fix it with a global rule, which is the
  durable answer:

  ```sql
  insert into attendance.alert_rules (department_id, kind, recipients)
  select null, kind, 'rh@empresa.com'
    from unnest(array['late_entry', 'missing_entry', 'break_exceeded',
                      'missing_exit', 'no_connection', 'review_offline',
                      'clock_tampered']) as kind
  on conflict do nothing;
  ```

  Rows already queued keep the null they were enqueued with, so set the function
  secret too if you want the existing backlog delivered.

- **`public.config_correo.metodo is '...'`** -- somebody switched the help desk's
  mail method. The dispatcher implements `graph_app` only, on purpose.

Nothing is lost while the dispatcher is down: the outbox keeps the work and
retries with backoff. A row that reached `failed` stopped after eight attempts
and needs a decision, not a retry loop.

### Revoking the device of someone who lost their laptop

```sql
update attendance.devices
   set revoked_at = now(), revoked_by = auth.uid()
 where employee_id = '<employee-uuid>' and device_id = '<device-id>';
```

Blocks that device without closing the account. From then on `punch()` rejects
it.

---

## Deploying the PWA

Pushing to `master` deploys it. There is nothing to run by hand, and no
migration or Edge Function is involved -- the build produces static files and
Vercel serves them.

What is worth doing is checking that the deployment is the one the repository
describes, because a `vercel.json` in the wrong place is ignored in silence
rather than reported:

```bash
# The service worker must revalidate. A pinned sw.js is a client stuck on an
# old build, which is exactly what registerType: 'autoUpdate' exists to prevent.
curl -sI https://<domain>/sw.js | grep -i '^cache-control'
# Expected: public, max-age=0, must-revalidate

# The hashed bundle must not. If this says must-revalidate too, the headers
# were not applied at all and every visit re-downloads the application.
curl -sI https://<domain>/assets/index-*.js | grep -i '^cache-control'
# Expected: public, max-age=31536000, immutable

# The policy that keeps the page from talking to anything but Supabase.
curl -sI https://<domain>/ | grep -i '^content-security-policy'
```

Then open the site and read the browser console once. A content security policy
reports what it blocked and nothing else does: an empty console is the only
evidence that the policy in `web/vercel.json` matches what the client actually
requests. Do this after any change to the client's external dependencies, not
only on the first deployment.

**Installing it on an employee's machine** is what makes it a time clock rather
than a tab. In Chrome or Edge, the install control appears at the right of the
address bar, and the application then opens in its own window with its own icon.
It needs HTTPS and a registered service worker, which is precisely what a
deployment provides and `localhost` did not.

## Deploying the dispatcher

`alerts-notify` is deployed on its own, and deploying it changes nothing until
something calls it -- there is still no cron job that does.

```bash
supabase functions deploy alerts-notify --project-ref cyjpucvvekzfpvvonuld
supabase secrets set ALERTS_DEFAULT_RECIPIENTS=rh@empresa.com --project-ref cyjpucvvekzfpvvonuld
```

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` are injected by
the platform and must not be set by hand.

Draining the queue once, by hand, is the way to prove it works before anything
is scheduled:

```bash
curl -X POST   -H "Authorization: Bearer $SERVICE_ROLE_KEY"   https://cyjpucvvekzfpvvonuld.supabase.co/functions/v1/alerts-notify
```

It answers `{"claimed":N,"sent":N,"failed":N}`. Anything that failed left its
reason in `notification_outbox.last_error`.

## Applying a migration

This is a production change, not a development command. Do it only during an
approved change window and only after `npm run db:verify` and CI are green.

1. Confirm the intended Supabase project in the dashboard and read its current
   migration ledger. Do not infer the target from shell state or cached links.
2. Take and verify an encrypted backup before a high-risk change.
3. Re-read the exact new immutable file under `supabase/migrations/`; do not edit
   an already applied migration and do not deploy test fixtures.
4. Obtain explicit authorization for that target and migration.
5. Apply exactly that migration using the approved deployment channel.
6. Read the migration ledger back from the same target and confirm the assigned
   version and statement content.
7. Run the security and performance advisors and inspect new findings.
8. Perform only non-destructive production smoke checks. The SQL test suites
   remain local-only.

Never use `db reset` on an operating project. Never make `db push` or
`migration up` part of a pull request, local test script or unattended workflow.
