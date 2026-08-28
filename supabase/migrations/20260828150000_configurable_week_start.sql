-- =============================================================================
-- Where a week begins, decided once and configurable.
--
-- The reports were ISO weeks -- Monday to Sunday -- because `date_trunc('week',
-- ...)` is ISO and that was the only correct answer available without asking
-- anybody. The company's week runs **Thursday to Wednesday**, so the default
-- moves and the convention becomes a setting rather than a property of a
-- Postgres builtin.
--
-- **One definition, and it is not a copy of the arithmetic.** Two places compute
-- a week: the scope in `public.attendance_report()` and the weekly grouping in
-- `internal.attendance_summary()`. If they disagree, "semana" means one thing on
-- Reportes and another in the box behind a name, and both would show a number
-- with only one of them right. So the offset is derived in exactly one function
-- and both callers use it.
--
-- **The split between the two new functions is about cost, not tidiness.**
-- `internal.week_start_dow()` reads a table, so it is `stable` and Postgres will
-- not inline it -- called inside a `group by` it would run once per row.
-- `internal.week_start()` is `immutable` and a single expression, so the planner
-- inlines it into the query. The resolver is therefore called once, into a
-- variable, and the arithmetic is what goes per row. That is the difference
-- between one lookup per statement and one per day per employee.
--
-- **A missing row is the default, not an error.** The same rule `alert_rules`
-- already holds to: no configuration is not the same as broken configuration, so
-- an empty `attendance.settings` reports Thursday rather than raising or
-- returning null.
--
-- Only the report's scope and the summary's grouping move. A month is still a
-- calendar month and a day is still a day; neither has a convention to choose.
-- =============================================================================

-- ================================================================= settings ===
-- Company-wide attendance configuration. **One row, enforced by the primary
-- key**: `id` may only be `true`, so a second row is impossible rather than
-- merely discouraged. A settings table that quietly grew a second row would give
-- two answers to "when does the week start" depending on which one was read
-- first.
--
-- Not per department, deliberately. `alert_rules` is per department because a
-- threshold is a local judgement; a week is not. Two departments on different
-- weeks would make a company-wide period incoherent -- there would be no
-- "semana" to report, only two overlapping ones.

create table if not exists attendance.settings (
  id              boolean     primary key default true,
  -- ISO day of week: 1 = Monday .. 7 = Sunday. isodow rather than dow because
  -- dow numbers Sunday 0 and 7 both, and the modular arithmetic below would
  -- have to special-case it.
  week_start_dow  smallint    not null default 4,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid        references auth.users (id) on delete set null,

  constraint settings_singleton check (id),
  constraint settings_week_start_dow_valid check (week_start_dow between 1 and 7)
);

comment on table attendance.settings is
  'Company-wide attendance configuration. Exactly one row: the primary key admits only true.';
comment on column attendance.settings.week_start_dow is
  'ISO day of week a reporting week begins on. 1 = Monday .. 7 = Sunday. Defaults to 4, Thursday.';

alter table attendance.settings enable row level security;

-- Read for the people who configure it. `internal.week_start_dow()` is DEFINER
-- precisely so that every employee's own summary can resolve the week without
-- this policy having to open the table to everybody.
create policy settings_read on attendance.settings
  for select to authenticated
  using ((select internal.caller_role()) in ('hr', 'admin'));

grant select on attendance.settings to authenticated;

-- The row exists from the start rather than being conjured by the first save.
-- The default would cover its absence, but a configuration screen with nothing
-- behind it is harder to reason about than one showing the value in force.
insert into attendance.settings (id, week_start_dow)
values (true, 4)
on conflict (id) do nothing;

-- ============================================================== week_start ===
-- The arithmetic, and nothing else.
--
-- `immutable` and one expression, so the planner inlines it: this is what goes
-- per row inside a `group by`, and a function call per row is the cost that
-- grows. `strict` because a null date has no week and should say so rather than
-- resolving to some epoch.
--
-- (isodow - start + 7) % 7 is how many days have passed since the week began:
-- zero on the start day itself, six on the day before it.

create or replace function internal.week_start(p_date date, p_start_dow smallint)
returns date
language sql
immutable
strict
set search_path = ''
as $fn$
  select p_date - ((extract(isodow from p_date)::integer - p_start_dow + 7) % 7);
$fn$;

comment on function internal.week_start(date, smallint) is
  'The first day of the week containing p_date, for a week beginning on ISO day p_start_dow. Immutable so the planner inlines it into a group by.';

revoke all     on function internal.week_start(date, smallint) from public, anon;
grant  execute on function internal.week_start(date, smallint) to authenticated;

-- ========================================================== week_start_dow ===
-- The setting, resolved once.
--
-- DEFINER, and that is the reason `attendance.settings` needs no policy for
-- `employee`: every employee's own summary groups its weeks and therefore needs
-- this number, but none of them needs to read the table. The same shape as
-- `internal.resolve_schedule()` and `internal.time_zone_of()`, which are DEFINER
-- for the same reason -- a read function that elevated would be the exception
-- rule 9 warns about, but an internal helper returning one company-wide integer
-- exposes nothing about anybody.
--
-- The coalesce is the contract: no row means Thursday, never null.

create or replace function internal.week_start_dow()
returns smallint
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select s.week_start_dow from attendance.settings s where s.id),
    4::smallint);
$fn$;

comment on function internal.week_start_dow() is
  'The ISO day a reporting week begins on. DEFINER so an employee summary can resolve it without reading attendance.settings. No row means Thursday.';

revoke all     on function internal.week_start_dow() from public, anon;
grant  execute on function internal.week_start_dow() to authenticated;

-- ===================================================== attendance_settings ===
-- What the configuration screen reads.
--
-- INVOKER with no role check written here: `settings_read` is already
-- `caller_role() in ('hr','admin')`, so the policy is the gate -- the same
-- reasoning as `list_alert_rules()`. An empty answer for a manager is the policy
-- doing its job, so the default is reported alongside, and the screen can say
-- what is in force even before anybody has saved.

create or replace function public.attendance_settings()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select jsonb_build_object(
    'week_start_dow', s.week_start_dow,
    'updated_at',     s.updated_at,
    'default_week_start_dow', 4)
    from attendance.settings s
   where s.id;
$fn$;

comment on function public.attendance_settings() is
  'Company-wide attendance configuration for the administration screen. Scope comes from the settings_read policy, not from a role check written here.';

revoke all     on function public.attendance_settings() from public, anon;
grant  execute on function public.attendance_settings() to authenticated;

-- ========================================================== save_settings ===
-- One function for the one table, like `save_alert_rule()`, and it will gain a
-- parameter rather than a sibling when a second setting arrives.
--
-- It never inserts a second row: the primary key would refuse it, and the
-- upsert names `id` so a first save on an empty table still works.

create or replace function public.save_settings(p_week_start_dow smallint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_before attendance.settings;
  v_after  attendance.settings;
begin
  perform internal.require_role(array['hr', 'admin'], 'cambiar la configuracion');

  if p_week_start_dow is null or p_week_start_dow < 1 or p_week_start_dow > 7 then
    raise exception 'El dia de inicio de semana va de 1 (lunes) a 7 (domingo)'
      using errcode = '22023';
  end if;

  select s.* into v_before from attendance.settings s where s.id;

  insert into attendance.settings (id, week_start_dow, updated_by)
  values (true, p_week_start_dow, auth.uid())
  on conflict (id) do update
     set week_start_dow = excluded.week_start_dow,
         updated_at     = now(),
         updated_by     = excluded.updated_by
  returning * into v_after;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('settings_saved', 'attendance.settings', null, auth.uid(),
     format('la semana ahora empieza en el dia ISO %s', v_after.week_start_dow),
     case when v_before.id is null then null else to_jsonb(v_before) end,
     to_jsonb(v_after));

  return jsonb_build_object(
    'week_start_dow', v_after.week_start_dow,
    'updated_at',     v_after.updated_at);
end;
$fn$;

comment on function public.save_settings(smallint) is
  'Sets the ISO day a reporting week begins on. Changes what every week-scoped report and the weekly grouping in every summary mean, from the next read onwards.';

revoke all     on function public.save_settings(smallint) from public, anon;
grant  execute on function public.save_settings(smallint) to authenticated;

-- ======================================================= attendance_summary ===
-- Reissued for the weekly grouping, and a body cannot be patched.
--
-- `date_trunc('week', ...)` becomes `internal.week_start(work_date, v_week_dow)`,
-- with the setting resolved once into `v_week_dow` above the query rather than
-- looked up per row.

create or replace function internal.attendance_summary(
  p_employee_id uuid,
  p_days        integer default 30
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_zone   text;
  v_today  date;
  v_from   date;
  v_days   integer;
  v_week_dow smallint;
  v_result jsonb;
begin
  -- The same 92-day ceiling `my_history()` holds to, and for the same reason:
  -- a payroll dispute over a quarter is the widest question anybody asks, and
  -- an uncapped range is an accident waiting for the day the table is large.
  v_days  := greatest(7, least(coalesce(p_days, 30), 92));
  v_zone  := internal.time_zone_of(p_employee_id);
  v_today := (now() at time zone v_zone)::date;
  v_from  := v_today - (v_days - 1);
  -- Resolved once, not per row: the lookup is `stable` and would not be
  -- inlined inside the grouping below.
  v_week_dow := internal.week_start_dow();

  with resolved as (
    select * from internal.resolved_days(array[p_employee_id], v_from, v_today)
  ),
  streak_source as (
    -- Walking backwards, the running count of days that were not finished. It
    -- is zero for exactly the unbroken run at the end, which is the streak.
    select sum(case when state = 'finished' then 0 else 1 end)
             over (order by work_date desc rows between unbounded preceding and current row)
             as broken
      from resolved
     where scheduled
       -- Today is not over. It neither extends the streak nor breaks it, so it
       -- is left out until it finishes.
       and not (work_date = v_today and state <> 'finished')
  ),
  streak as (
    select count(*)::integer as days from streak_source where broken = 0
  ),
  totals as (
    select coalesce(sum(worked_seconds),   0)::integer          as worked_seconds,
           coalesce(sum(break_seconds),    0)::integer          as break_seconds,
           coalesce(sum(expected_seconds), 0)::integer          as expected_seconds,
           count(*) filter (where scheduled)::integer           as days_scheduled,
           count(*) filter (where opened_at is not null)::integer as days_worked,
           count(*) filter (where state = 'finished')::integer  as days_complete,
           count(*) filter (where late)::integer                as late_days,
           count(*) filter (where opened_at is not null and not late)::integer
                                                                as on_time_days,
           count(*) filter (where has_offline)::integer          as offline_days,
           -- Only days already past: a scheduled day that has not happened yet
           -- is not an absence.
           count(*) filter (
             where scheduled and work_date < v_today and opened_at is null
           )::integer                                           as absent_days,
           case
             when count(*) filter (where opened_at is not null) = 0 then null
             else round(
               100.0 * count(*) filter (where opened_at is not null and not late)
                     / count(*) filter (where opened_at is not null))::integer
           end                                                  as punctuality_pct,
           -- The hour they usually arrive, in their own zone. Null until there
           -- is an entry to average.
           to_char(
             make_interval(secs =>
               avg(extract(epoch from (opened_at at time zone v_zone)::time))::double precision),
             'HH24:MI')                                         as average_entry
      from resolved
  ),
  weeks as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'week_start',       week_start,
             'days_scheduled',   days_scheduled,
             'days_worked',      days_worked,
             'days_complete',    days_complete,
             'worked_seconds',   worked_seconds,
             'break_seconds',    break_seconds,
             'expected_seconds', expected_seconds,
             'late_days',        late_days
           ) order by week_start), '[]'::jsonb) as items
      from (
        select internal.week_start(work_date, v_week_dow)       as week_start,
               count(*) filter (where scheduled)::integer       as days_scheduled,
               count(*) filter (where opened_at is not null)::integer as days_worked,
               count(*) filter (where state = 'finished')::integer    as days_complete,
               coalesce(sum(worked_seconds),   0)::integer      as worked_seconds,
               coalesce(sum(break_seconds),    0)::integer      as break_seconds,
               coalesce(sum(expected_seconds), 0)::integer      as expected_seconds,
               count(*) filter (where late)::integer            as late_days
          from resolved
         group by 1
      ) as by_week
  ),
  disconnections as (
    select
      (select count(*)::integer
         from attendance.alerts a
        where a.employee_id = p_employee_id
          and a.alert_date between v_from and v_today
          and a.kind   = 'no_connection'
          and a.state <> 'dismissed'
          -- Same reason as `late` above: the punches it was measured against
          -- stopped counting.
          and a.superseded_at is null)                          as no_connection_alerts,
      (select count(*)::integer
         from attendance.app_sessions s
        where s.employee_id = p_employee_id
          and s.end_reason  = 'expired'
          and (s.started_at at time zone v_zone)::date between v_from and v_today)
                                                                as expired_sessions
  ),
  series as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'date',             work_date,
             'scheduled',        scheduled,
             'state',            state,
             'worked_seconds',   worked_seconds,
             'break_seconds',    break_seconds,
             'expected_seconds', expected_seconds,
             'entry_expected',   entry_expected,
             'opened_at',        opened_at,
             'closed_at',        closed_at,
             'has_offline',      has_offline,
             'late',             late
           ) order by work_date), '[]'::jsonb) as items
      from resolved
  )
  select jsonb_build_object(
    'server_time',   now(),
    'time_zone',     v_zone,
    'from',          v_from,
    'to',            v_today,
    'days',          v_days,
    'worked_seconds',   t.worked_seconds,
    'break_seconds',    t.break_seconds,
    'expected_seconds', t.expected_seconds,
    'days_scheduled',   t.days_scheduled,
    'days_worked',      t.days_worked,
    'days_complete',    t.days_complete,
    'late_days',        t.late_days,
    'on_time_days',     t.on_time_days,
    'absent_days',      t.absent_days,
    'punctuality_pct',  t.punctuality_pct,
    'average_entry',    t.average_entry,
    'streak_days',      k.days,
    'offline_days',           t.offline_days,
    'no_connection_alerts',   c.no_connection_alerts,
    'expired_sessions',       c.expired_sessions,
    'weeks',            b.items,
    'series',           s.items
  )
    into v_result
    from totals t, streak k, series s, weeks b, disconnections c;

  return v_result;
end;
$fn$;

comment on function internal.attendance_summary(uuid, integer) is
  'Every figure the two summary screens show, decided once. INVOKER so the policies on workdays, alerts and app_sessions keep deciding whose figures come back. Builds on internal.resolved_days(); superseded alerts count for nothing; weeks are grouped from internal.week_start_dow(), so they match the report''s week rather than the ISO one.';

revoke all     on function internal.attendance_summary(uuid, integer) from public, anon;
grant  execute on function internal.attendance_summary(uuid, integer) to authenticated;

create or replace function public.attendance_report(
  p_scope  text default 'week',
  p_anchor date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_scope  text;
  v_zone   text;
  v_anchor date;
  v_today  date;
  v_from   date;
  v_to     date;
  v_week_dow smallint;
  v_ids    uuid[];
  v_result jsonb;
begin
  v_scope := lower(trim(coalesce(p_scope, 'week')));

  if v_scope not in ('day', 'week', 'month') then
    raise exception 'El periodo debe ser dia, semana o mes'
      using errcode = '22023';
  end if;

  -- The report is read by one person in one place, so it resolves in that
  -- person's zone -- the same assumption `team_day()` makes. Per-employee zones
  -- still decide each `work_date`, which is why no zone arithmetic is needed
  -- below: `work_date` is already a local date.
  v_zone := coalesce(
    internal.time_zone_of(internal.caller_employee_id()),
    'America/Mexico_City');

  v_today  := (now() at time zone v_zone)::date;
  v_anchor := coalesce(p_anchor, v_today);

  -- Read whatever the scope, so the answer can always say which convention
  -- produced it -- a reader looking at a Thursday-to-Wednesday week needs
  -- somewhere to see why, and a day or a month is a cheap lookup.
  v_week_dow := internal.week_start_dow();

  case v_scope
    when 'day' then
      v_from := v_anchor;
      v_to   := v_anchor;
    when 'week' then
      v_from := internal.week_start(v_anchor, v_week_dow);
      v_to   := v_from + 6;
    when 'month' then
      v_from := date_trunc('month', v_anchor)::date;
      v_to   := (v_from + interval '1 month' - interval '1 day')::date;
  end case;

  -- **Who the report is about: the people who can actually punch.**
  --
  -- An employee with no account has no way to clock in, so a period cannot
  -- report them as absent from it -- there was never anything for them to be
  -- absent from. This is the population `attendance.evaluate_alerts()` already
  -- watches, and keeping the two the same is the point: a report and an
  -- evaluator disagreeing about who is in scope would be two answers to one
  -- question. Not everybody on the roster works Home Office; onboarding
  -- somebody is what puts them in both.
  --
  -- The second clause is what keeps history. `retire_employee()` unlinks the
  -- account, so somebody who worked half a month and then left would otherwise
  -- take those days out of the month with them. A workday inside the window is
  -- proof they had access while it was open.
  --
  -- RLS on `empleados` still decides which of these the caller may see.
  select coalesce(array_agg(e.id), '{}'::uuid[])
    into v_ids
    from public.empleados e
   where (e.auth_user_id is not null and e.estado = 'activo')
      or exists (
           select 1
             from attendance.workdays w
            where w.employee_id = e.id
              and w.work_date between v_from and v_to);

  with resolved as (
    select * from internal.resolved_days(v_ids, v_from, v_to)
  ),
  -- Alerts in the window, per person and kind. Counted, never re-derived, and
  -- dismissed ones excluded for the same reason the summary excludes them: HR
  -- deciding an alert was worth nothing has to make it stop counting.
  alerts_scoped as (
    select a.employee_id, a.kind, a.severity, a.state
      from attendance.alerts a
     where a.alert_date between v_from and v_to
       and a.employee_id = any (v_ids)
       -- An alert whose punches were voided is not part of the period. Counting
       -- it would put a discarded arrival in the totals beside the real one.
       and a.superseded_at is null
  ),
  alerts_per_person as (
    select employee_id,
           coalesce(jsonb_object_agg(kind, total) filter (where total > 0), '{}'::jsonb) as by_kind,
           coalesce(sum(total), 0)::integer as total
      from (
        select employee_id, kind,
               count(*) filter (where state <> 'dismissed')::integer as total
          from alerts_scoped
         group by 1, 2
      ) as k
     group by 1
  ),
  per_person as (
    select r.employee_id,
           e.nombre                                              as employee_name,
           d.name                                                 as department,
           e.estado                                               as employee_state,
           count(*) filter (where r.scheduled)::integer            as days_scheduled,
           -- The scheduled days that have already happened, and what they asked
           -- for. A period still running is measured against the part of it that
           -- is over: charging somebody a full week's expectation on Tuesday
           -- reports a deficit that is only the calendar.
           count(*) filter (
             where r.scheduled and r.work_date < v_today
           )::integer                                              as days_scheduled_past,
           coalesce(sum(r.expected_seconds) filter (
             where r.scheduled and r.work_date < v_today
           ), 0)::integer                                          as expected_seconds_elapsed,
           count(*) filter (where r.opened_at is not null)::integer as days_worked,
           count(*) filter (where r.state = 'finished')::integer    as days_complete,
           coalesce(sum(r.worked_seconds),   0)::integer            as worked_seconds,
           coalesce(sum(r.break_seconds),    0)::integer            as break_seconds,
           coalesce(sum(r.expected_seconds), 0)::integer            as expected_seconds,
           count(*) filter (where r.late)::integer                  as late_days,
           count(*) filter (where r.has_offline)::integer           as offline_days,
           -- Past days only, on both of these. A scheduled day that has not
           -- happened yet is not an absence, and a day still being worked is
           -- not an unfinished one.
           count(*) filter (
             where r.scheduled and r.work_date < v_today and r.opened_at is null
           )::integer                                              as absent_days,
           count(*) filter (
             where r.work_date < v_today
               and r.opened_at is not null
               and r.state <> 'finished'
           )::integer                                              as incomplete_days,
           case
             when count(*) filter (where r.opened_at is not null) = 0 then null
             else round(
               100.0 * count(*) filter (where r.opened_at is not null and not r.late)
                     / count(*) filter (where r.opened_at is not null))::integer
           end                                                     as punctuality_pct,
           to_char(
             make_interval(secs =>
               avg(extract(epoch from (r.opened_at at time zone r.time_zone)::time))
                 ::double precision),
             'HH24:MI')                                            as average_entry
      from resolved r
      join public.empleados e on e.id = r.employee_id
      left join public.departments d on d.id = e.department_id
     group by r.employee_id, e.nombre, d.name, e.estado
  ),
  judged as (
    select p.*,
           coalesce(a.by_kind, '{}'::jsonb)                        as alerts_by_kind,
           coalesce(a.total, 0)                                    as alerts_total,
           -- Measured against what the elapsed part of the period asked for, not
           -- the whole of it. See `expected_seconds_elapsed` above.
           greatest(0, p.expected_seconds_elapsed - p.worked_seconds)
                                                                   as deficit_seconds,
           case
             when p.days_scheduled = 0                            then 'not_scheduled'
             when p.days_scheduled_past = 0                       then 'pending'
             when p.absent_days > 0                               then 'missed'
             when p.late_days > 0 or p.incomplete_days > 0         then 'partial'
             else                                                       'met'
           end                                                     as compliance
      from per_person p
      left join alerts_per_person a on a.employee_id = p.employee_id
  ),
  -- The reasons a period was not met, as codes with counts. Only the ones that
  -- actually happened: a zero in this list would read as a reason.
  reasoned as (
    select j.*,
           (
             select coalesce(jsonb_agg(jsonb_build_object('code', code, 'count', n)
                                       order by n desc, code), '[]'::jsonb)
               from (
                 values ('absent',     j.absent_days),
                        ('late',       j.late_days),
                        ('incomplete', j.incomplete_days),
                        ('tampered',
                         coalesce((j.alerts_by_kind ->> 'clock_tampered')::integer, 0))
               ) as r(code, n)
              where r.n > 0
           ) as reasons
      from judged j
  ),
  people as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'employee_id',      employee_id,
             'employee_name',    employee_name,
             'department',       department,
             'employee_state',   employee_state,
             'days_scheduled',      days_scheduled,
             'days_scheduled_past', days_scheduled_past,
             'days_worked',      days_worked,
             'days_complete',    days_complete,
             'worked_seconds',   worked_seconds,
             'break_seconds',    break_seconds,
             'expected_seconds', expected_seconds,
             'expected_seconds_elapsed', expected_seconds_elapsed,
             'deficit_seconds',  deficit_seconds,
             'late_days',        late_days,
             'absent_days',      absent_days,
             'incomplete_days',  incomplete_days,
             'offline_days',     offline_days,
             'punctuality_pct',  punctuality_pct,
             'average_entry',    average_entry,
             'alerts_total',     alerts_total,
             'alerts',           alerts_by_kind,
             'compliance',       compliance,
             'reasons',          reasons
           ) order by employee_name), '[]'::jsonb) as items
      from reasoned
  ),
  totals as (
    select count(*)::integer                                        as people,
           count(*) filter (where days_worked > 0)::integer          as people_home_office,
           count(*) filter (where compliance = 'met')::integer       as people_met,
           count(*) filter (where compliance = 'partial')::integer   as people_partial,
           count(*) filter (where compliance = 'missed')::integer    as people_missed,
           count(*) filter (where compliance = 'pending')::integer    as people_pending,
           count(*) filter (where compliance = 'not_scheduled')::integer
                                                                     as people_not_scheduled,
           coalesce(sum(days_scheduled),   0)::integer               as days_scheduled,
           coalesce(sum(days_scheduled_past), 0)::integer            as days_scheduled_past,
           coalesce(sum(expected_seconds_elapsed), 0)::integer
                                                                     as expected_seconds_elapsed,
           coalesce(sum(days_worked),      0)::integer               as days_worked,
           coalesce(sum(days_complete),    0)::integer               as days_complete,
           coalesce(sum(worked_seconds),   0)::integer               as worked_seconds,
           coalesce(sum(break_seconds),    0)::integer               as break_seconds,
           coalesce(sum(expected_seconds), 0)::integer               as expected_seconds,
           coalesce(sum(late_days),        0)::integer               as late_days,
           coalesce(sum(absent_days),      0)::integer               as absent_days,
           coalesce(sum(incomplete_days),  0)::integer               as incomplete_days,
           coalesce(sum(offline_days),     0)::integer               as offline_days,
           coalesce(sum(alerts_total),     0)::integer               as alerts_total,
           case
             when coalesce(sum(days_worked), 0) = 0 then null
             else round(100.0 * (coalesce(sum(days_worked), 0) - coalesce(sum(late_days), 0))
                              / coalesce(sum(days_worked), 0))::integer
           end                                                       as punctuality_pct
      from reasoned
  ),
  by_kind as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'kind',      kind,
             'severity',  severity,
             'total',     total,
             'dismissed', dismissed,
             'open',      still_open,
             'people',    people
           ) order by total desc, kind), '[]'::jsonb) as items
      from (
        select kind,
               -- One kind can carry more than one severity across people. The
               -- highest is what a summary line should show.
               case max(case severity when 'high' then 3 when 'medium' then 2 else 1 end)
                 when 3 then 'high' when 2 then 'medium' else 'low' end as severity,
               count(*) filter (where state <> 'dismissed')::integer    as total,
               count(*) filter (where state =  'dismissed')::integer    as dismissed,
               count(*) filter (where state =  'open')::integer         as still_open,
               count(distinct employee_id) filter (where state <> 'dismissed')::integer
                 as people
          from alerts_scoped
         group by kind
        having count(*) filter (where state <> 'dismissed') > 0
      ) as k
  ),
  -- Who stood out, in both directions. Ranking facts, not judging them: the
  -- figures were already decided above.
  standouts as (
    select jsonb_build_object(
      'punctual', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'employee_id', employee_id, 'employee_name', employee_name,
                 'value', days_worked) order by days_worked desc, employee_name), '[]'::jsonb)
          from (
            select employee_id, employee_name, days_worked
              from reasoned
             where days_worked > 0 and late_days = 0 and absent_days = 0
             order by days_worked desc, employee_name
             limit 3
          ) as t
      ),
      'most_late', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'employee_id', employee_id, 'employee_name', employee_name,
                 'value', late_days) order by late_days desc, employee_name), '[]'::jsonb)
          from (
            select employee_id, employee_name, late_days
              from reasoned
             where late_days > 0
             order by late_days desc, employee_name
             limit 3
          ) as t
      ),
      'most_absent', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'employee_id', employee_id, 'employee_name', employee_name,
                 'value', absent_days) order by absent_days desc, employee_name), '[]'::jsonb)
          from (
            select employee_id, employee_name, absent_days
              from reasoned
             where absent_days > 0
             order by absent_days desc, employee_name
             limit 3
          ) as t
      ),
      'most_hours', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'employee_id', employee_id, 'employee_name', employee_name,
                 'value', worked_seconds) order by worked_seconds desc, employee_name), '[]'::jsonb)
          from (
            select employee_id, employee_name, worked_seconds
              from reasoned
             where worked_seconds > 0
             order by worked_seconds desc, employee_name
             limit 3
          ) as t
      )
    ) as items
  )
  select jsonb_build_object(
    'server_time', now(),
    'time_zone',   v_zone,
    'scope',       v_scope,
    'anchor',      v_anchor,
    'from',        v_from,
    'to',          v_to,
    'days',        (v_to - v_from) + 1,
    -- Whether the period has finished. A week still running is not a week
    -- somebody failed, and the screen says which it is looking at.
    'closed',      v_to < v_today,
    -- The convention in force, so the screen can name it instead of leaving
    -- a reader to infer it from the bounds.
    'week_start_dow', v_week_dow,
    'totals', jsonb_build_object(
      'people',               t.people,
      'people_home_office',   t.people_home_office,
      'people_met',           t.people_met,
      'people_partial',       t.people_partial,
      'people_missed',        t.people_missed,
      'people_pending',       t.people_pending,
      'people_not_scheduled', t.people_not_scheduled,
      'days_scheduled',       t.days_scheduled,
      'days_scheduled_past',  t.days_scheduled_past,
      'days_worked',          t.days_worked,
      'days_complete',        t.days_complete,
      'worked_seconds',       t.worked_seconds,
      'break_seconds',        t.break_seconds,
      'expected_seconds',     t.expected_seconds,
      'expected_seconds_elapsed', t.expected_seconds_elapsed,
      'late_days',            t.late_days,
      'absent_days',          t.absent_days,
      'incomplete_days',      t.incomplete_days,
      'offline_days',         t.offline_days,
      'alerts_total',         t.alerts_total,
      'punctuality_pct',      t.punctuality_pct
    ),
    'alerts_by_kind', k.items,
    'people',         p.items,
    'standouts',      s.items
  )
    into v_result
    from totals t, by_kind k, people p, standouts s;

  return v_result;
end;
$fn$;

comment on function public.attendance_report(text, date) is
  'One period -- day, week or month -- across the people who have an account, which is the population evaluate_alerts() watches. Period bounds and what "cumplio" means are decided here; a week begins on internal.week_start_dow(); every figure comes from internal.resolved_days(); superseded alerts count for nothing.';

revoke all     on function public.attendance_report(text, date) from public, anon;
grant  execute on function public.attendance_report(text, date) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The default is Thursday, and it survives an empty table.
--   select internal.week_start_dow();                      -- expected: 4
--   select internal.week_start(date '2026-08-28', 4::smallint); -- a Friday -> 2026-08-27
--   select internal.week_start(date '2026-08-27', 4::smallint); -- the Thursday itself
--   select internal.week_start(date '2026-08-26', 4::smallint); -- a Wednesday -> 2026-08-20
--
--   -- 2. Every day of one week reports the same bounds.
--   select distinct public.attendance_report('week', d::date) ->> 'from'
--     from generate_series(date '2026-08-27', date '2026-09-02', interval '1 day') d;
--   -- Expected: one row.
--
--   -- 3. The summary's weeks agree with it.
--   select distinct extract(isodow from (w.value ->> 'week_start')::date)
--     from jsonb_array_elements(public.employee_summary('<id>', 30) -> 'weeks') w;
--   -- Expected: one row, equal to internal.week_start_dow().
