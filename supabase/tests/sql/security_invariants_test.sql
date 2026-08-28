-- Security invariants for the disposable local database.
-- Plain SQL with no client-specific meta-commands: any client can run it.

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

  -- Writes elevate; reads do not. The published surface is small enough to name
  -- in full, so the invariant is enforced rather than remembered: adding a
  -- SECURITY DEFINER read function fails here until somebody writes down why.
  --
  -- `list_accounts` is deliberately absent from both lists. It is the one read
  -- that elevates, because the answer lives in `auth.users` and
  -- `public.user_roles`, which no ordinary caller can reach -- and rule 9 asks
  -- for that reason in writing, which its migration gives.
  select count(*)
    into violation_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (
          (p.proname in ('my_profile', 'server_time', 'my_day', 'my_history',
                         'my_summary', 'my_sessions',
                         'team_day', 'open_alerts', 'employee_day',
                         'employee_sessions', 'employee_summary',
                         'list_departments', 'list_schedules', 'list_alert_rules',
                         'list_employees',
                         -- The four reads added since this list was written. It
                         -- is only an invariant while it is complete: a read
                         -- that elevates and is not named here would pass.
                         'attendance_report', 'employee_dossier',
                         'employee_session_events', 'attendance_settings')
           and p.prosecdef)
       or (p.proname in ('punch', 'sync_punches', 'heartbeat',
                         'review_punch', 'decide_alert',
                         'open_session', 'touch_session', 'close_session',
                         'save_schedule', 'retire_schedule', 'save_alert_rule',
                         'link_employee_account', 'set_account_role',
                         'unlink_employee_account', 'record_password_reset',
                         'reset_day', 'save_employee',
                         'retire_employee', 'restore_employee',
                         'report_session_event', 'save_settings')
           and not p.prosecdef)
     );

  if violation_count > 0 then
    raise exception
      '% published function(s) carry the wrong security mode', violation_count;
  end if;

  raise notice 'All local security invariants hold.';
end
$invariants$;
