-- Verification of the access log and the employee's own summary, run as the
-- role that will actually call them.
--
-- Like `read_api_test.sql`, this suite switches role around each call:
--
--   set role authenticated + request.jwt.claims -> call -> set role postgres
--
-- and asserts afterwards. The switch is deliberately narrow: only the call
-- under test runs as the client, so a fixture failing to insert can never be
-- mistaken for a policy working.
--
-- Two things here cannot be tested by calling the public API alone, and both
-- are set up by writing to the tables directly as `postgres`:
--
--   * The idle window. `now()` cannot be moved, so `last_seen_at` is backdated
--     instead. That is the same thing from the function's point of view -- it
--     compares the two -- and it is the only way to reach the branch that
--     matters most, because it is the branch that decides what hour somebody's
--     session is recorded as ending at.
--
--   * A workday that has been running for hours. `attendance.punches` is
--     append-only, so a punch cannot be taken and then backdated; it is
--     inserted at the hour it needs. INSERT is what the trigger allows, and
--     the whole point of the check is that `my_day()` reports the interval
--     that is still open rather than the zero the engine has accumulated.
--
-- How to run it:
--
--   npm run db:test
--
-- Run only against the disposable local database assembled by
-- scripts/local-supabase.mjs. Everything happens inside a transaction that ends
-- in ROLLBACK.

begin;

create temporary table test_results (
  n        serial,
  name     text,
  expected text,
  got      text,
  passed   boolean
) on commit drop;

do $test$
declare
  v_emp1 uuid; v_emp2 uuid;
  v_uid1 uuid; v_uid2 uuid := gen_random_uuid();

  v_zone      text;
  v_today     date;
  v_result    jsonb;
  v_other     jsonb;
  v_session   uuid;
  v_second    uuid;
  v_count     integer;
  v_closed    integer;
  v_text      text;
  v_ok        boolean;
  v_workday   uuid;
  v_row       attendance.app_sessions;
begin
  select id into v_uid1 from auth.users order by created_at, id limit 1;
  select id into v_emp1 from public.empleados where estado = 'activo' order by nombre limit 1;
  select id into v_emp2 from public.empleados
   where estado = 'activo' and id <> v_emp1 order by nombre limit 1;

  if v_uid1 is null or v_emp2 is null then
    raise exception 'Missing baseline data: need at least 1 account and 2 active employees';
  end if;

  insert into auth.users (id, email, raw_user_meta_data)
  values (v_uid2, 'local.second@example.invalid', '{}'::jsonb);

  update public.empleados set auth_user_id = v_uid1 where id = v_emp1;
  update public.empleados set auth_user_id = v_uid2 where id = v_emp2;

  insert into public.user_roles (auth_user_id, role, note) values
    (v_uid1, 'employee', 'Synthetic session subject'),
    (v_uid2, 'employee', 'Synthetic second employee')
  on conflict (auth_user_id) do update set role = excluded.role;

  v_zone  := internal.time_zone_of(v_emp1);
  v_today := (now() at time zone v_zone)::date;

  -- An employee schedule covering all seven days, so nothing below depends on
  -- which day of the week the suite happens to run. Eight working hours: nine
  -- hours between the expected times, less the hour of break it allows.
  insert into attendance.schedules (
    scope, employee_id, name, days,
    entry_from, entry_until, entry_expected, exit_expected,
    grace_minutes, break_max_minutes, valid_from
  ) values (
    'employee', v_emp1, 'Synthetic all-week schedule', '{1,2,3,4,5,6,7}'::smallint[],
    '07:00', '10:00', '09:00', '18:00', 10, 60, v_today - 60
  );

  -- ================================================ PHASE A: opening a session ==

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.open_session('device-a', 'Windows', 'America/Mexico_City', 'es-MX', '0.1.0');
  perform set_config('role', 'postgres', true);

  v_session := (v_result ->> 'session_id')::uuid;

  insert into test_results(name, expected, got, passed) values
    ('open_session answers with a session', 'a uuid',
     coalesce(v_session::text, 'null'), v_session is not null);

  insert into test_results(name, expected, got, passed) values
    ('the first call is not a resumption', 'false',
     coalesce(v_result ->> 'resumed', 'null'), (v_result ->> 'resumed') = 'false');

  select * into v_row from attendance.app_sessions where id = v_session;

  insert into test_results(name, expected, got, passed) values
    ('the employee is derived from the token', v_emp1::text,
     coalesce(v_row.employee_id::text, 'null'), v_row.employee_id = v_emp1);

  insert into test_results(name, expected, got, passed) values
    ('what the device reported about itself is stored', 'Windows',
     coalesce(v_row.platform, 'null'), v_row.platform = 'Windows');

  insert into test_results(name, expected, got, passed) values
    ('a new session is open', 'open',
     case when v_row.ended_at is null then 'open' else 'closed' end,
     v_row.ended_at is null and v_row.end_reason is null);

  -- The device is registered too, so a machine that opens the application every
  -- morning without ever punching is still revocable.
  select count(*) into v_count
    from attendance.devices d where d.employee_id = v_emp1 and d.device_id = 'device-a';

  insert into test_results(name, expected, got, passed) values
    ('opening a session registers the device', '1', v_count::text, v_count = 1);

  -- ------------------------------------------------- a reload is not a session --
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.open_session('device-a', 'Windows', 'America/Mexico_City', 'es-MX', '0.1.0');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('opening again on the same device resumes it', v_session::text,
     coalesce(v_result ->> 'session_id', 'null'),
     (v_result ->> 'session_id')::uuid = v_session);

  select count(*) into v_count
    from attendance.app_sessions where auth_user_id = v_uid1 and device_id = 'device-a';

  insert into test_results(name, expected, got, passed) values
    ('resuming does not add a second row', '1', v_count::text, v_count = 1);

  -- --------------------------------------------- a second device is its own row --
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_other := public.open_session('device-b');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a different device opens its own session', 'different',
     case when (v_other ->> 'session_id')::uuid = v_session then 'same' else 'different' end,
     (v_other ->> 'session_id')::uuid <> v_session);

  -- ------------------------------------------------------ a device id is required --
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  begin
    perform public.open_session('   ');
    v_ok := false; v_text := 'it accepted blank';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a blank device id is refused', 'Falta el identificador...',
     v_text, v_ok and v_text like 'Falta el identificador%');

  -- ==================================================== PHASE B: keeping alive ==

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.touch_session(v_session);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('touching an open session reports it active', 'true',
     coalesce(v_result ->> 'active', 'null'), (v_result ->> 'active') = 'true');

  -- Somebody else's session id, guessed or stolen, must move nothing. This is
  -- the whole security of a SECURITY DEFINER writer that takes an id from the
  -- client.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  v_result := public.touch_session(v_session);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('another account cannot touch this session', 'false',
     coalesce(v_result ->> 'active', 'null'), (v_result ->> 'active') = 'false');

  -- ======================================================= PHASE C: closing it ==

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  v_result := public.close_session(v_session, 'sign_out');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('another account cannot close this session', 'false',
     coalesce(v_result ->> 'closed', 'null'), (v_result ->> 'closed') = 'false');

  select * into v_row from attendance.app_sessions where id = v_session;

  insert into test_results(name, expected, got, passed) values
    ('and the session is still open after that attempt', 'open',
     case when v_row.ended_at is null then 'open' else 'closed' end, v_row.ended_at is null);

  -- A client may not claim `expired`: that word means nobody was heard from
  -- again, which a client reporting in contradicts.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.close_session(v_session, 'expired');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a client cannot claim the sweeper''s reason', 'sign_out',
     coalesce(v_result ->> 'end_reason', 'null'), (v_result ->> 'end_reason') = 'sign_out');

  -- Closing twice keeps the first close, so a `pagehide` firing after an
  -- explicit sign-out does not blur the reason.
  v_text := (select s.ended_at::text from attendance.app_sessions s where s.id = v_session);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.close_session(v_session, 'app_closed');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('closing twice keeps the first hour and reason', v_text,
     coalesce(v_result ->> 'ended_at', 'null'),
     (v_result ->> 'end_reason') = 'sign_out'
     and (v_result ->> 'ended_at')::timestamptz = v_text::timestamptz);

  -- A closed session is no longer active, which is what tells the client to
  -- open a new one instead of reporting into a row that is finished.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.touch_session(v_session);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('touching a closed session reports it inactive', 'false',
     coalesce(v_result ->> 'active', 'null'), (v_result ->> 'active') = 'false');

  -- ================================================== PHASE D: resuming a close ==
  -- A window closed and reopened two seconds later was never really shut. The
  -- row above was closed as `sign_out`, so it must NOT be resumed -- only
  -- `app_closed` is.

  update attendance.app_sessions
     set ended_at = now() - interval '10 seconds', end_reason = 'app_closed'
   where id = v_session;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.open_session('device-a');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a window closed moments ago is the same session', v_session::text,
     coalesce(v_result ->> 'session_id', 'null'),
     (v_result ->> 'session_id')::uuid = v_session);

  select * into v_row from attendance.app_sessions where id = v_session;

  insert into test_results(name, expected, got, passed) values
    ('resuming reopens it rather than leaving it closed', 'open',
     case when v_row.ended_at is null then 'open' else 'closed' end,
     v_row.ended_at is null and v_row.end_reason is null);

  -- A sign-out is a decision, not an accident. Reopening it would erase the
  -- record of somebody deliberately leaving.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  perform public.close_session(v_session, 'sign_out');
  v_result := public.open_session('device-a');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a sign-out is not resumed: a new session starts', 'different',
     case when (v_result ->> 'session_id')::uuid = v_session then 'same' else 'different' end,
     (v_result ->> 'session_id')::uuid <> v_session);

  v_second := (v_result ->> 'session_id')::uuid;

  -- ================================================== PHASE E: the idle window ==
  -- Backdated rather than waited for. From the function's point of view this is
  -- the same thing: it compares last_seen_at against now().

  update attendance.app_sessions
     set started_at   = now() - interval '9 hours',
         last_seen_at = now() - interval '8 hours'
   where id = v_second;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.open_session('device-a');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a machine that went quiet for hours starts a new session', 'different',
     case when (v_result ->> 'session_id')::uuid = v_second then 'same' else 'different' end,
     (v_result ->> 'session_id')::uuid <> v_second);

  select * into v_row from attendance.app_sessions where id = v_second;

  -- The hour that goes on the record is the last hour anybody knows about.
  -- Stamping now() would credit the person with every hour nobody was there.
  insert into test_results(name, expected, got, passed) values
    ('the quiet session is closed at its last report', 'expired at last_seen_at',
     coalesce(v_row.end_reason, 'null') || ' at ' ||
       case when v_row.ended_at = v_row.last_seen_at then 'last_seen_at' else 'now()' end,
     v_row.end_reason = 'expired' and v_row.ended_at = v_row.last_seen_at);

  -- ==================================================== PHASE F: the sweeper ====

  update attendance.app_sessions
     set started_at   = now() - interval '2 days',
         last_seen_at = now() - interval '2 days',
         ended_at     = null,
         end_reason   = null
   where id = v_session;

  v_closed := attendance.expire_stale_sessions(120);

  select * into v_row from attendance.app_sessions where id = v_session;

  insert into test_results(name, expected, got, passed) values
    ('the sweeper closes what stopped reporting', 'expired at last_seen_at',
     coalesce(v_row.end_reason, 'still open') || ' at ' ||
       case when v_row.ended_at = v_row.last_seen_at then 'last_seen_at' else 'now()' end,
     v_closed >= 1 and v_row.end_reason = 'expired' and v_row.ended_at = v_row.last_seen_at);

  -- A window shorter than the client's reporting interval would close sessions
  -- that are alive, which is worse than closing them late.
  begin
    perform attendance.expire_stale_sessions(5);
    v_ok := false; v_text := 'it accepted 5 minutes';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;

  insert into test_results(name, expected, got, passed) values
    ('an idle window under 15 minutes is refused', 'La ventana de inactividad...',
     v_text, v_ok and v_text like 'La ventana de inactividad%');

  -- ================================================== PHASE G: reading the log ==

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  select count(*) into v_count from public.my_sessions(50);
  perform set_config('role', 'postgres', true);

  select count(*) into v_closed from attendance.app_sessions where auth_user_id = v_uid1;

  insert into test_results(name, expected, got, passed) values
    ('my_sessions returns the caller''s own accesses', v_closed::text,
     v_count::text, v_count = v_closed and v_count > 0);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.my_sessions(50);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('and nobody else''s', '0', v_count::text, v_count = 0);

  -- An employee may not read another employee's log. The scope comes from the
  -- policy, not from a role check written into the function.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.employee_sessions(v_emp1);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot read a colleague''s accesses', '0', v_count::text, v_count = 0);

  -- ================================================ PHASE H: the live counters ==
  -- A workday that has been open for two hours with nothing to close the
  -- interval. `worked_seconds` is zero and correct; `worked_seconds_live` is
  -- what the screen shows.

  insert into attendance.workdays (employee_id, work_date, time_zone, state, opened_at)
  values (v_emp1, v_today, v_zone, 'working', now() - interval '2 hours')
  on conflict (employee_id, work_date) do update
    set state = 'working', opened_at = excluded.opened_at
  returning id into v_workday;

  insert into attendance.punches (
    workday_id, employee_id, kind, occurred_at, source, idempotency_key
  ) values (
    v_workday, v_emp1, 'clock_in', now() - interval '2 hours', 'online', gen_random_uuid()
  );

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.my_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the settled counter is still zero, as the engine left it', '0',
     coalesce(v_result ->> 'worked_seconds', 'null'),
     (v_result ->> 'worked_seconds')::integer = 0);

  insert into test_results(name, expected, got, passed) values
    ('the running counter includes the open interval', '~7200',
     coalesce(v_result ->> 'worked_seconds_live', 'null'),
     (v_result ->> 'worked_seconds_live')::integer between 7150 and 7250);

  insert into test_results(name, expected, got, passed) values
    ('the database says which counter is running', 'worked',
     coalesce(v_result ->> 'counting', 'null'), (v_result ->> 'counting') = 'worked');

  insert into test_results(name, expected, got, passed) values
    ('and since when', 'the last punch',
     coalesce(v_result ->> 'counting_since', 'null'),
     (v_result ->> 'counting_since') is not null);

  insert into test_results(name, expected, got, passed) values
    ('the day carries what the schedule asks for', '28800',
     coalesce(v_result ->> 'expected_seconds', 'null'),
     (v_result ->> 'expected_seconds')::integer = 28800);

  -- A break must not accumulate as worked time. The engine decides that, and
  -- `counting` is how it says so.
  insert into attendance.punches (
    workday_id, employee_id, kind, occurred_at, source, idempotency_key
  ) values (
    v_workday, v_emp1, 'break_start', now() - interval '30 minutes', 'online', gen_random_uuid()
  );
  update attendance.workdays set state = 'on_break', worked_seconds = 5400 where id = v_workday;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.my_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a break runs the break counter, not the worked one', 'break/5400',
     coalesce(v_result ->> 'counting', 'null') || '/' ||
       coalesce(v_result ->> 'worked_seconds_live', 'null'),
     (v_result ->> 'counting') = 'break'
     and (v_result ->> 'worked_seconds_live')::integer = 5400
     and (v_result ->> 'break_seconds_live')::integer between 1750 and 1850);

  -- Nothing runs on a day that is over.
  update attendance.workdays
     set state = 'finished', closed_at = now(), break_seconds = 1800
   where id = v_workday;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.my_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a finished day counts nothing', 'null/5400',
     coalesce(v_result ->> 'counting', 'null') || '/' ||
       coalesce(v_result ->> 'worked_seconds_live', 'null'),
     (v_result ->> 'counting') is null
     and (v_result ->> 'worked_seconds_live')::integer = 5400);

  -- ==================================================== PHASE I: the summary ====
  -- Three finished days behind today, one of them late, and one scheduled day
  -- before those with nobody on it.

  insert into attendance.workdays (
    employee_id, work_date, time_zone, state,
    opened_at, closed_at, worked_seconds, break_seconds
  )
  select v_emp1, v_today - offset_days, v_zone, 'finished',
         (v_today - offset_days + entry)::timestamp at time zone v_zone,
         (v_today - offset_days + time '18:00')::timestamp at time zone v_zone,
         8 * 3600, 3600
    from (values (1, time '09:00'), (2, time '09:10'), (3, time '09:20'))
           as day_of(offset_days, entry);

  -- The evaluator raised this, and it is the only thing that decides lateness.
  -- The summary counts it; it does not re-derive it.
  insert into attendance.alerts (employee_id, alert_date, kind, severity)
  values (v_emp1, v_today - 2, 'late_entry', 'medium');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.my_summary(30);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the summary covers the range it was asked for', '30',
     coalesce(v_result ->> 'days', 'null'), (v_result ->> 'days')::integer = 30);

  insert into test_results(name, expected, got, passed) values
    ('every scheduled day carries an expectation', '30',
     coalesce(v_result ->> 'days_scheduled', 'null'),
     (v_result ->> 'days_scheduled')::integer = 30);

  insert into test_results(name, expected, got, passed) values
    ('the days with an entry are counted', '4',
     coalesce(v_result ->> 'days_worked', 'null'), (v_result ->> 'days_worked')::integer = 4);

  insert into test_results(name, expected, got, passed) values
    ('lateness comes from the alert, not from the hour', '1',
     coalesce(v_result ->> 'late_days', 'null'), (v_result ->> 'late_days')::integer = 1);

  insert into test_results(name, expected, got, passed) values
    ('punctuality is on-time days over days with an entry', '75',
     coalesce(v_result ->> 'punctuality_pct', 'null'),
     (v_result ->> 'punctuality_pct')::integer = 75);

  insert into test_results(name, expected, got, passed) values
    ('the streak counts back to the first day that was not finished', '3',
     coalesce(v_result ->> 'streak_days', 'null'), (v_result ->> 'streak_days')::integer = 3);

  insert into test_results(name, expected, got, passed) values
    ('the average entry is the mean of the hours arrived at', '09:10',
     coalesce(v_result ->> 'average_entry', 'null'), (v_result ->> 'average_entry') = '09:10');

  insert into test_results(name, expected, got, passed) values
    ('the series has one entry per day of the range', '30',
     jsonb_array_length(v_result -> 'series')::text,
     jsonb_array_length(v_result -> 'series') = 30);

  -- HR deciding an alert was not worth anything has to stop it counting
  -- against the person, or the decision means nothing.
  update attendance.alerts
     set state = 'dismissed'
   where employee_id = v_emp1 and alert_date = v_today - 2 and kind = 'late_entry';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.my_summary(30);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a dismissed alert stops counting as a late day', '0',
     coalesce(v_result ->> 'late_days', 'null'), (v_result ->> 'late_days')::integer = 0);

  -- An account with no employee behind it has no attendance to summarise, and
  -- saying so beats answering with zeros that look like a perfect record.
  update public.empleados set auth_user_id = null where id = v_emp2;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  begin
    v_result := public.my_summary(30);
    v_ok := false; v_text := 'it answered';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an account with no employee record is refused', 'Esta cuenta no esta ligada...',
     v_text, v_ok and v_text like 'Esta cuenta%');

  -- ============================================================== restore ===
  update public.empleados set auth_user_id = null where id in (v_emp1, v_emp2);
end
$test$;

-- Readable report.
select n,
       name     as check_name,
       expected,
       got,
       case when passed then 'PASS' else '*** FAIL ***' end as verdict
  from test_results
 order by n;

-- If anything failed, blow up with a non-zero exit code so CI notices.
do $verdict$
declare
  v_failed int;
  v_total  int;
begin
  select count(*) filter (where passed is not true), count(*) into v_failed, v_total
    from test_results;

  if v_failed > 0 then
    raise exception '% of % checks failed', v_failed, v_total;
  end if;

  raise notice 'All % checks passed.', v_total;
end
$verdict$;

-- None of this sticks: not the sessions, not the workdays, not the punches, not
-- the schedule, not the alert, not the account links used to hold a real
-- session.
rollback;
