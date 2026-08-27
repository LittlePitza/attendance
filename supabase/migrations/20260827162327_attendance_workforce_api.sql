-- attendance_workforce_api.sql
--
-- The administration screen could configure the system and not the people in
-- it. Three things were missing, and all three have the shape
-- `attendance_admin_api.sql` closed the last three of: a decision somebody
-- makes in this system, with no way to make it except by typing SQL.
--
--   * **A day that has to start over.** Somebody clocks in by mistake, forgets
--     to clock out, or a queued batch replays a shift that did not happen, and
--     the counters are wrong for the rest of the day. Nothing could undo it:
--     `attendance.punches` is append-only and the counters are the engine's
--     running total, so undoing a punch meant editing one of the two things
--     this schema refuses to let anybody edit.
--
--   * **The roster.** `public.empleados` is the help desk's table and this
--     system only ever read it. Somebody joining, changing department or
--     leaving was an INSERT or an UPDATE typed into the SQL editor, with
--     nothing checking that the address was an address, that it was not already
--     somebody else's, or that the person leaving also lost their way in.
--
--   * **Everything about one person, in one place.** `my_summary()` answers
--     that for whoever asks about themselves. HR had `team_day()`, which is one
--     day of everybody, and `employee_day()`, which is one day of one person.
--     Nothing answered "how has this person been doing" without reading three
--     screens and doing the arithmetic by eye.
--
-- `attendance_review_api.sql` named the first of these and deferred it in
-- writing: 'correct_time', 'add_punch' and 'void_punch' were left out because
-- "doing it properly means teaching the counter logic about adjustments, which
-- is its own change with its own suite". This is that change, for `void_punch`.
--
-- The other two are still not here, and the distinction is not squeamishness:
-- discarding a punch somebody made is a decision about a fact that exists, and
-- both of the others invent a timestamp nobody ever punched. That deserves its
-- own argument about who may fabricate a record and how it is marked, not a
-- ride along with this one.
--
-- What "teaching the counter logic" turned out to mean, precisely:
--
--   1. `internal.recompute_workday()`, which derives a day's state and counters
--      from the punches that still count. It is the second implementation of
--      the same arithmetic `internal.record_punch()` performs incrementally,
--      which is a debt this file pays down by asserting the two agree --
--      `workforce_api_test.sql` recomputes an untouched day and checks nothing
--      moved.
--   2. `internal.record_punch()` and `internal.settle_workday_review()`, both
--      replaced so they skip a voided punch. Each was reading "the punches of
--      this day" and meaning "the punches of this day that count", and until
--      now those were the same set.

-- ================================================== a punch that no longer counts ===
-- One definition of voided, because three separate `not exists` clauses is
-- three chances to write it differently and the wrong one is the one nobody
-- reads again.
--
-- There is no inverse. `adjustments_kind_valid` allows no 'unvoid_punch' and
-- this file does not add one: a void is a decision recorded with a reason, and
-- undoing it would be a second decision that erases the first. The way back is
-- the same way anybody gets a punch in: punching.

create or replace function internal.punch_is_void(p_punch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from attendance.adjustments a
     where a.punch_id = p_punch_id
       and a.kind     = 'void_punch'
  );
$fn$;

comment on function internal.punch_is_void(uuid) is
  'True once a void_punch adjustment has been recorded against the punch. One definition of "no longer counts", read by the engine, the review flag and the recomputation.';

-- Not granted to authenticated, unlike most of `internal`. It is SECURITY
-- DEFINER over `attendance.adjustments`, so a caller holding EXECUTE could ask
-- whether any punch id had been voided without RLS filtering the answer. Its
-- three callers all elevate already, so nobody needs it.
revoke all on function internal.punch_is_void(uuid) from public, anon, authenticated;

-- ========================================================= the day, recomputed ===
-- The engine accumulates by difference at each punch: it never holds the day's
-- punches in mind, only the last one. That is right for a punch arriving and
-- useless once one is taken away, because the interval it closed has already
-- been added to a total nothing remembers the parts of.
--
-- So this replays them. Same transition table, same arithmetic, same
-- `greatest(0, ...)` -- deliberately the same, because a second implementation
-- that rounded differently would make the counters depend on which path last
-- touched the day.
--
-- It raises on a sequence that does not form a workday rather than skipping
-- what does not fit. Nothing here can produce one: `reset_day()` voids the
-- whole day, so what is left is empty. When 'add_punch' arrives it will be able
-- to, and refusing loudly is what will stop it writing a day whose counters
-- nobody can explain.
--
-- `last_heartbeat` is deliberately not recomputed. It records that the
-- application reported in at an hour, which stays true whatever is later
-- decided about the punches -- and `evaluate_alerts()` only reads it while the
-- day is open, which a reset day is not.

create or replace function internal.recompute_workday(p_workday_id uuid)
returns attendance.workdays
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_punch   attendance.punches;
  v_state   text        := 'not_started';
  v_worked  integer     := 0;
  v_break   integer     := 0;
  v_opened  timestamptz;
  v_closed  timestamptz;
  v_offline boolean     := false;
  v_last    timestamptz;
  v_delta   integer;
  v_workday attendance.workdays;
begin
  for v_punch in
    select p.*
      from attendance.punches p
     where p.workday_id = p_workday_id
       and not internal.punch_is_void(p.id)
     order by p.occurred_at, p.created_at
  loop
    v_delta := case
                 when v_last is null then 0
                 else greatest(0, extract(epoch from (v_punch.occurred_at - v_last))::integer)
               end;

    case v_punch.kind
      when 'clock_in' then
        if v_state <> 'not_started' then
          raise exception 'Los marcajes de esa jornada no forman una secuencia valida'
            using errcode = '22023',
                  detail  = format('clock_in sobre el estado %s', v_state);
        end if;
        v_state  := 'working';
        v_opened := v_punch.occurred_at;

      when 'break_start' then
        if v_state <> 'working' then
          raise exception 'Los marcajes de esa jornada no forman una secuencia valida'
            using errcode = '22023',
                  detail  = format('break_start sobre el estado %s', v_state);
        end if;
        v_worked := v_worked + v_delta;
        v_state  := 'on_break';

      when 'break_end' then
        if v_state <> 'on_break' then
          raise exception 'Los marcajes de esa jornada no forman una secuencia valida'
            using errcode = '22023',
                  detail  = format('break_end sobre el estado %s', v_state);
        end if;
        v_break := v_break + v_delta;
        v_state := 'working';

      when 'clock_out' then
        if v_state not in ('working', 'on_break') then
          raise exception 'Los marcajes de esa jornada no forman una secuencia valida'
            using errcode = '22023',
                  detail  = format('clock_out sobre el estado %s', v_state);
        end if;
        -- Leaving with the break open closes it, exactly as the engine does.
        if v_state = 'on_break' then
          v_break := v_break + v_delta;
        else
          v_worked := v_worked + v_delta;
        end if;
        v_state  := 'finished';
        v_closed := v_punch.occurred_at;
    end case;

    v_offline := v_offline or v_punch.source = 'offline';
    v_last    := v_punch.occurred_at;
  end loop;

  update attendance.workdays w
     set state          = v_state,
         opened_at      = v_opened,
         closed_at      = v_closed,
         worked_seconds = v_worked,
         break_seconds  = v_break,
         has_offline    = v_offline
   where w.id = p_workday_id;

  -- needs_review is not set here. It already has one place that derives it, and
  -- that place now knows a voided punch has nothing left to decide.
  perform internal.settle_workday_review(p_workday_id);

  select w.* into v_workday from attendance.workdays w where w.id = p_workday_id;
  return v_workday;
end;
$fn$;

comment on function internal.recompute_workday(uuid) is
  'Derives a workday''s state, hours and timestamps from the punches that still count. The only thing that rebuilds a day from its punches; raises rather than guessing at a sequence that is not a workday.';

revoke all on function internal.recompute_workday(uuid) from public, anon, authenticated;

-- ==================================================== the review flag, again ===
-- Replaced for one clause. A punch that arrived flagged and was then voided
-- kept the day flagged for ever: the flag asks whether any flagged punch is
-- still undecided, and a voided punch could never be approved or rejected
-- afterwards, because `review_punch()` refuses one that is not `needs_review`
-- and nothing clears that column.
--
-- Voiding is a decision, and a more final one than either of the other two, so
-- it settles the question the same way they do.

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
            and a.kind in ('approve_offline', 'reject_offline', 'void_punch')
       )
  ) into v_pending;

  update attendance.workdays w
     set needs_review = v_pending
   where w.id = p_workday_id;

  return v_pending;
end;
$fn$;

comment on function internal.settle_workday_review(uuid) is
  'Recomputes attendance.workdays.needs_review from the punches and the decisions recorded against them. Approving, rejecting and voiding all settle a punch; a voided one has nothing left to judge.';

revoke all on function internal.settle_workday_review(uuid) from public, anon, authenticated;

-- ========================================================== the engine, again ===
-- Replaced for one clause, in the one statement that reads the day's last
-- punch. Everything else in it is unchanged and is repeated here because a
-- function body cannot be patched -- the same reason `my_day()` was reissued
-- whole when it grew five fields.
--
-- The clause matters because the interval a punch closes is measured from the
-- previous one, and after a reset the previous one is a punch that no longer
-- counts. Measuring from it would credit the day with time the reset discarded.
-- With it, the engine's running totals and `internal.recompute_workday()`'s
-- replay agree on every day, which is what makes it safe for two pieces of code
-- to know the same arithmetic.

create or replace function internal.record_punch(
  p_employee_id        uuid,
  p_kind               text,
  p_occurred_at        timestamptz,
  p_source             text,
  p_key                uuid,
  p_client_reported_at timestamptz default null,
  p_clock_skew_ms      integer     default null,
  p_sync_delay_seconds integer     default null,
  p_device_id          text        default null,
  p_geo_lat            numeric     default null,
  p_geo_lng            numeric     default null,
  p_geo_accuracy_m     numeric     default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_zone         text;
  v_date         date;
  v_schedule     attendance.schedules;
  v_workday      attendance.workdays;
  v_last         attendance.punches;
  v_existing     attendance.punches;
  v_new_state    text;
  v_delta_sec    integer := 0;
  v_punch_id     uuid;
  v_geo_lat      numeric := p_geo_lat;
  v_geo_lng      numeric := p_geo_lng;
  v_geo_accuracy numeric := p_geo_accuracy_m;
  v_geo_purge    date;
  v_needs_review boolean := false;
  v_review_why   text;
  v_has_consent  boolean;
begin
  -- ---------------------------------------------------------- validaciones ---
  if p_kind not in ('clock_in', 'break_start', 'break_end', 'clock_out') then
    raise exception 'Tipo de marcaje invalido: %', p_kind using errcode = '22023';
  end if;

  if p_key is null then
    raise exception 'Falta la clave de idempotencia' using errcode = '22023';
  end if;

  -- ---------------------------------------------------------- idempotencia ---
  -- Una red inestable reintenta. El segundo intento no debe crear otra fila ni
  -- fallar: devuelve el resultado del primero.
  select p.* into v_existing
    from attendance.punches p
   where p.idempotency_key = p_key;

  if found then
    if v_existing.employee_id <> p_employee_id then
      raise exception 'La clave de idempotencia pertenece a otro empleado'
        using errcode = '42501';
    end if;

    select w.* into v_workday
      from attendance.workdays w where w.id = v_existing.workday_id;

    return jsonb_build_object(
      'repeated',       true,
      'punch_id',       v_existing.id,
      'workday_id',     v_workday.id,
      'state',          v_workday.state,
      'occurred_at',    v_existing.occurred_at,
      'worked_seconds', v_workday.worked_seconds,
      'break_seconds',  v_workday.break_seconds
    );
  end if;

  -- ------------------------------------------------------- equipo revocado ---
  if p_device_id is not null and exists (
    select 1 from attendance.devices d
     where d.employee_id = p_employee_id
       and d.device_id   = p_device_id
       and d.revoked_at is not null
  ) then
    raise exception 'Este equipo fue revocado. Contacta a RH.'
      using errcode = '42501';
  end if;

  -- ------------------------------------------- jornada del dia (por su zona) ---
  v_zone := internal.time_zone_of(p_employee_id);
  v_date := (p_occurred_at at time zone v_zone)::date;

  v_schedule := internal.resolve_schedule(p_employee_id, v_date);

  insert into attendance.workdays (employee_id, work_date, time_zone, schedule_id)
  values (p_employee_id, v_date, v_zone, v_schedule.id)
  on conflict (employee_id, work_date) do update
    set schedule_id = coalesce(workdays.schedule_id, excluded.schedule_id)
  returning * into v_workday;

  -- --------------------------------------------------- maquina de estados ---
  -- El ultimo marcaje que cuenta, no el ultimo que existe: uno anulado ya no
  -- forma parte de la jornada y medir contra el abonaria tiempo descartado.
  select p.* into v_last
    from attendance.punches p
   where p.workday_id = v_workday.id
     and not internal.punch_is_void(p.id)
   order by p.occurred_at desc, p.created_at desc
   limit 1;

  if v_last.id is not null then
    v_delta_sec := greatest(0,
      extract(epoch from (p_occurred_at - v_last.occurred_at))::integer);
  end if;

  case p_kind
    when 'clock_in' then
      if v_workday.state <> 'not_started' then
        raise exception 'Ya registraste tu entrada hoy (estado actual: %)', v_workday.state
          using errcode = '22023';
      end if;
      v_new_state := 'working';

    when 'break_start' then
      if v_workday.state <> 'working' then
        raise exception 'Solo puedes iniciar una pausa mientras trabajas (estado actual: %)', v_workday.state
          using errcode = '22023';
      end if;
      v_new_state := 'on_break';
      v_workday.worked_seconds := v_workday.worked_seconds + v_delta_sec;

    when 'break_end' then
      if v_workday.state <> 'on_break' then
        raise exception 'No tienes una pausa abierta (estado actual: %)', v_workday.state
          using errcode = '22023';
      end if;
      v_new_state := 'working';
      v_workday.break_seconds := v_workday.break_seconds + v_delta_sec;

    when 'clock_out' then
      if v_workday.state not in ('working', 'on_break') then
        raise exception 'No tienes una jornada abierta (estado actual: %)', v_workday.state
          using errcode = '22023';
      end if;
      -- Salir con la pausa abierta la cierra: es un descuido comun y rechazarlo
      -- solo dejaria la jornada colgada.
      if v_workday.state = 'on_break' then
        v_workday.break_seconds := v_workday.break_seconds + v_delta_sec;
      else
        v_workday.worked_seconds := v_workday.worked_seconds + v_delta_sec;
      end if;
      v_new_state := 'finished';
  end case;

  -- ------------------------------------------ geolocalizacion y privacidad ---
  -- Sin consentimiento registrado, las coordenadas se descartan aqui mismo.
  -- Es la unica forma de que la promesa de privacidad sea tecnica y no verbal.
  if v_geo_lat is not null then
    select exists (
      select 1 from attendance.consents c
       where c.employee_id = p_employee_id and c.accepted
    ) into v_has_consent;

    if not v_has_consent then
      v_geo_lat      := null;
      v_geo_lng      := null;
      v_geo_accuracy := null;
    else
      v_geo_purge := (p_occurred_at at time zone v_zone)::date + 90;
    end if;
  end if;

  -- ------------------------------------------------- marcas de desconfianza ---
  if p_source = 'offline' then
    if abs(coalesce(p_clock_skew_ms, 0)) > 120000 then
      v_needs_review := true;
      v_review_why   := format(
        'Reloj del equipo desviado %s segundos respecto al servidor',
        round(abs(p_clock_skew_ms) / 1000.0));
    elsif coalesce(p_sync_delay_seconds, 0) > 43200 then
      v_needs_review := true;
      v_review_why   := format(
        'Marcaje sincronizado %s horas despues de ocurrir',
        round(p_sync_delay_seconds / 3600.0));
    end if;
  end if;

  -- ------------------------------------------------------------- el registro ---
  insert into attendance.punches (
    workday_id, employee_id, kind,
    occurred_at, client_reported_at,
    source, idempotency_key,
    clock_skew_ms, sync_delay_seconds,
    needs_review, review_reason,
    ip, user_agent, device_id,
    geo_lat, geo_lng, geo_accuracy_m, geo_purge_on
  ) values (
    v_workday.id, p_employee_id, p_kind,
    p_occurred_at, p_client_reported_at,
    p_source, p_key,
    p_clock_skew_ms, p_sync_delay_seconds,
    v_needs_review, v_review_why,
    internal.request_ip(), internal.request_user_agent(), p_device_id,
    v_geo_lat, v_geo_lng, v_geo_accuracy, v_geo_purge
  )
  returning id into v_punch_id;

  -- ------------------------------------------------------ estado de la jornada ---
  update attendance.workdays w
     set state          = v_new_state,
         opened_at      = coalesce(w.opened_at,
                            case when p_kind = 'clock_in' then p_occurred_at end),
         closed_at      = case when p_kind = 'clock_out' then p_occurred_at else w.closed_at end,
         worked_seconds = v_workday.worked_seconds,
         break_seconds  = v_workday.break_seconds,
         last_heartbeat = greatest(coalesce(w.last_heartbeat, p_occurred_at), p_occurred_at),
         has_offline    = w.has_offline  or (p_source = 'offline'),
         needs_review   = w.needs_review or v_needs_review
   where w.id = v_workday.id
  returning * into v_workday;

  -- -------------------------------------------------------- equipo conocido ---
  if p_device_id is not null then
    insert into attendance.devices (employee_id, device_id, user_agent)
    values (p_employee_id, p_device_id, internal.request_user_agent())
    on conflict (employee_id, device_id) do update
      set last_seen_at = now(),
          user_agent   = coalesce(excluded.user_agent, devices.user_agent);
  end if;

  return jsonb_build_object(
    'repeated',       false,
    'punch_id',       v_punch_id,
    'workday_id',     v_workday.id,
    'state',          v_workday.state,
    'occurred_at',    p_occurred_at,
    'source',         p_source,
    'needs_review',   v_needs_review,
    'review_reason',  v_review_why,
    'worked_seconds', v_workday.worked_seconds,
    'break_seconds',  v_workday.break_seconds,
    'geo_saved',      v_geo_lat is not null
  );
end;
$fn$;

comment on function internal.record_punch is
  'Maquina de estados de la jornada. Unico lugar donde se escriben marcajes. La usan public.punch y public.sync_punches.';

revoke all on function internal.record_punch(
  uuid, text, timestamptz, text, uuid, timestamptz, integer, integer, text,
  numeric, numeric, numeric) from public, anon, authenticated;

-- ================================================================= reset_day ===
-- The counter, started over.
--
-- It voids every punch of the day rather than offering a punch to pick. That is
-- the smaller feature and the safer one, and both for the same reason: a
-- sequence with a hole in it is not a workday. Voiding the middle of
-- `clock_in, break_start, break_end, clock_out` leaves a break that ends
-- without beginning, and something would then have to decide what the day
-- counted as -- which is exactly the guessing `internal.recompute_workday()`
-- refuses to do. Voiding all of it leaves nothing to interpret: the day is back
-- to `not_started` and the person punches again.
--
-- What it does NOT do, on purpose:
--
--   * **It does not delete anything.** The punches stay, and so does the
--     workday. Somebody reading `attendance.punches` later sees what was
--     recorded and, beside it in `attendance.adjustments`, the decision that it
--     no longer counts and the reason given. That is the difference between a
--     correction and a cover-up.
--
--   * **It does not close the day's alerts.** An alert is a record of what
--     happened, not a live indicator -- and somebody who was an hour late at
--     09:30 still was, whatever is later decided about the punch. HR decides
--     what each was worth on Revisión. The count comes back in the answer so
--     the person who reset the day is told they are still there rather than
--     discovering it later.
--
--   * **It does not stop the evaluator.** A day reset after the entry window
--     has closed looks exactly like a day nobody started, so `missing_entry`
--     may be raised for it within the next five minutes. That is the evaluator
--     being right about the record as it now stands, and the unique
--     `(employee_id, alert_date, kind)` keeps it to one.

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
  v_employee public.empleados;
  v_zone     text;
  v_date     date;
  v_before   attendance.workdays;
  v_after    attendance.workdays;
  v_voided   integer;
  v_alerts   integer;
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

  select count(*)::integer into v_alerts
    from attendance.alerts a
   where a.employee_id = p_employee_id
     and a.alert_date  = v_date
     and a.state       = 'open';

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('workday_reset', 'attendance.workdays', v_before.id, auth.uid(),
     format('Se reinicio la jornada de %s del %s: %s marcajes anulados. %s',
            v_employee.nombre, v_date, v_voided, p_reason),
     to_jsonb(v_before),
     to_jsonb(v_after));

  return jsonb_build_object(
    'employee_id',    p_employee_id,
    'employee_name',  v_employee.nombre,
    'workday_id',     v_after.id,
    'date',           v_date,
    'punches_voided', v_voided,
    'state',          v_after.state,
    'worked_seconds', v_after.worked_seconds,
    'break_seconds',  v_after.break_seconds,
    -- Still open, and still HR's to decide. Reported so nobody assumes the
    -- reset dealt with them.
    'open_alerts',    v_alerts);
end;
$fn$;

comment on function public.reset_day(uuid, text, date) is
  'Voids every punch of one person''s day and rebuilds the counters from what is left, which is nothing. Deletes no punch, closes no alert, and records the reason in attendance.adjustments and attendance.audit_events.';

revoke all     on function public.reset_day(uuid, text, date) from public, anon;
grant  execute on function public.reset_day(uuid, text, date) to authenticated;

-- ================================================================== an address ===
-- `internal.is_email_list()` already held this pattern, for the comma-separated
-- `alert_rules.recipients`. A person has exactly one address, so the check is
-- lifted out and the list is redefined in terms of it: two copies of a
-- validation regex is two answers to "is this an address", and the day they
-- disagree is the day an address that saves here cannot be mailed there.
--
-- Still deliberately looser than RFC 5322, for the reason the original gave: a
-- validator stricter than the mail server refuses addresses that work.

create or replace function internal.is_email(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_value is not null
     and trim(p_value) ~ '^[^[:space:]@,]+@[^[:space:]@,.]+(\.[^[:space:]@,.]+)+$';
$fn$;

comment on function internal.is_email(text) is
  'True when the value is a plausible single address. The one pattern this system judges an address by; internal.is_email_list() applies it to each entry.';

revoke all     on function internal.is_email(text) from public, anon;
grant  execute on function internal.is_email(text) to authenticated;

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
           where not internal.is_email(entry.address)
        )
      );
$fn$;

comment on function internal.is_email_list(text) is
  'True when the value is null or a comma-separated list of plausible addresses. Judges each entry with internal.is_email(), so the list and the single address can never disagree.';

revoke all     on function internal.is_email_list(text) from public, anon;
grant  execute on function internal.is_email_list(text) to authenticated;

-- ============================================================= list_employees ===
-- The roster, which is not the same list as `list_accounts()` and is not a
-- second version of it.
--
-- `list_accounts()` answers "who can sign in", so it shows active people only
-- and elevates to reach `auth.users` and `public.user_roles`. This answers "who
-- is on the payroll", so it has to include somebody who has left -- their days
-- are still in the record and the box that shows them has to be reachable --
-- and it reaches nothing an ordinary caller could not.
--
-- Which is why it is INVOKER, like every other read here. The role gate refuses
-- early rather than elevating: `employees_hr_admin_all` already hands HR and
-- admin the whole table, and an employee reaching this would get their own row
-- back, which is not an answer to any question this screen asks.

create or replace function public.list_employees()
returns table (
  employee_id    uuid,
  employee_name  text,
  employee_email text,
  job_title      text,
  department_id  uuid,
  department     text,
  state          text,
  has_account    boolean,
  created_at     timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
begin
  perform internal.require_role(array['hr', 'admin'], 'ver el padron de personal');

  return query
    select e.id,
           e.nombre,
           e.correo,
           e.puesto,
           e.department_id,
           d.name,
           e.estado,
           e.auth_user_id is not null,
           e.created_at
      from public.empleados e
      left join public.departments d on d.id = e.department_id
     -- Active first, then by name. Written as a predicate rather than leaning
     -- on 'activo' sorting before 'baja', which is true and is a coincidence of
     -- the language the column was named in.
     order by (e.estado <> 'activo'), e.nombre;
end;
$fn$;

comment on function public.list_employees() is
  'The whole roster, people on baja included, with their department and whether they have access. list_accounts() answers who can sign in; this answers who is on the payroll.';

revoke all     on function public.list_employees() from public, anon;
grant  execute on function public.list_employees() to authenticated;

-- ============================================================== save_employee ===
-- Create or edit, in one function, because from the screen it is one action --
-- the same shape `save_schedule()` settled on.
--
-- This writes to `public.empleados`, which the help desk owns and `ti-hub`
-- reads. Two consequences are deliberate:
--
--   * **It touches four columns and no others.** `estado` belongs to
--     `retire_employee()` and `restore_employee()`, which take a reason;
--     `auth_user_id` belongs to `link_employee_account()`; `extension` is the
--     help desk's and no business of an attendance screen. A writer that
--     updated the whole row would silently clear whatever it did not know
--     about.
--
--   * **`departamento` is left alone.** It is the obsolete text column, and
--     `internal.employees_sync_department()` fills it from the catalogue on
--     every insert and update. Setting it here as well would be a second
--     opinion about the same fact, and the trigger's is the one that survives.
--
-- The address is trimmed and never case-folded. `empleados_correo_key` is
-- case-sensitive, so the duplicate check below is deliberately stricter than
-- the constraint -- two rows differing only in capitalisation are the same
-- person to everybody except Postgres. Rewriting an existing address to
-- lowercase, on the other hand, would change a value ti-hub displays, for the
-- sake of tidiness nobody asked for.

create or replace function public.save_employee(
  p_name          text,
  p_email         text,
  p_job_title     text default null,
  p_department_id uuid default null,
  p_id            uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_before public.empleados;
  v_after  public.empleados;
  v_email  text;
  v_holder text;
begin
  perform internal.require_role(array['hr', 'admin'], 'dar de alta o editar personas');

  if p_name is null or length(trim(p_name)) < 3 then
    raise exception 'El nombre debe tener al menos 3 caracteres'
      using errcode = '22023';
  end if;

  v_email := trim(coalesce(p_email, ''));

  if not internal.is_email(v_email) then
    raise exception 'El correo no parece una direccion valida'
      using errcode = '22023',
            hint    = 'Por ejemplo nombre.apellido@empresa.com';
  end if;

  if p_department_id is not null
     and not exists (select 1 from public.departments d where d.id = p_department_id) then
    raise exception 'Ese departamento no existe'
      using errcode = '02000';
  end if;

  -- Named rather than reported as a constraint violation, the way
  -- link_employee_account() names the person an account already belongs to.
  select e.nombre into v_holder
    from public.empleados e
   where lower(e.correo) = lower(v_email)
     and (p_id is null or e.id <> p_id);

  if v_holder is not null then
    raise exception 'Ese correo ya es de %', v_holder
      using errcode = '23505';
  end if;

  if p_id is not null then
    select e.* into v_before from public.empleados e where e.id = p_id;

    if v_before.id is null then
      raise exception 'Esa persona no esta en el catalogo de empleados'
        using errcode = '02000';
    end if;

    update public.empleados e
       set nombre        = trim(p_name),
           correo        = v_email,
           puesto        = nullif(trim(coalesce(p_job_title, '')), ''),
           department_id = p_department_id
     where e.id = p_id
    returning * into v_after;
  else
    insert into public.empleados (nombre, correo, puesto, department_id, estado)
    values (trim(p_name), v_email,
            nullif(trim(coalesce(p_job_title, '')), ''),
            p_department_id, 'activo')
    returning * into v_after;
  end if;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    (case when p_id is null then 'employee_created' else 'employee_updated' end,
     'public.empleados', v_after.id, auth.uid(),
     format('%s (%s)', v_after.nombre, v_after.correo),
     case when v_before.id is null then null else to_jsonb(v_before) end,
     to_jsonb(v_after));

  return jsonb_build_object(
    'employee_id',   v_after.id,
    'employee_name', v_after.nombre,
    'created',       p_id is null);
end;
$fn$;

comment on function public.save_employee(text, text, text, uuid, uuid) is
  'Creates or edits a person in the shared roster. Touches four columns only: estado, auth_user_id, extension and the obsolete departamento text all belong to somebody else.';

revoke all     on function public.save_employee(text, text, text, uuid, uuid) from public, anon;
grant  execute on function public.save_employee(text, text, text, uuid, uuid) to authenticated;

-- =========================================================== retire_employee ===
-- What "delete" means here, and why it is not DELETE.
--
-- The database will not allow the real thing for anybody who has ever punched:
-- `punches_employee_id_fkey` and `workdays_employee_id_fkey` are both
-- `on delete restrict`, and they are right to be -- somebody's attendance
-- record is not a detail of their personnel file. For somebody who has never
-- punched it would succeed, and take their alerts, sessions, devices,
-- schedules and consents with it through five `on delete cascade`s, without
-- saying so.
--
-- So the two outcomes of DELETE are "refused with a constraint name" and
-- "silently more than you asked for". `estado = 'baja'` is neither, and it is
-- what the rest of the system already reads: `list_accounts()`,
-- `my_profile()` and `attendance.evaluate_alerts()` all filter on
-- `estado = 'activo'`, so a retired person cannot punch and is not watched for
-- not punching.
--
-- Access goes with it, through `unlink_employee_account()` rather than beside
-- it. That function already decides that only an administrator may take an
-- administrator's account, and it writes its own audit row. Two rows land for
-- one action, and both are true: somebody was retired, and an account was
-- unlinked.

create or replace function public.retire_employee(
  p_employee_id uuid,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_employee public.empleados;
  v_revoked  boolean := false;
  v_open     integer;
begin
  perform internal.require_role(array['hr', 'admin'], 'dar de baja a una persona');

  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'El motivo debe tener al menos 10 caracteres'
      using errcode = '22023';
  end if;

  select e.* into v_employee from public.empleados e where e.id = p_employee_id;

  if v_employee.id is null then
    raise exception 'Esa persona no esta en el catalogo de empleados'
      using errcode = '02000';
  end if;

  if v_employee.estado = 'baja' then
    raise exception 'Esa persona ya esta dada de baja'
      using errcode = '22023';
  end if;

  -- Said here rather than left to unlink_employee_account(), which would refuse
  -- for the right reason with the wrong sentence: this is not about an account.
  if v_employee.auth_user_id = auth.uid() then
    raise exception 'No puedes darte de baja a ti mismo'
      using errcode = '22023',
            hint    = 'Pideselo a otra persona de Recursos Humanos';
  end if;

  if v_employee.auth_user_id is not null then
    perform public.unlink_employee_account(p_employee_id, p_reason);
    v_revoked := true;
  end if;

  update public.empleados e
     set estado = 'baja'
   where e.id = p_employee_id;

  -- Their open alerts outlive them, like every other alert: the record of what
  -- happened does not depend on the person still being here. Reported so
  -- whoever retires somebody knows there is a list left on Revisión.
  select count(*)::integer into v_open
    from attendance.alerts a
   where a.employee_id = p_employee_id and a.state = 'open';

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('employee_retired', 'public.empleados', p_employee_id, auth.uid(), p_reason,
     jsonb_build_object('estado', 'activo', 'auth_user_id', v_employee.auth_user_id),
     jsonb_build_object('estado', 'baja',   'auth_user_id', null));

  return jsonb_build_object(
    'employee_id',    p_employee_id,
    'employee_name',  v_employee.nombre,
    'state',          'baja',
    'access_revoked', v_revoked,
    'open_alerts',    v_open);
end;
$fn$;

comment on function public.retire_employee(uuid, text) is
  'Puts somebody on baja and takes their access with them. Never deletes the row: the foreign keys would refuse it for anybody who has punched and would cascade away five tables for anybody who has not.';

revoke all     on function public.retire_employee(uuid, text) from public, anon;
grant  execute on function public.retire_employee(uuid, text) to authenticated;

-- ========================================================== restore_employee ===
-- The way back, and only part of it. Somebody returning is active again in the
-- roster and still has no way in: their account was unlinked, and creating one
-- is `Configuración → Accesos`, where somebody decides what role they get this
-- time. Restoring the link silently would hand back whatever they had before,
-- which is a decision, and one nobody made.

create or replace function public.restore_employee(
  p_employee_id uuid,
  p_reason      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_employee public.empleados;
begin
  perform internal.require_role(array['hr', 'admin'], 'reactivar a una persona');

  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'El motivo debe tener al menos 10 caracteres'
      using errcode = '22023';
  end if;

  select e.* into v_employee from public.empleados e where e.id = p_employee_id;

  if v_employee.id is null then
    raise exception 'Esa persona no esta en el catalogo de empleados'
      using errcode = '02000';
  end if;

  if v_employee.estado = 'activo' then
    raise exception 'Esa persona ya esta activa'
      using errcode = '22023';
  end if;

  update public.empleados e
     set estado = 'activo'
   where e.id = p_employee_id;

  insert into attendance.audit_events
    (kind, entity, entity_id, actor, body, before_data, after_data)
  values
    ('employee_restored', 'public.empleados', p_employee_id, auth.uid(), p_reason,
     jsonb_build_object('estado', 'baja'),
     jsonb_build_object('estado', 'activo'));

  return jsonb_build_object(
    'employee_id',   p_employee_id,
    'employee_name', v_employee.nombre,
    'state',         'activo',
    -- The screen says so rather than leaving somebody to discover it when the
    -- person cannot sign in on Monday.
    'needs_account', v_employee.auth_user_id is null);
end;
$fn$;

comment on function public.restore_employee(uuid, text) is
  'Returns somebody to activo. Does not give access back: which role they get is a decision, and it is made on Configuración → Accesos.';

revoke all     on function public.restore_employee(uuid, text) from public, anon;
grant  execute on function public.restore_employee(uuid, text) to authenticated;

-- ========================================================= attendance_summary ===
-- The body of `my_summary()`, lifted out so the same figures can be asked about
-- somebody else.
--
-- This is the shape `public.punch()` and `public.sync_punches()` already have
-- over `internal.record_punch()`: two entry points, one set of rules, and the
-- only difference between them is where the employee comes from. Two copies of
-- a punctuality calculation would drift exactly the way two copies of the state
-- machine would, and the drift would be invisible -- both screens would show a
-- number, and only one of them would be right.
--
-- **SECURITY INVOKER, and that is load-bearing.** An invoker function called
-- from an invoker function still runs as the original caller, so the policies
-- on `workdays`, `alerts` and `app_sessions` -- all of them
-- `internal.can_view_employee()` -- are what decide whose figures come back.
-- Made definer, it would answer about anybody to anybody, and both wrappers
-- would have to reimplement a scope rule that already exists in one place.
--
-- Three additions over what `my_summary()` used to return, and all three are
-- counts of facts rather than new judgements:
--
--   * `weeks`, because "days worked this week" is a question with a wrong
--     answer available -- a week that starts on Sunday, or in the reader's zone
--     rather than the employee's. `date_trunc('week', ...)` is ISO, so weeks
--     start on Monday, and the first and last of the range are partial by
--     construction.
--   * the three disconnection counts. `no_connection` alerts are the
--     evaluator's judgement and are counted the way `late_entry` is, dismissed
--     ones excluded. `offline_days` and `expired_sessions` are not judgements
--     at all: one is a day some punch arrived by sync, the other is a session
--     that stopped reporting and was closed by the sweeper.

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

  with calendar as (
    -- Every date in the range, not only the ones with a workday row. A day
    -- somebody was expected and never arrived is exactly the day worth seeing,
    -- and it has no row anywhere to be found by.
    select d::date as work_date
      from generate_series(v_from, v_today, interval '1 day') as d
  ),
  resolved as (
    select c.work_date,
           s.id is not null                                     as scheduled,
           -- What the schedule asks for, in working seconds: the span between
           -- the expected hours, less the break it allows. `worked_seconds` on
           -- a workday excludes breaks too, so the two are comparable.
           greatest(0,
             extract(epoch from (s.exit_expected - s.entry_expected))::integer
             - coalesce(s.break_max_minutes, 0) * 60)           as expected_seconds,
           to_char(s.entry_expected, 'HH24:MI')                 as entry_expected,
           coalesce(w.state, 'not_started')                     as state,
           w.opened_at,
           w.closed_at,
           coalesce(w.worked_seconds, 0)                        as worked_seconds,
           coalesce(w.break_seconds,  0)                        as break_seconds,
           coalesce(w.has_offline, false)                       as has_offline,
           exists (
             select 1
               from attendance.alerts a
              where a.employee_id = p_employee_id
                and a.alert_date  = c.work_date
                and a.kind        = 'late_entry'
                and a.state      <> 'dismissed'
           )                                                    as late
      from calendar c
      left join lateral internal.resolve_schedule(p_employee_id, c.work_date) s on true
      left join attendance.workdays w
             on w.employee_id = p_employee_id
            and w.work_date   = c.work_date
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
           count(*) filter (where has_offline)::integer         as offline_days,
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
  'Every figure the two summary screens show, decided once. INVOKER so the policies on workdays, alerts and app_sessions keep deciding whose figures come back.';

revoke all     on function internal.attendance_summary(uuid, integer) from public, anon;
grant  execute on function internal.attendance_summary(uuid, integer) to authenticated;

-- ============================================================== my_summary ===
-- Now a wrapper, and it holds exactly one rule: the employee comes from the
-- token. That is the same division `public.punch()` has -- the entry point
-- decides who, the shared function decides what.
--
-- Same contract as before, with the five keys the shared function added. A
-- caller reading only what it read yesterday sees no difference.

create or replace function public.my_summary(p_days integer default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_employee_id uuid;
begin
  v_employee_id := internal.caller_employee_id();

  if v_employee_id is null then
    raise exception 'Esta cuenta no esta ligada a un empleado activo'
      using errcode = '42501';
  end if;

  return internal.attendance_summary(v_employee_id, p_days);
end;
$fn$;

comment on function public.my_summary(integer) is
  'Resumen de la propia asistencia sobre un rango de a lo mas 92 dias. El empleado sale del token; las cifras las decide internal.attendance_summary().';

revoke all     on function public.my_summary(integer) from public, anon;
grant  execute on function public.my_summary(integer) to authenticated;

-- ========================================================= employee_summary ===
-- The same answer about somebody else, for whoever is entitled to ask.
--
-- No role check is written here and none is wanted. The lookup below goes
-- through RLS on `public.empleados`, so a manager finds their department, HR
-- finds everyone and an employee finds only themselves -- the same rule
-- `employee_day()` leans on, in the same shape, refusing with the same sentence
-- for "does not exist" and "not yours to see" because telling those two apart
-- is exactly what a directory scan needs.
--
-- The refusal is the point. Without it an employee asking about a colleague
-- would get a summary of zeros -- every policy filtering every row -- and zeros
-- read as a perfect absence record rather than as no access.
--
-- Unlike `list_employees()`, this does not filter on `estado`: the days of
-- somebody who has left are still in the record, and a box that could not be
-- opened for them would make the roster's own baja rows unreadable.

create or replace function public.employee_summary(
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
  v_employee public.empleados;
begin
  select e.* into v_employee
    from public.empleados e
   where e.id = p_employee_id;

  if v_employee.id is null then
    raise exception 'No hay ningun empleado visible con ese identificador'
      using errcode = '42501';
  end if;

  return internal.attendance_summary(p_employee_id, p_days)
      || jsonb_build_object(
           'employee_id',   v_employee.id,
           'employee_name', v_employee.nombre,
           'employee_state', v_employee.estado);
end;
$fn$;

comment on function public.employee_summary(uuid, integer) is
  'The summary my_summary() gives an employee about themselves, about somebody else, for whoever RLS lets see them. Includes people on baja: their days are still in the record.';

revoke all     on function public.employee_summary(uuid, integer) from public, anon;
grant  execute on function public.employee_summary(uuid, integer) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The reads invoke and the writers elevate, as everywhere else here.
--   --    workforce_api_test.sql asserts this too.
--   select p.proname,
--          case p.prosecdef when true then 'definer' else 'invoker' end as security
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('list_employees', 'employee_summary', 'my_summary',
--                        'save_employee', 'retire_employee', 'restore_employee',
--                        'reset_day')
--    order by p.prosecdef, p.proname;
--   -- Expected: list_employees, employee_summary and my_summary are 'invoker';
--   -- the four writers are 'definer'.
--
--   -- 2. No workday disagrees with the punches that still count. This is the
--   --    invariant the two implementations of the arithmetic have to keep.
--   select w.id, w.work_date, w.worked_seconds, r.worked_seconds as recomputed
--     from attendance.workdays w
--     cross join lateral internal.recompute_workday(w.id) r
--    where (w.worked_seconds, w.break_seconds, w.state)
--       is distinct from (r.worked_seconds, r.break_seconds, r.state);
--   -- Expected: 0 rows. NOTE this writes: run it on a copy, or in a transaction
--   -- that rolls back.
--
--   -- 3. Every void carries its reason, and every reset carries its trail:
--   select a.kind, count(*), min(length(a.reason)) as shortest_reason
--     from attendance.adjustments a
--    where a.kind = 'void_punch'
--    group by a.kind;
--   select kind, count(*), max(created_at) from attendance.audit_events
--    where kind in ('workday_reset', 'employee_created', 'employee_updated',
--                   'employee_retired', 'employee_restored')
--    group by kind order by kind;
--
--   -- 4. Nobody was deleted from the roster to make somebody inactive:
--   select estado, count(*) from public.empleados group by estado;
