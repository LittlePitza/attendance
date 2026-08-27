-- Verification of the workforce API: the day reset, the roster and the summary.
--
-- Same approach as admin_api_test.sql: the calls under test run as
-- `authenticated` with a JWT claim, because what most of these functions are
-- for is deciding who may do what, and a suite that ran entirely as `postgres`
-- would pass no matter how the gates were written. The switch stays narrow --
-- only the call under test runs as the client -- so a fixture failing to insert
-- can never be mistaken for a gate working.
--
-- The punches are made through `internal.record_punch()` with chosen hours
-- rather than through `public.punch()`, which always stamps `now()`. The
-- arithmetic being checked is about intervals between punches, and a suite that
-- could not choose them could only assert that the numbers were small.
--
-- The cast:
--
--   emp1  <- an 'employee' account. Proves the gates turn away the workforce,
--            and is the person retired to show access goes with the retirement.
--   emp2  <- nobody. The day that gets reset, and the summary that gets read.
--   emp5  <- the 'hr' account, and the caller for everything administrative.
--
-- The two claims this file exists to make, above the rest:
--
--   1. `internal.recompute_workday()` and `internal.record_punch()` agree. They
--      are two implementations of one piece of arithmetic, which is a debt, and
--      the only way to hold it is to check it on every shape of day.
--   2. Resetting a day discards nothing. The punches are all still there
--      afterwards, each with the decision recorded beside it.
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
  v_emp5 uuid := '30000000-0000-4000-8000-0000000000b5';
  v_new  uuid;

  v_uid_admin uuid;
  v_uid_emp   uuid := gen_random_uuid();
  v_uid_hr    uuid := gen_random_uuid();
  v_uid_spare uuid := gen_random_uuid();

  v_dept1 uuid;
  v_dept2 uuid;

  v_zone     text;
  v_today    date;
  v_workday  uuid;
  v_wd       attendance.workdays;
  v_state    text;
  v_worked   integer;
  v_break    integer;
  v_result   jsonb;
  v_count    integer;
  v_text     text;
  v_ok       boolean;
  v_flagged  uuid;
begin
  select id into v_uid_admin from auth.users order by created_at, id limit 1;
  select id into v_emp1 from public.empleados where estado = 'activo' order by nombre limit 1;
  select id into v_emp2 from public.empleados
   where estado = 'activo' and id <> v_emp1 order by nombre limit 1;
  select id into v_dept1 from public.departments order by name limit 1;
  select id into v_dept2 from public.departments where id <> v_dept1 order by name limit 1;

  if v_uid_admin is null or v_emp2 is null or v_dept2 is null then
    raise exception 'Missing baseline data: need 1 account, 2 active employees and 2 departments';
  end if;

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_uid_emp,   'workforce.employee@example.invalid', '{}'::jsonb),
    (v_uid_hr,    'workforce.hr@example.invalid',       '{}'::jsonb),
    (v_uid_spare, 'workforce.spare@example.invalid',    '{}'::jsonb);

  insert into public.empleados (id, nombre, correo, puesto, estado, department_id, auth_user_id)
  values (v_emp5, 'Persona de Recursos Humanos', 'workforce.hr@example.invalid',
          'Analista de RH', 'activo', v_dept1, v_uid_hr);

  update public.empleados set auth_user_id = v_uid_emp where id = v_emp1;

  insert into public.user_roles (auth_user_id, role, note) values
    (v_uid_emp, 'employee', 'Synthetic employee'),
    (v_uid_hr,  'hr',       'Synthetic HR, and a person')
  on conflict (auth_user_id) do update set role = excluded.role;

  -- Every day of the week, so the summary assertions hold on a Saturday too.
  -- The seeded global schedule is Monday to Friday and would resolve to nothing.
  insert into attendance.schedules
    (scope, employee_id, name, days, entry_from, entry_until, entry_expected, exit_expected)
  values
    ('employee', v_emp2, 'Horario propio de prueba', '{1,2,3,4,5,6,7}'::smallint[],
     '07:00', '10:00', '09:00', '18:00');

  v_zone  := internal.time_zone_of(v_emp2);
  v_today := (now() at time zone v_zone)::date;

  -- ========================================================= PHASE A: the gate ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
  begin
    perform public.list_employees();
    v_ok := false; v_text := 'it answered';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot read the roster', 'refused', v_text, v_ok);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
  begin
    perform public.save_employee('Alguien Inventado', 'inventado@example.invalid');
    v_ok := false; v_text := 'it was created';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot add a person', 'refused', v_text, v_ok);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
  begin
    perform public.reset_day(v_emp2, 'Intento de un empleado cualquiera');
    v_ok := false; v_text := 'it was reset';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot reset a day', 'refused', v_text, v_ok);

  -- ====================================================== PHASE B: a whole day ===
  -- 09:00 in, 10:00 break, 10:30 back, 12:00 out. Worked is the hour before the
  -- break plus the ninety minutes after it; the break is the half hour between.

  perform internal.record_punch(v_emp2, 'clock_in',
    (v_today + time '09:00') at time zone v_zone, 'online', gen_random_uuid());
  perform internal.record_punch(v_emp2, 'break_start',
    (v_today + time '10:00') at time zone v_zone, 'online', gen_random_uuid());
  perform internal.record_punch(v_emp2, 'break_end',
    (v_today + time '10:30') at time zone v_zone, 'online', gen_random_uuid());
  perform internal.record_punch(v_emp2, 'clock_out',
    (v_today + time '12:00') at time zone v_zone, 'online', gen_random_uuid());

  select w.id, w.state, w.worked_seconds, w.break_seconds
    into v_workday, v_state, v_worked, v_break
    from attendance.workdays w
   where w.employee_id = v_emp2 and w.work_date = v_today;

  insert into test_results(name, expected, got, passed) values
    ('the engine counted the day as it was punched', 'finished 9000/1800',
     format('%s %s/%s', v_state, v_worked, v_break),
     v_state = 'finished' and v_worked = 9000 and v_break = 1800);

  -- The claim this file exists for: replaying the punches produces exactly what
  -- accumulating them did. Two implementations of one piece of arithmetic are a
  -- debt, and this is the payment.
  v_wd := internal.recompute_workday(v_workday);

  insert into test_results(name, expected, got, passed) values
    ('recomputing an untouched day moves nothing',
     format('%s %s/%s', v_state, v_worked, v_break),
     format('%s %s/%s', v_wd.state, v_wd.worked_seconds, v_wd.break_seconds),
     (v_wd.state, v_wd.worked_seconds, v_wd.break_seconds)
       is not distinct from (v_state, v_worked, v_break));

  -- ========================================================== PHASE C: the reset ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  begin
    perform public.reset_day(v_emp2, 'corto');
    v_ok := false; v_text := 'it was reset';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a reset without a real reason is refused', 'refused', v_text, v_ok);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.reset_day(v_emp2, 'Marco la jornada equivocada por error');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the reset voided every punch of the day', '4',
     coalesce(v_result ->> 'punches_voided', 'null'),
     (v_result ->> 'punches_voided')::integer = 4);

  select w.* into v_wd from attendance.workdays w where w.id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('the day is back to not_started with nothing counted', 'not_started 0/0',
     format('%s %s/%s', v_wd.state, v_wd.worked_seconds, v_wd.break_seconds),
     v_wd.state = 'not_started' and v_wd.worked_seconds = 0 and v_wd.break_seconds = 0);

  insert into test_results(name, expected, got, passed) values
    ('the opening and closing hours went with it', 'both null',
     format('%s / %s', coalesce(v_wd.opened_at::text, 'null'),
                       coalesce(v_wd.closed_at::text, 'null')),
     v_wd.opened_at is null and v_wd.closed_at is null);

  -- Nothing was deleted. This is the difference between a correction and a
  -- cover-up, and it is the property attendance.punches is append-only for.
  select count(*)::integer into v_count
    from attendance.punches p where p.workday_id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('the punches are all still there', '4', v_count::text, v_count = 4);

  select count(*)::integer into v_count
    from attendance.adjustments a
   where a.workday_id = v_workday
     and a.kind      = 'void_punch'
     and a.old_value is not null
     and length(trim(a.reason)) >= 10;

  insert into test_results(name, expected, got, passed) values
    ('each one carries a void with its hour and its reason', '4', v_count::text, v_count = 4);

  select count(*)::integer into v_count
    from attendance.audit_events e
   where e.kind = 'workday_reset' and e.entity_id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('the reset is in the audit trail', '1', v_count::text, v_count = 1);

  -- Twice is not twice as reset. The second call finds nothing that still
  -- counts and says so, rather than writing a second set of void rows.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  begin
    perform public.reset_day(v_emp2, 'Otra vez, por si acaso, sin razon');
    v_ok := false; v_text := 'it was reset again';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('resetting an already reset day is refused', 'refused', v_text, v_ok);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  begin
    perform public.reset_day(v_emp2, 'Un dia en el que no marco nada', v_today - 200);
    v_ok := false; v_text := 'it was reset';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a day with no workday at all is refused', 'refused', v_text, v_ok);

  -- ============================================ PHASE D: punching after a reset ===
  -- The morning arrives late, from a phone that was offline while all of the
  -- above happened. Its first punch is earlier than the ones the reset voided,
  -- which is the only way a voided punch can still be the last one by the
  -- clock -- and the reason internal.record_punch() measures against the last
  -- punch that counts rather than the last punch that exists.

  perform internal.record_punch(v_emp2, 'clock_in',
    (v_today + time '08:00') at time zone v_zone, 'offline', gen_random_uuid(),
    (v_today + time '08:00') at time zone v_zone);
  perform internal.record_punch(v_emp2, 'break_start',
    (v_today + time '08:30') at time zone v_zone, 'offline', gen_random_uuid(),
    (v_today + time '08:30') at time zone v_zone);

  select w.* into v_wd from attendance.workdays w where w.id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('the interval is measured from the punch that still counts', '1800',
     v_wd.worked_seconds::text, v_wd.worked_seconds = 1800);

  insert into test_results(name, expected, got, passed) values
    ('the day knows a punch arrived by sync', 'true',
     v_wd.has_offline::text, v_wd.has_offline);

  -- And the two implementations still agree, on a day that has been reset and
  -- punched into again.
  v_state := v_wd.state; v_worked := v_wd.worked_seconds; v_break := v_wd.break_seconds;
  v_wd := internal.recompute_workday(v_workday);

  insert into test_results(name, expected, got, passed) values
    ('they still agree after a reset and a resync',
     format('%s %s/%s', v_state, v_worked, v_break),
     format('%s %s/%s', v_wd.state, v_wd.worked_seconds, v_wd.break_seconds),
     (v_wd.state, v_wd.worked_seconds, v_wd.break_seconds)
       is not distinct from (v_state, v_worked, v_break));

  -- ================================== PHASE E: a flagged punch that gets voided ===
  -- A punch that arrived flagged keeps the day flagged until somebody decides
  -- about it. Voiding it is a decision -- the most final one -- so the day has
  -- to settle. Before this migration it could not: review_punch() refuses a
  -- punch that is not needs_review, and nothing ever clears that column.

  perform internal.record_punch(v_emp2, 'break_end',
    (v_today + time '09:00') at time zone v_zone, 'offline', gen_random_uuid(),
    (v_today + time '09:00') at time zone v_zone, 600000);

  select p.id into v_flagged
    from attendance.punches p
   where p.workday_id = v_workday and p.needs_review
   order by p.created_at desc limit 1;

  select w.needs_review into v_ok from attendance.workdays w where w.id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('a punch with a drifted clock flags the day', 'true',
     coalesce(v_ok::text, 'null'), v_flagged is not null and v_ok);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  perform public.reset_day(v_emp2, 'La jornada entera quedo mal, se reinicia');
  perform set_config('role', 'postgres', true);

  select w.* into v_wd from attendance.workdays w where w.id = v_workday;

  insert into test_results(name, expected, got, passed) values
    ('voiding a flagged punch settles the day', 'false',
     coalesce(v_wd.needs_review::text, 'null'), not v_wd.needs_review);

  -- The sync flag describes the punches that count, so it goes when they do.
  -- The same reasoning that puts the counters back to zero: a day with nothing
  -- in it did not have anything arrive by sync either.
  insert into test_results(name, expected, got, passed) values
    ('and the sync flag goes with the punches that carried it', 'false',
     coalesce(v_wd.has_offline::text, 'null'), not v_wd.has_offline);

  -- The morning arrives once more, and this time it stays: the summary below
  -- has to have a day with a synced punch on it to count.
  perform internal.record_punch(v_emp2, 'clock_in',
    (v_today + time '08:00') at time zone v_zone, 'offline', gen_random_uuid(),
    (v_today + time '08:00') at time zone v_zone);

  -- ======================================================== PHASE F: the roster ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.save_employee('Persona Recien Contratada',
                                   'recien.contratada@example.invalid',
                                   'Auxiliar', v_dept2);
  perform set_config('role', 'postgres', true);

  v_new := (v_result ->> 'employee_id')::uuid;

  insert into test_results(name, expected, got, passed) values
    ('HR can add somebody to the roster', 'true',
     coalesce(v_result ->> 'created', 'null'), (v_result ->> 'created')::boolean);

  select e.departamento, e.estado into v_text, v_state
    from public.empleados e where e.id = v_new;

  insert into test_results(name, expected, got, passed) values
    ('the obsolete department text is filled by the trigger, not by the writer',
     (select d.name from public.departments d where d.id = v_dept2),
     coalesce(v_text, 'null'),
     v_text = (select d.name from public.departments d where d.id = v_dept2));

  insert into test_results(name, expected, got, passed) values
    ('somebody new starts active', 'activo', v_state, v_state = 'activo');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  begin
    perform public.save_employee('Otra Persona', 'recien.contratada@example.invalid');
    v_ok := false; v_text := 'it was created';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a duplicate address is refused, naming who holds it', 'refused',
     v_text, v_ok and v_text like '%Persona Recien Contratada%');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  begin
    perform public.save_employee('Persona Sin Arroba', 'no-es-una-direccion');
    v_ok := false; v_text := 'it was created';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an address that is not one is refused', 'refused', v_text, v_ok);

  -- Editing touches four columns. `extension` belongs to the help desk and
  -- `estado` to the two functions that take a reason, so a writer that wrote
  -- the whole row would clear one and quietly move the other.
  update public.empleados set extension = '1234' where id = v_new;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  perform public.save_employee('Persona Recien Contratada', 'recien.contratada@example.invalid',
                               'Coordinadora', v_dept1, v_new);
  perform set_config('role', 'postgres', true);

  select format('%s|%s|%s', e.puesto, coalesce(e.extension, 'null'), e.estado)
    into v_text from public.empleados e where e.id = v_new;

  insert into test_results(name, expected, got, passed) values
    ('an edit changes the job and leaves the rest alone', 'Coordinadora|1234|activo',
     v_text, v_text = 'Coordinadora|1234|activo');

  -- ================================================== PHASE G: leaving and back ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.retire_employee(v_emp1, 'Termino su relacion laboral hoy');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('retiring somebody takes their access with them', 'baja + revoked',
     format('%s + %s', v_result ->> 'state',
            case when (v_result ->> 'access_revoked')::boolean then 'revoked' else 'kept' end),
     (v_result ->> 'state') = 'baja' and (v_result ->> 'access_revoked')::boolean);

  select count(*)::integer into v_count
    from public.user_roles ur where ur.auth_user_id = v_uid_emp;

  insert into test_results(name, expected, got, passed) values
    ('their role row is gone, so they resolve to guest', '0', v_count::text, v_count = 0);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  begin
    perform public.retire_employee(v_emp5, 'La persona de RH intenta darse de baja');
    v_ok := false; v_text := 'it was retired';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('nobody can retire themselves', 'refused', v_text, v_ok);

  -- Somebody with a record behind them. The foreign keys would refuse a real
  -- DELETE and this has to work anyway, which is the whole argument for baja.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  perform public.retire_employee(v_emp2, 'Cambio de adscripcion, deja de marcar');
  perform set_config('role', 'postgres', true);

  select count(*)::integer into v_count
    from attendance.punches p where p.employee_id = v_emp2;

  insert into test_results(name, expected, got, passed) values
    ('retiring somebody keeps every punch they made', '8', v_count::text, v_count = 8);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.restore_employee(v_emp1, 'Regreso a la empresa este lunes');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('coming back is active again but still without a way in', 'activo + needs_account',
     format('%s + %s', v_result ->> 'state',
            case when (v_result ->> 'needs_account')::boolean then 'needs_account' else 'has_account' end),
     (v_result ->> 'state') = 'activo' and (v_result ->> 'needs_account')::boolean);

  -- ========================================= PHASE H: the roster and the accounts ===
  -- Two lists, two questions. Somebody on baja is off the access screen and
  -- still on the roster, because their days are still in the record.

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select count(*)::integer into v_count from public.list_accounts();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the access screen shows only active people', '3', v_count::text, v_count = 3);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select count(*)::integer into v_count from public.list_employees();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the roster shows everybody, baja included', '4', v_count::text, v_count = 4);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select count(*)::integer into v_count
    from public.list_employees() r where r.state = 'baja';
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('and says which of them has left', '1', v_count::text, v_count = 1);

  -- ======================================================= PHASE I: the summary ===

  insert into attendance.alerts (employee_id, alert_date, kind, severity)
  values (v_emp2, v_today, 'no_connection', 'low');

  insert into attendance.app_sessions
    (auth_user_id, employee_id, device_id, started_at, last_seen_at, ended_at, end_reason)
  values
    (v_uid_spare, v_emp2, 'workforce-test-device',
     now() - interval '3 hours', now() - interval '2 hours',
     now() - interval '2 hours', 'expired');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.employee_summary(v_emp2, 30);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the box opens for somebody who has left', 'baja',
     coalesce(v_result ->> 'employee_state', 'null'),
     (v_result ->> 'employee_state') = 'baja');

  insert into test_results(name, expected, got, passed) values
    ('the summary covers the range it was asked for', '30',
     coalesce(v_result ->> 'days', 'null'), (v_result ->> 'days')::integer = 30);

  insert into test_results(name, expected, got, passed) values
    ('a day some punch arrived by sync is counted as one', '1',
     coalesce(v_result ->> 'offline_days', 'null'),
     (v_result ->> 'offline_days')::integer = 1);

  insert into test_results(name, expected, got, passed) values
    ('the disconnection alert is counted, not re-derived', '1',
     coalesce(v_result ->> 'no_connection_alerts', 'null'),
     (v_result ->> 'no_connection_alerts')::integer = 1);

  insert into test_results(name, expected, got, passed) values
    ('a session the sweeper closed is counted', '1',
     coalesce(v_result ->> 'expired_sessions', 'null'),
     (v_result ->> 'expired_sessions')::integer = 1);

  -- HR deciding an alert was worth nothing has to stop it counting, the same
  -- way a dismissed late_entry does.
  update attendance.alerts
     set state = 'dismissed'
   where employee_id = v_emp2 and alert_date = v_today and kind = 'no_connection';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.employee_summary(v_emp2, 30);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a dismissed disconnection stops counting', '0',
     coalesce(v_result ->> 'no_connection_alerts', 'null'),
     (v_result ->> 'no_connection_alerts')::integer = 0);

  -- The weeks are ISO weeks in the employee's own zone, which is the whole
  -- reason they are grouped here and not in the browser.
  select count(*)::integer into v_count
    from jsonb_array_elements(v_result -> 'weeks') as w
   where extract(isodow from (w.value ->> 'week_start')::date) <> 1;

  insert into test_results(name, expected, got, passed) values
    ('every week starts on a Monday', '0', v_count::text, v_count = 0);

  select coalesce(sum((w.value ->> 'worked_seconds')::integer), 0)::integer into v_count
    from jsonb_array_elements(v_result -> 'weeks') as w;

  insert into test_results(name, expected, got, passed) values
    ('the weeks add up to the range', v_result ->> 'worked_seconds', v_count::text,
     v_count = (v_result ->> 'worked_seconds')::integer);

  -- An employee asking about somebody else is refused rather than answered
  -- with zeros. Zeros would read as a perfect absence record.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
  begin
    v_result := public.employee_summary(v_emp2, 30);
    v_ok := false; v_text := 'it answered';
  exception when others then
    v_ok := true; v_text := left(sqlerrm, 45);
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee asking about a colleague is refused, not given zeros', 'refused',
     v_text, v_ok);

  -- ======================================================= PHASE J: the shapes ===

  select count(*)::integer into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('list_employees', 'employee_summary', 'my_summary')
     and p.prosecdef;

  insert into test_results(name, expected, got, passed) values
    ('the three reads invoke', '0', v_count::text, v_count = 0);

  select count(*)::integer into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('reset_day', 'save_employee', 'retire_employee', 'restore_employee')
     and p.prosecdef;

  insert into test_results(name, expected, got, passed) values
    ('the four writers elevate', '4', v_count::text, v_count = 4);

  -- Nothing here is reachable without signing in, and nothing here handed the
  -- client a way to write a table directly.
  select count(*)::integer into v_count
    from information_schema.role_routine_grants
   where grantee = 'anon'
     and specific_schema = 'public'
     and routine_name in ('reset_day', 'save_employee', 'retire_employee',
                          'restore_employee', 'list_employees', 'employee_summary');

  insert into test_results(name, expected, got, passed) values
    ('the public key can call none of them', '0', v_count::text, v_count = 0);

  select count(*)::integer into v_count
    from information_schema.role_table_grants
   where grantee = 'authenticated'
     and table_schema = 'attendance'
     and privilege_type <> 'SELECT';

  insert into test_results(name, expected, got, passed) values
    ('the client still cannot write any attendance table', '0', v_count::text, v_count = 0);

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

-- None of this sticks: not the punches, not the voids, not the two synthetic
-- people, not the accounts, and not the audit rows the writers left.
rollback;
