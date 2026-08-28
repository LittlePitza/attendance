-- Verification of the read API, run as the role that will actually call it.
--
-- Every other suite runs as `postgres`, which owns the tables and therefore
-- bypasses RLS entirely. That is fine for the engine, whose rules live inside
-- SECURITY DEFINER functions, but it means the policies themselves have never
-- been executed by the role they were written for. A policy that referenced a
-- function `authenticated` cannot execute, or that filtered nothing, would have
-- passed every check in this repository.
--
-- So this suite switches role. Around each call it does:
--
--   set role authenticated + request.jwt.claims -> call -> set role postgres
--
-- and asserts on the result afterwards. The switch is deliberately narrow: only
-- the call under test runs as the client, so a fixture failing to insert can
-- never be mistaken for a policy working.
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
  v_emp1 uuid; v_emp2 uuid; v_dept2 uuid;
  v_uid1 uuid; v_uid2 uuid := gen_random_uuid(); v_uid3 uuid := gen_random_uuid();

  v_result  jsonb;
  v_count   integer;
  v_text    text;
  v_ok      boolean;
  v_zone    text;
  v_today   date;

  v_states    text[] := array['not_started', 'working', 'on_break', 'finished'];
  v_advance   text[] := array['clock_in', 'break_start', 'clock_out', null];
  v_kinds     text[] := array['clock_in', 'break_start', 'break_end', 'clock_out'];
  v_accepted  text[];
  v_expected  text[];
  v_kind      text;
  i           integer;
begin
  select id into v_uid1 from auth.users order by created_at, id limit 1;
  select id into v_emp1 from public.empleados where estado = 'activo' order by nombre limit 1;
  select id into v_emp2 from public.empleados
   where estado = 'activo' and id <> v_emp1 order by nombre limit 1;

  if v_uid1 is null or v_emp2 is null then
    raise exception 'Missing baseline data: need at least 1 account and 2 active employees';
  end if;

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_uid2, 'local.manager@example.invalid', '{}'::jsonb),
    (v_uid3, 'local.orphan@example.invalid',  '{}'::jsonb);

  update public.empleados set auth_user_id = v_uid1 where id = v_emp1;
  update public.empleados set auth_user_id = v_uid2 where id = v_emp2;

  -- uid3 has a role and no employee record. That is the administrator case the
  -- role table exists for, and the case my_day() has to refuse.
  insert into public.user_roles (auth_user_id, role, note) values
    (v_uid3, 'admin', 'Synthetic account with no employee record')
  on conflict (auth_user_id) do update set role = excluded.role;

  update public.user_roles set role = 'employee' where auth_user_id = v_uid1;
  insert into public.user_roles (auth_user_id, role, note) values
    (v_uid2, 'employee', 'Synthetic second employee')
  on conflict (auth_user_id) do update set role = excluded.role;

  select department_id into v_dept2 from public.empleados where id = v_emp2;
  v_zone  := internal.time_zone_of(v_emp1);
  v_today := (now() at time zone v_zone)::date;

  -- The seeded global schedule runs Monday to Friday, so on a weekend run
  -- my_day() would legitimately report no schedule and the assertion below
  -- would fail for a reason that has nothing to do with the read API. An
  -- employee schedule covering all seven days removes the day of the week from
  -- the result.
  insert into attendance.schedules (
    scope, employee_id, name, days,
    entry_from, entry_until, entry_expected, exit_expected,
    grace_minutes, break_max_minutes, valid_from
  )
  values (
    'employee', v_emp1, 'Test schedule', '{1,2,3,4,5,6,7}'::smallint[],
    '08:00', '09:30', '09:00', '18:00', 10, 60, v_today - 1
  );

  -- ========================================== PHASE A: my_day() before work ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  v_result := public.my_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('my_day answers an employee session', v_emp1::text,
     coalesce(v_result->>'employee_id', 'no answer'),
     (v_result->>'employee_id') = v_emp1::text);

  insert into test_results(name, expected, got, passed) values
    ('a day with no punches reads not_started', 'not_started',
     coalesce(v_result->>'state', 'null'), (v_result->>'state') = 'not_started');

  insert into test_results(name, expected, got, passed) values
    ('the only offered action is clocking in', '["clock_in"]',
     coalesce((v_result->'next_actions')::text, 'null'),
     (v_result->'next_actions') = '["clock_in"]'::jsonb);

  insert into test_results(name, expected, got, passed) values
    ('the schedule comes with the day', 'a schedule',
     coalesce(v_result->'schedule'->>'entry_expected', 'none'),
     v_result->'schedule'->>'entry_expected' is not null);

  -- ============================ PHASE B: the state machine and its projection ==
  -- Walk the workday through every state and, at each stop, attempt all four
  -- punch kinds against the live engine. What the engine accepts must be
  -- exactly what internal.allowed_punches() advertised. Each attempt runs in a
  -- subtransaction that is always undone -- including the successful ones, by
  -- raising on purpose once the punch has gone through.

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);

  for i in 1 .. array_length(v_states, 1) loop
    v_result   := public.my_day();
    v_accepted := array[]::text[];

    foreach v_kind in array v_kinds loop
      begin
        perform public.punch(v_kind, gen_random_uuid());
        v_accepted := v_accepted || v_kind;
        -- The punch worked. Undo it: this is a probe, not a workday.
        raise exception 'probe_undo' using errcode = 'P0001';
      exception when others then
        null;   -- either the engine refused it, or the undo above fired
      end;
    end loop;

    v_expected := internal.allowed_punches(v_states[i]);

    perform set_config('role', 'postgres', true);

    insert into test_results(name, expected, got, passed) values
      ('state ' || v_states[i] || ' is the state my_day reports', v_states[i],
       coalesce(v_result->>'state', 'null'), (v_result->>'state') = v_states[i]);

    insert into test_results(name, expected, got, passed) values
      ('from ' || v_states[i] || ' the engine accepts what my_day offers',
       coalesce(array_to_string(v_expected, ','), ''),
       coalesce(array_to_string(v_accepted, ','), ''),
       (select coalesce(array_agg(x order by x), array[]::text[])
          from unnest(v_expected) x)
       = (select coalesce(array_agg(y order by y), array[]::text[])
            from unnest(v_accepted) y));

    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);

    if v_advance[i] is not null then
      perform public.punch(v_advance[i], gen_random_uuid());
    end if;
  end loop;

  perform set_config('role', 'postgres', true);

  -- ========================================= PHASE C: what the client cannot do ==
  -- Rule 2 says `authenticated` holds SELECT and nothing else, and that exact
  -- coordinates were never granted at all. Until now both were true by
  -- construction. Here they are attempted.

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);

  begin
    perform p.geo_lat from attendance.punches p limit 1;
    v_ok := false; v_text := 'the column was readable';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 50);
  end;

  perform set_config('role', 'postgres', true);
  insert into test_results(name, expected, got, passed) values
    ('exact coordinates are not readable', 'refused', v_text, v_ok);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);

  begin
    insert into attendance.punches (workday_id, employee_id, kind, occurred_at, idempotency_key)
    select w.id, v_emp1, 'clock_in', now(), gen_random_uuid()
      from attendance.workdays w where w.employee_id = v_emp1 limit 1;
    v_ok := false; v_text := 'the insert went through';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 50);
  end;

  perform set_config('role', 'postgres', true);
  insert into test_results(name, expected, got, passed) values
    ('a client cannot insert a punch directly', 'refused', v_text, v_ok);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);

  begin
    update attendance.workdays set state = 'not_started' where employee_id = v_emp1;
    v_ok := false; v_text := 'the update went through';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 50);
  end;

  perform set_config('role', 'postgres', true);
  insert into test_results(name, expected, got, passed) values
    ('a client cannot rewrite its own workday', 'refused', v_text, v_ok);

  -- =============================================== PHASE D: scope, by role ===
  -- Both employees are moved into one department so that "their department" and
  -- "everybody" are different answers. Without that, a manager scope that
  -- silently returned only the caller would look correct.

  update public.empleados set department_id = v_dept2 where id = v_emp1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  select count(*) into v_count from public.team_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee sees only themselves', '1', v_count::text, v_count = 1);

  update public.user_roles set role = 'manager' where auth_user_id = v_uid2;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.team_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a manager sees their department', '2', v_count::text, v_count = 2);

  -- Somebody the manager does not manage must not appear. Moving one employee
  -- out again is the only way to tell a working scope from a permissive one.
  update public.empleados set department_id = null where id = v_emp1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.team_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a manager does not see another department', '1', v_count::text, v_count = 1);

  update public.user_roles set role = 'hr' where auth_user_id = v_uid2;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.team_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('hr sees everyone', '2', v_count::text, v_count = 2);

  -- ======================================= PHASE D2: who could have punched ===
  -- `team_day()` reports whether somebody has an account, and deliberately does
  -- not filter on it. Three screens read this list -- the board, the Expedientes
  -- picker and Revisión -- and only the board wants the short one, so the
  -- narrowing is a decision about what to draw rather than about what to send.
  -- An assertion here is what stops that being "fixed" into a where clause,
  -- which would empty two screens nobody complained about.

  update public.empleados set auth_user_id = null where id = v_emp1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.team_day();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('somebody without an account is still returned', '2', v_count::text, v_count = 2);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.team_day() t where not t.has_account;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('and is marked as unable to punch', '1', v_count::text, v_count = 1);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.team_day() t where t.has_account;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('while the one with an account is marked able to', '1', v_count::text, v_count = 1);

  -- Never null: the board tests for a definite false, and a null would make
  -- somebody neither able nor unable to punch.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.team_day() t where t.has_account is null;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('and never null', '0', v_count::text, v_count = 0);

  -- It agrees with the population the report and the evaluator use, which is the
  -- whole reason it is this column and not some other notion of access.
  select count(*) into v_count
    from public.empleados e
   where e.estado = 'activo' and e.auth_user_id is not null;

  insert into test_results(name, expected, got, passed) values
    ('has_account is the same column evaluate_alerts() reads', '1',
     v_count::text, v_count = 1);

  update public.empleados set auth_user_id = v_uid1 where id = v_emp1;

  -- ================================================= PHASE E: open_alerts() ===

  insert into attendance.alerts (employee_id, alert_date, kind, severity)
  values (v_emp1, v_today, 'missing_entry', 'high');

  update public.user_roles set role = 'employee' where auth_user_id = v_uid2;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.open_alerts();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an alert about somebody else is invisible', '0', v_count::text, v_count = 0);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  select count(*), max(kind) into v_count, v_text from public.open_alerts();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee sees their own alert', '1 missing_entry',
     v_count || ' ' || coalesce(v_text, 'none'),
     v_count = 1 and v_text = 'missing_entry');

  update public.user_roles set role = 'hr' where auth_user_id = v_uid2;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
  select count(*) into v_count from public.open_alerts();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('hr sees an alert about anyone', '1', v_count::text, v_count = 1);

  -- ================================================= PHASE F: my_history() ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
  select count(*) into v_count from public.my_history();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('my_history returns the day just worked', '1', v_count::text, v_count = 1);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);

  begin
    perform * from public.my_history(v_today - 200, v_today);
    v_ok := false; v_text := 'the range was accepted';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 40);
  end;

  perform set_config('role', 'postgres', true);
  insert into test_results(name, expected, got, passed) values
    ('an unbounded range is refused, in Spanish', 'El rango no puede exceder 92 dias',
     v_text, v_ok and v_text like 'El rango%');

  -- ======================================= PHASE G: an account with no employee ==

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid3)::text, true);

  begin
    v_result := public.my_day();
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

-- None of this sticks: not the punches, not the alert, not the role changes,
-- not the account links used to hold a real session.
rollback;
