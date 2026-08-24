-- punch_engine_test.sql
--
-- Verification of the punch engine: state machine, timestamping, idempotency,
-- append-only enforcement, privacy and offline ingestion.
--
-- How to run it:
--
--   npm run db:test
--
-- Run only against the disposable local database assembled by
-- scripts/local-supabase.mjs. Everything also happens inside a transaction that
-- ends in ROLLBACK, so no punch, workday or account link survives the test.
-- Deliberately not pgTAP: this is plain SQL that can run through
-- `supabase db query` without installing test functions in `public`.
--
-- Fails loudly: if a single check does not pass it raises an exception and the
-- Supabase CLI exits non-zero, which is what CI needs.
--
-- Note on language: assertion names are in English, but a few literals stay in
-- Spanish on purpose -- they match the error messages the database raises for
-- employees, which are written in Spanish by design.

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
  v_emp1 uuid; v_emp2 uuid; v_uid uuid;
  v_r jsonb; v_k1 uuid := gen_random_uuid();
  v_punch_id uuid; v_count int; v_text text;
  v_client_time timestamptz := '2001-01-01 00:00:00+00';
  v_occurred timestamptz;
  v_original_role text;
begin
  select id into v_uid  from auth.users limit 1;
  select id into v_emp1 from public.empleados where estado = 'activo' order by nombre limit 1;
  select id into v_emp2 from public.empleados where estado = 'activo' and id <> v_emp1
   order by nombre limit 1;

  if v_uid is null or v_emp2 is null then
    raise exception 'Missing baseline data: need at least 1 account and 2 active employees';
  end if;

  -- The original synthetic role is captured so each phase remains explicit,
  -- even though the outer ROLLBACK also restores it.
  select role into v_original_role from public.user_roles where auth_user_id = v_uid;

  -- ========================================================= PHASE A: online ===
  update public.empleados set auth_user_id = v_uid where id = v_emp1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  -- Clocking in opens the workday.
  v_r := public.punch('clock_in', v_k1, v_client_time, null, null, 19.43, -99.13, 12.5);
  insert into test_results(name, expected, got, passed) values
    ('clock_in opens the workday', 'working', v_r->>'state', v_r->>'state' = 'working');

  -- The official timestamp comes from the server, not the client.
  v_occurred := (v_r->>'occurred_at')::timestamptz;
  insert into test_results(name, expected, got, passed) values
    ('occurred_at is the server time', '< 60s from now()',
     round(abs(extract(epoch from (now() - v_occurred))))::text || 's',
     abs(extract(epoch from (now() - v_occurred))) < 60);

  -- The client's time is stored separately, for auditing only.
  select client_reported_at into v_occurred
    from attendance.punches where idempotency_key = v_k1;
  insert into test_results(name, expected, got, passed) values
    ('client time stored separately', v_client_time::text, v_occurred::text,
     v_occurred = v_client_time);

  -- Without recorded consent, coordinates are discarded.
  insert into test_results(name, expected, got, passed) values
    ('geo discarded without consent', 'false', v_r->>'geo_saved',
     (v_r->>'geo_saved') = 'false');

  -- Invalid transitions.
  begin
    v_r := public.punch('clock_in', gen_random_uuid());
    insert into test_results(name, expected, got, passed) values
      ('second clock_in rejected', 'error', 'it was accepted', false);
  exception when others then
    insert into test_results(name, expected, got, passed) values
      ('second clock_in rejected', 'error', left(sqlerrm, 45), true);
  end;

  v_r := public.punch('break_start', gen_random_uuid());
  insert into test_results(name, expected, got, passed) values
    ('break_start pauses the workday', 'on_break', v_r->>'state', v_r->>'state' = 'on_break');

  begin
    v_r := public.punch('break_start', gen_random_uuid());
    insert into test_results(name, expected, got, passed) values
      ('double break_start rejected', 'error', 'it was accepted', false);
  exception when others then
    insert into test_results(name, expected, got, passed) values
      ('double break_start rejected', 'error', left(sqlerrm, 45), true);
  end;

  v_r := public.punch('break_end', gen_random_uuid());
  insert into test_results(name, expected, got, passed) values
    ('break_end resumes work', 'working', v_r->>'state', v_r->>'state' = 'working');

  v_r := public.punch('clock_out', gen_random_uuid());
  insert into test_results(name, expected, got, passed) values
    ('clock_out closes the workday', 'finished', v_r->>'state', v_r->>'state' = 'finished');

  -- Idempotency: replaying the same key neither duplicates nor errors.
  v_r := public.punch('clock_in', v_k1);
  select count(*) into v_count from attendance.punches where idempotency_key = v_k1;
  insert into test_results(name, expected, got, passed) values
    ('idempotency does not duplicate', 'repeated=true and 1 row',
     'repeated=' || (v_r->>'repeated') || ' and ' || v_count || ' row(s)',
     (v_r->>'repeated') = 'true' and v_count = 1);

  -- Append-only: not even the service role can alter a punch.
  select id into v_punch_id from attendance.punches where idempotency_key = v_k1;
  begin
    update attendance.punches set occurred_at = now() where id = v_punch_id;
    insert into test_results(name, expected, got, passed) values
      ('UPDATE on punches blocked', 'error', 'it was allowed', false);
  exception when others then
    insert into test_results(name, expected, got, passed) values
      ('UPDATE on punches blocked', 'error', left(sqlerrm, 45), true);
  end;

  begin
    delete from attendance.punches where id = v_punch_id;
    insert into test_results(name, expected, got, passed) values
      ('DELETE on punches blocked', 'error', 'it was allowed', false);
  exception when others then
    insert into test_results(name, expected, got, passed) values
      ('DELETE on punches blocked', 'error', left(sqlerrm, 45), true);
  end;

  -- ======================================================== PHASE B: offline ===
  update public.empleados set auth_user_id = null   where id = v_emp1;
  update public.empleados set auth_user_id = v_uid  where id = v_emp2;

  -- A deliberately shuffled batch, with a fast clock and one broken date. If
  -- the function did not reorder by time, the state machine would reject almost
  -- all of it: all four being accepted IS the proof that it reorders.
  v_r := public.sync_punches(jsonb_build_array(
    jsonb_build_object('kind','break_end',   'occurred_at',(now() - interval '20 min')::text,
                       'idempotency_key', gen_random_uuid()),
    jsonb_build_object('kind','clock_in',    'occurred_at',(now() - interval '40 min')::text,
                       'idempotency_key', gen_random_uuid(), 'clock_skew_ms', 600000),
    jsonb_build_object('kind','clock_out',   'occurred_at',(now() - interval '10 min')::text,
                       'idempotency_key', gen_random_uuid()),
    jsonb_build_object('kind','break_start', 'occurred_at',(now() - interval '30 min')::text,
                       'idempotency_key', gen_random_uuid()),
    jsonb_build_object('kind','clock_in',    'occurred_at','not-a-date',
                       'idempotency_key', gen_random_uuid())
  ));

  insert into test_results(name, expected, got, passed) values
    ('shuffled batch sorts itself', '4 accepted, 1 rejected',
     (v_r->>'accepted') || ' accepted, ' || (v_r->>'rejected') || ' rejected',
     (v_r->>'accepted') = '4' and (v_r->>'rejected') = '1');

  select state into v_text from attendance.workdays where employee_id = v_emp2;
  insert into test_results(name, expected, got, passed) values
    ('final state after the batch', 'finished', v_text, v_text = 'finished');

  select count(*) into v_count from attendance.punches
   where employee_id = v_emp2 and source = 'offline';
  insert into test_results(name, expected, got, passed) values
    ('all four labelled as offline', '4', v_count::text, v_count = 4);

  -- A clock more than 2 minutes off is not accepted silently.
  -- 'Reloj' is Spanish on purpose: it matches the review_reason the engine
  -- writes, and those messages are written for the people who read them.
  select count(*) into v_count from attendance.punches
   where employee_id = v_emp2 and needs_review and review_reason like '%Reloj%';
  insert into test_results(name, expected, got, passed) values
    ('tampered clock flagged for review', '1', v_count::text, v_count = 1);

  select needs_review::text into v_text from attendance.workdays where employee_id = v_emp2;
  insert into test_results(name, expected, got, passed) values
    ('workday inherits needs_review', 'true', v_text, v_text = 'true');

  -- The heartbeat does not revive a closed workday.
  v_r := public.heartbeat();
  insert into test_results(name, expected, got, passed) values
    ('heartbeat does not revive a closed workday', 'recorded=false',
     'recorded=' || (v_r->>'recorded'), (v_r->>'recorded') = 'false');

  -- =========================================================== RLS scoping ===
  update public.empleados set auth_user_id = null  where id = v_emp2;
  update public.empleados set auth_user_id = v_uid where id = v_emp1;

  update public.user_roles set role = 'employee' where auth_user_id = v_uid;
  insert into test_results(name, expected, got, passed) values
    ('employee sees themselves', 'true',
     internal.can_view_employee(v_emp1)::text, internal.can_view_employee(v_emp1) is true);
  insert into test_results(name, expected, got, passed) values
    ('employee does NOT see another', 'false',
     internal.can_view_employee(v_emp2)::text, internal.can_view_employee(v_emp2) is false);

  update public.user_roles set role = 'hr' where auth_user_id = v_uid;
  insert into test_results(name, expected, got, passed) values
    ('hr sees anyone', 'true',
     internal.can_view_employee(v_emp2)::text, internal.can_view_employee(v_emp2) is true);

  perform set_config('request.jwt.claims',
                     json_build_object('sub', gen_random_uuid())::text, true);
  insert into test_results(name, expected, got, passed) values
    ('account with no role falls back to guest', 'guest',
     internal.caller_role(), internal.caller_role() = 'guest');
  insert into test_results(name, expected, got, passed) values
    ('guest sees nobody', 'false',
     internal.can_view_employee(v_emp1)::text, internal.can_view_employee(v_emp1) is false);

  -- ============================================================== restore ===
  update public.user_roles set role = v_original_role where auth_user_id = v_uid;
  update public.empleados  set auth_user_id = null    where id in (v_emp1, v_emp2);
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
  select count(*) filter (where not passed), count(*) into v_failed, v_total
    from test_results;

  if v_failed > 0 then
    raise exception '% of % checks failed', v_failed, v_total;
  end if;

  raise notice 'All % checks passed.', v_total;
end
$verdict$;

-- None of this sticks: not the punches, not the workdays, not the account link
-- used to simulate the token, not the temporary role change.
rollback;
