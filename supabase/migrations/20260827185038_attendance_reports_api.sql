-- Reports: one period, everybody visible in it, and what the period was worth.
--
-- The board answers "what is happening today". This answers "what happened over
-- a day, a week or a month, across everybody" -- the question a supervisor asks
-- at the end of a period rather than in the middle of one.
--
-- Three things it does NOT do, all three deliberate:
--
--   * It does not compute a second opinion. `internal.attendance_summary()`
--     already decides what a day was worth for one person, and a report that
--     re-derived it would disagree with the box on the board about the same
--     person -- invisibly, because both would show a number. So the per-day
--     resolution is lifted out into `internal.resolved_days()` and *both* build
--     on it. That is the division `punch()`/`sync_punches()` have over
--     `record_punch()`, and `my_summary()`/`employee_summary()` have over
--     `attendance_summary()`.
--   * It does not work out who was late. `late_entry` alerts are counted, never
--     re-derived from the hour: the schedule, the grace period and the
--     department threshold are resolved in `attendance.evaluate_alerts()` and
--     nowhere else. A dismissed alert stops counting, or HR's decision would
--     mean nothing.
--   * It does not decide who may read it. `SECURITY INVOKER`, so the policies
--     on `empleados`, `workdays` and `alerts` -- all `can_view_employee()` --
--     give a manager their department and HR everyone, with no role check
--     written here.

-- ============================================================ resolved_days ===
-- What each day was, for a set of people over a window. One definition.
--
-- The employees arrive as an array rather than being looked up here, so this
-- function changes nobody's scope: the caller has already established who it
-- may ask about, and the policies on `workdays` and `alerts` still filter every
-- row. That is what makes reissuing `attendance_summary()` on top of it a
-- mechanical substitution rather than a change of behaviour.
--
-- A row per (employee, date) for every date in the window, including the days
-- with no workday row at all -- a day somebody was expected and never arrived
-- is exactly the day worth seeing, and it has no row anywhere to be found by.

create or replace function internal.resolved_days(
  p_employee_ids uuid[],
  p_from         date,
  p_to           date
)
returns table (
  employee_id      uuid,
  work_date        date,
  time_zone        text,
  scheduled        boolean,
  expected_seconds integer,
  entry_expected   text,
  state            text,
  opened_at        timestamptz,
  closed_at        timestamptz,
  worked_seconds   integer,
  break_seconds    integer,
  has_offline      boolean,
  late             boolean
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select p.id,
         c.work_date,
         internal.time_zone_of(p.id),
         s.id is not null,
         -- What the schedule asks for, in working seconds: the span between the
         -- expected hours, less the break it allows. `worked_seconds` on a
         -- workday excludes breaks too, so the two are comparable. Null when the
         -- day is not scheduled, so a sum ignores it rather than counting a
         -- zero-hour expectation as an expectation of zero.
         case when s.id is null then null else
           greatest(0,
             extract(epoch from (s.exit_expected - s.entry_expected))::integer
             - coalesce(s.break_max_minutes, 0) * 60)
         end,
         to_char(s.entry_expected, 'HH24:MI'),
         coalesce(w.state, 'not_started'),
         w.opened_at,
         w.closed_at,
         coalesce(w.worked_seconds, 0),
         coalesce(w.break_seconds,  0),
         coalesce(w.has_offline, false),
         exists (
           select 1
             from attendance.alerts a
            where a.employee_id = p.id
              and a.alert_date  = c.work_date
              and a.kind        = 'late_entry'
              and a.state      <> 'dismissed'
         )
    from unnest(p_employee_ids) as p(id)
    cross join lateral (
      select d::date as work_date
        from generate_series(p_from, p_to, interval '1 day') as d
    ) c
    left join lateral internal.resolve_schedule(p.id, c.work_date) s on true
    left join attendance.workdays w
           on w.employee_id = p.id
          and w.work_date   = c.work_date;
$fn$;

comment on function internal.resolved_days(uuid[], date, date) is
  'What each day was, per employee and date, over a window. The one definition the summary and the report both build on.';

revoke all     on function internal.resolved_days(uuid[], date, date) from public, anon;
grant  execute on function internal.resolved_days(uuid[], date, date) to authenticated;

-- ======================================================= attendance_summary ===
-- Reissued for one change: the `resolved` CTE is now `internal.resolved_days()`
-- instead of a copy of it. Every figure below it is unchanged, and
-- `workforce_api_test.sql` is the proof -- it asserts these numbers already and
-- was not touched for this.
--
-- A body cannot be patched, so the whole function comes back. Its contract is
-- identical: same signature, same keys, same 92-day ceiling.

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
  v_result jsonb;
begin
  -- The same 92-day ceiling `my_history()` holds to, and for the same reason:
  -- a payroll dispute over a quarter is the widest question anybody asks, and
  -- an uncapped range is an accident waiting for the day the table is large.
  v_days  := greatest(7, least(coalesce(p_days, 30), 92));
  v_zone  := internal.time_zone_of(p_employee_id);
  v_today := (now() at time zone v_zone)::date;
  v_from  := v_today - (v_days - 1);

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
        select date_trunc('week', work_date)::date              as week_start,
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
          and a.state <> 'dismissed')                           as no_connection_alerts,
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
  'Every figure the two summary screens show, decided once. INVOKER so the policies on workdays, alerts and app_sessions keep deciding whose figures come back. Builds on internal.resolved_days().';

revoke all     on function internal.attendance_summary(uuid, integer) from public, anon;
grant  execute on function internal.attendance_summary(uuid, integer) to authenticated;

-- ======================================================== attendance_report ===
-- A period, and everybody in it.
--
-- **The period is resolved here, not in the browser.** "This week" has a wrong
-- answer available -- a week that starts on Sunday, or in the reader's zone
-- rather than the company's -- and `date_trunc('week', ...)` is ISO, so weeks
-- start on Monday. The same reasoning already put the summary's weekly grouping
-- in SQL. The client sends a scope and an anchor; what those mean is decided
-- here, once.
--
-- **What "cumplió" means is written down in exactly one place: this function.**
-- It is the one judgement the report makes that is not already a fact in a
-- table, so it gets stated rather than implied:
--
--   not_scheduled -- no scheduled day fell in the window. Nothing was asked of
--                    them, so nothing was met or missed.
--   pending       -- they are scheduled in this period, but every scheduled day
--                    is today or still to come. There is no evidence either
--                    way yet, and `met` on no evidence is the answer that would
--                    quietly certify a week nobody has worked.
--   missed        -- at least one scheduled day already past has no entry at
--                    all. Absence outranks everything else below it.
--   partial       -- they were there every scheduled day, but arrived late at
--                    least once, or opened a day they never closed.
--   met           -- every scheduled past day was finished, and no late entry
--                    that HR has not dismissed.
--
-- Today is never judged, on any of these. A day still being worked is not an
-- absence and not an unfinished day, which is the same cut `absent_days` makes
-- in the summary.
--
-- The reasons are returned as codes with counts, never as sentences: the
-- wording belongs to the screen, and a report consumed by anything other than
-- that screen should not have to parse Spanish to learn why.
--
-- **`absent` is not "días que tomaron".** There is no leave table yet, so a day
-- of approved holiday and a day somebody simply did not appear are the same row
-- here: a scheduled day with no entry. The screen has to say so, and does. When
-- a leave table exists this is where the extra condition goes -- one condition,
-- not a second report.

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

  case v_scope
    when 'day' then
      v_from := v_anchor;
      v_to   := v_anchor;
    when 'week' then
      v_from := date_trunc('week', v_anchor)::date;
      v_to   := v_from + 6;
    when 'month' then
      v_from := date_trunc('month', v_anchor)::date;
      v_to   := (v_from + interval '1 month' - interval '1 day')::date;
  end case;

  -- Who the report is about: everybody active, plus anybody who has a day in
  -- the window but has since left. A month that somebody worked half of should
  -- not lose those days the moment they are given de baja, and `estado` keeps
  -- no history to reconstruct it from. RLS on `empleados` is what scopes this.
  select coalesce(array_agg(e.id), '{}'::uuid[])
    into v_ids
    from public.empleados e
   where e.estado = 'activo'
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
  'One period -- day, week or month -- across everybody the caller may see. The period bounds and what "cumplio" means are decided here; every figure comes from internal.resolved_days().';

revoke all     on function public.attendance_report(text, date) from public, anon;
grant  execute on function public.attendance_report(text, date) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The report and the box agree about the same person. This is the
--   --    invariant that makes one shared resolution worth the refactor;
--   --    reports_api_test.sql asserts it directly.
--   select (public.attendance_report('month', current_date) -> 'people') -> 0;
--
--   -- 2. Both reads still invoke. A report that elevated would answer about
--   --    anybody to anybody.
--   select p.proname,
--          case p.prosecdef when true then 'definer' else 'invoker' end as security
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname in ('public', 'internal')
--      and p.proname in ('attendance_report', 'resolved_days', 'attendance_summary')
--    order by p.proname;
--   -- Expected: all three 'invoker'.
--
--   -- 3. A week starts on Monday, whatever day it is anchored at.
--   select public.attendance_report('week', d::date) ->> 'from'
--     from generate_series(current_date - 6, current_date, interval '1 day') as d;
--   -- Expected: the same Monday repeated, unless the range spans two weeks.
