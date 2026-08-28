-- Align the operational alert queue with the policy exposed in Administration.
--
-- Late entry remains schedule-based: entry_expected + grace_minutes + ten
-- additional minutes. The end of the entry window remains independently
-- configurable on each schedule and defaults to 10:00.
--
-- A schedule already owns the maximum break (60 minutes by default), so the
-- alert adds no hidden grace. Signal loss is actionable only after twenty full
-- minutes. Existing values are changed only when they still equal the previous
-- shipped defaults; an administrator's explicit customization wins.

insert into attendance.alert_rules (department_id, kind, active, threshold_minutes)
values
  (null, 'late_entry',     true, 10),
  (null, 'break_exceeded', true, 0),
  (null, 'no_connection',  true, 20)
on conflict (kind) where department_id is null do nothing;

update attendance.alert_rules
   set threshold_minutes = case kind
     when 'late_entry'     then 10
     when 'break_exceeded' then 0
     when 'no_connection'  then 20
   end
 where department_id is null
   and (
        (kind = 'late_entry'     and threshold_minutes = 0)
     or (kind = 'break_exceeded' and threshold_minutes = 5)
     or (kind = 'no_connection'  and threshold_minutes = 15)
   );

-- A missing rule is an active rule with the defaults below. Reissue the one
-- evaluator rather than introducing a second policy path.

create or replace function attendance.evaluate_alerts(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_upserted jsonb;
  v_queued   integer;
begin
  with employee_day as (
    select
      e.id                                                  as employee_id,
      e.department_id,
      coalesce(d.time_zone, 'America/Mexico_City')          as zone,
      (p_now at time zone coalesce(d.time_zone, 'America/Mexico_City'))::date
        - offset_days                                       as local_date
      from public.empleados e
      left join public.departments d on d.id = e.department_id
      cross join unnest(array[0, 1]) as offset_days
     where e.estado = 'activo'
       and e.auth_user_id is not null
  ),

  -- One row per employee and day: the schedule in force, the workday as it
  -- stands, and the few facts about the day's punches the rules need.
  context as (
    select
      ed.employee_id,
      ed.department_id,
      ed.zone,
      ed.local_date,

      sch.id                as schedule_id,
      sch.grace_minutes,
      sch.break_max_minutes,
      (ed.local_date + sch.entry_expected) at time zone ed.zone as entry_expected_at,
      (ed.local_date + sch.entry_until)    at time zone ed.zone as entry_until_at,
      (ed.local_date + sch.exit_expected)  at time zone ed.zone as exit_expected_at,

      w.id                  as workday_id,
      coalesce(w.state, 'not_started') as state,
      w.opened_at,
      w.closed_at,
      w.needs_review,
      coalesce(w.last_heartbeat, w.opened_at) as last_signal_at,

      -- An open break counts from the moment it started, or a break that is
      -- still running would never exceed anything.
      w.break_seconds + case
        when w.state = 'on_break' and pf.break_started_at is not null
        then greatest(0, extract(epoch from (p_now - pf.break_started_at))::integer)
        else 0
      end                   as break_seconds_total,

      pf.review_count,
      pf.review_reason,
      pf.max_skew_ms

      from employee_day ed
      left join lateral internal.resolve_schedule(ed.employee_id, ed.local_date) sch on true
      left join attendance.workdays w
             on w.employee_id = ed.employee_id
            and w.work_date   = ed.local_date
      left join lateral (
        select
          max(p.occurred_at) filter (where p.kind = 'break_start') as break_started_at,
          count(*)           filter (where p.needs_review)         as review_count,
          max(p.review_reason)                                     as review_reason,
          max(abs(p.clock_skew_ms))                                as max_skew_ms
          from attendance.punches p
         where p.workday_id = w.id
      ) pf on true
  ),

  -- The thresholds in force, one row per candidate alert. Written as a cross
  -- join with the defaults rather than eight separate queries so that adding a
  -- kind is one row here and one branch in the case below, and so that every
  -- kind resolves its rule exactly the same way.
  defaults (kind, severity, threshold_minutes) as (
    values
      ('late_entry',     'medium', 10),
      ('missing_entry',  'high',   0),
      ('break_exceeded', 'low',    0),
      ('missing_exit',   'medium', 60),
      -- Fifteen minutes, and `medium` like `late_entry`: leaving early and
      -- arriving late are the same kind of claim, made from the same clock.
      ('early_exit',     'medium', 15),
      ('no_connection',  'low',    20),
      ('review_offline', 'medium', 0),
      ('clock_tampered', 'high',   15)
  ),

  candidate as (
    select
      c.*,
      k.kind,
      k.severity,
      coalesce(r.threshold_minutes, k.threshold_minutes) as threshold_minutes,
      make_interval(mins => coalesce(r.threshold_minutes, k.threshold_minutes)) as slack
      from context c
      cross join defaults k
      left join lateral internal.alert_rule(c.department_id, k.kind) r on true
     where coalesce(r.active, true)
  ),

  raised as (
    select
      employee_id,
      local_date,
      kind,
      severity,
      case kind
        when 'late_entry' then jsonb_build_object(
          'minutes_late', round(extract(epoch from
            (opened_at - (entry_expected_at + make_interval(mins => grace_minutes)))) / 60)::integer,
          'expected_at',  to_char(entry_expected_at at time zone zone, 'HH24:MI'),
          'arrived_at',   to_char(opened_at         at time zone zone, 'HH24:MI'),
          'grace_minutes', grace_minutes)

        when 'missing_entry' then jsonb_build_object(
          'entry_until',      to_char(entry_until_at at time zone zone, 'HH24:MI'),
          'minutes_overdue',  round(extract(epoch from (p_now - entry_until_at)) / 60)::integer)

        when 'break_exceeded' then jsonb_build_object(
          'break_minutes',    round(break_seconds_total / 60.0)::integer,
          'allowed_minutes',  break_max_minutes,
          'still_on_break',   state = 'on_break')

        when 'missing_exit' then jsonb_build_object(
          'exit_expected',    to_char(exit_expected_at at time zone zone, 'HH24:MI'),
          'minutes_overdue',  round(extract(epoch from (p_now - exit_expected_at)) / 60)::integer,
          'state',            state)

        when 'early_exit' then jsonb_build_object(
          'minutes_early',    round(extract(epoch from (exit_expected_at - closed_at)) / 60)::integer,
          'expected_at',      to_char(exit_expected_at at time zone zone, 'HH24:MI'),
          'left_at',          to_char(closed_at        at time zone zone, 'HH24:MI'),
          'threshold_minutes', threshold_minutes)

        when 'no_connection' then jsonb_build_object(
          'minutes_silent',   round(extract(epoch from (p_now - last_signal_at)) / 60)::integer,
          'last_signal_at',   to_char(last_signal_at at time zone zone, 'HH24:MI'))

        when 'review_offline' then jsonb_build_object(
          'punches_flagged',  review_count,
          'reason',           review_reason)

        when 'clock_tampered' then jsonb_build_object(
          'skew_minutes',     round(max_skew_ms / 60000.0)::integer,
          'threshold_minutes', threshold_minutes)
      end as details
      from candidate
     where case kind

             -- Arrived, and later than the schedule plus its grace allows.
             -- Silence before the arrival is deliberate: until somebody clocks
             -- in there is nothing to measure, and missing_entry covers the
             -- case where they never do.
             when 'late_entry' then
               schedule_id is not null
               and opened_at is not null
               and opened_at > entry_expected_at + make_interval(mins => grace_minutes) + slack

             -- The entry window closed and the workday never started.
             when 'missing_entry' then
               schedule_id is not null
               and state = 'not_started'
               and p_now > entry_until_at + slack

             when 'break_exceeded' then
               schedule_id is not null
               and workday_id is not null
               and break_seconds_total > (break_max_minutes * 60) + (threshold_minutes * 60)

             -- Still open well after the expected exit. Also the shape of
             -- "forgot to clock out", which is why the evaluator looks at
             -- yesterday as well as today.
             when 'missing_exit' then
               schedule_id is not null
               and state in ('working', 'on_break')
               and p_now > exit_expected_at + slack

             -- Closed the day, and earlier than the schedule's exit allows.
             -- Only once it is `finished`: somebody on a break at three in the
             -- afternoon has not left early, they are on a break, and the rule
             -- for a break that runs long is break_exceeded. This is the mirror
             -- of missing_exit and deliberately cannot overlap with it -- the
             -- states they require are disjoint.
             when 'early_exit' then
               schedule_id is not null
               and state = 'finished'
               and closed_at is not null
               and closed_at < exit_expected_at - slack

             -- The PWA beats every five minutes while the workday is open, so
             -- silence means the laptop is off, asleep or offline. Only while
             -- the person is working, though: closing the laptop during a
             -- break is what a break is for, and the alert for a break that
             -- runs long is break_exceeded, not this one.
             when 'no_connection' then
               state = 'working'
               and last_signal_at is not null
               and last_signal_at < p_now - slack

             -- Independent of any schedule: a punch that arrived flagged has to
             -- be looked at whether or not the day had a schedule at all.
             when 'review_offline' then
               workday_id is not null
               and needs_review

             when 'clock_tampered' then
               workday_id is not null
               and max_skew_ms > threshold_minutes * 60000
           end
  ),

  upserted as (
    insert into attendance.alerts as a (employee_id, alert_date, kind, severity, details)
    select employee_id, local_date, kind, severity, details from raised
    -- The predicate is not optional: it is how Postgres infers the partial
    -- index. Without it this would look for a total unique index that no longer
    -- exists.
    on conflict (employee_id, alert_date, kind) where superseded_at is null
    do update
       set severity = excluded.severity,
           details  = excluded.details
     -- An acknowledged, resolved or dismissed alert stays that way. Reopening
     -- it every five minutes would make the state column meaningless. A
     -- superseded one is not reached at all -- it is outside the index.
     where a.state = 'open'
    returning a.id, a.employee_id, a.alert_date, a.kind, a.severity, a.details
  )

  select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) into v_upserted from upserted u;

  -- Enqueueing is attempted for every alert the statement above touched, not
  -- just the new ones: the unique key on idempotency_key is what makes it
  -- exactly-once, and it does that without this function having to work out
  -- which rows were inserted and which were refreshed.
  insert into attendance.notification_outbox (alert_id, idempotency_key, recipients, payload)
  select
    u.id,
    'alert:' || u.id::text,
    r.recipients,
    jsonb_build_object(
      'alert_id',      u.id,
      'kind',          u.kind,
      'severity',      u.severity,
      'alert_date',    u.alert_date,
      'employee_id',   u.employee_id,
      'employee_name', e.nombre,
      'department',    d.name,
      'time_zone',     coalesce(d.time_zone, 'America/Mexico_City'),
      'details',       u.details
    )
    from jsonb_to_recordset(v_upserted) as u (
           id uuid, employee_id uuid, alert_date date,
           kind text, severity text, details jsonb)
    join public.empleados e on e.id = u.employee_id
    left join public.departments d on d.id = e.department_id
    left join lateral internal.alert_rule(e.department_id, u.kind) r on true
  on conflict (idempotency_key) do nothing;

  get diagnostics v_queued = row_count;

  return jsonb_build_object(
    'evaluated_at',         p_now,
    'alerts_upserted',      jsonb_array_length(v_upserted),
    'notifications_queued', v_queued
  );
end;
$fn$;

comment on function attendance.evaluate_alerts(timestamptz) is
  'The only place that decides an alert exists. Defaults: ten minutes beyond expected entry plus schedule grace, no extra break grace, twenty minutes without signal. Rules remain configurable globally or by department.';
