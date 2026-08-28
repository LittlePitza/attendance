-- Verification of the administration API, run as the role that will call it.
--
-- Same approach as read_api_test.sql and review_api_test.sql: the calls under
-- test run as `authenticated` with a JWT claim, because what these functions are
-- for is deciding who may do what. A suite that ran entirely as `postgres` would
-- pass no matter how the gates were written.
--
-- The switch stays narrow: only the call under test runs as the client, so a
-- fixture failing to insert can never be mistaken for a gate working.
--
-- The cast is four people and four accounts, and every one of them exists to
-- reach a refusal that needs two parties:
--
--   emp1  <- an 'employee' account. Proves the gates turn away the workforce.
--   emp2  <- nobody, at first. The target every account test writes to.
--   emp3  <- the 'hr' account, so HR is a person and can try to act on itself.
--   emp4  <- a second 'admin' account, so "only an admin may touch an admin"
--            and "no admin may demote itself" are both reachable.
--   the seeded admin, linked to nobody: the administrator caller.
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
  v_emp3 uuid := '30000000-0000-4000-8000-0000000000a3';
  v_emp4 uuid := '30000000-0000-4000-8000-0000000000a4';

  v_uid_admin  uuid;
  v_uid_emp    uuid := gen_random_uuid();
  v_uid_hr     uuid := gen_random_uuid();
  v_uid_admin2 uuid := gen_random_uuid();
  v_uid_spare  uuid := gen_random_uuid();
  v_uid_spare2 uuid := gen_random_uuid();

  v_dept1 uuid;

  v_result   jsonb;
  v_count    integer;
  v_text     text;
  v_days     smallint[];
  v_schedule uuid;
  v_global   uuid;
  v_sqlstate text;
begin
  select id into v_uid_admin from auth.users order by created_at, id limit 1;
  select id into v_emp1 from public.empleados where estado = 'activo' order by nombre limit 1;
  select id into v_emp2 from public.empleados
   where estado = 'activo' and id <> v_emp1 order by nombre limit 1;
  select id into v_dept1 from public.departments order by name limit 1;

  if v_uid_admin is null or v_emp2 is null or v_dept1 is null then
    raise exception 'Missing baseline data: need 1 account, 2 active employees and 1 department';
  end if;

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_uid_emp,    'local.employee@example.invalid', '{}'::jsonb),
    (v_uid_hr,     'local.hr@example.invalid',       '{}'::jsonb),
    (v_uid_admin2, 'local.admin2@example.invalid',   '{}'::jsonb),
    (v_uid_spare,  'local.spare@example.invalid',    '{}'::jsonb),
    (v_uid_spare2, 'local.spare2@example.invalid',   '{}'::jsonb);

  insert into public.empleados (id, nombre, correo, puesto, estado, department_id, auth_user_id)
  values
    (v_emp3, 'Persona de Recursos Humanos', 'local.hr@example.invalid',     'Analista de RH', 'activo', v_dept1, v_uid_hr),
    (v_emp4, 'Segunda Administradora',      'local.admin2@example.invalid', 'Sistemas',       'activo', v_dept1, v_uid_admin2);

  update public.empleados set auth_user_id = v_uid_emp where id = v_emp1;

  insert into public.user_roles (auth_user_id, role, note) values
    (v_uid_emp,    'employee', 'Synthetic employee'),
    (v_uid_hr,     'hr',       'Synthetic HR, and a person'),
    (v_uid_admin2, 'admin',    'Synthetic second administrator')
  on conflict (auth_user_id) do update set role = excluded.role;

  -- Every day of the week, so the assertion below holds on a Saturday too. The
  -- seeded global schedule is Monday to Friday and would resolve to nothing.
  insert into attendance.schedules
    (scope, employee_id, name, days, entry_from, entry_until, entry_expected, exit_expected)
  values
    ('employee', v_emp1, 'Horario propio de prueba', '{1,2,3,4,5,6,7}'::smallint[],
     '07:00', '10:00', '09:00', '18:00');

  -- ========================================================= PHASE A: reads ===

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select count(*) into v_count from public.list_accounts();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('HR sees every active person', '4', v_count::text, v_count = 4);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select a.role into v_text
    from public.list_accounts() a where a.employee_id = v_emp1;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the list reports the role behind an account', 'employee',
     coalesce(v_text, 'none'), v_text = 'employee');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select a.schedule_scope into v_text
    from public.list_accounts() a where a.employee_id = v_emp1;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the list says which schedule covers a person', 'employee',
     coalesce(v_text, 'none'), v_text = 'employee');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select count(*) into v_count
    from public.list_accounts() a where a.has_account;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('three of the four have an account', '3', v_count::text, v_count = 3);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
    perform public.list_accounts();
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot read the account list', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
    perform public.list_schedules();
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot read the schedule configuration', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select count(*) into v_count from public.list_alert_rules();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('HR sees every seeded rule, one per kind', '8', v_count::text, v_count = 8);

  -- No refusal here, and that is the design: alert_rules_read is the gate, so an
  -- employee gets an empty answer rather than an error. A second role check
  -- written into the function would be a second definition of the same rule.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
  select count(*) into v_count from public.list_alert_rules();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee sees no alert rules at all', '0', v_count::text, v_count = 0);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  select d.employee_count into v_count
    from public.list_departments() d where d.id = v_dept1;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the catalogue counts the people in a department', '3',
     coalesce(v_count::text, 'none'), v_count = 3);

  -- ====================================================== PHASE B: accounts ===

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
    perform public.link_employee_account(v_emp2, v_uid_spare, 'employee');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot create an account', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.link_employee_account(v_emp2, v_uid_spare, 'admin');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('HR cannot make an administrator', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.link_employee_account(v_emp2, v_uid_spare, 'manager');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('HR gives somebody access', 'manager',
     coalesce(v_result->>'role', 'none'), v_result->>'role' = 'manager');

  select count(*) into v_count
    from public.empleados e
    join public.user_roles ur on ur.auth_user_id = e.auth_user_id
   where e.id = v_emp2 and e.auth_user_id = v_uid_spare and ur.role = 'manager';

  insert into test_results(name, expected, got, passed) values
    ('the link and the role landed together', '1', v_count::text, v_count = 1);

  select count(*) into v_count
    from attendance.audit_events
   where kind = 'account_linked' and entity_id = v_emp2 and actor = v_uid_hr;

  insert into test_results(name, expected, got, passed) values
    ('the account creation is on the record', '1', v_count::text, v_count = 1);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.link_employee_account(v_emp2, v_uid_spare2, 'employee');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a person cannot be given a second account', '23505',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '23505');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.set_account_role(v_emp2, 'hr', 'corto');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a role change under ten characters of reason is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.set_account_role(v_emp2, 'hr', 'Ahora tambien atiende nomina');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the previous role is reported back', 'manager',
     coalesce(v_result->>'previous_role', 'none'), v_result->>'previous_role' = 'manager');

  select count(*) into v_count
    from attendance.audit_events
   where kind = 'account_role_changed'
     and entity_id = v_emp2
     and before_data->>'role' = 'manager'
     and after_data->>'role'  = 'hr';

  insert into test_results(name, expected, got, passed) values
    ('the change records what the role used to be', '1', v_count::text, v_count = 1);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.set_account_role(v_emp2, 'hr', 'Ya lo tenia, no cambia nada');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('setting the role it already has is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.set_account_role(v_emp4, 'manager', 'Ya no administra el sistema');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('HR cannot demote an administrator', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_admin2)::text, true);
    perform public.set_account_role(v_emp4, 'manager', 'Me quito el rol a mi misma');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an administrator cannot demote itself', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_admin)::text, true);
  v_result := public.set_account_role(v_emp4, 'manager', 'Cambia de area, deja de administrar');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('another administrator can', 'manager',
     coalesce(v_result->>'role', 'none'), v_result->>'role' = 'manager');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  perform public.record_password_reset(v_emp2);
  perform set_config('role', 'postgres', true);

  select count(*) into v_count
    from attendance.audit_events
   where kind = 'account_password_reset' and entity_id = v_emp2 and actor = v_uid_hr;

  insert into test_results(name, expected, got, passed) values
    ('handing out a temporary password is on the record', '1', v_count::text, v_count = 1);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.unlink_employee_account(v_emp3, 'Me retiro mi propio acceso');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('nobody can revoke their own access', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  perform public.unlink_employee_account(v_emp2, 'Termina su relacion laboral el viernes');
  perform set_config('role', 'postgres', true);

  select count(*) into v_count
    from public.empleados e
   where e.id = v_emp2 and e.auth_user_id is null;

  insert into test_results(name, expected, got, passed) values
    ('the link is gone', '1', v_count::text, v_count = 1);

  select count(*) into v_count
    from public.user_roles ur where ur.auth_user_id = v_uid_spare;

  insert into test_results(name, expected, got, passed) values
    ('and so is the role', '0', v_count::text, v_count = 0);

  -- The auth account survives on purpose: attendance.adjustments.adjusted_by is
  -- `on delete restrict`, so deleting it would take the record of who decided
  -- what with it.
  select count(*) into v_count from auth.users u where u.id = v_uid_spare;

  insert into test_results(name, expected, got, passed) values
    ('the auth account itself is not deleted', '1', v_count::text, v_count = 1);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.record_password_reset(v_emp2);
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('there is no password to reset without an account', '02000',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '02000');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.link_employee_account(v_emp2, v_uid_emp, 'employee');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an account already in use cannot be handed to somebody else', '23505',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '23505');

  -- ===================================================== PHASE C: schedules ===

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
    perform public.save_schedule('global', 'Mi propio horario',
      '07:00', '10:00', '09:00', '18:00');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot write a schedule', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.save_schedule(
    p_scope => 'department', p_name => 'Turno de planta',
    p_entry_from => '06:00', p_entry_until => '08:00',
    p_entry_expected => '07:00', p_exit_expected => '15:00',
    p_department_id => v_dept1, p_days => array[5, 1, 1, 3]);
  perform set_config('role', 'postgres', true);

  v_schedule := (v_result->>'schedule_id')::uuid;

  insert into test_results(name, expected, got, passed) values
    ('HR creates a schedule for a department', 'true',
     coalesce((v_result->>'created'), 'null'), (v_result->>'created')::boolean);

  select s.days into v_days from attendance.schedules s where s.id = v_schedule;

  insert into test_results(name, expected, got, passed) values
    ('the days are stored sorted and without repeats', '{1,3,5}',
     coalesce(v_days::text, 'none'), v_days = '{1,3,5}'::smallint[]);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.save_schedule(
      p_scope => 'department', p_name => 'Otro turno de planta',
      p_entry_from => '06:00', p_entry_until => '08:00',
      p_entry_expected => '07:00', p_exit_expected => '15:00',
      p_department_id => v_dept1);
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('two live schedules cannot cover the same scope', '23505',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '23505');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.save_schedule('global', 'Ventana incoherente',
      '09:00', '10:00', '08:00', '18:00');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an expected entry outside its own window is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.save_schedule('global', 'Salida antes de entrar',
      '07:00', '10:00', '09:00', '08:00');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('leaving before arriving is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.save_schedule(
      p_scope => 'global', p_name => 'Turno de planta',
      p_entry_from => '06:00', p_entry_until => '08:00',
      p_entry_expected => '07:00', p_exit_expected => '15:00',
      p_id => v_schedule);
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a schedule cannot change what it applies to', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.save_schedule(
    p_scope => 'department', p_name => 'Turno de planta, corrido',
    p_entry_from => '06:00', p_entry_until => '08:00',
    p_entry_expected => '06:30', p_exit_expected => '15:00',
    p_id => v_schedule, p_department_id => v_dept1);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('editing reports that nothing was created', 'false',
     coalesce((v_result->>'created'), 'null'), not (v_result->>'created')::boolean);

  select count(*) into v_count
    from attendance.audit_events
   where kind = 'schedule_updated'
     and entity_id = v_schedule
     and before_data->>'entry_expected' = '07:00:00';

  insert into test_results(name, expected, got, passed) values
    ('the edit records the hour it replaced', '1', v_count::text, v_count = 1);

  select s.id into v_global
    from attendance.schedules s
   where s.scope = 'global' and s.active
   order by s.created_at limit 1;

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.retire_schedule(v_global, 'Ya no aplica a nadie de la empresa');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the last general schedule cannot be retired', '23505',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '23505');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  perform public.retire_schedule(v_schedule, 'La planta vuelve al horario general');
  perform set_config('role', 'postgres', true);

  select count(*) into v_count
    from attendance.schedules s where s.id = v_schedule and not s.active;

  insert into test_results(name, expected, got, passed) values
    ('a retired schedule is deactivated, not deleted', '1', v_count::text, v_count = 1);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.retire_schedule(v_schedule, 'Otra vez, por si acaso');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('retiring it twice is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  -- =================================================== PHASE D: alert rules ===
  -- The bug this replaces: docs/runbook.md documented `on conflict do nothing`
  -- against rows the seed had already created, so the documented way to give HR
  -- an address did nothing at all. The count below is what proves it now does.

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.save_alert_rule('late_entry', true, 5, 'rh@example.invalid, jefe@example.invalid');
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('the existing global rule is updated, not duplicated', 'false',
     coalesce((v_result->>'created'), 'null'), not (v_result->>'created')::boolean);

  select count(*) into v_count
    from attendance.alert_rules r where r.department_id is null;

  -- One global row per alert kind. The count is written out rather than derived
  -- so that adding a kind without seeding its row is a failing test rather than
  -- a rule that quietly never appears on Configuracion -> Alertas.
  insert into test_results(name, expected, got, passed) values
    ('there is still one global rule per kind', '8', v_count::text, v_count = 8);

  select r.recipients into v_text
    from attendance.alert_rules r
   where r.department_id is null and r.kind = 'late_entry';

  insert into test_results(name, expected, got, passed) values
    ('the rule now names who to tell', 'rh@example.invalid, jefe@example.invalid',
     coalesce(v_text, 'none'), v_text = 'rh@example.invalid, jefe@example.invalid');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.save_alert_rule('late_entry', true, 5, 'rh@example.invalid, no-es-un-correo');
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('one bad address refuses the whole list', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  -- A field left blank is not a typo, and it is not a decision to send nowhere
  -- either: the dispatcher falls back to ALERTS_DEFAULT_RECIPIENTS. Null and ''
  -- mean the same thing to it, so they are stored the same way.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  perform public.save_alert_rule('late_entry', true, 5, '   ');
  perform set_config('role', 'postgres', true);

  select count(*) into v_count
    from attendance.alert_rules r
   where r.department_id is null and r.kind = 'late_entry' and r.recipients is null;

  insert into test_results(name, expected, got, passed) values
    ('an empty list is stored as no list', '1', v_count::text, v_count = 1);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.save_alert_rule('late_entry', true, 25, 'planta@example.invalid', v_dept1);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a department rule is created beside the global one', 'true',
     coalesce((v_result->>'created'), 'null'), (v_result->>'created')::boolean);

  select r.threshold_minutes into v_count
    from internal.alert_rule(v_dept1, 'late_entry') r;

  insert into test_results(name, expected, got, passed) values
    ('the evaluator resolves the department rule first', '25',
     coalesce(v_count::text, 'none'), v_count = 25);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
    perform public.save_alert_rule('late_entry', false, 0);
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot change an alert rule', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  -- The kind list lives in three places: the CHECK on `alerts`, the CHECK on
  -- `alert_rules`, and the guard inside `save_alert_rule()`. Widening the two
  -- CHECKs and forgetting the guard leaves a row that is seeded, listed with a
  -- threshold beside it, and refused the moment anybody presses save. This is
  -- that assertion, and it fails for every kind added without the third edit.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.save_alert_rule('early_exit', true, 20);
  perform set_config('role', 'postgres', true);

  select r.threshold_minutes into v_count
    from internal.alert_rule(null, 'early_exit') r;

  insert into test_results(name, expected, got, passed) values
    ('every seeded kind can actually be saved, early_exit included', '20',
     coalesce(v_count::text, 'none'), v_count = 20);

  -- ============================================ PHASE D2: the week is a setting ===
  -- `attendance.settings` is company-wide, so it is edited here rather than on a
  -- department, and the refusals are what stop a screen writing a day that is
  -- not a day.

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.attendance_settings();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('HR reads the configured week start', '4',
     coalesce(v_result ->> 'week_start_dow', 'null'),
     (v_result ->> 'week_start_dow')::smallint = 4);

  -- The policy is the gate, exactly as it is for list_alert_rules: an employee
  -- gets nothing back rather than an error.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
  v_result := public.attendance_settings();
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee reads no settings at all', 'null',
     coalesce(v_result::text, 'null'), v_result is null);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
  v_result := public.save_settings(1::smallint);
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('HR can move the week start', '1',
     coalesce(v_result ->> 'week_start_dow', 'null'),
     (v_result ->> 'week_start_dow')::smallint = 1);

  select count(*)::integer into v_count from attendance.settings;

  insert into test_results(name, expected, got, passed) values
    ('and it is still one row, never two', '1', v_count::text, v_count = 1);

  select count(*)::integer into v_count
    from attendance.audit_events e
   where e.kind = 'settings_saved';

  insert into test_results(name, expected, got, passed) values
    ('the change is on the record', '1', v_count::text, v_count = 1);

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.save_settings(8::smallint);
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('a day outside 1..7 is refused', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    perform public.save_settings(null);
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('and so is no day at all', '22023',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '22023');

  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_emp)::text, true);
    perform public.save_settings(1::smallint);
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('an employee cannot move the week start', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  -- The client never writes tables, and a settings row is the most tempting one
  -- to write directly.
  v_sqlstate := null;
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid_hr)::text, true);
    update attendance.settings set week_start_dow = 3 where id;
  exception when others then
    v_sqlstate := sqlstate;
  end;
  perform set_config('role', 'postgres', true);

  insert into test_results(name, expected, got, passed) values
    ('not even HR can write the settings row directly', '42501',
     coalesce(v_sqlstate, 'no refusal'), v_sqlstate = '42501');

  update attendance.settings set week_start_dow = 4 where id;

  -- =================================================== PHASE E: the contract ===

  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and ((p.proname in ('list_departments', 'list_schedules', 'list_alert_rules')
           and p.prosecdef)
       or (p.proname in ('list_accounts', 'save_schedule', 'retire_schedule',
                         'save_alert_rule', 'link_employee_account',
                         'set_account_role', 'unlink_employee_account',
                         'record_password_reset')
           and not p.prosecdef));

  insert into test_results(name, expected, got, passed) values
    ('only the reads that must elevate do', '0', v_count::text, v_count = 0);

  -- Every function in this API, and nothing may be missing: a name that failed
  -- to be created would otherwise look like a passing suite.
  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('list_accounts', 'list_departments', 'list_schedules',
                       'list_alert_rules', 'save_schedule', 'retire_schedule',
                       'save_alert_rule', 'link_employee_account',
                       'set_account_role', 'unlink_employee_account',
                       'record_password_reset');

  insert into test_results(name, expected, got, passed) values
    ('all eleven functions exist', '11', v_count::text, v_count = 11);

  -- Every one of them fixes its search_path. Without it a manipulated one
  -- allows hijacking a SECURITY DEFINER function, which is most of this file.
  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'internal')
     and p.proname in ('list_accounts', 'list_departments', 'list_schedules',
                       'list_alert_rules', 'save_schedule', 'retire_schedule',
                       'save_alert_rule', 'link_employee_account',
                       'set_account_role', 'unlink_employee_account',
                       'record_password_reset', 'require_role', 'is_email_list')
     and not coalesce(p.proconfig::text like '%search_path=%', false);

  insert into test_results(name, expected, got, passed) values
    ('nothing here inherits a search_path', '0', v_count::text, v_count = 0);

  -- This API added no way for the client to write a table directly. If it had,
  -- every gate above would be decoration.
  select count(*) into v_count
    from information_schema.role_table_grants
   where grantee = 'authenticated'
     and table_schema in ('attendance', 'internal')
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

-- None of this sticks: not the two synthetic employees, not the five accounts,
-- not the schedules, not the alert rules, not the audit rows the writers left.
rollback;
