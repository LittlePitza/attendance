-- An alert whose evidence was discarded, and the alert nobody could raise.
--
-- Both were found by resetting a day, clocking in four hours late and clocking
-- out four hours early, and watching nothing at all happen.
--
-- **The blocking one.** `alerts` carried `unique (employee_id, alert_date, kind)`
-- -- one alert per person, day and kind -- and the evaluator's upsert refreshes
-- only rows that are still `open`, so that HR acknowledging or dismissing one
-- makes the decision stick. Those two rules are each right and together they
-- have a hole: once an alert for a date is dismissed, **no later alert of that
-- kind can ever be raised for that date**. Reset the day, arrive late again, and
-- the evaluator computes the alert correctly, hits the conflict, finds the row
-- is not `open`, and updates nothing. Silence, with the old row still describing
-- an arrival the reset discarded.
--
-- The fix is not to reopen what HR closed. It is to say that an alert whose
-- evidence stopped counting is no longer the live alert for that day:
-- `superseded_at` records it, the unique index is narrowed to rows where that is
-- null, and the slot frees up for an alert about what actually happened. The old
-- row stays -- nothing deletes here -- and the dossier shows it for what it is.
--
-- **`missing_entry` is the one kind that is not superseded**, and the reason is
-- worth stating: its evidence is an *absence*. Every other kind points at a
-- punch, and voiding the punch takes the evidence away. Voiding the punches
-- behind a `missing_entry` makes its claim *more* true, not less, so superseding
-- it would free a slot for an alert identical to the one already there.
--
-- **The missing one.** Leaving three hours before the schedule's exit raised
-- nothing, because no kind described it. `missing_exit` is the opposite case --
-- a day still open long after the exit -- and additionally requires the state to
-- be `working` or `on_break`, so a day that was closed early cannot reach it.
-- `early_exit` is that kind. Its default threshold is fifteen minutes and it
-- resolves department > global > default like every other, so a department where
-- finishing early is normal turns it off on Configuración → Alertas rather than
-- living with the noise.

-- ================================================================== schema ===

alter table attendance.alerts
  add column if not exists superseded_at timestamptz;

comment on column attendance.alerts.superseded_at is
  'Set when the punches this alert was about stopped counting. The row stays as a record; it is no longer the live alert for that day and counts towards nothing.';

-- The total unique constraint becomes a partial unique index. Idempotency is
-- unaffected for the case that matters -- the evaluator sees the same live day
-- roughly 288 times and every one of those rows has `superseded_at` null -- and
-- a superseded row no longer occupies the slot.
alter table attendance.alerts
  drop constraint if exists alerts_unique_per_day;

create unique index if not exists alerts_unique_live
  on attendance.alerts (employee_id, alert_date, kind)
  where superseded_at is null;

comment on index attendance.alerts_unique_live is
  'One live alert per person, day and kind. Superseded rows are excluded so a discarded alert does not block the one that replaces it.';

-- `early_exit` joins both vocabularies. Widening a CHECK validates instantly:
-- every existing row already satisfies the new one.
alter table attendance.alerts
  drop constraint alerts_kind_valid;
alter table attendance.alerts
  add constraint alerts_kind_valid check (kind in (
    'late_entry', 'missing_entry', 'break_exceeded', 'missing_exit',
    'early_exit', 'no_connection', 'review_offline', 'clock_tampered'
  ));

alter table attendance.alert_rules
  drop constraint alert_rules_kind_valid;
alter table attendance.alert_rules
  add constraint alert_rules_kind_valid check (kind in (
    'late_entry', 'missing_entry', 'break_exceeded', 'missing_exit',
    'early_exit', 'no_connection', 'review_offline', 'clock_tampered'
  ));

-- A missing row is not a disabled rule -- it falls back to the evaluator's own
-- default -- so this is for discoverability rather than behaviour: the kind
-- appears on Configuración → Alertas with a threshold somebody can change.
-- `recipients` stays null like the other seven, so notifications keep falling
-- back to ALERTS_DEFAULT_RECIPIENTS.
insert into attendance.alert_rules (department_id, kind, active, threshold_minutes)
select null, 'early_exit', true, 15
 where not exists (
   select 1 from attendance.alert_rules
    where department_id is null and kind = 'early_exit');

-- ======================================================== evaluate_alerts ====
-- Reissued for three changes, and a body cannot be patched:
--
--   * `closed_at` joins the context, because `early_exit` is the first rule that
--     needs the hour a day ended.
--   * `early_exit` gets a default, a details branch and a condition.
--   * the upsert's conflict target names the partial index's predicate, which
--     Postgres requires in order to infer it.
--
-- The four properties this function has to keep are unchanged: it is idempotent,
-- it never closes an alert, it enqueues rather than sends, and it looks at
-- yesterday as well as today.

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
      ('late_entry',     'medium', 0),
      ('missing_entry',  'high',   0),
      ('break_exceeded', 'low',    5),
      ('missing_exit',   'medium', 60),
      -- Fifteen minutes, and `medium` like `late_entry`: leaving early and
      -- arriving late are the same kind of claim, made from the same clock.
      ('early_exit',     'medium', 15),
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
  'The only place that decides an alert exists. Idempotent, never closes one, enqueues rather than sends, and looks at yesterday too. Eight kinds; a superseded alert is outside the unique index so a discarded one never blocks its replacement.';

-- =============================================================== reset_day ===
-- Reissued so that voiding a day's punches also marks the alerts those punches
-- were about.
--
-- This is not the same thing as closing them, which this function still refuses
-- to do -- HR's judgement is HR's. It records that the evidence stopped
-- counting, which is a fact about the punches rather than an opinion about the
-- alert, and it is what lets the evaluator raise a fresh one for what the day
-- turned out to be.
--
-- `missing_entry` is left alone. See the header: it is the one kind whose
-- evidence is an absence, and a reset makes it more true rather than less.

create or replace function public.reset_day(
  p_employee_id uuid,
  p_reason      text,
  p_date        date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_employee   public.empleados;
  v_zone       text;
  v_date       date;
  v_before     attendance.workdays;
  v_after      attendance.workdays;
  v_voided     integer;
  v_superseded integer;
  v_alerts     integer;
begin
  perform internal.require_role(array['hr', 'admin'], 'reiniciar la jornada de una persona');

  -- The same bar as adjustments_reason_substantial, said here so the caller
  -- reads a sentence instead of a constraint name.
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'El motivo debe tener al menos 10 caracteres'
      using errcode = '22023';
  end if;

  select e.* into v_employee from public.empleados e where e.id = p_employee_id;

  if v_employee.id is null then
    raise exception 'Esa persona no esta en el catalogo de empleados'
      using errcode = '02000';
  end if;

  -- Definer means RLS filtered nothing above, so the scope check the read
  -- functions get for free is written out, the way review_punch() writes it.
  if not coalesce(internal.can_view_employee(p_employee_id), false) then
    raise exception 'Esa persona esta fuera de tu alcance'
      using errcode = '42501';
  end if;

  v_zone := internal.time_zone_of(p_employee_id);
  v_date := coalesce(p_date, (now() at time zone v_zone)::date);

  -- The lock is what makes two administrators pressing the button at the same
  -- moment produce one reset instead of two sets of void rows. It also holds
  -- back a punch arriving mid-reset: record_punch() takes the same row lock on
  -- its upsert, so it waits and then reads the day this transaction left.
  select w.* into v_before
    from attendance.workdays w
   where w.employee_id = p_employee_id
     and w.work_date   = v_date
     for update;

  if v_before.id is null then
    raise exception 'No hay jornada registrada de esa persona en esa fecha'
      using errcode = '02000';
  end if;

  insert into attendance.adjustments
    (punch_id, workday_id, kind, old_value, new_value, reason, adjusted_by)
  select p.id, p.workday_id, 'void_punch',
         -- old_value is the hour that stops counting; new_value stays null
         -- because nothing replaces it. review_punch() leaves both null for the
         -- opposite reason: approving moves no timestamp at all.
         p.occurred_at, null, p_reason, auth.uid()
    from attendance.punches p
   where p.workday_id = v_before.id
     and not internal.punch_is_void(p.id);

  get diagnostics v_voided = row_count;

  if v_voided = 0 then
    raise exception 'Esa jornada ya no tiene marcajes que contar'
      using errcode = '22023',
            hint    = 'Se reinicio antes, o nunca tuvo marcajes';
  end if;

  v_after := internal.recompute_workday(v_before.id);

  -- The alerts those punches were about stop being the live ones for the day.
  -- Not closed: `state` is left exactly as HR left it, and the row stays.
  update attendance.alerts a
     set superseded_at = now()
   where a.employee_id   = p_employee_id
     and a.alert_date    = v_date
     and a.superseded_at is null
     -- The one kind whose evidence is an absence rather than a punch. Voiding
     -- the day's punches does not weaken it, so superseding it would only free
     -- a slot for an identical alert.
     and a.kind <> 'missing_entry';

  get diagnostics v_superseded = row_count;

  select count(*)::integer into v_alerts
    from attendance.alerts a
   where a.employee_id   = p_employee_id
     and a.alert_date    = v_date
     and a.state         = 'open'
     and a.superseded_at is null;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('workday_reset', 'attendance.workdays', v_before.id, auth.uid(),
     format('Se reinicio la jornada de %s del %s: %s marcajes anulados, %s alertas sin efecto. %s',
            v_employee.nombre, v_date, v_voided, v_superseded, p_reason),
     to_jsonb(v_before),
     to_jsonb(v_after));

  return jsonb_build_object(
    'employee_id',       p_employee_id,
    'employee_name',     v_employee.nombre,
    'workday_id',        v_after.id,
    'date',              v_date,
    'punches_voided',    v_voided,
    'state',             v_after.state,
    'worked_seconds',    v_after.worked_seconds,
    'break_seconds',     v_after.break_seconds,
    -- How many stopped counting because their punches did, and how many are
    -- still open and still HR's to decide. A `missing_entry` for the day is the
    -- one that can be in the second number after a reset.
    'alerts_superseded', v_superseded,
    'open_alerts',       v_alerts);
end;
$fn$;

comment on function public.reset_day(uuid, text, date) is
  'Voids every punch of a day and rebuilds it from what is left. Marks the alerts those punches were about as superseded -- not closed -- so the evaluator can raise what the day actually turned out to be. missing_entry is left alone: its evidence is an absence.';

revoke all     on function public.reset_day(uuid, text, date) from public, anon;
grant  execute on function public.reset_day(uuid, text, date) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. A dismissed alert no longer blocks its replacement.
--   --    Reset a day, punch in late, wait five minutes, and expect two rows:
--   --    the old one superseded, a new one open.
--   select kind, state, superseded_at is not null as sin_efecto, details ->> 'arrived_at'
--     from attendance.alerts
--    where employee_id = '<id>' and alert_date = current_date and kind = 'late_entry';
--
--   -- 2. Only one live alert per person, day and kind.
--   select employee_id, alert_date, kind, count(*)
--     from attendance.alerts where superseded_at is null
--    group by 1, 2, 3 having count(*) > 1;
--   -- Expected: 0 rows.
--
--   -- 3. early_exit resolves its rule like every other kind.
--   select * from internal.alert_rule(null, 'early_exit');
