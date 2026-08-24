## What changes

<!-- What this does and why. If it fixes something, describe the failure. -->

## Blast radius

The database is shared with a production help desk that lives in another
repository. Tick what applies:

- [ ] Touches the `public` schema
- [ ] Touches tables the help desk reads (`empleados`, `departments`, `tickets`…)
- [ ] Adds or changes a `SECURITY DEFINER` function
- [ ] Adds or changes an RLS policy
- [ ] None of the above

## Checklist

- [ ] `npm test` and `npm run db:verify` pass from a clean generated workspace,
      or CI is green
- [ ] Any new migration is a new file with a new timestamp; no applied migration
      was edited, comments included
- [ ] Every new function carries `SET search_path = ''` and fully qualified
      names
- [ ] Nothing new in `public` that should not be a REST endpoint
- [ ] `authenticated` gained no write privilege
- [ ] Employee-facing error messages are in Spanish; everything else in English

## Not part of this pull request

Applying the migration to the shared project is an authorized production change,
not a review step. It happens **after** this merges, following
[docs/runbook.md](../docs/runbook.md): confirm the target, back up, apply, read
the ledger back, rename the local file if the assigned version differs, then run
the security and performance advisors.
