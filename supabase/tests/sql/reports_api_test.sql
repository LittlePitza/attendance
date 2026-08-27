-- Verification of the reports API: the period, the roll-up and the one judgement.
--
-- Same approach as workforce_api_test.sql: the call under test runs as
-- `authenticated` with a JWT claim, because what scopes a report is RLS rather
-- than anything written inside it, and a suite that ran entirely as `postgres`
-- would pass no matter how the scoping went. The switch stays narrow -- only the
-- call under test runs as the client -- so a fixture failing to insert can never
-- be mistaken for a policy working.
--
-- The punches are made through `internal.record_punch()` with chosen hours
-- rather than through `public.punch()`, which always stamps `now()`. A report is
-- about days that have already happened, and a suite that could not choose them
-- could only ever assert about today.
--
-- The cast, built so that every compliance verdict has exactly one owner:
--
--   met_person     <- punched two past days, in full, with no alert.
--   partial_person <- punched the same two days, and carries a `late_entry`.
--   missed_person  <- scheduled those days and never punched at all.
--   pending_person <- scheduled only from tomorrow, so nothing is yet knowable.
--
-- The caller is an 'hr' account with no `empleados` row -- the administrative
-- account the roles table already allows for. That keeps the population exactly
-- the four people above, so the totals can be asserted as absolute numbers
-- instead of as offsets from whatever the seed happens to contain.
--
-- Two pieces of the fixture exist because of how scheduling actually resolves,
-- and both were found by the assertions failing:
--
--   * Each schedule is bounded to the days it is meant to cover. Left open, a
--     month report finds every unpunched day inside it and is right to call
--     them absences -- which is correct behaviour and a useless fixture.
--   * `internal.resolve_schedule()` falls back to the global schedule, so
--     nobody is ever unscheduled while the seeded global row applies. The
--     `not_scheduled` verdict is therefore asserted on a past day the global
--     row does not reach rather than on the month.
--
-- The three claims this file exists to make, above the rest:
--
--   1. **The report and the box agree.** `internal.resolved_days()` is the one
--      definition both build on, and the whole point of the refactor that
--      introduced it was that a report re-deriving these figures would disagree
--      with `employee_summary()` invisibly. So the two are compared directly.
--   2. **A week starts on Monday and a month on the 1st**, whatever day inside
--      it the report is anchored at. "This week" has a wrong answer available
--      and the browser is where it would be given.
--   3. **`met` is never awarded on no evidence.** A period whose scheduled days
--      are all still to come is `pending`, because certifying a week nobody has
--      worked yet is the failure mode a compliance figure actually has.
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
  v_met     uuid := '30000000-0000-4000-8000-0000000000c1';
  v_partial uuid := '30000000-0000-4000-8000-0000000000c2';
  v_missed  uuid := '30000000-0000-4000-8000-0000000000c3';
  v_pending uuid := '30000000-0000-4000-8000-0000000000c4';

  v_uid_hr  uuid := gen_random_uuid();
  v_uid_emp uuid := gen_random_uuid();

  v_dept    uuid;
  v_zone    text;
  v_today   date;
  v_d1      date;
  v_d2      date;

  v_report  jsonb;
  v_summary jsonb;
  v_person  jsonb;
  v_count   integer;
  v_text    text;
  v_ok      boolean;
  v_monday  date;
begin
  select id into v_dept from public.departments order by name limit 1;

  if v_dept is null then
    raise exception 'Missing baseline data: need at least 1 department';
  end if;

  v_zone := 'America/Mexico_City';

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_uid_hr,  'reports.hr@example.invalid',       '{}'::jsonb),
    (v_uid_emp, 'reports.employee@example.invalid', '{}'::jsonb);

  insert into public.empleados
    (id, nombre, correo, puesto, estado, department_id, auth_user_id)
  values
    (v_met,     'Ana Cumplida',    'reports.met@example.invalid',
     'Analista', 'activo', v_dept, null),
    (v_partial, 'Beto Retrasado',  'reports.partial@example.invalid',
     'Analista', 'activo', v_dept, v_uid_emp),
    (v_missed,  'Carla Ausente',   'reports.missed@example.invalid',
     'Analista', 'activo', v_dept, null),
    (v_pending, 'Dora Pendiente',  'reports.pending@example.invalid',
     'Analista', 'activo', v_dept, null);

  -- The seed's own people are given de baja for the duration. They have no day
  -- inside the window, so the population becomes exactly the four above and the
  -- totals can be asserted as absolute numbers. Nothing sticks: the transaction
  -- ends in ROLLBACK.
  update public.empleados set estado = 'baja'
   where id not in (v_met, v_partial, v_missed, v_pending);

  insert into public.user_roles (auth_user_id, role, note) values
    (v_uid_hr,  'hr',       'Synthetic HR for the reports suite'),
    (v_uid_emp, 'employee', 'Synthetic employee for the reports suite')
  on conflict (auth_user_id) do update set role = excluded.role;

  v_today := (now() at time zone v_zone)::date;

  -- Two past days that are not today, and are far enough back that a month
  -- report anchored at today contains them. Every day of the week is scheduled
  -- so the assertions hold whichever day the suite runs on -- the seeded global
  -- schedule is Monday to Friday and starts today, so it would resolve to
  -- nothing useful for any of this.
  v_d1 := v_today - 2;
  v_d2 := v_today - 1;

  insert into attendance.schedules
    (scope, employee_id, name, days, entry_from, entry_until,
     entry_expected, exit_expected, break_max_minutes, valid_from, valid_until)
  -- Bounded to exactly the two days they are about. An open-ended schedule
  -- would make every other unpunched day of the month an absence, which is the
  -- right answer to a different question.
  values
    ('employee', v_met,     'Reportes: cumple',   '{1,2,3,4,5,6,7}'::smallint[],
     '07:00', '10:00', '09:00', '18:00', 60, v_d1, v_d2),
    ('employee', v_partial, 'Reportes: parcial',  '{1,2,3,4,5,6,7}'::smallint[],
     '07:00', '10:00', '09:00', '18:00', 60, v_d1, v_d2),
    ('employee', v_missed,  'Reportes: ausente',  '{1,2,3,4,5,6,7}'::smallint[],
     '07:00', '10:00', '09:00', '18:00', 60, v_d1, v_d2),
    -- Scheduled only from tomorrow: the period contains an expectation, and
    -- none of it has happened yet.
    ('employee', v_pending, 'Reportes: pendiente','{1,2,3,4,5,6,7}'::smallint[],
     '07:00', '10:00', '09:00', '18:00', 60, v_today + 1, v_today + 5);

  -- A full day for each of the two who punched: 09:00 in, 13:00 break, 14:00
  -- back, 18:00 out. Eight hours worked, one hour of break.
  foreach v_text in array array[v_met::text, v_partial::text]
  loop
    perform internal.record_punch(v_text::uuid, 'clock_in',
      (v_d1 + time '09:00') at time zone v_zone, 'online', gen_random_uuid());
    perform internal.record_punch(v_text::uuid, 'break_start',
      (v_d1 + time '13:00') at time zone v_zone, 'online', gen_random_uuid());
    perform internal.record_punch(v_text::uuid, 'break_end',
      (v_d1 + time '14:00') at time zone v_zone, 'online', gen_random_uuid());
    perform internal.record_punch(v_text::uuid, 'clock_out',
      (v_d1 + time '18:00') at time zone v_zone, 'online', gen_random_uuid());

    perform internal.record_punch(v_text::uuid, 'clock_in',
      (v_d2 + time '09:00') at time zone v_zone, 'online', gen_random_uuid());
    perform internal.record_punch(v_text::uuid, 'break_start',
      (v_d2 + time '13:00') at time zone v_zone, 'online', gen_random_uuid());
    perform internal.record_punch(v_text::uuid, 'break_end',
      (v_d2 + time '14:00') at time zone v_zone, 'online', gen_random_uuid());
    perform internal.record_punch(v_text::uuid, 'clock_out',
      (v_d2 + time '18:00') at time zone v_zone, 'online', gen_random_uuid());
  end loop;

  -- The one thing that separates the two: an alert the evaluator raised. The
  -- report counts it and never re-derives it from the hour, which is why the
  -- punches above are identical.
  insert into attendance.alerts (employee_id, alert_date, kind, severity, state)
  values (v_partial, v_d2, 'late_entry', 'medium', 'open');

  -- ====================================================== PHASE A: the period ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_report := public.attendance_report('week', v_today);
  perform set_config('role', 'postgres', true);

  v_monday := date_trunc('week', v_today)::date;

  insert into test_results(name, expected, got, passed) values
    ('a week starts on the Monday of the anchor', v_monday::text,
     coalesce(v_report ->> 'from', 'null'),
     (v_report ->> 'from')::date = v_monday);

  insert into test_results(name, expected, got, passed) values
    ('a week is seven days long', '7',
     coalesce(v_report ->> 'days', 'null'), (v_report ->> 'days')::integer = 7);

  -- Anchored at every day of the same week, the bounds must not move. This is
  -- the assertion that would fail if the period were ever resolved in the
  -- browser's zone or with a Sunday-start week.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select count(distinct r.value)::integer into v_count
    from generate_series(v_monday, v_monday + 6, interval '1 day') as d
    cross join lateral (
      select public.attendance_report('week', d::date) ->> 'from' as value
    ) r;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('every day of a week reports the same Monday', '1', v_count::text, v_count = 1);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_report := public.attendance_report('month', v_today);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a month starts on the first', date_trunc('month', v_today)::date::text,
     coalesce(v_report ->> 'from', 'null'),
     (v_report ->> 'from')::date = date_trunc('month', v_today)::date);

  insert into test_results(name, expected, got, passed) values
    ('a month ends on its own last day',
     (date_trunc('month', v_today) + interval '1 month' - interval '1 day')::date::text,
     coalesce(v_report ->> 'to', 'null'),
     (v_report ->> 'to')::date
       = (date_trunc('month', v_today) + interval '1 month' - interval '1 day')::date);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_report := public.attendance_report('day', v_d1);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a day is one day, opening and closing on itself', format('%s/%s', v_d1, v_d1),
     format('%s/%s', v_report ->> 'from', v_report ->> 'to'),
     (v_report ->> 'from')::date = v_d1 and (v_report ->> 'to')::date = v_d1);

  insert into test_results(name, expected, got, passed) values
    ('a period that has finished says so', 'true',
     coalesce(v_report ->> 'closed', 'null'), (v_report ->> 'closed')::boolean);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  begin
    perform public.attendance_report('quarter', v_today);
    v_ok := false; v_text := 'it answered';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a period nobody defined is refused, not guessed at', 'refused', v_text, v_ok);

  -- ================================================== PHASE B: the one judgement ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_report := public.attendance_report('month', v_today);
  perform set_config('role', 'postgres', true);

  select p.value into v_person
    from jsonb_array_elements(v_report -> 'people') as p
   where (p.value ->> 'employee_id')::uuid = v_met;

  insert into test_results(name, expected, got, passed) values
    ('somebody who was there, in full, on time, met the period', 'met',
     coalesce(v_person ->> 'compliance', 'null'),
     (v_person ->> 'compliance') = 'met');

  insert into test_results(name, expected, got, passed) values
    ('meeting the period leaves no reason behind', '0',
     jsonb_array_length(v_person -> 'reasons')::text,
     jsonb_array_length(v_person -> 'reasons') = 0);

  insert into test_results(name, expected, got, passed) values
    ('two full days are sixteen worked hours', '57600',
     coalesce(v_person ->> 'worked_seconds', 'null'),
     (v_person ->> 'worked_seconds')::integer = 57600);

  select p.value into v_person
    from jsonb_array_elements(v_report -> 'people') as p
   where (p.value ->> 'employee_id')::uuid = v_partial;

  insert into test_results(name, expected, got, passed) values
    ('an alert, not an hour, is what makes a period partial', 'partial',
     coalesce(v_person ->> 'compliance', 'null'),
     (v_person ->> 'compliance') = 'partial');

  insert into test_results(name, expected, got, passed) values
    ('the reason given is the late arrival', 'late',
     coalesce((v_person -> 'reasons' -> 0) ->> 'code', 'null'),
     ((v_person -> 'reasons' -> 0) ->> 'code') = 'late');

  -- The two punched identically. If the report ever re-derived lateness from
  -- the hour instead of counting the alert, these would stop differing.
  insert into test_results(name, expected, got, passed) values
    ('the late person worked exactly as long as the punctual one', '57600',
     coalesce(v_person ->> 'worked_seconds', 'null'),
     (v_person ->> 'worked_seconds')::integer = 57600);

  select p.value into v_person
    from jsonb_array_elements(v_report -> 'people') as p
   where (p.value ->> 'employee_id')::uuid = v_missed;

  insert into test_results(name, expected, got, passed) values
    ('somebody scheduled who never appeared missed the period', 'missed',
     coalesce(v_person ->> 'compliance', 'null'),
     (v_person ->> 'compliance') = 'missed');

  insert into test_results(name, expected, got, passed) values
    ('the reason given is the absence', 'absent',
     coalesce((v_person -> 'reasons' -> 0) ->> 'code', 'null'),
     ((v_person -> 'reasons' -> 0) ->> 'code') = 'absent');

  select p.value into v_person
    from jsonb_array_elements(v_report -> 'people') as p
   where (p.value ->> 'employee_id')::uuid = v_pending;

  insert into test_results(name, expected, got, passed) values
    ('a period whose days are all still to come is pending, never met', 'pending',
     coalesce(v_person ->> 'compliance', 'null'),
     (v_person ->> 'compliance') = 'pending');

  insert into test_results(name, expected, got, passed) values
    ('nothing elapsed means nothing owed', '0',
     coalesce(v_person ->> 'deficit_seconds', 'null'),
     (v_person ->> 'deficit_seconds')::integer = 0);

  -- `not_scheduled` needs a day the global fallback does not reach, because
  -- while it does nobody is ever unscheduled. The seeded global row starts
  -- today, so a past day answers it: the pending person's own schedule begins
  -- tomorrow and nothing else covers them on v_d1.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select p.value into v_person
    from jsonb_array_elements(public.attendance_report('day', v_d1) -> 'people') as p
   where (p.value ->> 'employee_id')::uuid = v_pending;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a day no schedule covers is not judged at all', 'not_scheduled',
     coalesce(v_person ->> 'compliance', 'null'),
     (v_person ->> 'compliance') = 'not_scheduled');

  -- ===================================================== PHASE C: the roll-up ===

  insert into test_results(name, expected, got, passed) values
    ('the people who registered an entry are the Home Office count', '2',
     coalesce(v_report -> 'totals' ->> 'people_home_office', 'null'),
     (v_report -> 'totals' ->> 'people_home_office')::integer = 2);

  insert into test_results(name, expected, got, passed) values
    ('one alert in the period is one alert in the total', '1',
     coalesce(v_report -> 'totals' ->> 'alerts_total', 'null'),
     (v_report -> 'totals' ->> 'alerts_total')::integer = 1);

  insert into test_results(name, expected, got, passed) values
    ('the alert is broken out by the kind it is', 'late_entry',
     coalesce((v_report -> 'alerts_by_kind' -> 0) ->> 'kind', 'null'),
     ((v_report -> 'alerts_by_kind' -> 0) ->> 'kind') = 'late_entry');

  insert into test_results(name, expected, got, passed) values
    ('the four verdicts each found their owner', '1/1/1/1',
     format('%s/%s/%s/%s',
       v_report -> 'totals' ->> 'people_met',
       v_report -> 'totals' ->> 'people_partial',
       v_report -> 'totals' ->> 'people_missed',
       v_report -> 'totals' ->> 'people_pending'),
     (v_report -> 'totals' ->> 'people_met')::integer     = 1 and
     (v_report -> 'totals' ->> 'people_partial')::integer = 1 and
     (v_report -> 'totals' ->> 'people_missed')::integer  = 1 and
     (v_report -> 'totals' ->> 'people_pending')::integer = 1);

  -- Who stood out, in both directions.
  insert into test_results(name, expected, got, passed) values
    ('the person with no late day and no absence stands out for punctuality',
     v_met::text,
     coalesce((v_report -> 'standouts' -> 'punctual' -> 0) ->> 'employee_id', 'null'),
     ((v_report -> 'standouts' -> 'punctual' -> 0) ->> 'employee_id')::uuid = v_met);

  insert into test_results(name, expected, got, passed) values
    ('the person carrying the alert stands out for lateness', v_partial::text,
     coalesce((v_report -> 'standouts' -> 'most_late' -> 0) ->> 'employee_id', 'null'),
     ((v_report -> 'standouts' -> 'most_late' -> 0) ->> 'employee_id')::uuid = v_partial);

  insert into test_results(name, expected, got, passed) values
    ('the person who never appeared stands out for absence', v_missed::text,
     coalesce((v_report -> 'standouts' -> 'most_absent' -> 0) ->> 'employee_id', 'null'),
     ((v_report -> 'standouts' -> 'most_absent' -> 0) ->> 'employee_id')::uuid = v_missed);

  -- HR dismissing the alert has to take it out of every count it fed, or the
  -- decision would mean nothing. It is the same rule the summary holds to.
  update attendance.alerts
     set state = 'dismissed'
   where employee_id = v_partial and kind = 'late_entry';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_report := public.attendance_report('month', v_today);
  perform set_config('role', 'postgres', true);

  select p.value into v_person
    from jsonb_array_elements(v_report -> 'people') as p
   where (p.value ->> 'employee_id')::uuid = v_partial;

  insert into test_results(name, expected, got, passed) values
    ('a dismissed alert stops making the period partial', 'met',
     coalesce(v_person ->> 'compliance', 'null'),
     (v_person ->> 'compliance') = 'met');

  insert into test_results(name, expected, got, passed) values
    ('a dismissed alert leaves the totals', '0',
     coalesce(v_report -> 'totals' ->> 'alerts_total', 'null'),
     (v_report -> 'totals' ->> 'alerts_total')::integer = 0);

  -- ================================== PHASE D: the report and the box agree ===
  -- The claim the shared resolution exists to make. `employee_summary()` and
  -- `attendance_report()` are two callers of `internal.resolved_days()`, and if
  -- they ever disagreed about one person both screens would show a number and
  -- only one of them would be right.
  --
  -- The windows are made to coincide: a report over the last 30 days is not a
  -- period the report offers, so the comparison runs the other way -- a day
  -- report on a day both cover, where the summary's own series carries the same
  -- day and must carry the same figures.

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_report  := public.attendance_report('day', v_d1);
  v_summary := public.employee_summary(v_met, 30);
  perform set_config('role', 'postgres', true);

  select p.value into v_person
    from jsonb_array_elements(v_report -> 'people') as p
   where (p.value ->> 'employee_id')::uuid = v_met;

  select s.value into v_text
    from jsonb_array_elements(v_summary -> 'series') as s
   where (s.value ->> 'date')::date = v_d1;

  insert into test_results(name, expected, got, passed) values
    ('the report and the box agree on the hours of one day',
     coalesce(v_text::jsonb ->> 'worked_seconds', 'null'),
     coalesce(v_person ->> 'worked_seconds', 'null'),
     (v_text::jsonb ->> 'worked_seconds') = (v_person ->> 'worked_seconds'));

  insert into test_results(name, expected, got, passed) values
    ('the report and the box agree on what was expected of that day',
     coalesce(v_text::jsonb ->> 'expected_seconds', 'null'),
     coalesce(v_person ->> 'expected_seconds', 'null'),
     (v_text::jsonb ->> 'expected_seconds') = (v_person ->> 'expected_seconds'));

  insert into test_results(name, expected, got, passed) values
    ('the report and the box agree the day was not late',
     coalesce(v_text::jsonb ->> 'late', 'null'),
     case when (v_person ->> 'late_days')::integer = 0 then 'false' else 'true' end,
     ((v_text::jsonb ->> 'late')::boolean)
       = ((v_person ->> 'late_days')::integer > 0));

  -- ========================================================= PHASE E: the scope ===
  -- No role check is written in the report and none is wanted: RLS on
  -- `empleados` is `can_view_employee()`, so what comes back is decided by the
  -- policies. An employee asking gets themselves and nobody else -- which is
  -- harmless, and is not the same thing as being refused.

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
  v_report := public.attendance_report('month', v_today);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee reading the report sees one person', '1',
     jsonb_array_length(v_report -> 'people')::text,
     jsonb_array_length(v_report -> 'people') = 1);

  insert into test_results(name, expected, got, passed) values
    ('and that person is themselves', v_partial::text,
     coalesce((v_report -> 'people' -> 0) ->> 'employee_id', 'null'),
     ((v_report -> 'people' -> 0) ->> 'employee_id')::uuid = v_partial);

  -- ======================================================== PHASE F: the shapes ===

  select count(*)::integer into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'internal')
     and p.proname in ('attendance_report', 'resolved_days', 'attendance_summary')
     and p.prosecdef;

  insert into test_results(name, expected, got, passed) values
    ('every read in this feature invokes', '0', v_count::text, v_count = 0);

  select count(*)::integer into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'internal')
     and p.proname in ('attendance_report', 'resolved_days')
     and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%';

  insert into test_results(name, expected, got, passed) values
    ('both new functions pin their search_path', '0', v_count::text, v_count = 0);

  select count(*)::integer into v_count
    from information_schema.role_routine_grants
   where grantee = 'anon'
     and routine_name in ('attendance_report');

  insert into test_results(name, expected, got, passed) values
    ('the public key cannot call the report', '0', v_count::text, v_count = 0);

  -- `resolved_days` is internal, and internal is not an exposed schema. It must
  -- not have become reachable over REST by being useful.
  select count(*)::integer into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resolved_days';

  insert into test_results(name, expected, got, passed) values
    ('the shared resolution stayed out of public', '0', v_count::text, v_count = 0);

  -- ============================================================== restore ===
  update public.empleados set auth_user_id = null
   where id in (v_met, v_partial, v_missed, v_pending);
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

-- None of this sticks: not the punches, not the alerts, not the five synthetic
-- people, not their schedules and not the two accounts.
rollback;
