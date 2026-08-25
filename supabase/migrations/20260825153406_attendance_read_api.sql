-- attendance_read_api.sql
--
-- The client had no way to read anything.
--
-- `attendance` is deliberately not an exposed schema, so PostgREST cannot reach
-- `attendance.workdays` however many privileges the caller holds. The SELECT
-- grants and the RLS policies on those tables were written for a reader that
-- had no way to arrive: the five functions published in `public` all write.
--
-- These four are the read half of that contract. They are the shape the PWA is
-- written against, which is why the range caps and the field names matter more
-- than they look -- changing them later is changing an API.
--
-- They are SECURITY INVOKER, and that is the entire design:
--
--   * A write elevates because it must. It is the only path that may write at
--     all, so it has to hold privileges the caller does not.
--
--   * A read must not elevate. `internal.can_view_employee()` already decides
--     who sees whom, in one place, and the column grants on `punches` already
--     withhold `geo_lat` and `geo_lng` by never granting them. A SECURITY
--     DEFINER read function would have to reimplement both, and could get
--     either one wrong quietly. An invoker one cannot return a row that RLS
--     would not have handed the caller anyway: a bug in this file is a bug in
--     what is displayed, never a leak.
--
-- The comment on the RLS block in the attendance schema migration already said
-- this was the intent -- "SELECT filtrado por RLS para que las vistas con
-- security_invoker funcionen". This is that reader, three migrations later.

-- ================================================== legal next transitions ===
-- The punch screen has to know which buttons to show. The rule this repository
-- holds to is that the PWA carries no logic, so it cannot decide that from the
-- state itself: it asks.
--
-- This is a projection of the state machine in `internal.record_punch()`, and a
-- projection is the thing this repository warns about -- two copies drift, and
-- one eventually offers a button the other rejects. What keeps them together is
-- not discipline, it is `read_api_test.sql`: it puts a workday in each state and
-- attempts all four punch kinds against the live engine, then asserts the set
-- that succeeded is exactly the set this function returned. Drift cannot land
-- green.
--
-- The engine stays authoritative. If they ever disagree, this is the one that
-- is wrong.

create or replace function internal.allowed_punches(p_state text)
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select case p_state
    when 'not_started' then array['clock_in']
    when 'working'     then array['break_start', 'clock_out']
    when 'on_break'    then array['break_end', 'clock_out']
    else                    array[]::text[]     -- finished, and anything new
  end;
$fn$;

comment on function internal.allowed_punches(text) is
  'Punch kinds the engine accepts from a given workday state. Projection of internal.record_punch(); the engine decides, this only reports.';

revoke all     on function internal.allowed_punches(text) from public;
grant  execute on function internal.allowed_punches(text) to authenticated;

-- ============================================================== my_day() ===
-- Everything the punch screen needs, in one round trip: the state, the counters,
-- the schedule it is measured against, today's punches and the server's clock.
--
-- One call rather than five because the screen is useless with a partial
-- answer, and because every one of those values has to describe the same
-- instant. Fetched separately, the state could come from before a punch and the
-- counters from after it.

create or replace function public.my_day()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_employee_id uuid;
  v_zone        text;
  v_date        date;
  v_workday     attendance.workdays;
  v_schedule    attendance.schedules;
  v_state       text;
begin
  v_employee_id := internal.caller_employee_id();

  if v_employee_id is null then
    raise exception 'Esta cuenta no esta ligada a un empleado activo'
      using errcode = '42501';
  end if;

  v_zone := internal.time_zone_of(v_employee_id);
  v_date := (now() at time zone v_zone)::date;

  select w.* into v_workday
    from attendance.workdays w
   where w.employee_id = v_employee_id
     and w.work_date   = v_date;

  v_schedule := internal.resolve_schedule(v_employee_id, v_date);
  v_state    := coalesce(v_workday.state, 'not_started');

  return jsonb_build_object(
    'server_time',    now(),
    'employee_id',    v_employee_id,
    'date',           v_date,
    'time_zone',      v_zone,

    'state',          v_state,
    'next_actions',   to_jsonb(internal.allowed_punches(v_state)),

    'worked_seconds', coalesce(v_workday.worked_seconds, 0),
    'break_seconds',  coalesce(v_workday.break_seconds, 0),
    'opened_at',      v_workday.opened_at,
    'closed_at',      v_workday.closed_at,
    'last_heartbeat', v_workday.last_heartbeat,
    'has_offline',    coalesce(v_workday.has_offline, false),
    'needs_review',   coalesce(v_workday.needs_review, false),

    -- Null on a day the schedule does not cover, a weekend most of the time.
    -- The screen should say so rather than invent an expected hour.
    'schedule', case
      when v_schedule.id is null then null
      else jsonb_build_object(
        'name',              v_schedule.name,
        'entry_from',        to_char(v_schedule.entry_from,     'HH24:MI'),
        'entry_until',       to_char(v_schedule.entry_until,    'HH24:MI'),
        'entry_expected',    to_char(v_schedule.entry_expected, 'HH24:MI'),
        'exit_expected',     to_char(v_schedule.exit_expected,  'HH24:MI'),
        'grace_minutes',     v_schedule.grace_minutes,
        'break_max_minutes', v_schedule.break_max_minutes)
    end,

    -- Explicit column list, not p.*: `authenticated` was never granted
    -- geo_lat or geo_lng, so a star here would fail outright. That is the
    -- privacy promise working, not an inconvenience to route around.
    'punches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',            p.id,
               'kind',          p.kind,
               'occurred_at',   p.occurred_at,
               'source',        p.source,
               'needs_review',  p.needs_review,
               'review_reason', p.review_reason)
             order by p.occurred_at)
        from attendance.punches p
       where p.workday_id = v_workday.id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.my_day() is
  'Everything the punch screen needs for today, in one call: state, legal next actions, counters, schedule and punches.';

revoke all     on function public.my_day() from public, anon;
grant  execute on function public.my_day() to authenticated;

-- =========================================================== my_history() ===
-- The employee's own record, which is the thing this system exists to produce.
-- Ranges are capped because an uncapped one is an accident waiting for the day
-- the table is large: 92 days covers a payroll dispute over a quarter.

create or replace function public.my_history(
  p_from date default null,
  p_to   date default null
)
returns table (
  work_date      date,
  state          text,
  opened_at      timestamptz,
  closed_at      timestamptz,
  worked_seconds integer,
  break_seconds  integer,
  has_offline    boolean,
  needs_review   boolean,
  punch_count    integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_employee_id uuid;
  v_zone        text;
  v_to          date;
  v_from        date;
begin
  v_employee_id := internal.caller_employee_id();

  if v_employee_id is null then
    raise exception 'Esta cuenta no esta ligada a un empleado activo'
      using errcode = '42501';
  end if;

  v_zone := internal.time_zone_of(v_employee_id);
  v_to   := coalesce(p_to, (now() at time zone v_zone)::date);
  v_from := coalesce(p_from, v_to - 29);

  if v_from > v_to then
    raise exception 'La fecha inicial no puede ser posterior a la final'
      using errcode = '22023';
  end if;

  if v_to - v_from > 92 then
    raise exception 'El rango no puede exceder 92 dias'
      using errcode = '22023';
  end if;

  return query
    select w.work_date, w.state, w.opened_at, w.closed_at,
           w.worked_seconds, w.break_seconds,
           w.has_offline, w.needs_review,
           (select count(*)::integer from attendance.punches p
             where p.workday_id = w.id)
      from attendance.workdays w
     where w.employee_id = v_employee_id
       and w.work_date between v_from and v_to
     order by w.work_date desc;
end;
$fn$;

comment on function public.my_history(date, date) is
  'The caller''s own workdays over a range of at most 92 days. Defaults to the last 30.';

revoke all     on function public.my_history(date, date) from public, anon;
grant  execute on function public.my_history(date, date) to authenticated;

-- ============================================================= team_day() ===
-- Who is working, for whoever is entitled to ask. No role check is written
-- here: RLS on public.empleados is `internal.can_view_employee(id)`, so a
-- manager gets their department, HR and admin get everyone, and an employee
-- gets a list of one. Writing the rule again here would be a second definition
-- of it, and the point of that function is that there is only one.
--
-- It starts from the employee list rather than from workdays on purpose. A
-- board that only showed people who clocked in would be missing exactly the
-- people it is consulted about.

create or replace function public.team_day(p_date date default null)
returns table (
  employee_id    uuid,
  employee_name  text,
  department     text,
  work_date      date,
  state          text,
  opened_at      timestamptz,
  closed_at      timestamptz,
  worked_seconds integer,
  break_seconds  integer,
  last_heartbeat timestamptz,
  has_offline    boolean,
  needs_review   boolean,
  entry_expected time,
  exit_expected  time
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_date date;
begin
  -- Resolved in the caller's own zone: a board is read by one person, in one
  -- place, and a date that shifted per row would be unreadable.
  v_date := coalesce(
    p_date,
    (now() at time zone coalesce(
      internal.time_zone_of(internal.caller_employee_id()),
      'America/Mexico_City'))::date);

  return query
    select e.id,
           e.nombre,
           d.name,
           v_date,
           coalesce(w.state, 'not_started'),
           w.opened_at,
           w.closed_at,
           coalesce(w.worked_seconds, 0),
           coalesce(w.break_seconds, 0),
           w.last_heartbeat,
           coalesce(w.has_offline, false),
           coalesce(w.needs_review, false),
           s.entry_expected,
           s.exit_expected
      from public.empleados e
      left join public.departments d on d.id = e.department_id
      left join attendance.workdays w
             on w.employee_id = e.id
            and w.work_date   = v_date
      left join lateral internal.resolve_schedule(e.id, v_date) s on true
     where e.estado = 'activo'
     order by e.nombre;
end;
$fn$;

comment on function public.team_day(date) is
  'Every active employee the caller may see, with their state on a given date. Scope comes from RLS, not from a role check written here.';

revoke all     on function public.team_day(date) from public, anon;
grant  execute on function public.team_day(date) to authenticated;

-- =========================================================== open_alerts() ===
-- What the evaluator raised and nobody has dealt with yet. Same scoping as
-- team_day: RLS on attendance.alerts is can_view_employee(), so a manager sees
-- their department and HR sees everyone.

create or replace function public.open_alerts(
  p_since date    default null,
  p_limit integer default 200
)
returns table (
  id            uuid,
  employee_id   uuid,
  employee_name text,
  alert_date    date,
  kind          text,
  severity      text,
  state         text,
  details       jsonb,
  created_at    timestamptz,
  notified_at   timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_since date;
begin
  v_since := coalesce(p_since, (now() at time zone 'America/Mexico_City')::date - 30);

  return query
    select a.id, a.employee_id, e.nombre, a.alert_date,
           a.kind, a.severity, a.state, a.details,
           a.created_at, a.notified_at
      from attendance.alerts a
      join public.empleados e on e.id = a.employee_id
     where a.state = 'open'
       and a.alert_date >= v_since
     order by a.alert_date desc,
              -- Not alphabetical: 'high' before 'medium' before 'low'.
              case a.severity when 'high' then 1 when 'medium' then 2 else 3 end,
              e.nombre
     limit greatest(1, least(p_limit, 500));
end;
$fn$;

comment on function public.open_alerts(date, integer) is
  'Open alerts for the employees the caller may see, most recent and most severe first.';

revoke all     on function public.open_alerts(date, integer) from public, anon;
grant  execute on function public.open_alerts(date, integer) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The read API is published and executable by authenticated, and
--   --    nothing else was added to public by accident:
--   select p.proname,
--          case p.prosecdef when true then 'definer' else 'invoker' end as security
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('my_profile', 'server_time', 'punch', 'sync_punches',
--                        'heartbeat', 'my_day', 'my_history', 'team_day',
--                        'open_alerts')
--    order by p.prosecdef, p.proname;
--   -- Expected: the four read functions are 'invoker'; the writers are 'definer'.
--
--   -- 2. As an employee's session, my_day() answers and team_day() returns
--   --    exactly one row. Run from the client, not from the SQL editor: the
--   --    editor connects as postgres, which bypasses RLS and would tell you
--   --    nothing.
