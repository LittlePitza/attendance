-- Two corrections to `attendance_reports_api`, landing before anybody has read
-- a report with either of them in it.
--
-- 1. **Only people who can actually punch are in a report.** Of the 31 people on
--    the roster, two have an account. The rest are not working Home Office --
--    they have no way to clock in at all -- and the first version counted every
--    one of them, so a period came back full of `missed` and `pending` rows for
--    people nobody had ever asked to punch. That is the same population rule
--    `attendance.evaluate_alerts()` already holds to, in the same words:
--    somebody who cannot punch cannot be late. A report that disagreed with the
--    evaluator about who is being watched would be the third definition of the
--    same thing.
--
-- 2. **`expected_seconds` is 0 on an unscheduled day, not null.** Lifting the
--    per-day resolution out of `internal.attendance_summary()` changed a value
--    that function had always published. Detail below, on the function itself.

-- ============================================================ resolved_days ===
-- The old expression was:
--
--   greatest(0, extract(epoch from (s.exit_expected - s.entry_expected))::integer
--               - coalesce(s.break_max_minutes, 0) * 60)
--
-- With no schedule row `extract(...)` is null, so that reads `greatest(0, null)`
-- -- and **`greatest` ignores nulls**, so it returned 0. The replacement wrapped
-- it in `case when s.id is null then null else ... end`, on the stated reasoning
-- that a null would be skipped by a sum "rather than counting a zero-hour
-- expectation as an expectation of zero". That reasoning was wrong twice over:
-- summing a 0 and skipping a null give the same total, so the null bought
-- nothing, and `my_summary()` and `employee_summary()` publish this value per
-- day in `series[].expected_seconds`, where 26 days of a 30-day range went from
-- `0` to `null`.
--
-- `web/src/lib/types.ts` declares `SummaryDay.expected_seconds` as `number`, not
-- `number | null`, so the employee's own screen and the box on the board were
-- handed a null they are not typed for -- the same shape of bug as the counter
-- that once showed NaN while a migration was behind the bundle.
--
-- The totals were unaffected in both directions, which is exactly why nothing
-- caught it. Only the per-day array moved, and no assertion looked at it.
-- `workforce_api_test.sql` now does, on both the null and the zero.

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
         -- workday excludes breaks too, so the two are comparable.
         --
         -- On a day no schedule covers this is 0, and it is written plainly
         -- rather than left to `greatest` quietly dropping a null: `scheduled`
         -- is the field that says whether anything was expected, and this one is
         -- a number every caller can add up. Two screens publish it per day and
         -- neither types it as nullable.
         case when s.id is null then 0 else
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
  'What each day was, per employee and date, over a window. The one definition the summary and the report both build on. expected_seconds is 0 on an unscheduled day, never null: two screens publish it per day.';

revoke all     on function internal.resolved_days(uuid[], date, date) from public, anon;
grant  execute on function internal.resolved_days(uuid[], date, date) to authenticated;

-- ======================================================== attendance_report ===
-- Reissued for the population clause alone. Every figure, the period
-- resolution and the compliance rule are unchanged from
-- `attendance_reports_api`; a body cannot be patched, so the whole function
-- comes back.

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
  'One period -- day, week or month -- across the people who have an account, which is the population evaluate_alerts() watches. Period bounds and what "cumplio" means are decided here; every figure comes from internal.resolved_days().';

revoke all     on function public.attendance_report(text, date) from public, anon;
grant  execute on function public.attendance_report(text, date) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. Nobody without a way in is in a report.
--   select count(*) as people_without_access
--     from jsonb_array_elements(public.attendance_report('month') -> 'people') p
--     join public.empleados e on e.id = (p.value ->> 'employee_id')::uuid
--    where e.auth_user_id is null
--      and not exists (select 1 from attendance.workdays w
--                       where w.employee_id = e.id);
--   -- Expected: 0.
--
--   -- 2. Every day of a range carries a number, scheduled or not.
--   select count(*) filter (where s.value ->> 'expected_seconds' is null) as nulls
--     from jsonb_array_elements(internal.attendance_summary(
--            (select id from public.empleados where auth_user_id is not null limit 1),
--            30) -> 'series') s;
--   -- Expected: 0.
