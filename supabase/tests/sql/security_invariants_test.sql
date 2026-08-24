-- Security invariants for the disposable local database.
-- This file contains plain SQL so it can run through `supabase db query`.

do $invariants$
declare
  violation_count integer;
begin
  -- Authenticated clients must not hold table-level write privileges in the
  -- private Attendance schema. All writes go through reviewed RPC functions.
  select count(*)
    into violation_count
    from information_schema.role_table_grants
   where table_schema = 'attendance'
     and grantee = 'authenticated'
     and privilege_type <> 'SELECT';

  if violation_count > 0 then
    raise exception
      'authenticated holds % write privilege(s) on attendance tables',
      violation_count;
  end if;

  -- Exact coordinates are never granted to authenticated clients.
  select count(*)
    into violation_count
    from information_schema.column_privileges
   where table_schema = 'attendance'
     and table_name = 'punches'
     and grantee = 'authenticated'
     and column_name in ('geo_lat', 'geo_lng');

  if violation_count > 0 then
    raise exception 'authenticated can read exact punch coordinates';
  end if;

  -- The notification outbox holds recipient addresses and delivery plumbing.
  -- Employees, managers and HR have no business reading it at all, so it is not
  -- granted even SELECT: the dispatcher reaches it with the service role.
  select count(*)
    into violation_count
    from information_schema.role_table_grants
   where table_schema = 'attendance'
     and table_name = 'notification_outbox'
     and grantee = 'authenticated';

  if violation_count > 0 then
    raise exception
      'authenticated holds % privilege(s) on the notification outbox',
      violation_count;
  end if;

  -- RLS is a defense-in-depth boundary even though Attendance is not exposed by
  -- PostgREST.
  select count(*)
    into violation_count
    from pg_catalog.pg_tables
   where schemaname = 'attendance'
     and not rowsecurity;

  if violation_count > 0 then
    raise exception '% attendance table(s) do not have RLS enabled', violation_count;
  end if;

  -- Detect genuinely wide-open public policies without treating INSERT
  -- policies as open merely because pg_policies.qual is null for that command.
  select count(*)
    into violation_count
    from pg_catalog.pg_policies
   where schemaname = 'public'
     and permissive = 'PERMISSIVE'
     and policyname <> 'departments_read'
     and (
          (cmd = 'SELECT' and qual = 'true')
       or (cmd = 'INSERT' and with_check = 'true')
       or (cmd = 'UPDATE' and qual = 'true' and with_check = 'true')
       or (cmd = 'DELETE' and qual = 'true')
       or (cmd = 'ALL' and qual = 'true' and with_check = 'true')
     );

  if violation_count > 0 then
    raise exception '% wide-open permissive public policy/policies', violation_count;
  end if;

  raise notice 'All local security invariants hold.';
end
$invariants$;
