-- attendance_review_api.sql
--
-- The board could already say "there is something to review here" and nothing
-- could act on it. `team_day()` returns `needs_review` and `has_offline` as
-- flags, and no read function reaches the punches behind them: HR could see
-- that a judgement was owed and never see what it was about.
--
-- This file is that judgement, and only that. Three rules shape it.
--
--   * The punch never changes. `internal.punches_append_only()` rejects every
--     UPDATE and DELETE, service role included, and that is right: the flag on
--     a punch records how it arrived, which stays true no matter what anybody
--     later decides about it. The decision is a new row beside it, in
--     attendance.adjustments.
--
--   * The workday's flag becomes derived. The engine sets it with
--     `needs_review = w.needs_review or v_needs_review`, so today it is a
--     sticky OR that nothing clears. From here it is recomputed from the
--     punches and the decisions recorded against them, which is what stops a
--     caller clearing a day that still has work left in it.
--
--   * Every administrative action lands in attendance.audit_events. That table
--     has existed since the schema was created, saying "aqui cae TODA accion
--     administrativa", and until now nothing administrative existed to put in
--     it. These are the first.
--
-- What is deliberately NOT here: 'correct_time', 'add_punch' and 'void_punch'.
-- All three change what a day counts as, and worked_seconds/break_seconds are
-- derived by the engine from the punches. A correction that records an intent
-- without recomputing those is a note pretending to be a correction. Doing it
-- properly means teaching the counter logic about adjustments, which is its own
-- change with its own suite. `adjustments_kind_valid` already allows all five
-- kinds, so nothing here has to move when they arrive.

-- ============================================== the evidence behind a flag ===
-- SECURITY INVOKER, and that is the design rather than an oversight.
--
-- `punches_read` is already `internal.can_view_employee(employee_id)`, and the
-- column grants already withhold geo_lat and geo_lng by never granting them. A
-- definer version of this function would have to reimplement both and could get
-- either one wrong in silence. As invoker it cannot return a row that RLS would
-- not have handed the caller anyway: an employee asking about a colleague gets
-- nothing back, without a single role check written here.

create or replace function public.employee_day(
  p_employee_id uuid,
  p_date        date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_name    text;
  v_zone    text;
  v_date    date;
  v_workday attendance.workdays;
begin
  -- RLS on public.empleados decides this, not a role check. Somebody outside
  -- the caller's scope simply has no row, and the refusal below cannot tell
  -- the two cases apart -- which is the point.
  select e.nombre into v_name
    from public.empleados e
   where e.id = p_employee_id;

  if v_name is null then
    raise exception 'No hay ningun empleado visible con ese identificador'
      using errcode = '42501';
  end if;

  v_zone := coalesce(internal.time_zone_of(p_employee_id), 'America/Mexico_City');
  v_date := coalesce(p_date, (now() at time zone v_zone)::date);

  select w.* into v_workday
    from attendance.workdays w
   where w.employee_id = p_employee_id
     and w.work_date   = v_date;

  return jsonb_build_object(
    'employee_id',    p_employee_id,
    'employee_name',  v_name,
    'date',           v_date,
    'time_zone',      v_zone,

    'workday_id',     v_workday.id,
    'state',          coalesce(v_workday.state, 'not_started'),
    'opened_at',      v_workday.opened_at,
    'closed_at',      v_workday.closed_at,
    'worked_seconds', coalesce(v_workday.worked_seconds, 0),
    'break_seconds',  coalesce(v_workday.break_seconds, 0),
    'has_offline',    coalesce(v_workday.has_offline, false),
    'needs_review',   coalesce(v_workday.needs_review, false),

    -- Explicit column list, never p.*: `authenticated` was never granted
    -- geo_lat or geo_lng, so a star here would fail outright. That is the
    -- privacy promise working, not an inconvenience to route around.
    --
    -- Everything a reviewer needs to judge how the punch arrived travels with
    -- it: the client's own clock, how far it had drifted, how late the batch
    -- was, and the engine's own words for why it was flagged.
    'punches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',                 p.id,
               'kind',               p.kind,
               'occurred_at',        p.occurred_at,
               'source',             p.source,
               'client_reported_at', p.client_reported_at,
               'clock_skew_ms',      p.clock_skew_ms,
               'sync_delay_seconds', p.sync_delay_seconds,
               'needs_review',       p.needs_review,
               'review_reason',      p.review_reason,

               -- The decision in force, or null while none has been made. The
               -- latest one governs: adjustments is a log, so a reviewer who
               -- changes their mind adds a row rather than editing one, and
               -- both remain readable.
               'decision', (
                 select jsonb_build_object(
                          'kind',       a.kind,
                          'reason',     a.reason,
                          'created_at', a.created_at)
                   from attendance.adjustments a
                  where a.punch_id = p.id
                    and a.kind in ('approve_offline', 'reject_offline')
                  order by a.created_at desc
                  limit 1
               ))
             order by p.occurred_at)
        from attendance.punches p
       where p.workday_id = v_workday.id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.employee_day(uuid, date) is
  'One employee''s day for whoever RLS lets see it: the workday, its punches with the evidence of how each arrived, and the decision recorded against each.';

revoke all     on function public.employee_day(uuid, date) from public, anon;
grant  execute on function public.employee_day(uuid, date) to authenticated;

-- ================================================ the workday review flag ===
-- Derived, never set by a caller. The flag is on while any punch that arrived
-- flagged has no decision recorded against it, which is what stops a day being
-- cleared while it still has work in it -- and stops the flag surviving a day
-- whose work is done.

create or replace function internal.settle_workday_review(p_workday_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_pending boolean;
begin
  select exists (
    select 1
      from attendance.punches p
     where p.workday_id = p_workday_id
       and p.needs_review
       and not exists (
         select 1
           from attendance.adjustments a
          where a.punch_id = p.id
            and a.kind in ('approve_offline', 'reject_offline')
       )
  ) into v_pending;

  update attendance.workdays w
     set needs_review = v_pending
   where w.id = p_workday_id;

  return v_pending;
end;
$fn$;

comment on function internal.settle_workday_review(uuid) is
  'Recomputes attendance.workdays.needs_review from the punches and the decisions recorded against them. Derived, so no caller can clear a day with work left in it.';

revoke all on function internal.settle_workday_review(uuid) from public, anon, authenticated;

-- ========================================================== review_punch ===
-- SECURITY DEFINER, in public, because the browser calls it and it is the only
-- write path into attendance.adjustments. The advisors flag it the way they
-- flag punch(), sync_punches() and heartbeat(): that is the design, not a
-- finding. What keeps it safe is that it derives nothing from the caller except
-- through internal.caller_role() and internal.can_view_employee().

create or replace function public.review_punch(
  p_punch_id uuid,
  p_decision text,
  p_reason   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_punch   attendance.punches;
  v_pending boolean;
  v_id      uuid;
begin
  -- coalesce because this is a security guard: `null not in (...)` is null, and
  -- an `if` on null does not fire. internal.caller_role() already defaults to
  -- 'guest' and cannot return null today, but a gate should not depend on
  -- another function keeping that promise.
  if coalesce(internal.caller_role(), 'guest') not in ('hr', 'admin') then
    raise exception 'Solo Recursos Humanos puede revisar marcajes'
      using errcode = '42501';
  end if;

  if p_decision not in ('approve_offline', 'reject_offline') then
    raise exception 'La decision debe ser aprobar o rechazar'
      using errcode = '22023',
            hint    = 'approve_offline o reject_offline';
  end if;

  -- The same bar as adjustments_reason_substantial. Checked here so the caller
  -- is told in Spanish what is wrong instead of receiving a constraint name.
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'El motivo debe tener al menos 10 caracteres'
      using errcode = '22023';
  end if;

  -- Definer means RLS does not filter this read, so the scope check the read
  -- functions get for free has to be written out.
  select p.* into v_punch
    from attendance.punches p
   where p.id = p_punch_id;

  if v_punch.id is null then
    raise exception 'Ese marcaje no existe'
      using errcode = '02000';
  end if;

  if not coalesce(internal.can_view_employee(v_punch.employee_id), false) then
    raise exception 'Ese marcaje pertenece a alguien fuera de tu alcance'
      using errcode = '42501';
  end if;

  -- A punch that arrived clean has nothing to decide. Refusing is better than
  -- accepting a decision that would never be shown anywhere.
  if not v_punch.needs_review then
    raise exception 'Ese marcaje no quedo marcado para revision'
      using errcode = '22023';
  end if;

  -- old_value and new_value stay null: approving or rejecting moves no
  -- timestamp. They are there for 'correct_time', which is not in this file.
  -- Filling them with the unchanged occurred_at would read as a correction that
  -- corrected nothing.
  insert into attendance.adjustments
    (punch_id, workday_id, kind, reason, adjusted_by)
  values
    (v_punch.id, v_punch.workday_id, p_decision, p_reason, auth.uid())
  returning id into v_id;

  v_pending := internal.settle_workday_review(v_punch.workday_id);

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('punch_reviewed', 'attendance.punches', v_punch.id, auth.uid(), p_reason,
     jsonb_build_object('needs_review', true, 'review_reason', v_punch.review_reason),
     jsonb_build_object('decision', p_decision, 'adjustment_id', v_id));

  return jsonb_build_object(
    'adjustment_id',        v_id,
    'punch_id',             v_punch.id,
    'decision',             p_decision,
    'workday_needs_review', v_pending
  );
end;
$fn$;

comment on function public.review_punch(uuid, text, text) is
  'Records HR''s decision about a punch that arrived flagged. Writes attendance.adjustments and never touches the punch, which is append-only.';

revoke all     on function public.review_punch(uuid, text, text) from public, anon;
grant  execute on function public.review_punch(uuid, text, text) to authenticated;

-- ========================================================== decide_alert ===
-- An alert is a record of what happened, not a notification to clear, so this
-- never deletes one and never returns it to 'open'. It writes down what HR
-- decided it was worth.
--
-- The note is required for all three outcomes, not just for dismissing. All
-- three take the alert out of open_alerts(), so all three are the moment
-- somebody stopped looking at it, and that moment is worth a sentence.
--
-- Nothing in attendance.evaluate_alerts() needs to change: its upsert already
-- refreshes only rows still `open`, so a decided alert stays decided through
-- the next 288 runs of the day.

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
  'Records what HR decided an alert was worth. Never deletes one and never returns it to open; the note is mandatory because all three outcomes end the looking.';

revoke all     on function public.decide_alert(uuid, text, text) from public, anon;
grant  execute on function public.decide_alert(uuid, text, text) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The security modes are the ones intended: the reader invokes, the two
--   --    writers elevate. review_api_test.sql asserts this too.
--   select p.proname,
--          case p.prosecdef when true then 'definer' else 'invoker' end as security
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('employee_day', 'review_punch', 'decide_alert');
--
--   -- 2. Administrative actions are being recorded, which nothing did before.
--   select kind, entity, count(*), max(created_at)
--     from attendance.audit_events
--    where kind in ('punch_reviewed', 'alert_decided')
--    group by kind, entity;
--
--   -- 3. No workday claims a review that has already been settled.
--   select w.id, w.work_date, w.needs_review
--     from attendance.workdays w
--    where w.needs_review
--      and not exists (
--        select 1 from attendance.punches p
--         where p.workday_id = w.id and p.needs_review
--           and not exists (select 1 from attendance.adjustments a
--                            where a.punch_id = p.id
--                              and a.kind in ('approve_offline', 'reject_offline')));
--   -- Expected: 0 rows.
