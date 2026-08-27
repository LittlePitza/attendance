-- A superseded alert counts towards nothing, everywhere.
--
-- The migration before this one gave `attendance.alerts` a `superseded_at` and
-- narrowed the unique index to rows where it is null, so a discarded alert stops
-- blocking its replacement. That is only half of it: every reader still counted
-- the superseded row, so a `late_entry` about a voided punch would keep marking
-- the day late and keep punctuality wrong -- while a second, correct alert sat
-- beside it being counted too.
--
-- So this is one change made in six places, and the list is the point: these are
-- every function that asks the alerts table a question.
--
--   internal.resolved_days      the `late` flag behind punctuality and the board
--   internal.attendance_summary the disconnection count
--   public.open_alerts          what Alertas shows
--   public.attendance_report    the period's counts, per person and in total
--   public.decide_alert         refuses to decide one, with a sentence saying why
--   public.employee_dossier     shows them, marked -- it is a history
--
-- The dossier is the deliberate exception. It does not filter them out, because
-- a page about one person exists to show what the record holds, and "flagged for
-- arriving at 12:50, then that punch was discarded, then flagged again for
-- 13:41" is the true story of that day. Every other reader is counting, and a
-- superseded alert must not be counted.

-- ============================================================ resolved_days ===
-- One line: the `late` flag ignores a superseded alert. It is the most
-- consequential line in the file -- `late` is what punctuality, the streak, the
-- board's counts and the report's verdicts are all built on.

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
              -- An alert about a punch that stopped counting says nothing about
              -- the day any more. Without this, resetting a day leaves it marked
              -- late for ever on the strength of an arrival the reset discarded.
              and a.superseded_at is null
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
  'What each day was, per employee and date, over a window. The one definition the summary and the report both build on. expected_seconds is 0 on an unscheduled day, never null; a superseded late_entry does not mark a day late.';

revoke all     on function internal.resolved_days(uuid[], date, date) from public, anon;
grant  execute on function internal.resolved_days(uuid[], date, date) to authenticated;

-- ======================================================= attendance_summary ===
-- One line, in the disconnection count. Everything else here already comes from
-- `resolved_days` above.

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
  'Every figure the two summary screens show, decided once. INVOKER so the policies on workdays, alerts and app_sessions keep deciding whose figures come back. Builds on internal.resolved_days(); superseded alerts count for nothing.';

revoke all     on function internal.attendance_summary(uuid, integer) from public, anon;
grant  execute on function internal.attendance_summary(uuid, integer) to authenticated;

-- ============================================================= open_alerts ===
-- What Alertas shows. A superseded alert is not open work even when its `state`
-- still says `open`, because the thing it was about was discarded.

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
       and a.superseded_at is null
     order by a.alert_date desc,
              -- Not alphabetical: 'high' before 'medium' before 'low'.
              case a.severity when 'high' then 1 when 'medium' then 2 else 3 end,
              e.nombre
     limit greatest(1, least(p_limit, 500));
end;
$fn$;

comment on function public.open_alerts(date, integer) is
  'Open alerts for the employees the caller may see, most recent and most severe first. Superseded ones are not open work: the punches they were about stopped counting.';

revoke all     on function public.open_alerts(date, integer) from public, anon;
grant  execute on function public.open_alerts(date, integer) to authenticated;

-- ============================================================ decide_alert ===
-- Reissued for one refusal: an alert whose evidence was discarded is not
-- something to decide about. The sentence says so, because the alternative is a
-- reviewer writing a ten-character justification for a record that already
-- counts for nothing.

create or replace function public.decide_alert(
  p_alert_id uuid,
  p_state    text,
  p_note     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_alert attendance.alerts;
begin
  -- Null-safe for the same reason as review_punch: an `if` on null does not
  -- fire, and this is the gate.
  if coalesce(internal.caller_role(), 'guest') not in ('hr', 'admin') then
    raise exception 'Solo Recursos Humanos puede resolver alertas'
      using errcode = '42501';
  end if;

  if p_state not in ('acknowledged', 'resolved', 'dismissed') then
    raise exception 'El estado debe ser reconocida, resuelta o descartada'
      using errcode = '22023',
            hint    = 'acknowledged, resolved o dismissed';
  end if;

  if p_note is null or length(trim(p_note)) < 10 then
    raise exception 'La nota debe tener al menos 10 caracteres'
      using errcode = '22023';
  end if;

  select a.* into v_alert
    from attendance.alerts a
   where a.id = p_alert_id;

  if v_alert.id is null then
    raise exception 'Esa alerta no existe'
      using errcode = '02000';
  end if;

  if not coalesce(internal.can_view_employee(v_alert.employee_id), false) then
    raise exception 'Esa alerta pertenece a alguien fuera de tu alcance'
      using errcode = '42501';
  end if;

  -- The punches this was about were voided, so it already counts towards
  -- nothing. Deciding it would record a judgement about a discarded record.
  if v_alert.superseded_at is not null then
    raise exception 'Esa alerta quedo sin efecto porque se anularon los marcajes del dia'
      using errcode = '22023',
            hint    = 'Si el dia volvio a marcarse, hay una alerta nueva con lo que paso';
  end if;

  -- Deciding a decided alert would overwrite the first decision and the note
  -- that explained it. The record of who closed it and why is the thing this
  -- function exists to create.
  if v_alert.state <> 'open' then
    raise exception 'Esa alerta ya fue resuelta'
      using errcode = '22023';
  end if;

  update attendance.alerts a
     set state           = p_state,
         note            = p_note,
         acknowledged_by = auth.uid(),
         acknowledged_at = now(),
         resolved_at     = case when p_state = 'resolved' then now() else null end
   where a.id = p_alert_id
  returning * into v_alert;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('alert_decided', 'attendance.alerts', v_alert.id, auth.uid(), p_note,
     jsonb_build_object('state', 'open', 'kind', v_alert.kind,
                        'severity', v_alert.severity),
     jsonb_build_object('state', p_state));

  return jsonb_build_object(
    'alert_id', v_alert.id,
    'state',    v_alert.state,
    'kind',     v_alert.kind
  );
end;
$fn$;

comment on function public.decide_alert(uuid, text, text) is
  'Records HR decision on one open alert, with a mandatory note. Refuses an alert already decided, and one left without effect by a day reset.';

revoke all     on function public.decide_alert(uuid, text, text) from public, anon;
grant  execute on function public.decide_alert(uuid, text, text) to authenticated;

-- ======================================================== attendance_report ===
-- One line, in the period's alert scope. Every other figure here comes from
-- `resolved_days` above, which already ignores them.
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
  'One period -- day, week or month -- across the people who have an account, which is the population evaluate_alerts() watches. Period bounds and what "cumplio" means are decided here; every figure comes from internal.resolved_days(); superseded alerts count for nothing.';

revoke all     on function public.attendance_report(text, date) from public, anon;
grant  execute on function public.attendance_report(text, date) to authenticated;

-- ========================================================= employee_dossier ===
-- The exception. It gains `superseded_at` on each alert rather than a filter,
-- because it is the one reader that is showing a history instead of counting one.
create or replace function public.employee_dossier(
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
  v_days     integer;
  v_zone     text;
  v_today    date;
  v_from     date;
  v_summary  jsonb;
  v_employee public.empleados;
  v_result   jsonb;
begin
  -- The same ceiling the summary holds to, so the trails below cover exactly
  -- the range its figures do. A dossier whose alert list ran wider than its
  -- hours would invite comparing two different periods.
  v_days := greatest(7, least(coalesce(p_days, 30), 92));

  -- This is the visibility check as well as the figures. It raises for somebody
  -- the caller may not see, which is why it comes first.
  v_summary := public.employee_summary(p_employee_id, v_days);

  select e.* into v_employee
    from public.empleados e
   where e.id = p_employee_id;

  v_zone  := v_summary ->> 'time_zone';
  v_today := (v_summary ->> 'to')::date;
  v_from  := (v_summary ->> 'from')::date;

  select jsonb_build_object(
    'server_time', now(),
    'days',        v_days,
    'from',        v_from,
    'to',          v_today,

    -- Who they are. Not their role or their last sign-in: those live on
    -- Configuración → Accesos, and `list_accounts()` is the one place that
    -- decides them.
    'employee', jsonb_build_object(
      'employee_id',   v_employee.id,
      'employee_name', v_employee.nombre,
      'email',         v_employee.correo,
      'job_title',     v_employee.puesto,
      'department',    (select d.name from public.departments d
                         where d.id = v_employee.department_id),
      'state',         v_employee.estado,
      'time_zone',     v_zone,
      -- Whether they can punch at all. The report counts only people who can,
      -- and a dossier that did not say so would make an empty one puzzling.
      'has_account',   v_employee.auth_user_id is not null
    ),

    'summary', v_summary,

    -- ------------------------------------------------------------ sessions ---
    -- When they had the application open, from where, and how it ended.
    -- `end_reason` is the honest part: `sign_out` and `app_closed` were said out
    -- loud, `expired` means nothing was heard again and the sweeper stamped it
    -- at the last report. `expired` is not evidence of anything deliberate.
    'sessions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id',           s.id,
               'started_at',   s.started_at,
               'last_seen_at', s.last_seen_at,
               'ended_at',     s.ended_at,
               'end_reason',   s.end_reason,
               'seconds',      extract(epoch from (
                                 coalesce(s.ended_at, s.last_seen_at) - s.started_at
                               ))::integer,
               'ip',           host(s.ip),
               'platform',     s.platform,
               'time_zone',    s.time_zone,
               'app_version',  s.app_version,
               'device_id',    s.device_id
             ) order by s.started_at desc), '[]'::jsonb)
        from attendance.app_sessions s
       where s.employee_id = p_employee_id
         and (s.started_at at time zone v_zone)::date between v_from and v_today
    ),

    -- ------------------------------------------------------------- devices ---
    -- One row per machine, with the `last_seen_at` that gets overwritten. Not a
    -- history -- that is what the sessions above are -- but it is the list HR
    -- revokes from, so it belongs on the person's page.
    --
    -- Not filtered to the range: a machine first seen a year ago is still the
    -- machine they use, and hiding it because the window is 30 days would make
    -- the revoke list wrong.
    'devices', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'device_id',     d.device_id,
               'user_agent',    d.user_agent,
               'first_seen_at', d.first_seen_at,
               'last_seen_at',  d.last_seen_at,
               'revoked_at',    d.revoked_at
             ) order by d.last_seen_at desc), '[]'::jsonb)
        from attendance.devices d
       where d.employee_id = p_employee_id
    ),

    -- -------------------------------------------------------------- alerts ---
    -- Every alert in the range, whatever its state -- which is the difference
    -- from `open_alerts()`. A person's history includes the ones HR dealt with,
    -- and a page that showed only the open ones would make somebody who has been
    -- late twenty times and forgiven each look spotless.
    'alerts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id',         a.id,
               'alert_date', a.alert_date,
               'kind',       a.kind,
               'severity',   a.severity,
               'state',      a.state,
               'details',    a.details,
               'note',       a.note,
               'created_at', a.created_at,
               -- Not filtered out, unlike every counting reader: a page about
               -- one person exists to show what the record holds, and "flagged
               -- for 12:50, that punch discarded, flagged again for 13:41" is
               -- the true story of that day.
               'superseded_at', a.superseded_at
             ) order by a.alert_date desc, a.created_at desc), '[]'::jsonb)
        from attendance.alerts a
       where a.employee_id = p_employee_id
         and a.alert_date between v_from and v_today
    ),

    -- --------------------------------------------------------- adjustments ---
    -- What somebody decided about this person's record: a day reset, an offline
    -- punch approved or rejected. Each carries the mandatory reason, which is
    -- the whole point of the table.
    --
    -- The actor is resolved through `empleados` rather than `auth.users`, which
    -- `authenticated` cannot read. Null when the account is not an employee --
    -- the administrative one is not -- and the screen says so rather than
    -- inventing a name.
    'adjustments', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id',         j.id,
               'kind',       j.kind,
               'reason',     j.reason,
               'work_date',  w.work_date,
               'old_value',  j.old_value,
               'new_value',  j.new_value,
               'created_at', j.created_at,
               'actor',      actor.nombre
             ) order by j.created_at desc), '[]'::jsonb)
        from attendance.adjustments j
        join attendance.workdays w on w.id = j.workday_id
        left join public.empleados actor on actor.auth_user_id = j.adjusted_by
       where w.employee_id = p_employee_id
         and w.work_date between v_from and v_today
    ),

    -- -------------------------------------------------------- connectivity ---
    -- The gaps. `occurred_at` is when the server heard it and
    -- `client_reported_at` is when the device says it happened -- and for
    -- `connection_lost` those are necessarily different, because an offline
    -- event cannot be sent while offline.
    'connectivity', jsonb_build_object(
      'counts', (
        select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)
          from (
            select ev.kind, count(*)::integer as n
              from attendance.session_events ev
             where ev.employee_id = p_employee_id
               and (ev.occurred_at at time zone v_zone)::date between v_from and v_today
             group by ev.kind
          ) as k
      ),
      'items', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id',                 ev.id,
                 'session_id',         ev.session_id,
                 'kind',               ev.kind,
                 'occurred_at',        ev.occurred_at,
                 'client_reported_at', ev.client_reported_at,
                 'detail',             ev.detail
               ) order by ev.occurred_at desc), '[]'::jsonb)
          from (
            select ev.*
              from attendance.session_events ev
             where ev.employee_id = p_employee_id
               and (ev.occurred_at at time zone v_zone)::date between v_from and v_today
             order by ev.occurred_at desc
             limit 200
          ) as ev
      )
    ),

    -- -------------------------------------------------------------- punches ---
    -- The marks themselves, over the range rather than for one day, which is
    -- what `employee_day()` answers. Capped: ninety days of four punches is
    -- readable, and a runaway is not.
    --
    -- A punch that stopped counting carries **the adjustment that stopped it**,
    -- not a boolean. `internal.punch_is_void()` is the one definition of the
    -- difference and it is deliberately not executable by `authenticated`, so
    -- reaching for it here would mean widening a grant somebody narrowed on
    -- purpose. Exposing the underlying row is better on the merits anyway: on a
    -- page about one person, "voided at 14:02, because ..." is what a reader
    -- needs, and `void` is then a null check rather than a rule. Without it a
    -- reset day would show four punches beside a zeroed counter with nothing to
    -- explain the difference.
    'punches', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id',                 p.id,
               'work_date',          p.work_date,
               'kind',               p.kind,
               'occurred_at',        p.occurred_at,
               'client_reported_at', p.client_reported_at,
               'source',             p.source,
               'needs_review',       p.needs_review,
               'voided_at',          p.voided_at,
               'void_reason',        p.void_reason
             ) order by p.occurred_at desc), '[]'::jsonb)
        from (
          -- The day a punch belongs to lives on its workday, not on the punch:
          -- `work_date` is resolved once when the day opens, in the employee's
          -- zone, and a punch after midnight still belongs to the shift that
          -- opened it.
          select p.id, w.work_date, p.kind, p.occurred_at, p.client_reported_at,
                 p.source, p.needs_review,
                 v.created_at as voided_at,
                 v.reason     as void_reason
            from attendance.punches p
            join attendance.workdays w on w.id = p.workday_id
            -- One void per punch is what `reset_day()` writes, but the schema
            -- does not promise it, so this takes the first rather than
            -- multiplying the punch by its adjustments.
            left join lateral (
              select a.created_at, a.reason
                from attendance.adjustments a
               where a.punch_id = p.id
                 and a.kind     = 'void_punch'
               order by a.created_at
               limit 1
            ) v on true
           where p.employee_id = p_employee_id
             and w.work_date between v_from and v_today
           order by p.occurred_at desc
           limit 400
        ) as p
    )
  )
    into v_result;

  return v_result;
end;
$fn$;

comment on function public.employee_dossier(uuid, integer) is
  'Everything about one person over a range: the summary as employee_summary() decides it, plus sessions, devices, every alert (superseded ones marked, not hidden), adjustments, connectivity events and punches. INVOKER, so six policies decide who may read whom.';

revoke all     on function public.employee_dossier(uuid, integer) from public, anon;
grant  execute on function public.employee_dossier(uuid, integer) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. A superseded alert does not mark its day late.
--   select s.value ->> 'date', s.value ->> 'late'
--     from jsonb_array_elements(internal.attendance_summary('<id>'::uuid, 30) -> 'series') s
--    where (s.value ->> 'date')::date = '<the reset day>';
--
--   -- 2. Nor does it appear as open work.
--   select count(*) from public.open_alerts()
--    where id in (select id from attendance.alerts where superseded_at is not null);
--   -- Expected: 0.
--
--   -- 3. But the dossier still shows it, marked.
--   select a.value ->> 'kind', a.value ->> 'superseded_at'
--     from jsonb_array_elements(public.employee_dossier('<id>'::uuid, 30) -> 'alerts') a;
