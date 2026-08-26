-- attendance_admin_api.sql
--
-- The last layer that only existed as SQL somebody would have to type by hand.
--
-- Three things stood between this system and a pilot, and all three were the
-- same shape: a table with rows in it and no way for a person to reach them.
--
--   * **Accounts.** `public.empleados.auth_user_id` was null for all 31 people,
--     so nobody could sign in and `evaluate_alerts()` -- which filters on
--     `auth_user_id is not null` -- had nobody to evaluate. Linking a person to
--     an account meant an UPDATE and an INSERT typed into the SQL editor, with
--     no check that the person was active, that the account was not already
--     somebody else's, or that the role being handed out was one the person
--     handing it out was allowed to hand out.
--
--   * **Schedules.** One global row, seeded by a migration. Changing the hour
--     the company expects people to start meant editing a table the client
--     cannot write to.
--
--   * **Alert rules.** Seven global rows with `recipients` left null, which is
--     why the dispatcher has nothing to send to and refuses to guess. There was
--     no way to fill that column except by hand, and the remedy the runbook
--     documented used `on conflict do nothing` against rows that already exist,
--     so it did nothing at all.
--
-- What follows is that missing half: four read functions and six writers.
--
-- The shape is the one this repository already settled on. Reads are
-- `SECURITY INVOKER` and let RLS decide scope; writes are `SECURITY DEFINER`,
-- gated on the caller's role, and land a row in `attendance.audit_events`. The
-- one read that elevates says why it has to, below.
--
-- What is deliberately NOT here: creating the account itself. `auth.users` is
-- Auth's table, and writing to it means the Admin API and a service key --
-- which is exactly the boundary `CONTRIBUTING.md` draws around Edge Functions
-- ("email, user provisioning, exports"). `supabase/functions/admin-accounts`
-- creates the account and then calls `public.link_employee_account()` here with
-- the human's own token, so the role check and the audit trail record the person
-- who decided, never the service key that executed.

-- ================================================================== the gate ===
-- One place decides who may administer, for the same reason
-- `internal.can_view_employee()` is one place: six writers each rolling their
-- own check is six chances to write it slightly differently, and the one that
-- is wrong is the one nobody reads again.
--
-- The message is a parameter because "solo Recursos Humanos puede ..." is worth
-- finishing with what was actually refused. A gate that says only "no" sends
-- somebody to read the source to find out what they tried to do.

create or replace function internal.require_role(p_allowed text[], p_what text)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
begin
  -- coalesce because this is a security guard: `null <> all (...)` is null, and
  -- an `if` on null does not fire. internal.caller_role() defaults to 'guest'
  -- and cannot return null today, but a gate should not depend on another
  -- function keeping that promise.
  if coalesce(internal.caller_role(), 'guest') <> all (p_allowed) then
    raise exception 'No tienes permiso para %', p_what
      using errcode = '42501';
  end if;
end;
$fn$;

comment on function internal.require_role(text[], text) is
  'Raises 42501 unless the caller holds one of the given roles. One place decides who may administer, the way internal.can_view_employee() is one place for who may read.';

revoke all     on function internal.require_role(text[], text) from public, anon;
grant  execute on function internal.require_role(text[], text) to authenticated;

-- ======================================================= a list of addresses ===
-- `alert_rules.recipients` is a comma-separated list because that is the column
-- the dispatcher already reads. Validating it here rather than in the browser is
-- the difference between a rule that cannot hold a typo and a rule that holds
-- one until the night an alert fails to send.
--
-- The pattern is deliberately loose: it rejects what would certainly fail to
-- send -- an entry with no `@`, a domain with no dot, whitespace inside an
-- address -- and does not attempt to be RFC 5322. A validator stricter than the
-- mail server refuses addresses that work.

create or replace function internal.is_email_list(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_value is null
      or (
        length(trim(p_value)) > 0
        and not exists (
          select 1
            from unnest(string_to_array(p_value, ',')) as entry(address)
           where trim(entry.address) !~ '^[^[:space:]@,]+@[^[:space:]@,.]+(\.[^[:space:]@,.]+)+$'
        )
      );
$fn$;

comment on function internal.is_email_list(text) is
  'True when the value is null or a comma-separated list of plausible addresses. Deliberately looser than RFC 5322: a validator stricter than the mail server refuses addresses that work.';

revoke all     on function internal.is_email_list(text) from public, anon;
grant  execute on function internal.is_email_list(text) to authenticated;

-- ============================================================ list_accounts ===
-- Who can sign in, who cannot, and what each account is allowed to see.
--
-- This is the one read function in the project that is SECURITY DEFINER, and
-- rule 9 asks for the reason in writing. It is this: the answer lives in three
-- places the caller cannot all reach.
--
--   * `public.user_roles` restricts SELECT to admin and to the row's own owner
--     (`user_roles_admin_read`, `user_roles_read_own`). An invoker version would
--     hand `hr` a list where every role but their own was null -- which is the
--     column this screen exists to show.
--   * `auth.users` has no policies at all and is not readable by
--     `authenticated` on any terms. `last_sign_in_at` is what tells HR whether a
--     pilot participant ever actually arrived.
--   * `public.empleados` is scoped by `internal.can_view_employee()`, which is
--     right for the board and wrong here: account administration is not
--     department-scoped, and a manager has no business on this screen at all.
--
-- So the scope is written out instead of inherited, and it is narrow: `hr` and
-- `admin`, nobody else, the whole active roster. Widening it means editing this
-- line, which is the point of having it on one line.
--
-- What it does NOT return, and will not: anything from `auth.users` that is a
-- credential or a token. `email` and `last_sign_in_at` are facts about a person
-- HR already has a file on; the rest of that table is Auth's business.

create or replace function public.list_accounts()
returns table (
  employee_id          uuid,
  employee_name        text,
  employee_email       text,
  job_title            text,
  department_id        uuid,
  department           text,
  has_account          boolean,
  role                 text,
  account_email        text,
  last_sign_in_at      timestamptz,
  must_change_password boolean,
  schedule_scope       text,
  schedule_name        text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  perform internal.require_role(array['hr', 'admin'], 'administrar cuentas');

  return query
    select e.id,
           e.nombre,
           e.correo,
           e.puesto,
           e.department_id,
           d.name,
           e.auth_user_id is not null,
           ur.role,
           u.email::text,
           u.last_sign_in_at,
           -- The temporary password the Edge Function hands out sets this flag,
           -- and the PWA clears it when the person chooses their own. While it
           -- is true, HR still knows the password -- which is the whole reason
           -- it is on this screen.
           coalesce((u.raw_user_meta_data ->> 'must_change_password')::boolean, false),
           s.scope,
           s.name
      from public.empleados e
      left join public.departments d  on d.id = e.department_id
      left join auth.users u          on u.id = e.auth_user_id
      left join public.user_roles ur  on ur.auth_user_id = e.auth_user_id
      -- The schedule in force today, so the screen can say who has no rules at
      -- all rather than leaving somebody to work that out from three tables.
      left join lateral internal.resolve_schedule(
                  e.id,
                  (now() at time zone coalesce(d.time_zone, 'America/Mexico_City'))::date) s
             on true
     where e.estado = 'activo'
     order by e.nombre;
end;
$fn$;

comment on function public.list_accounts() is
  'Every active employee with the state of their access: whether they have an account, what role it holds, when they last signed in, and which schedule covers them. HR and admin only.';

revoke all     on function public.list_accounts() from public, anon;
grant  execute on function public.list_accounts() to authenticated;

-- ========================================================= list_departments ===
-- The catalogue, as something to choose from. `public.departments` is readable
-- by `authenticated` already -- `departments_read` is `using (true)`, on purpose
-- -- so this elevates nothing. It exists so the client keeps calling functions
-- instead of learning to select from tables: `web/src/lib/api.ts` is the only
-- module that names a database object, and one table read there would end that.
--
-- `employee_count` is counted through the caller's own view of
-- `public.empleados`, so an employee asking would be told 1. That is RLS working
-- rather than a bug, and it is why the count is only ever read on the
-- administration screen, where the caller is HR or admin and sees everyone.

create or replace function public.list_departments()
returns table (
  id             uuid,
  name           text,
  time_zone      text,
  active         boolean,
  employee_count integer
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select d.id,
         d.name,
         d.time_zone,
         d.active,
         (select count(*)::integer
            from public.empleados e
           where e.department_id = d.id
             and e.estado = 'activo')
    from public.departments d
   order by d.name;
$fn$;

comment on function public.list_departments() is
  'The department catalogue with its active headcount. Readable by anyone signed in, because attendance.schedules already is.';

revoke all     on function public.list_departments() from public, anon;
grant  execute on function public.list_departments() to authenticated;

-- =========================================================== list_schedules ===
-- Every schedule, with the thing it applies to named rather than referenced.
--
-- INVOKER, so `schedules_read` (`using (true)`) is what lets it answer and the
-- names come back through the policies on `empleados` and `departments`. The
-- role gate is here anyway, and it is not elevation -- it is this function
-- refusing early. An employee has no use for the list: the schedule that
-- concerns them travels with `my_day()`, already resolved.

create or replace function public.list_schedules()
returns table (
  id                uuid,
  scope             text,
  applies_to        text,
  department_id     uuid,
  employee_id       uuid,
  name              text,
  days              smallint[],
  entry_from        text,
  entry_until       text,
  entry_expected    text,
  exit_expected     text,
  grace_minutes     integer,
  break_max_minutes integer,
  valid_from        date,
  valid_until       date,
  active            boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
begin
  perform internal.require_role(array['hr', 'admin'], 'ver la configuracion de horarios');

  return query
    select s.id,
           s.scope,
           -- Resolved here rather than in the browser: the client would have to
           -- hold three lists and join them to print one line.
           case s.scope
             when 'global'     then 'Toda la empresa'
             when 'department' then coalesce(d.name,   'Departamento eliminado')
             else                   coalesce(e.nombre, 'Empleado eliminado')
           end,
           s.department_id,
           s.employee_id,
           s.name,
           s.days,
           -- HH:MM, the same shape my_day() sends, so the client has one format
           -- for a time of day and not two.
           to_char(s.entry_from,     'HH24:MI'),
           to_char(s.entry_until,    'HH24:MI'),
           to_char(s.entry_expected, 'HH24:MI'),
           to_char(s.exit_expected,  'HH24:MI'),
           s.grace_minutes,
           s.break_max_minutes,
           s.valid_from,
           s.valid_until,
           s.active
      from attendance.schedules s
      left join public.departments d on d.id = s.department_id
      left join public.empleados   e on e.id = s.employee_id
     order by s.active desc,
              case s.scope when 'global' then 1 when 'department' then 2 else 3 end,
              s.name;
end;
$fn$;

comment on function public.list_schedules() is
  'Every schedule with the department or person it applies to named. Times are HH:MM, the same shape my_day() sends.';

revoke all     on function public.list_schedules() from public, anon;
grant  execute on function public.list_schedules() to authenticated;

-- ========================================================= list_alert_rules ===
-- INVOKER with no gate written here, and that is not an omission:
-- `alert_rules_read` is already `caller_role() in ('manager','hr','admin')`, so
-- the policy is the gate. Writing it a second time would be a second definition
-- of it, and the two would eventually disagree.

create or replace function public.list_alert_rules()
returns table (
  id                uuid,
  department_id     uuid,
  department        text,
  kind              text,
  active            boolean,
  threshold_minutes integer,
  recipients        text,
  updated_at        timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select r.id,
         r.department_id,
         coalesce(d.name, 'Toda la empresa'),
         r.kind,
         r.active,
         r.threshold_minutes,
         r.recipients,
         r.updated_at
    from attendance.alert_rules r
    left join public.departments d on d.id = r.department_id
   order by r.department_id nulls first, r.kind;
$fn$;

comment on function public.list_alert_rules() is
  'Alert rules with their department named. Scope comes from the alert_rules_read policy, not from a role check written here.';

revoke all     on function public.list_alert_rules() from public, anon;
grant  execute on function public.list_alert_rules() to authenticated;

-- ============================================================ save_schedule ===
-- Create or edit, in one function, because from the screen it is one action.
--
-- **Editing is in place, and that is a decision with a cost.** A schedule is
-- what alerts are measured against, so moving `entry_expected` back an hour
-- changes what "late" meant -- for today and yesterday, which are the two days
-- `evaluate_alerts()` still looks at. Anything older is already written down as
-- an alert with its own details, and those do not move. The alternative --
-- versioning every schedule and resolving by date -- buys accuracy over a window
-- of two days and costs a second resolution path for every read. The audit row
-- carries `before_data`, so what the schedule used to say is recoverable
-- without it.
--
-- The three partial unique indexes on the table allow exactly one open-ended
-- active schedule per scope. Hitting one is the ordinary case -- HR opens the
-- screen to change the company's hours -- so it is answered with a sentence
-- instead of a constraint name.

create or replace function public.save_schedule(
  p_scope             text,
  p_name              text,
  p_entry_from        time,
  p_entry_until       time,
  p_entry_expected    time,
  p_exit_expected     time,
  p_id                uuid    default null,
  p_department_id     uuid    default null,
  p_employee_id       uuid    default null,
  p_days              integer[] default array[1, 2, 3, 4, 5],
  p_grace_minutes     integer default 10,
  p_break_max_minutes integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_before attendance.schedules;
  v_after  attendance.schedules;
  v_days   smallint[];
begin
  perform internal.require_role(array['hr', 'admin'], 'cambiar horarios');

  if p_scope not in ('global', 'department', 'employee') then
    raise exception 'El alcance debe ser toda la empresa, un departamento o una persona'
      using errcode = '22023',
            hint    = 'global, department o employee';
  end if;

  -- The table's own `schedules_scope_coherent` check says the same thing. It is
  -- said here first so the answer names the field that is wrong.
  if p_scope = 'department' and p_department_id is null then
    raise exception 'Falta el departamento al que aplica el horario'
      using errcode = '22023';
  end if;

  if p_scope = 'employee' and p_employee_id is null then
    raise exception 'Falta la persona a la que aplica el horario'
      using errcode = '22023';
  end if;

  if p_name is null or length(trim(p_name)) < 3 then
    raise exception 'El horario necesita un nombre de al menos 3 caracteres'
      using errcode = '22023';
  end if;

  if p_days is null or array_length(p_days, 1) is null then
    raise exception 'El horario debe aplicar en al menos un dia de la semana'
      using errcode = '22023';
  end if;

  if exists (select 1 from unnest(p_days) as d(n) where d.n < 1 or d.n > 7) then
    raise exception 'Los dias van del 1 (lunes) al 7 (domingo)'
      using errcode = '22023';
  end if;

  -- Sorted and de-duplicated so `{5,1,1}` and `{1,5}` are stored as the same
  -- schedule. The engine reads this with `= any(days)`, so order never mattered
  -- to it -- it matters to the person reading the row back.
  select array_agg(distinct d.n order by d.n)::smallint[] into v_days
    from unnest(p_days) as d(n);

  if p_entry_from > p_entry_until then
    raise exception 'La ventana de entrada empieza despues de terminar'
      using errcode = '22023';
  end if;

  if p_entry_expected < p_entry_from or p_entry_expected > p_entry_until then
    raise exception 'La hora de entrada esperada queda fuera de la ventana de entrada'
      using errcode = '22023';
  end if;

  if p_exit_expected <= p_entry_expected then
    raise exception 'La salida esperada no puede ser antes de la entrada'
      using errcode = '22023';
  end if;

  if p_grace_minutes < 0 or p_grace_minutes > 120 then
    raise exception 'La tolerancia va de 0 a 120 minutos'
      using errcode = '22023';
  end if;

  if p_break_max_minutes < 0 or p_break_max_minutes > 480 then
    raise exception 'La pausa maxima va de 0 a 480 minutos'
      using errcode = '22023';
  end if;

  -- ------------------------------------------------------------------ update ---
  if p_id is not null then
    select s.* into v_before from attendance.schedules s where s.id = p_id;

    if v_before.id is null then
      raise exception 'Ese horario no existe'
        using errcode = '02000';
    end if;

    -- Moving a schedule between scopes would silently take a person or a
    -- department out from under it. Retiring it and creating the new one makes
    -- that visible in the audit trail, which is where it belongs.
    if v_before.scope <> p_scope then
      raise exception 'No se puede cambiar el alcance de un horario existente'
        using errcode = '22023',
              hint    = 'Retira este horario y crea el nuevo';
    end if;

    update attendance.schedules s
       set name              = trim(p_name),
           days              = v_days,
           entry_from        = p_entry_from,
           entry_until       = p_entry_until,
           entry_expected    = p_entry_expected,
           exit_expected     = p_exit_expected,
           grace_minutes     = p_grace_minutes,
           break_max_minutes = p_break_max_minutes
     where s.id = p_id
    returning * into v_after;

  -- ------------------------------------------------------------------ insert ---
  else
    if p_scope = 'department'
       and not exists (select 1 from public.departments d where d.id = p_department_id) then
      raise exception 'Ese departamento no existe'
        using errcode = '02000';
    end if;

    if p_scope = 'employee'
       and not exists (select 1 from public.empleados e
                        where e.id = p_employee_id and e.estado = 'activo') then
      raise exception 'Esa persona no existe o no esta activa'
        using errcode = '02000';
    end if;

    if exists (
      select 1
        from attendance.schedules s
       where s.scope = p_scope
         and s.active
         and s.valid_until is null
         and s.department_id is not distinct from
             case when p_scope = 'department' then p_department_id end
         and s.employee_id is not distinct from
             case when p_scope = 'employee' then p_employee_id end
    ) then
      raise exception 'Ya hay un horario vigente para ese alcance'
        using errcode = '23505',
              hint    = 'Edita el que ya existe, o retiralo antes de crear otro';
    end if;

    insert into attendance.schedules
      (scope, department_id, employee_id, name, days,
       entry_from, entry_until, entry_expected, exit_expected,
       grace_minutes, break_max_minutes)
    values
      (p_scope,
       case when p_scope = 'department' then p_department_id end,
       case when p_scope = 'employee'   then p_employee_id   end,
       trim(p_name), v_days,
       p_entry_from, p_entry_until, p_entry_expected, p_exit_expected,
       p_grace_minutes, p_break_max_minutes)
    returning * into v_after;
  end if;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    (case when p_id is null then 'schedule_created' else 'schedule_updated' end,
     'attendance.schedules', v_after.id, auth.uid(),
     format('%s (%s)', v_after.name, v_after.scope),
     case when v_before.id is null then null else to_jsonb(v_before) end,
     to_jsonb(v_after));

  return jsonb_build_object(
    'schedule_id', v_after.id,
    'scope',       v_after.scope,
    'created',     p_id is null);
end;
$fn$;

comment on function public.save_schedule(text, text, time, time, time, time, uuid, uuid, uuid, integer[], integer, integer) is
  'Creates or edits a schedule. Edits in place and records the previous values in attendance.audit_events; the alert evaluator only ever re-reads today and yesterday.';

revoke all on function public.save_schedule(
  text, text, time, time, time, time, uuid, uuid, uuid, integer[], integer, integer)
  from public, anon;
grant execute on function public.save_schedule(
  text, text, time, time, time, time, uuid, uuid, uuid, integer[], integer, integer)
  to authenticated;

-- ========================================================== retire_schedule ===
-- Deactivated, never deleted. `attendance.workdays.schedule_id` points at the
-- schedule a day was measured against, and deleting the row would either take
-- the workday with it or leave it pointing at nothing -- in both cases losing
-- the answer to "what were they supposed to do that day".

create or replace function public.retire_schedule(
  p_schedule_id uuid,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_before attendance.schedules;
begin
  perform internal.require_role(array['hr', 'admin'], 'retirar horarios');

  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'El motivo debe tener al menos 10 caracteres'
      using errcode = '22023';
  end if;

  select s.* into v_before from attendance.schedules s where s.id = p_schedule_id;

  if v_before.id is null then
    raise exception 'Ese horario no existe'
      using errcode = '02000';
  end if;

  if not v_before.active then
    raise exception 'Ese horario ya estaba retirado'
      using errcode = '22023';
  end if;

  -- The global schedule is what covers the 8 people with no department. Retiring
  -- the last one leaves them with no rules and no alerts, silently -- the
  -- evaluator simply finds nothing to measure and reports success.
  if v_before.scope = 'global'
     and not exists (
       select 1 from attendance.schedules s
        where s.scope = 'global' and s.active and s.id <> p_schedule_id) then
    raise exception 'Es el unico horario general activo y cubre a quien no tiene departamento'
      using errcode = '23505',
            hint    = 'Crea el horario general que lo reemplaza antes de retirar este';
  end if;

  update attendance.schedules s
     set active = false
   where s.id = p_schedule_id;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('schedule_retired', 'attendance.schedules', p_schedule_id, auth.uid(), p_reason,
     to_jsonb(v_before),
     jsonb_build_object('active', false));

  return jsonb_build_object('schedule_id', p_schedule_id, 'active', false);
end;
$fn$;

comment on function public.retire_schedule(uuid, text) is
  'Deactivates a schedule, never deletes it: attendance.workdays.schedule_id is the record of what a day was measured against.';

revoke all     on function public.retire_schedule(uuid, text) from public, anon;
grant  execute on function public.retire_schedule(uuid, text) to authenticated;

-- ========================================================== save_alert_rule ===
-- The function that finally fills `recipients`.
--
-- An upsert on a partial unique index has to name the index's predicate, which
-- is why this is two statements and not one: `alert_rules_global` covers
-- `where department_id is null` and `alert_rules_per_department` covers the
-- rest, and `on conflict` can only infer one of them at a time.
--
-- An absent rule means "use the evaluator's default threshold", never
-- "disabled". Turning a kind off is `active = false` on a row that exists, and
-- that distinction is why this never deletes.

create or replace function public.save_alert_rule(
  p_kind              text,
  p_active            boolean,
  p_threshold_minutes integer,
  p_recipients        text default null,
  p_department_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_before     attendance.alert_rules;
  v_after      attendance.alert_rules;
  v_recipients text;
begin
  perform internal.require_role(array['hr', 'admin'], 'cambiar las reglas de alerta');

  if p_kind not in ('late_entry', 'missing_entry', 'break_exceeded', 'missing_exit',
                    'no_connection', 'review_offline', 'clock_tampered') then
    raise exception 'Ese tipo de alerta no existe'
      using errcode = '22023';
  end if;

  if p_active is null then
    raise exception 'Falta decir si la regla esta activa'
      using errcode = '22023';
  end if;

  if p_threshold_minutes is null or p_threshold_minutes < 0 or p_threshold_minutes > 1440 then
    raise exception 'El umbral va de 0 a 1440 minutos'
      using errcode = '22023';
  end if;

  if p_department_id is not null
     and not exists (select 1 from public.departments d where d.id = p_department_id) then
    raise exception 'Ese departamento no existe'
      using errcode = '02000';
  end if;

  -- Empty and null mean the same thing to the dispatcher -- no addresses on the
  -- rule -- so they are stored as the same thing. An empty string that survived
  -- would fail `is_email_list` and refuse a form the person left blank on
  -- purpose.
  v_recipients := nullif(trim(coalesce(p_recipients, '')), '');

  if not internal.is_email_list(v_recipients) then
    raise exception 'Los destinatarios deben ser correos separados por coma'
      using errcode = '22023';
  end if;

  select r.* into v_before
    from attendance.alert_rules r
   where r.kind = p_kind
     and r.department_id is not distinct from p_department_id;

  if p_department_id is null then
    insert into attendance.alert_rules
      (department_id, kind, active, threshold_minutes, recipients)
    values (null, p_kind, p_active, p_threshold_minutes, v_recipients)
    on conflict (kind) where department_id is null
      do update set active            = excluded.active,
                    threshold_minutes = excluded.threshold_minutes,
                    recipients        = excluded.recipients
    returning * into v_after;
  else
    insert into attendance.alert_rules
      (department_id, kind, active, threshold_minutes, recipients)
    values (p_department_id, p_kind, p_active, p_threshold_minutes, v_recipients)
    on conflict (department_id, kind) where department_id is not null
      do update set active            = excluded.active,
                    threshold_minutes = excluded.threshold_minutes,
                    recipients        = excluded.recipients
    returning * into v_after;
  end if;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('alert_rule_saved', 'attendance.alert_rules', v_after.id, auth.uid(),
     format('%s (%s)', v_after.kind,
            coalesce((select d.name from public.departments d where d.id = v_after.department_id),
                     'toda la empresa')),
     case when v_before.id is null then null else to_jsonb(v_before) end,
     to_jsonb(v_after));

  return jsonb_build_object(
    'rule_id',  v_after.id,
    'kind',     v_after.kind,
    'active',   v_after.active,
    'created',  v_before.id is null);
end;
$fn$;

comment on function public.save_alert_rule(text, boolean, integer, text, uuid) is
  'Creates or updates one alert rule, including the addresses the dispatcher sends to. Never deletes: an absent rule means "use the default threshold", not "disabled".';

revoke all     on function public.save_alert_rule(text, boolean, integer, text, uuid) from public, anon;
grant  execute on function public.save_alert_rule(text, boolean, integer, text, uuid) to authenticated;

-- ==================================================== link_employee_account ===
-- The other half of account creation. `supabase/functions/admin-accounts`
-- creates the row in `auth.users`, because only the Admin API can; this decides
-- whether that account may become this person's, and hands it a role.
--
-- It is called with the HR person's own token, not the service key. That is the
-- whole reason this is a separate function rather than four statements inside
-- the Edge Function: the gate below checks the human, and `auth.uid()` in the
-- audit row is the human. A service key doing it would record that a key did it.

create or replace function public.link_employee_account(
  p_employee_id  uuid,
  p_auth_user_id uuid,
  p_role         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_caller_role text;
  v_employee    public.empleados;
  v_holder      text;
begin
  perform internal.require_role(array['hr', 'admin'], 'crear cuentas de acceso');
  v_caller_role := coalesce(internal.caller_role(), 'guest');

  if p_role not in ('employee', 'manager', 'hr', 'admin') then
    raise exception 'Ese rol no existe'
      using errcode = '22023',
            hint    = 'employee, manager, hr o admin';
  end if;

  -- HR provisions the workforce; only an administrator creates another
  -- administrator. Without this line the first HR account can grant itself
  -- everything, which makes the two roles the same role.
  if p_role = 'admin' and v_caller_role <> 'admin' then
    raise exception 'Solo un administrador puede otorgar el rol de administrador'
      using errcode = '42501';
  end if;

  select e.* into v_employee from public.empleados e where e.id = p_employee_id;

  if v_employee.id is null then
    raise exception 'Esa persona no esta en el catalogo de empleados'
      using errcode = '02000';
  end if;

  if v_employee.estado <> 'activo' then
    raise exception 'Esa persona no esta activa'
      using errcode = '22023';
  end if;

  if v_employee.auth_user_id is not null then
    raise exception 'Esa persona ya tiene una cuenta'
      using errcode = '23505',
            hint    = 'Cambia su rol, o retira la cuenta actual antes de ligar otra';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_auth_user_id) then
    raise exception 'Esa cuenta de acceso no existe'
      using errcode = '02000';
  end if;

  -- `employees_auth_user_id_unique` would catch this, with a constraint name.
  -- Naming the person instead is the difference between an answer and an error.
  select e.nombre into v_holder
    from public.empleados e
   where e.auth_user_id = p_auth_user_id;

  if v_holder is not null then
    raise exception 'Esa cuenta de acceso ya es de %', v_holder
      using errcode = '23505';
  end if;

  update public.empleados e
     set auth_user_id = p_auth_user_id
   where e.id = p_employee_id;

  -- An account can pre-exist its link -- the administrator account did, and its
  -- role row with it -- so this is an upsert rather than an insert.
  insert into public.user_roles (auth_user_id, role, note)
  values (p_auth_user_id, p_role,
          format('Cuenta de %s, creada para el checador', v_employee.nombre))
  on conflict (auth_user_id) do update
    set role = excluded.role,
        note = excluded.note;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('account_linked', 'public.empleados', p_employee_id, auth.uid(),
     format('%s recibio acceso como %s', v_employee.nombre, p_role),
     jsonb_build_object('auth_user_id', null, 'role', null),
     jsonb_build_object('auth_user_id', p_auth_user_id, 'role', p_role));

  return jsonb_build_object(
    'employee_id',   p_employee_id,
    'employee_name', v_employee.nombre,
    'auth_user_id',  p_auth_user_id,
    'role',          p_role);
end;
$fn$;

comment on function public.link_employee_account(uuid, uuid, text) is
  'Makes an existing auth account belong to an employee and gives it a role. Called with the HR person''s own token so the gate checks the human and the audit records them.';

revoke all     on function public.link_employee_account(uuid, uuid, text) from public, anon;
grant  execute on function public.link_employee_account(uuid, uuid, text) to authenticated;

-- ========================================================= set_account_role ===
-- Changing what an account may see. Three guards, and each one exists because
-- of a way this could otherwise end badly.

create or replace function public.set_account_role(
  p_employee_id uuid,
  p_role        text,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_caller_role text;
  v_employee    public.empleados;
  v_current     text;
begin
  perform internal.require_role(array['hr', 'admin'], 'cambiar roles');
  v_caller_role := coalesce(internal.caller_role(), 'guest');

  if p_role not in ('employee', 'manager', 'hr', 'admin') then
    raise exception 'Ese rol no existe'
      using errcode = '22023',
            hint    = 'employee, manager, hr o admin';
  end if;

  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'El motivo debe tener al menos 10 caracteres'
      using errcode = '22023';
  end if;

  select e.* into v_employee from public.empleados e where e.id = p_employee_id;

  if v_employee.id is null or v_employee.auth_user_id is null then
    raise exception 'Esa persona no tiene cuenta de acceso'
      using errcode = '02000';
  end if;

  select ur.role into v_current
    from public.user_roles ur
   where ur.auth_user_id = v_employee.auth_user_id;

  if p_role = 'admin' and v_caller_role <> 'admin' then
    raise exception 'Solo un administrador puede otorgar el rol de administrador'
      using errcode = '42501';
  end if;

  if v_current = 'admin' and v_caller_role <> 'admin' then
    raise exception 'Solo un administrador puede cambiar el rol de otro administrador'
      using errcode = '42501';
  end if;

  -- Losing your own administrator role mid-change leaves you unable to undo it.
  -- Somebody else with the role has to do it, which is also the review this
  -- particular change deserves.
  --
  -- Together with the line above, this is also what makes it impossible to leave
  -- the database with no administrator: demoting one requires being one, and
  -- requires not being the one being demoted -- so there are always at least two
  -- when this statement runs. No separate "is this the last admin" count is
  -- needed, and one would be unreachable code pretending to be a safeguard.
  if v_employee.auth_user_id = auth.uid() and v_current = 'admin' and p_role <> 'admin' then
    raise exception 'No puedes quitarte tu propio rol de administrador'
      using errcode = '22023',
            hint    = 'Pideselo a otro administrador';
  end if;

  if v_current = p_role then
    raise exception 'Esa cuenta ya tiene el rol %', p_role
      using errcode = '22023';
  end if;

  insert into public.user_roles (auth_user_id, role, note)
  values (v_employee.auth_user_id, p_role, p_reason)
  on conflict (auth_user_id) do update
    set role = excluded.role,
        note = excluded.note;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('account_role_changed', 'public.empleados', p_employee_id, auth.uid(), p_reason,
     jsonb_build_object('role', v_current),
     jsonb_build_object('role', p_role));

  return jsonb_build_object(
    'employee_id',   p_employee_id,
    'employee_name', v_employee.nombre,
    'role',          p_role,
    'previous_role', v_current);
end;
$fn$;

comment on function public.set_account_role(uuid, text, text) is
  'Changes an account''s role, with a mandatory reason. Only an administrator may touch an administrator, and none may demote itself -- which is also what makes an administrator-less database impossible.';

revoke all     on function public.set_account_role(uuid, text, text) from public, anon;
grant  execute on function public.set_account_role(uuid, text, text) to authenticated;

-- ================================================== unlink_employee_account ===
-- Taking access away.
--
-- The `auth.users` row survives. Deleting it is Auth's business and it would
-- take with it the `acknowledged_by` and `adjusted_by` references that say who
-- decided what -- `attendance.adjustments.adjusted_by` is `on delete restrict`
-- precisely so that cannot happen quietly. Unlinking is enough to close the
-- door: `internal.caller_employee_id()` returns null, so `my_day()` refuses,
-- and with no role row `internal.caller_role()` answers 'guest', which grants
-- nothing.

create or replace function public.unlink_employee_account(
  p_employee_id uuid,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_caller_role text;
  v_employee    public.empleados;
  v_current     text;
begin
  perform internal.require_role(array['hr', 'admin'], 'retirar cuentas de acceso');
  v_caller_role := coalesce(internal.caller_role(), 'guest');

  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'El motivo debe tener al menos 10 caracteres'
      using errcode = '22023';
  end if;

  select e.* into v_employee from public.empleados e where e.id = p_employee_id;

  if v_employee.id is null or v_employee.auth_user_id is null then
    raise exception 'Esa persona no tiene cuenta de acceso'
      using errcode = '02000';
  end if;

  if v_employee.auth_user_id = auth.uid() then
    raise exception 'No puedes retirar tu propia cuenta'
      using errcode = '22023';
  end if;

  select ur.role into v_current
    from public.user_roles ur
   where ur.auth_user_id = v_employee.auth_user_id;

  -- With the line above, this is also the guard against a database left with no
  -- administrator: retiring one requires being one and requires not being the
  -- one retired, so at least two exist whenever this runs.
  if v_current = 'admin' and v_caller_role <> 'admin' then
    raise exception 'Solo un administrador puede retirar la cuenta de otro administrador'
      using errcode = '42501';
  end if;

  delete from public.user_roles ur where ur.auth_user_id = v_employee.auth_user_id;

  update public.empleados e
     set auth_user_id = null
   where e.id = p_employee_id;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('account_unlinked', 'public.empleados', p_employee_id, auth.uid(), p_reason,
     jsonb_build_object('auth_user_id', v_employee.auth_user_id, 'role', v_current),
     jsonb_build_object('auth_user_id', null, 'role', null));

  return jsonb_build_object(
    'employee_id',   p_employee_id,
    'employee_name', v_employee.nombre,
    'auth_user_id',  v_employee.auth_user_id,
    'previous_role', v_current);
end;
$fn$;

comment on function public.unlink_employee_account(uuid, text) is
  'Takes an employee''s access away and leaves the auth account in place: deleting it would take the record of who decided what with it.';

revoke all     on function public.unlink_employee_account(uuid, text) from public, anon;
grant  execute on function public.unlink_employee_account(uuid, text) to authenticated;

-- ====================================================== record_password_reset ===
-- The one administrative action whose effect happens somewhere else.
--
-- Resetting a password is an Auth write, so the database never sees it and would
-- otherwise have no record that HR handed out a credential. This function writes
-- that record and nothing else: it takes no password, cannot change one, and
-- exists so `attendance.audit_events` stays the answer to "who did what".
--
-- It is deliberately not generic. A `note_account_event(kind, body)` would let
-- any HR session write any row into the audit log, which turns the log into
-- something a person can dress up. This writes one kind, about one person, with
-- the actor taken from the token.

create or replace function public.record_password_reset(p_employee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_employee public.empleados;
begin
  perform internal.require_role(array['hr', 'admin'], 'restablecer contrasenas');

  select e.* into v_employee from public.empleados e where e.id = p_employee_id;

  if v_employee.id is null or v_employee.auth_user_id is null then
    raise exception 'Esa persona no tiene cuenta de acceso'
      using errcode = '02000';
  end if;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, after_data)
  values
    ('account_password_reset', 'public.empleados', p_employee_id, auth.uid(),
     format('Se entrego una contrasena temporal a %s', v_employee.nombre),
     jsonb_build_object('must_change_password', true));

  return jsonb_build_object('employee_id', p_employee_id, 'recorded', true);
end;
$fn$;

comment on function public.record_password_reset(uuid) is
  'Records that HR handed out a temporary password. Takes no password and cannot change one: the reset itself is an Auth write made by supabase/functions/admin-accounts.';

revoke all     on function public.record_password_reset(uuid) from public, anon;
grant  execute on function public.record_password_reset(uuid) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The reads that may invoke do, the one that must elevate says so, and
--   --    every writer elevates. admin_api_test.sql asserts this too.
--   select p.proname,
--          case p.prosecdef when true then 'definer' else 'invoker' end as security
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('list_accounts', 'list_departments', 'list_schedules',
--                        'list_alert_rules', 'save_schedule', 'retire_schedule',
--                        'save_alert_rule', 'link_employee_account',
--                        'set_account_role', 'unlink_employee_account',
--                        'record_password_reset')
--    order by p.prosecdef, p.proname;
--   -- Expected: list_departments, list_schedules and list_alert_rules are
--   -- 'invoker'; list_accounts and the seven writers are 'definer'.
--
--   -- 2. Nothing here granted the client a table privilege by accident:
--   select table_schema, table_name, privilege_type
--     from information_schema.role_table_grants
--    where grantee = 'authenticated'
--      and table_schema = 'attendance'
--      and privilege_type <> 'SELECT';
--   -- Expected: 0 rows.
--
--   -- 3. Administration is being recorded, which nothing did before:
--   select kind, count(*), max(created_at)
--     from attendance.audit_events
--    where kind in ('account_linked', 'account_role_changed', 'account_unlinked',
--                   'schedule_created', 'schedule_updated', 'schedule_retired',
--                   'alert_rule_saved')
--    group by kind order by kind;
--
--   -- 4. There is at least one administrator, and the rules name a recipient:
--   select count(*) filter (where role = 'admin') as admins from public.user_roles;
--   select kind, active, threshold_minutes, recipients is not null as has_recipients
--     from attendance.alert_rules where department_id is null order by kind;
