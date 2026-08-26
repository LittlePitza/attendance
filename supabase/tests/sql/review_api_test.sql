-- Verification of the review API, run as the role that will actually call it.
--
-- Same approach as read_api_test.sql: the calls under test run as
-- `authenticated` with a JWT claim, because the whole point of these functions
-- is who is allowed to make them. A suite that ran entirely as `postgres` would
-- bypass RLS and pass no matter how the gates were written.
--
-- The switch stays narrow: only the call under test runs as the client, so a
-- fixture failing to insert can never be mistaken for a gate working.
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
  v_uid1 uuid; v_uid2 uuid := gen_random_uuid(); v_uid_hr uuid := gen_random_uuid();

  v_zone      text;
  v_today     date;
  v_workday   uuid;
  v_punch1    uuid;
  v_punch2    uuid;
  v_alert     uuid;
  v_result    jsonb;
  v_day       jsonb;
  v_flag      boolean;
  v_state     text;
  v_count     integer;
  v_sqlstate  text;
  v_message   text;

  -- A skew over two minutes is what makes internal.record_punch() flag an
  -- offline punch. Ten minutes is unambiguous.
  v_skew integer := 600000;
begin
  select id into v_uid1 from auth.users order by created_at, id limit 1;
  select id into v_emp1 from public.empleados where estado = 'activo' order by nombre limit 1;
  select id into v_emp2 from public.empleados
   where estado = 'activo' and id <> v_emp1 order by nombre limit 1;

  if v_uid1 is null or v_emp2 is null then
    raise exception 'Missing baseline data: need at least 1 account and 2 active employees';
  end if;

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_uid2,   'local.colleague@example.invalid', '{}'::jsonb),
    (v_uid_hr, 'local.hr@example.invalid',        '{}'::jsonb);

  update public.empleados set auth_user_id = v_uid1 where id = v_emp1;
  update public.empleados set auth_user_id = v_uid2 where id = v_emp2;

  update public.user_roles set role = 'employee' where auth_user_id = v_uid1;
  insert into public.user_roles (auth_user_id, role, note) values
    (v_uid2,   'employee', 'Synthetic colleague'),
    (v_uid_hr, 'hr',       'Synthetic HR account, not an employee')
  on conflict (auth_user_id) do update set role = excluded.role;

  v_zone  := internal.time_zone_of(v_emp1);
  v_today := (now() at time zone v_zone)::date;

  -- The seeded global schedule runs Monday to Friday, so a weekend run would
  -- leave the day without a schedule for reasons unrelated to this API.
  insert into attendance.schedules (
    scope, employee_id, name, days,
    entry_from, entry_until, entry_expected, exit_expected,
    grace_minutes, break_max_minutes, valid_from
  )
  values (
    'employee', v_emp1, 'Review suite schedule', '{1,2,3,4,5,6,7}'::smallint[],
    '08:00', '09:30', '09:00', '18:00', 10, 60, v_today - 1
  );

  -- ================================ two flagged punches, through the engine ===
  -- Built with sync_punches() rather than inserted directly, so what is being
  -- reviewed is a punch the real engine decided to flag.

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);

  perform public.sync_punches(jsonb_build_array(
    jsonb_build_object(
      'kind', 'clock_in',
      'occurred_at', (now() - interval '3 hours')::text,
      'idempotency_key', gen_random_uuid()::text,
      'clock_skew_ms', v_skew),
    jsonb_build_object(
      'kind', 'break_start',
      'occurred_at', (now() - interval '2 hours')::text,
      'idempotency_key', gen_random_uuid()::text,
      'clock_skew_ms', v_skew)
  ));

  perform set_config('role', 'postgres', true);

  select w.id into v_workday
    from attendance.workdays w
   where w.employee_id = v_emp1 and w.work_date = v_today;

  select p.id into v_punch1 from attendance.punches p
   where p.workday_id = v_workday and p.kind = 'clock_in';
  select p.id into v_punch2 from attendance.punches p
   where p.workday_id = v_workday and p.kind = 'break_start';

  select w.needs_review into v_flag from attendance.workdays w where w.id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('the engine flagged the skewed punches', 'true',
     coalesce(v_flag::text, 'null'), v_flag is true);

  -- ====================================================== PHASE A: reading ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_day := public.employee_day(v_emp1, v_today);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('HR sees the punches behind the flag', '2',
     coalesce(jsonb_array_length(v_day->'punches')::text, 'none'),
     jsonb_array_length(v_day->'punches') = 2);

  insert into test_results(name, expected, got, passed) values
    ('the reviewer is told why the engine flagged it', 'a reason',
     coalesce(v_day->'punches'->0->>'review_reason', 'none'),
     v_day->'punches'->0->>'review_reason' is not null);

  insert into test_results(name, expected, got, passed) values
    ('nothing is decided yet', 'null',
     coalesce(v_day->'punches'->0->>'decision', 'null'),
     v_day->'punches'->0->'decision' = 'null'::jsonb
       or v_day->'punches'->0->'decision' is null);

  -- Coordinates are never granted to authenticated, so they must not appear
  -- even for HR. The function lists its columns for exactly this reason.
  insert into test_results(name, expected, got, passed) values
    ('coordinates are not in the reviewer''s copy', 'absent',
     case when v_day->'punches'->0 ? 'geo_lat' then 'present' else 'absent' end,
     not (v_day->'punches'->0 ? 'geo_lat'));

  -- A colleague is an employee: can_view_employee() gives them themselves and
  -- nobody else, so the row is not there and the function refuses.
  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid2)::text, true);
    perform public.employee_day(v_emp1, v_today);
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a colleague cannot read somebody else''s day', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  -- ==================================================== PHASE B: refusals ===

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid1)::text, true);
    perform public.review_punch(v_punch1, 'approve_offline', 'Yo mismo lo apruebo');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot review their own punch', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.review_punch(v_punch1, 'approve_offline', 'corto');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a reason under ten characters is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.review_punch(v_punch1, 'correct_time', 'Un motivo suficientemente largo');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a decision this function does not make is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  -- ============================================== PHASE C: deciding alerts ===
  -- The workday is flagged, so evaluate_alerts() raises review_offline for it
  -- without any alert having to be planted.

  perform attendance.evaluate_alerts();

  select a.id into v_alert
    from attendance.alerts a
   where a.employee_id = v_emp1 and a.alert_date = v_today
     and a.kind = 'review_offline';

  insert into test_results(name, expected, got, passed) values
    ('the evaluator raised the review alert', 'an alert',
     coalesce(v_alert::text, 'none'), v_alert is not null);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.decide_alert(v_alert, 'dismissed', 'corto');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a note under ten characters is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.decide_alert(v_alert, 'dismissed',
                                  'Estaba de vacaciones autorizadas esa semana');
  perform set_config('role', 'postgres', true);

  select a.state into v_state from attendance.alerts a where a.id = v_alert;

  insert into test_results(name, expected, got, passed) values
    ('HR can write down what an alert was worth', 'dismissed',
     coalesce(v_state, 'null'), v_state = 'dismissed');

  -- The property the whole outbox design rests on: the evaluator sees this day
  -- roughly 288 times before it is over, and must not undo the decision.
  perform attendance.evaluate_alerts();
  select a.state into v_state from attendance.alerts a where a.id = v_alert;

  insert into test_results(name, expected, got, passed) values
    ('the evaluator does not reopen a decided alert', 'dismissed',
     coalesce(v_state, 'null'), v_state = 'dismissed');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.decide_alert(v_alert, 'resolved', 'Cambio de opinion sobre esta alerta');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('deciding a decided alert is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  -- ============================================= PHASE D: deciding punches ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.review_punch(v_punch1, 'approve_offline',
                                  'Reloj del equipo mal configurado, hora verificada');
  perform set_config('role', 'postgres', true);

  select w.needs_review into v_flag from attendance.workdays w where w.id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('one decision does not clear a day with two flags', 'true',
     coalesce(v_flag::text, 'null'), v_flag is true);

  -- The punch itself is untouched. attendance.punches is append-only, and the
  -- flag on it records how the punch arrived, which no later decision changes.
  select p.needs_review into v_flag from attendance.punches p where p.id = v_punch1;

  insert into test_results(name, expected, got, passed) values
    ('reviewing never edits the punch', 'true',
     coalesce(v_flag::text, 'null'), v_flag is true);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.review_punch(v_punch2, 'reject_offline',
                                  'Sin evidencia de que estuviera trabajando');
  perform set_config('role', 'postgres', true);

  select w.needs_review into v_flag from attendance.workdays w where w.id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('the day clears once every flag has been decided', 'false',
     coalesce(v_flag::text, 'null'), v_flag is false);

  select count(*)::integer into v_count
    from attendance.adjustments a
   where a.workday_id = v_workday
     and a.kind in ('approve_offline', 'reject_offline');

  insert into test_results(name, expected, got, passed) values
    ('both decisions are on the record', '2', v_count::text, v_count = 2);

  -- audit_events has existed since the schema was created and nothing
  -- administrative had ever written to it.
  select count(*)::integer into v_count
    from attendance.audit_events
   where kind in ('punch_reviewed', 'alert_decided');

  insert into test_results(name, expected, got, passed) values
    ('every administrative action is audited', '3', v_count::text, v_count = 3);

  -- The reviewer's copy now carries the decisions it did not have in phase A.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_day := public.employee_day(v_emp1, v_today);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the decision travels with the punch', 'approve_offline',
     coalesce(v_day->'punches'->0->'decision'->>'kind', 'none'),
     v_day->'punches'->0->'decision'->>'kind' = 'approve_offline');

  -- ================================================== the published surface ===
  -- Rule 9: writes elevate, reads do not. Asserted here so it is enforced
  -- rather than remembered.

  select count(*)::integer into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and ((p.proname = 'employee_day' and p.prosecdef)
       or (p.proname in ('review_punch', 'decide_alert') and not p.prosecdef));

  insert into test_results(name, expected, got, passed) values
    ('the reader invokes and the writers elevate', '0', v_count::text, v_count = 0);

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

-- None of this sticks: not the punches, not the adjustments, not the alert,
-- not the role changes, not the account links used to hold a real session.
rollback;
