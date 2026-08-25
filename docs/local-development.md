# Isolated Local Supabase Development

This repository shares its production Supabase database with `ti-hub`. Local
development therefore fails closed: if a disposable local database cannot run,
the workflow stops instead of switching to a remote project.

## Prerequisites

- Node.js 24 and npm
- Git
- Docker Desktop using Linux containers, with its daemon running

Install the project-pinned Supabase CLI:

```bash
npm ci
```

Do not link this checkout to a Supabase project. Development does not require a
remote access token, database password, project ref or `SUPABASE_DB_URL`.

## One-command verification

```bash
npm test
npm run db:verify
npm run db:stop
```

`npm test` exercises the safety harness without starting containers.
`npm run db:verify` performs this fixed sequence:

1. Delete and rebuild the ignored `.local/supabase` workspace.
2. Copy `supabase/config.toml` while replacing its project id with
   `attendance-local`.
3. Place the test-only shared-schema contract before the canonical migration
   history.
4. Copy every canonical migration without modifying the source files.
5. Copy the synthetic seed and SQL verification files.
6. Check that Docker is available and its daemon responds.
7. Start the local Supabase database service.
8. Reset the local database from the generated migrations and seed.
9. Run the punch-engine SQL suite.
10. Run the alert-evaluator SQL suite.
11. Run the read-API suite, which switches to the `authenticated` role so the
    RLS policies are executed by the role they were written for.
12. Run the grants, RLS and function security-invariant suite.

The suites are piped into `psql` inside the local database container rather than
sent through `supabase db query`. That command submits a file as a single
prepared statement, and Postgres rejects a prepared statement holding more than
one command -- which every suite is: a transaction, the checks, a report and a
rollback. A container name is also a narrower target than a connection string:
there is no value it could take that reaches a database on another machine.

Stop the local stack when finished:

```bash
npm run db:stop
```

## Focused commands

| Command | Effect |
|---|---|
| `npm test` | Run fast Node safety and orchestration tests; no database |
| `npm run db:prepare` | Rebuild `.local/supabase`; no Docker or database |
| `npm run db:start` | Prepare the workspace and start local Postgres |
| `npm run db:reset` | Prepare and reset only the local database |
| `npm run db:test` | Prepare and run the four SQL suites against local Postgres |
| `npm run db:verify` | Prepare, start, reset and run the four SQL suites |
| `npm run db:stop` | Stop the stack identified as `attendance-local` |

The CLI accepts exactly one action. Extra flags and arguments are rejected, so a
caller cannot append `--db-url`, `--linked` or another destination.

## Generated workspace

The canonical `supabase/migrations/` directory remains the source of truth. The
assembler creates this test-only layout:

```text
.local/supabase/
└── supabase/
    ├── config.toml
    ├── migrations/
    │   ├── 00000000000000_shared_schema_test_baseline.sql
    │   └── <copies of canonical migrations>
    ├── seed.sql
    └── tests/sql/
```

`.local/` is ignored by Git and can be deleted at any time.

### Shared-schema contract

`supabase/tests/fixtures/shared_schema_test_baseline.sql` models only the minimum
`public` objects owned by `ti-hub` that the Attendance migration history expects.
It is not a schema dump and must never be copied into canonical migrations.

When Attendance legitimately depends on another shared object:

1. Confirm the contract in the owning `ti-hub` codebase.
2. Add only the required table, column, policy or constraint to the fixture.
3. Use no real identifiers, names, emails, coordinates or business records.
4. Run the complete local reset to prove migration compatibility from zero.

### Synthetic seed

`supabase/tests/fixtures/local_seed.sql` contains fixed synthetic UUIDs and
`.invalid` identities. It creates only the minimum local accounts, departments,
employees and roles required by the SQL suites. Production exports are forbidden
as development fixtures.

## Safety guarantees

The harness is designed around mechanical controls rather than operator memory:

- The canonical config uses `project_id = "attendance-local"`.
- Generated config is rejected if it contains the operating project ref.
- The database reset action always includes `--local`.
- The suites are addressed by container name, never by connection string,
  and that name is derived from the same local project id as the config.
- Every Supabase call is scoped with `--workdir` to `.local/supabase`.
- There is no action for linking, login, `db push`, `migration up`, restore or
  arbitrary SQL.
- The parser rejects unknown actions and all additional arguments.
- The pinned CLI is launched through its JavaScript entrypoint for consistent
  Windows and Linux behavior.
- Docker is checked before Supabase starts; a missing daemon produces an explicit
  `No remote fallback is allowed` error.
- `.env.example` points the PWA at `http://127.0.0.1:54321`.
- Pull-request CI receives no production database secret and runs the same local
  verifier.

The `ROLLBACK` in the engine test is defense in depth. It does not make a live
or shared database an acceptable test target.

## The PWA

The employee client lives in `web/` and has its own lockfile, so it is installed
separately from the database tooling:

```bash
cd web
npm ci
npm test        # unit tests: the queue, the sync pass, the punch screen
npm run build   # type-check in strict mode, then bundle with the service worker
npm run dev     # http://localhost:5173
```

Configuration comes from a single `.env` at the repository root -- copy
`.env.example` beside it and fill it in. Vite is pointed there with `envDir`
rather than keeping a second env file inside `web/`, so there is one place to
look and one place to get wrong.

Only variables prefixed with `VITE_` reach the browser, and only the publishable
key ever should. It grants nothing on its own: every table is behind RLS and
every write goes through a `SECURITY DEFINER` function that derives the employee
from the token.

The client needs no database to run its tests -- everything that would touch the
network is mocked, and the offline queue runs against `fake-indexeddb`. Pointing
it at a real project is a manual step, and `npm run db:start` gives you a local
one to point it at.

## Migration workflow

Applied migrations are immutable. To change the database:

1. Add a new file under `supabase/migrations/` using
   `YYYYMMDDHHMMSS_short_description.sql`.
2. Write technical identifiers and comments in English. Keep employee-facing
   messages in Spanish.
3. Add or update tests first and observe the expected failure.
4. Run `npm run db:verify` until a clean database passes.
5. Review any impact on shared `public` objects with the `ti-hub` owner.
6. Let CI repeat the clean local verification.

Remote application is a separate, explicitly authorized production operation.
Follow `docs/runbook.md`; never turn a development failure into a remote fallback.

## Troubleshooting

### Docker is unavailable

Expected failure:

```text
Docker Desktop with a running daemon is required for the disposable local database.
No remote fallback is allowed.
```

Install or start Docker Desktop, wait until the daemon is healthy, and rerun
`npm run db:verify`. Do not substitute a remote database URL.

### A clean reset fails

Read the first failing migration in the generated workspace, then fix the source
through a new migration when the failing file has already been applied. Do not
edit historical migrations merely to make the local replay pass. If the failure
is a missing shared dependency, correct the minimal test contract instead.

### A SQL suite fails

Run `npm run db:test` against the already running local stack while iterating.
The engine suite is one transactional block whose phases share fixtures; keep it
whole unless a deliberate test refactor first preserves that setup.
