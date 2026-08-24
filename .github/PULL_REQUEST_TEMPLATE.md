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

- [ ] Migration applied, and the local filename matches the version it was
      assigned
- [ ] Every new function carries `SET search_path = ''` and fully qualified
      names
- [ ] Nothing new in `public` that should not be a REST endpoint
- [ ] `authenticated` gained no write privilege
- [ ] Security and performance advisors run, no new findings
- [ ] `punch_engine_test.sql` passes
- [ ] Employee-facing error messages are in Spanish; everything else in English
