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

## The alert evaluator

`attendance.evaluate_alerts(p_now)` is the only place that decides an alert
exists. Cron calls it every five minutes with no argument; the suites call it
with a chosen instant, which is the entire reason the parameter is there. It is
not a way to rewrite history.

Four properties it has to keep, because the schedule it runs on depends on all
four:

1. **Idempotent.** It sees the same day roughly 288 times before that day ends.
   The unique `(employee_id, alert_date, kind)` on `alerts` and the unique
   `idempotency_key` on `notification_outbox` are what make repetition free.
2. **It never closes an alert.** An alert is a record of what happened, not a
   live indicator. Somebody who missed the entry window and turned up two hours
   later was still absent at 09:30. HR decides what that was worth, so the
   upsert refreshes only rows that are still `open`.
3. **It enqueues, it does not send.** A mail provider that is down must never
   roll back attendance state. The evaluator writes to
   `attendance.notification_outbox`; delivery is a separate Edge Function that
   claims work through `claim_notifications()` and reports back through
   `complete_notification()`.
4. **It looks at yesterday too.** The Free plan pauses the project after seven
   days of low activity and cron does not run while it is paused. Re-evaluating
   the previous local day costs nothing and is what keeps an evening of missing
   exits from being lost.

Thresholds resolve department > global > the evaluator's own defaults. **No row
in `alert_rules` is not the same as a disabled rule**: a missing row falls back
to the default, so an alert kind is never switched off by absent configuration.

Only employees who are active **and** linked to an account are evaluated:
somebody who cannot punch cannot be late. The 31 accounts do not exist yet, so
the evaluator raises nothing until they are provisioned.

**Known gap:** there is no leave or absence table. Until there is one, a person
on holiday collects a `missing_entry` every day, and HR dismisses them by hand.
Adding one means an extra condition in the evaluator, not a second evaluator.


## The dispatcher

`supabase/functions/alerts-notify` drains `attendance.notification_outbox`. It
is the only Edge Function, and it is the clearest example of the boundary: it
owns **how** to talk to a mail provider and nothing else. When to retry, how
long to wait, when to give up and whether an alert counts as notified are all
decided in SQL, where they survive a deploy, a restart and a Free plan pause.

- **It connects to Postgres directly**, with `SUPABASE_DB_URL`, rather than
  through `supabase-js`. `attendance` is deliberately not an exposed schema, so
  PostgREST cannot reach `claim_notifications()` at all -- and publishing
  `public` wrappers would add two `SECURITY DEFINER` functions to the REST
  surface that no browser would ever call.
- **It loads the mail configuration before it claims anything.** Claiming first
  would mark twenty rows `sending` and burn an attempt on each before
  discovering that mail is misconfigured.
- **It requires the service role**, compared as a digest. `verify_jwt` only
  proves the caller has *a* valid token, and every employee has one; this
  function reads recipient addresses and sends mail as the company.
- **Delivery is at-least-once.** A run that dies between sending and reporting
  leaves the row claimed, and fifteen minutes later another run may send a
  second copy. A duplicate is visible and harmless; a missing notification is
  neither.
- **It never invents a recipient.** The seven global rows in `alert_rules` all
  carry a null `recipients`, so every notification still falls back to
  `ALERTS_DEFAULT_RECIPIENTS` -- **Configuración → Alertas** is where that column
  finally gets filled. With the fallback unset it
  reports the failure rather than borrowing the help desk's distribution list
  from `config_correo`, which would mail attendance alerts to the IT ticket
  queue -- wrong, and hard to notice.

Only `graph_app` is implemented, because that is what `config_correo.metodo`
says. The other two values the column allows are refused with an explanation
rather than half-implemented; a quiet SMTP path nobody has ever run is worse
than a loud stop.

## The client

The employee PWA is in `web/`: React, TypeScript in strict mode, Vite, and a
service worker from `vite-plugin-pwa`. It is the third layer of the boundary,
and the thinnest one -- **it holds no rule about attendance at all**.

Where that gets decided in practice:

- **The buttons come from the server.** `my_day()` returns `next_actions`, and
  the screen renders exactly those. It does not know that a break follows an
  entry or that a finished day accepts nothing. Adding a fifth punch kind is a
  migration and a label, never a condition in a component.
- **Nothing is optimistic.** After a punch the screen asks `my_day()` again
  instead of predicting the new state. Predicting it would put the state machine
  in two places, and the browser's copy would be the wrong one when they
  disagree.
- **Refused is not the same as unsent.** `isTransportFailure()` in
  `web/src/lib/errors.ts` is the whole of that decision. A refusal carries a
  SQLSTATE, is final, and is shown to the employee in the Spanish the engine
  wrote. A request that never arrived decided nothing, so the punch goes to the
  IndexedDB queue. Backwards in one direction it loses a legitimate punch;
  backwards in the other it retries an illegal one on every reconnection
  forever.
- **The idempotency key is minted before the attempt**, not when it is sent. A
  reply lost in transit is then retried onto the same key, and the database
  returns the original punch instead of making a second one.
- **The queue drains on reconnection, not on a timer.** An event the server
  answered for is deleted from the queue even when the answer was a refusal:
  keeping it would mean retrying it for the life of the installation. It is
  surfaced on screen instead, and held there until dismissed.

`web/src/lib/types.ts` is the client's copy of the SQL contract, written by hand
rather than generated. It is small, and a generated file would hide the moment
the contract moved.

**The board** (`web/src/features/hr/`) follows the same rule, and it is worth
saying where it bites: the board **never works out who was late**. Whether an
arrival counts as late depends on the schedule, the grace period and the
department's threshold, and `attendance.evaluate_alerts()` is the only thing
that resolves all three. Everything the board shows is grouping and counting of
facts the database already reported; lateness arrives as a `late_entry` alert.
It also offers no way to close one, because an alert is a record of what
happened rather than a notification to clear.

The role decides which screen opens and nothing else. `team_day()` and
`open_alerts()` are `SECURITY INVOKER`, so a manager gets their department and
HR gets everyone without a single role check in the browser -- a role tampered
with in devtools changes what is offered, never what comes back.

**The administration screen** (`web/src/features/admin/`) is the one place in
the client where somebody types, and it is why `attendance.schedules`,
`attendance.alert_rules` and `public.user_roles` are no longer edited in the SQL
editor. It holds no rule either: every field it offers is validated again by the
function it calls, and what it prints on a refusal is the database's own Spanish
sentence rather than a kinder one of its own.

The one thing it decides is what to *draw*: the sidebar hides the entry from a
manager. That is a courtesy, not a permission -- `list_accounts()` refuses
anybody who is not `hr` or `admin`, so a forced route reaches a screen whose
every call comes back 403.

**No UI framework, and no icon package.** The whole client has four runtime
dependencies. A component library would bring a build-time toolchain and dozens
of transitive packages to style what is, in total, two screens; the icons are a
dozen hand-drawn SVG paths for the same reason, and the one chart is forty
lines of SVG geometry rather than a charting library.

**The one external asset is the typeface.** Geist and Geist Mono are loaded
from Google Fonts, which is the single exception to this application fetching
nothing it did not ship. It earns it: the board is a dense grid of figures and
names and the face carries most of that. The cost is paid down rather than
ignored -- there is a real system fallback stack, `display=swap` means text
renders immediately either way, and the service worker caches the files after
the first visit so a later offline launch still gets them. Nothing depends on
the font arriving.

**The board is light and the punch screen is dark**, which is not an oversight
either. They are different surfaces: a phone held for five seconds at the start
of a shift, and a desktop grid left open all day. They share `lib/` and share
nothing visual, which is why `hr.css` defines its own components instead of
recolouring the ones in `app.css`.

**It is served from Vercel, and `web/vercel.json` is part of it.** Root
Directory is `web`; everything else -- build command, output directory, cache
headers, the content security policy -- is in that file rather than in a
dashboard, so it is reviewed like the rest of the client. Two of its rules track
what the code does and will go stale silently if they are not moved with it:
`connect-src` names `https://*.supabase.co` and no `wss:`, and
`Permissions-Policy` denies geolocation because nothing asks for it yet. Adding
Realtime or collecting coordinates means editing that file in the same commit,
or the browser refuses the request without the code ever hearing why.

`connect-src` also names the two Google Fonts hosts, which reads as duplication
of `style-src` and `font-src` and is not: the catch-all header rule matches
`/sw.js` too, so the service worker is served this policy, and a worker's
`connect-src` governs the fetches *it* makes -- including the runtime caching
that keeps the typeface working offline. Removing them as redundant would leave
the font loading on the first visit and failing once the service worker takes
over. The decision is
[ADR-0003](docs/decisions/ADR-0003-serve-the-pwa-from-vercel.md); the procedure
is in [docs/runbook.md](docs/runbook.md).

**`manifest.id` in `vite.config.ts` is not cosmetic and does not change.** It is
the name Windows files the installed application under, and the Edge policy that
makes it start at sign-in is keyed by it rather than by the URL. A new value is
a new application to the operating system: the old one stays installed, the
policy matches nothing, and nobody is told.

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

## Repository conventions

These are settled decisions, not preferences to re-litigate per change.

**Naming.** Repositories and their local folders are named in **English**, kept
**general**, and do not carry the company name: `attendance`, not `checador` and
not `pimsa-attendance`. The rule that applies to schemas, tables and files
applies to the repository too. A name without the company also travels -- the
same system could be lifted into another context without the name lying about
it. The sibling repository `ti-hub` already set the terse, unprefixed
precedent. When proposing a name, drop the company-prefixed variants rather than
offering them.

**Structure.** Lay the repository out the way a well-kept public project is laid
out, even though this one is private: `README.md`, `CONTRIBUTING.md`, `LICENSE`,
`SECURITY.md`, `.github/` templates, `.gitattributes`, `.editorconfig`. Apply
that by default -- it is not an optional extra to be proposed and deferred. With
judgement, though: add the files that earn their place and skip the ceremony
that does not. A private internal system gets a proprietary `LICENSE`, not an
open source one, and needs no code of conduct. `SECURITY.md` earns its place
here because the database holds employee personal data. The pull request
template carries this project's real checklist -- advisors, suites, blast radius
-- not a generic one.

**The record.** A commit message and a pull request body describe the change and
why it was made. They do not describe the tooling that produced it: no
attribution trailers, no generated-with footers. Which editor, assistant or
generator someone used is not part of the project's record, and a repository
that reads as a company work product should read like one throughout.

By the same reasoning, **editor and assistant configuration stays out of the
repository**. It belongs in the developer's global ignore file, not in
`.gitignore` here, so that this project's ignore list stays about this project.
Anything a given contributor's tooling needs locally can be a file that is
ignored globally and never appears in `git status`.

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
   over REST: `my_profile()`, `server_time()`, `punch()`, `sync_punches()`,
   `heartbeat()`, `my_day()`, `my_history()`, `team_day()` and `open_alerts()`.
   The advisors flag `punch`, `sync_punches` and `heartbeat` as "SECURITY
   DEFINER executable by authenticated": **that is the design**, not a finding.
   They are the only write path, so they must elevate privileges.

8. **Wrap calls in `(select ...)` inside RLS policies**:
   `using ((select internal.caller_role()) = 'admin')`. That way Postgres
   evaluates them once per statement instead of once per row.

9. **Writes elevate; reads do not.** The four read functions are `SECURITY
   INVOKER`, and adding a fifth that is `DEFINER` needs a reason written down.
   `internal.can_view_employee()` already decides who sees whom and the column
   grants already withhold `geo_lat` and `geo_lng`; a read function that
   elevated would have to reimplement both and could get either wrong quietly.
   As invoker, the worst a bug in one of them can do is display the wrong thing
   to somebody already entitled to it.

## Code conventions

### The standard, for SQL and TypeScript alike

Every line here is expected to be well structured, solid, readable, secure and
efficient, using current practice rather than habits carried over from older
code. That is easy to say and easy to nod at, so here is what it means when
something is being reviewed:

- **Structure comes first.** One responsibility per function, per module, per
  migration. The architectural boundary is the first structural rule: Postgres
  decides, Edge Functions talk to the outside world, the PWA renders. Code that
  makes a decision on the wrong side of that line is badly structured even if it
  works.

- **Readable means readable by someone who was not here.** Names say what the
  thing is. Comments explain **why**, never what -- the code already says what.
  If a construct takes a minute to decode, it is not clever, it is a cost paid
  by everyone who reads it afterwards. Prefer the plain form.

- **Solid means the failure path is written on purpose.** An error is handled,
  reported or allowed to raise -- never swallowed. Nothing is left half-applied:
  the batch that fails on one event, the notification that fails to send, the
  punch that arrives twice, all have a defined outcome. If a case cannot happen,
  say why in a comment instead of leaving the reader to guess.

- **Secure means it does not depend on the caller behaving.** Least privilege by
  default: a privilege not granted cannot be revoked by mistake. Never trust an
  identifier the client supplied. Secrets do not enter the repository, the logs
  or an error message.

- **Efficient means the right shape, not micro-optimisation.** The cost that
  matters is the one that grows: a query per row instead of a query per
  statement, a policy re-evaluated per row, a table that nothing prunes. Fix
  those. Do not contort readable code to save an allocation.

- **Modern means the current standard, deliberately chosen.** Current language
  features, TypeScript in strict mode, no pattern kept only because it is
  familiar. And no dependency that has not earned its place -- every one is
  something to keep current, audit and explain.

### SQL specifics

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

The PWA has its own lockfile and is installed separately:

```bash
cd web
npm ci
npm test          # the queue, the sync pass, the punch screen, the board
npm run typecheck # strict type-check on its own, without bundling
npm run build     # type-check, then the bundle and service worker
npm run dev       # http://localhost:5173
```

It needs no database to run its tests, and its configuration is the single
`.env` at the repository root -- Vite is pointed there with `envDir` so there is
never a second env file inside `web/` to get out of step.

The Edge Function is Deno, and needs neither:

```bash
cd supabase/functions
deno fmt --check
deno lint
deno check alerts-notify/index.ts _shared/*_test.ts
deno test
```

`deno.lock` pins the dependency tree; CI runs exactly these four commands, and
`deno task check` and `deno task test` are the same two spelled shorter.

### Running one test

Each toolchain names its subject differently, and none of them needs a watcher
to be useful:

```bash
# The Node guards are one file, so narrow by test name.
node --test --test-name-pattern "allowlist" tests/local-supabase.test.mjs

# The client, by file or by name. `test:watch` leaves vitest running.
cd web && npx vitest run src/features/hr/summary.test.ts
cd web && npx vitest run -t "never goes back down"

# The Edge Function, by file or by name.
cd supabase/functions && deno test _shared/message_test.ts
cd supabase/functions && deno test --filter "recipient"
```

**The SQL suites are the exception: there is no way to run one.**
`npm run db:test` runs all six, because the wrapper takes a single known
action and rejects every additional argument -- which is the same property that
stops a suite being pointed at a different database by accident. Narrow inside
the file instead.

`npm test` verifies the assembler, command allowlist, local-only configuration,
portable CLI launcher and documentation guardrails. `npm run db:verify` then
builds `.local/supabase`, starts local Postgres, resets it from all migrations
and synthetic fixtures, and runs the six SQL suites.

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
npm run db:test     # punch, alert, read, review, admin and security SQL suites
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
select tablename, policyname, cmd from pg_policies
 where schemaname = 'public' and permissive = 'PERMISSIVE'
   -- An INSERT policy restricts through with_check and always has a null qual,
   -- so testing qual alone reports every one of them as wide open. Falling back
   -- to with_check reads whichever clause actually governs the command.
   and coalesce(qual, with_check, 'true') = 'true'
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
- **The Vercel project settings in the runbook were never applied.** Root
  Directory is unset, so every production deployment so far has built from the
  repository root, found nothing to build, finished in about a tenth of a second
  and served a 404 -- `READY` and empty, which is the combination that does not
  look like a failure. `web/vercel.json` has been correct the whole time and was
  never read. The three settings are in [docs/runbook.md](docs/runbook.md); they
  are dashboard-only, so no deploy fixes them and neither does the Vercel MCP.
- **Nothing schedules the dispatcher.** `alerts-notify` drains the outbox when
  it is called and no cron job calls it. Scheduling means deciding where the
  function URL and its key live for `pg_net` to use, which is a credential
  decision and so its own change.
- **The 31 user accounts still have to be created**, one at a time, on
  **Configuración → Accesos**. The agreement was to start with 2 or 3. Until an
  account exists a person cannot punch, and `evaluate_alerts()` does not look at
  them -- so onboarding somebody is also what puts them under watch.
- **There is no leave or absence table.** Somebody on holiday collects a
  `missing_entry` every day until one exists, and HR dismisses each by hand on
  **Revisión**. Closing it is one extra condition inside `evaluate_alerts()`, not
  a second evaluator.
