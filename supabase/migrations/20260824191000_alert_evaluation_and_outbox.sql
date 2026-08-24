-- alert_evaluation_and_outbox.sql
--
-- attendance.alerts has existed since the schema was created, with a unique
-- (employee_id, alert_date, kind) that was put there so repeated evaluation
-- could never flood HR with the same alert twice. What was missing is the
-- function that decides when a row belongs there, and somewhere to queue the
-- notification that follows.
--
-- Two rules shape this file.
--
--   * The decision stays in Postgres. evaluate_alerts() reads the schedule, the
--     workday and the punches, and writes the alert. No Edge Function ever
--     decides whether somebody was late.
--
--   * Delivery leaves the transaction. The evaluator enqueues a row in
--     attendance.notification_outbox and stops. A mail provider that is slow,
--     down or rate limiting must never roll back attendance state, and a failed
--     send must never lose the alert that produced it.
--
-- p_now is a parameter instead of a hardcoded now() so the evaluator is
-- testable: the same instant always yields the same alerts. It is not a way to
-- rewrite history -- the caller in production is cron, which passes nothing.

-- ==================================================== notification outbox ===
-- The transactional boundary between "an alert exists" and "somebody was told".
-- The evaluator only ever inserts here; the dispatcher claims, sends and
-- reports back through the two functions at the bottom of this file.
--
-- payload is denormalised on purpose. It carries the employee's name, the
-- department and the time zone so the dispatcher composes the message without
-- reading a single table -- and so a message sent in October still reads the
-- way it did when it was queued, even if the person changed department in
-- November.

create table if not exists attendance.notification_outbox (
  id               uuid        primary key default gen_random_uuid(),
  alert_id         uuid        not null references attendance.alerts (id) on delete cascade,
  idempotency_key  text        not null,
  channel          text        not null default 'email',
  recipients       text,
  payload          jsonb       not null default '{}',
  status           text        not null default 'pending',
  attempts         integer     not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One notification per alert. The key is derived from the alert id, which is
  -- itself stable per (employee, date, kind): re-running the evaluator every
  -- five minutes cannot queue the same message twice.
  constraint notification_outbox_key_unique unique (idempotency_key),

  constraint notification_outbox_channel_valid
    check (channel in ('email')),
  constraint notification_outbox_status_valid
    check (status in ('pending', 'sending', 'sent', 'failed')),
  constraint notification_outbox_attempts_sane
    check (attempts >= 0),
  constraint notification_outbox_delivery_coherent
    check ((status = 'sent') = (delivered_at is not null))
);

comment on table attendance.notification_outbox is
  'Queued alert notifications. The evaluator enqueues inside its transaction; delivery happens outside it and is retried.';
comment on column attendance.notification_outbox.idempotency_key is
  'Derived from the alert id. Makes enqueueing exactly-once no matter how often the evaluator runs.';
comment on column attendance.notification_outbox.payload is
  'Everything the dispatcher needs to compose the message, denormalised so it reads as it did when queued.';
comment on column attendance.notification_outbox.recipients is
  'Comma-separated addresses from the alert rule. Null means the dispatcher uses the defaults in public.config_correo.';

-- The dispatcher's working query: what is due, oldest first.
create index if not exists notification_outbox_due_idx
  on attendance.notification_outbox (next_attempt_at)
  where status = 'pending';

-- For finding work abandoned by a dispatcher that died mid-send.
create index if not exists notification_outbox_sending_idx
  on attendance.notification_outbox (updated_at)
  where status = 'sending';

create index if not exists notification_outbox_alert_idx
  on attendance.notification_outbox (alert_id);

drop trigger if exists notification_outbox_touch on attendance.notification_outbox;
create trigger notification_outbox_touch
  before update on attendance.notification_outbox
  for each row execute function public.touch_updated_at();

-- RLS is on and no policy is created: nothing here is readable by an employee,
-- a manager or HR. It holds delivery plumbing and recipient addresses, and the
-- dispatcher reaches it with the service role. No table privilege is granted to
-- authenticated either, which is what actually keeps it closed.
alter table attendance.notification_outbox enable row level security;

-- =========================================================== rule lookup ===
-- Precedence department > global, the same shape as internal.resolve_schedule.
-- A null department_id in alert_rules is the global rule; comparing it to the
-- employee's department yields null, never true, so the global row can only win
-- when no department row exists.
--
-- No row at all is not the same as a disabled rule: the evaluator falls back to
-- its own defaults, so an alert kind is never silently switched off by the
-- absence of configuration.

create or replace function internal.alert_rule(p_department_id uuid, p_kind text)
returns attendance.alert_rules
language sql
stable
security definer
set search_path = ''
as $fn$
  select r.*
    from attendance.alert_rules r
   where r.kind = p_kind
     and (r.department_id = p_department_id or r.department_id is null)
   order by case when r.department_id is not null then 1 else 2 end
   limit 1;
$fn$;

comment on function internal.alert_rule(uuid, text) is
  'Alert rule in force for a department and kind. Precedence: department > global. Null when neither exists.';

revoke all on function internal.alert_rule(uuid, text) from public, anon, authenticated;

-- ================================================= the evaluator's defaults ===
-- What every alert kind means, what it costs HR to be told, and how much slack
-- it gets before it fires. These are the values used when alert_rules has no
-- row for the kind, and they are seeded below as global rules so HR can see and
-- change them from the interface instead of guessing they exist.
--
--   late_entry      minutes past entry_expected + grace before the arrival
--                   counts as late. 0: the schedule's grace is the tolerance,
--                   and a second one on top of it would only hide the first.
--   missing_entry   minutes past entry_until with no clock_in at all.
--   break_exceeded  minutes over break_max_minutes.
--   missing_exit    minutes past exit_expected with the workday still open.
--   no_connection   minutes without a heartbeat while the person is working.
--                   Not while on break: closing the laptop is what a break is
--                   for, and a break that runs long is break_exceeded.
--   review_offline  a punch arrived flagged for review. Not time-based.
--   clock_tampered  minutes of clock skew on a punch. Above two minutes the
--                   engine already flags the punch; this fires at fifteen,
--                   where it stops looking like drift.

insert into attendance.alert_rules (department_id, kind, active, threshold_minutes)
values
  (null, 'late_entry',      true,  0),
  (null, 'missing_entry',   true,  0),
  (null, 'break_exceeded',  true,  5),
  (null, 'missing_exit',    true,  60),
  (null, 'no_connection',   true,  15),
  (null, 'review_offline',  true,  0),
  (null, 'clock_tampered',  true,  15)
on conflict do nothing;

-- ============================================================== evaluator ===
-- Runs every five minutes. Everything it does has to be idempotent, because it
-- will look at the same day roughly 288 times before that day is over.
--
-- Which days it looks at: the employee's current local date and the one before
-- it. The second one is not belt and braces. This project is on the Free plan,
-- which pauses the database after seven days of low activity, and cron does not
-- run while it is paused -- an evening of missing exits would otherwise be lost
-- for good. Re-evaluating yesterday is free: the unique key turns it into an
-- update of details that were already correct.
--
-- Which employees: active, and linked to an account. An employee with no
-- account cannot punch, and a system that cannot be used cannot be used late.
-- The 31 accounts do not exist yet, so this evaluator raises nothing until they
-- are provisioned, and then starts covering people as they are onboarded.
--
-- What it never does: close an alert. An alert is a record of what happened,
-- not a live indicator. Somebody who missed the entry window and shows up two
-- hours later was still absent at 09:30, and HR decides what that was worth --
-- acknowledged, resolved or dismissed. Which is also why the upsert below
-- refreshes only alerts that are still open.

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
  -- join with the defaults rather than seven separate queries so that adding a
  -- kind is one row here and one branch in the case below, and so that every
  -- kind resolves its rule exactly the same way.
  defaults (kind, severity, threshold_minutes) as (
    values
      ('late_entry',     'medium', 0),
      ('missing_entry',  'high',   0),
      ('break_exceeded', 'low',    5),
      ('missing_exit',   'medium', 60),
      ('no_connection',  'low',    15),
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
    on conflict (employee_id, alert_date, kind) do update
       set severity = excluded.severity,
           details  = excluded.details
     -- An acknowledged, resolved or dismissed alert stays that way. Reopening
     -- it every five minutes would make the state column meaningless.
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
  'Raises the alerts HR needs for the current and previous local day, and queues one notification per new alert. Idempotent by design: it runs every five minutes.';

revoke all     on function attendance.evaluate_alerts(timestamptz) from public, anon, authenticated;
grant  execute on function attendance.evaluate_alerts(timestamptz) to service_role;

-- ====================================================== dispatcher contract ===
-- Two functions, so the Edge Function that sends the mail holds no rule beyond
-- "call the provider, report what happened". Everything about ordering, retry
-- and giving up is decided here.
--
-- They live in `attendance`, which is not an exposed schema, so the dispatcher
-- cannot reach them over PostgREST. It connects to Postgres directly with the
-- service role. Publishing `public` wrappers would put two more SECURITY
-- DEFINER functions on the REST surface for no gain: nothing in a browser ever
-- calls these. See docs/decisions/ADR-0002-alert-delivery-outbox.md.

create or replace function attendance.claim_notifications(
  p_limit integer     default 20,
  p_now   timestamptz default now()
)
returns setof attendance.notification_outbox
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
  update attendance.notification_outbox o
     set status   = 'sending',
         attempts = o.attempts + 1
   where o.id in (
     select q.id
       from attendance.notification_outbox q
      where (q.status = 'pending' and q.next_attempt_at <= p_now)
         -- A dispatcher that died mid-send leaves its rows claimed forever.
         -- After fifteen minutes the claim is treated as abandoned. Worst case
         -- is a duplicate email; the alternative is a notification that is
         -- never sent and never noticed.
         or (q.status = 'sending' and q.updated_at < p_now - interval '15 minutes')
      order by q.next_attempt_at
      limit greatest(1, least(p_limit, 200))
      -- Two dispatchers running at once must not claim the same row.
      for update skip locked
   )
  returning o.*;
end;
$fn$;

comment on function attendance.claim_notifications(integer, timestamptz) is
  'Claims due notifications for one dispatcher run. Skips rows another dispatcher holds and reclaims abandoned ones after fifteen minutes.';

revoke all     on function attendance.claim_notifications(integer, timestamptz) from public, anon, authenticated;
grant  execute on function attendance.claim_notifications(integer, timestamptz) to service_role;

create or replace function attendance.complete_notification(
  p_id    uuid,
  p_error text        default null,
  p_now   timestamptz default now()
)
returns attendance.notification_outbox
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_max_attempts constant integer := 8;
  v_row          attendance.notification_outbox;
begin
  if p_error is null then
    update attendance.notification_outbox o
       set status       = 'sent',
           delivered_at = p_now,
           last_error   = null
     where o.id = p_id
    returning * into v_row;

    if v_row.id is null then
      raise exception 'Notification % does not exist', p_id using errcode = '02000';
    end if;

    -- The alert records when somebody was actually told, which is not the same
    -- as when the alert was raised.
    update attendance.alerts a
       set notified_at = coalesce(a.notified_at, p_now)
     where a.id = v_row.alert_id;

    return v_row;
  end if;

  -- Exponential backoff capped at an hour: 2, 4, 8, 16, 32, 60, 60 minutes.
  -- After eight attempts it stops on its own instead of retrying a broken
  -- mailbox until the end of time. The row stays as evidence of what failed.
  update attendance.notification_outbox o
     set status = case
                    when o.attempts >= v_max_attempts then 'failed'
                    else 'pending'
                  end,
         next_attempt_at = p_now + make_interval(
           mins => least(60, power(2, greatest(o.attempts, 1))::integer)),
         last_error = left(p_error, 2000)
   where o.id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Notification % does not exist', p_id using errcode = '02000';
  end if;

  return v_row;
end;
$fn$;

comment on function attendance.complete_notification(uuid, text, timestamptz) is
  'Reports the outcome of one delivery attempt. Success stamps the alert; failure schedules a retry and gives up after eight attempts.';

revoke all     on function attendance.complete_notification(uuid, text, timestamptz) from public, anon, authenticated;
grant  execute on function attendance.complete_notification(uuid, text, timestamptz) to service_role;

-- ================================================= keeping the outbox small ===
-- Same reasoning as the rest of the Free plan maintenance: what grows without a
-- ceiling gets pruned before it becomes a problem. Delivered notifications are
-- operational metadata -- the alert they belong to is the record, and it is
-- never pruned. Failed ones are kept: they are evidence that HR was not told.

create or replace function attendance.prune_notification_outbox(p_keep_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  delete from attendance.notification_outbox
   where status = 'sent'
     and delivered_at < now() - make_interval(days => p_keep_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

comment on function attendance.prune_notification_outbox(integer) is
  'Drops delivered notifications after 90 days. Failed ones are kept as evidence; the alerts themselves are never pruned.';

revoke all on function attendance.prune_notification_outbox(integer) from public, anon, authenticated;

-- ==================================================== trabajos programados ===
-- Same pattern as free_plan_maintenance: unschedule first so the migration can
-- be replayed without duplicating jobs, and cron.unschedule raises when the job
-- does not exist, which is the normal case the first time.
--
-- Five minutes is the resolution of no_connection, whose signal is a heartbeat
-- the PWA sends every five. Evaluating more often would not learn anything new.
--
-- Delivery is deliberately not scheduled here. The dispatcher Edge Function
-- does not exist yet, and scheduling a call to something that is not there
-- would fill cron.job_run_details with failures.

do $do$
declare
  v_job text;
begin
  foreach v_job in array array[
    'attendance_evaluate_alerts',
    'attendance_prune_notification_outbox'
  ] loop
    begin
      perform cron.unschedule(v_job);
    exception when others then
      null;   -- it did not exist: the normal case the first time
    end;
  end loop;
end
$do$;

select cron.schedule(
  'attendance_evaluate_alerts',
  '*/5 * * * *',
  $cron$ select attendance.evaluate_alerts(); $cron$
);

-- Sundays 03:50 local (09:50 UTC), after the other maintenance jobs.
select cron.schedule(
  'attendance_prune_notification_outbox',
  '50 9 * * 0',
  $cron$ select attendance.prune_notification_outbox(90); $cron$
);

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The two jobs are scheduled:
--   select jobname, schedule, active from cron.job order by jobname;
--
--   -- 2. What one run would raise, without waiting for the next one:
--   select attendance.evaluate_alerts();
--
--   -- 3. Open alerts and what is waiting to be sent:
--   select kind, severity, count(*) from attendance.alerts
--    where state = 'open' group by 1, 2 order by 1;
--   select status, count(*), min(next_attempt_at)
--     from attendance.notification_outbox group by 1;
--
--   -- 4. Nothing is stuck: a row that has been claimed for over 15 minutes is
--   --    reclaimed by the next dispatcher run, and one that failed eight times
--   --    stopped on purpose. Both are worth looking at.
--   select id, status, attempts, last_error from attendance.notification_outbox
--    where status = 'failed' or (status = 'sending' and updated_at < now() - interval '15 minutes');
