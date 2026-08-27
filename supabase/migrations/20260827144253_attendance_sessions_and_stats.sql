-- attendance_sessions_and_stats.sql
--
-- Two things the client could not do, and one figure it should never work out
-- for itself.
--
-- 1. THE ACCESS LOG. `attendance.devices` already answers "which machines does
--    this person punch from", which is what it was built for: revoking a lost
--    laptop. It does not answer "when did somebody start using the application,
--    from where, and when did they stop" -- it keeps one row per device with a
--    `last_seen_at` that is overwritten, so yesterday's session is gone the
--    moment today's begins. That question needs a row per session, which is
--    what `attendance.app_sessions` is.
--
-- 2. THE COUNTERS THE EMPLOYEE'S OWN SCREEN SHOWS. `my_day()` reports them as
--    the engine accumulated them, and the engine accumulates by difference at
--    each punch -- so somebody four hours into a shift with no break sees
--    `0 min` worked, because nothing has closed an interval yet. That is
--    correct and unreadable. `my_day()` now also reports the running total and
--    the instant it has been running from, so the screen can show a counter
--    that moves without ever deciding what it is counting.
--
-- 3. `my_summary()`. Hours against expected, punctuality, streak, average
--    entry. Every one of those is a judgement about somebody's attendance, and
--    this repository has one rule above the others: Postgres decides. The
--    client is handed the answers and lays them out.
--
-- What is deliberately NOT here: coordinates. "Where" in this migration is the
-- request IP and the zone the device reports, both of which arrive with the
-- request and need nobody's permission. Real geolocation already has its
-- machinery in this schema -- `attendance.consents`, the 90-day `geo_purge_on`,
-- the discard-without-consent branch in `record_punch()` -- and turning it on
-- for sessions means a consent screen and an edit to `Permissions-Policy` in
-- `web/vercel.json`. That is a privacy decision, so it is its own change rather
-- than a column added quietly here.

-- =========================================================== app_sessions ===
-- One row per stretch of the application being open on one device by one
-- account. Not per punch, not per device: per session.
--
-- `auth_user_id` is the subject and is never null. `employee_id` is the scope
-- and can be, because there is an administrator account that is not a person --
-- the same reason `public.user_roles` is keyed by account rather than by
-- employee.

create table if not exists attendance.app_sessions (
  id            uuid        primary key default gen_random_uuid(),
  auth_user_id  uuid        not null references auth.users (id)       on delete cascade,
  employee_id   uuid                 references public.empleados (id) on delete cascade,
  device_id     text        not null,

  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  ended_at      timestamptz,
  end_reason    text,

  -- Where the request came from, as far as anything here can honestly say.
  ip            inet,
  user_agent    text,
  -- What the device says about itself. Reported by the client, so it is
  -- evidence and not proof -- exactly like `punches.client_reported_at`.
  platform      text,
  time_zone     text,
  locale        text,
  app_version   text,

  created_at    timestamptz not null default now(),

  constraint app_sessions_reason_valid
    check (end_reason is null or end_reason in ('sign_out', 'app_closed', 'expired')),
  -- A closed session has a reason and an open one has neither. Without this the
  -- log grows rows that are half-closed and nothing can tell which.
  constraint app_sessions_close_coherent
    check ((ended_at is null) = (end_reason is null)),
  constraint app_sessions_end_after_start
    check (ended_at is null or ended_at >= started_at),
  constraint app_sessions_seen_after_start
    check (last_seen_at >= started_at)
);

comment on table attendance.app_sessions is
  'Un renglon por sesion de la aplicacion: que equipo, desde donde, a que hora abrio y a que hora cerro.';
comment on column attendance.app_sessions.employee_id is
  'Nulo para una cuenta que no es una persona (la administradora). El alcance de RLS cae entonces al propio auth_user_id.';
comment on column attendance.app_sessions.last_seen_at is
  'Ultimo momento en que la aplicacion dijo estar abierta. Es la hora de cierre cuando la sesion se vence sin aviso.';
comment on column attendance.app_sessions.end_reason is
  'sign_out: cerro sesion. app_closed: cerro la aplicacion. expired: dejo de reportarse y la barrio el trabajo programado.';
comment on column attendance.app_sessions.platform is
  'Lo que el equipo dice de si mismo. Es evidencia reportada por el cliente, no un dato verificado.';

-- One open session per account and device. Not a tidiness rule: it is what
-- makes open_session() able to resume instead of having to decide which of
-- several open rows is the real one.
create unique index if not exists app_sessions_open_unique
  on attendance.app_sessions (auth_user_id, device_id)
  where ended_at is null;

-- The shape `my_sessions()` reads in, and the covering index the foreign key to
-- auth.users needs. The unique index above leads with the same column but is
-- partial -- it holds only the open rows -- so it can serve neither a listing of
-- somebody's history nor the cascade when an account is deleted.
create index if not exists app_sessions_account_idx
  on attendance.app_sessions (auth_user_id, started_at desc);

create index if not exists app_sessions_employee_idx
  on attendance.app_sessions (employee_id, started_at desc);
create index if not exists app_sessions_device_idx
  on attendance.app_sessions (device_id, started_at desc);
-- Read by the sweeper, which only ever looks at what is still open.
create index if not exists app_sessions_stale_idx
  on attendance.app_sessions (last_seen_at)
  where ended_at is null;

alter table attendance.app_sessions enable row level security;

grant select on attendance.app_sessions to authenticated;

-- Same scope rule as every other table in this schema, plus the account's own
-- rows: an administrator has no employee_id, so can_view_employee(null) is null
-- for them and they would not see their own access log.
create policy app_sessions_read on attendance.app_sessions
  for select to authenticated
  using (
       internal.can_view_employee(employee_id)
    or auth_user_id = (select auth.uid())
  );

-- ============================================================ open_session ===
-- Called when the application starts, and whenever a keep-alive finds the
-- session already gone. It resumes rather than accumulating rows, because the
-- three ways an application "starts" are not three sessions:
--
--   a reload              -> the same session; it is still open
--   a clean close and a   -> the same session; a window closed two seconds ago
--     relaunch moments        and reopened was never really shut
--     later
--   a machine that went   -> a NEW session. The old one is closed at the last
--     quiet for hours         moment anybody knows the person was there, which
--                             is last_seen_at and not now().

create or replace function public.open_session(
  p_device_id   text,
  p_platform    text default null,
  p_time_zone   text default null,
  p_locale      text default null,
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- Long enough that a closed lid over lunch is the same session; short enough
  -- that a machine shut down for the night is not still open in the morning.
  -- The client reports every five minutes, so the gap is unambiguous.
  c_idle   constant interval := interval '2 hours';
  -- A reload, a crash and a relaunch all land inside this. A genuine second
  -- visit does not.
  c_resume constant interval := interval '2 minutes';

  v_uid      uuid;
  v_employee uuid;
  v_device   text;
  v_session  attendance.app_sessions;
  v_revoked  boolean;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception 'No hay sesion activa' using errcode = '42501';
  end if;

  v_device := nullif(trim(p_device_id), '');
  if v_device is null then
    raise exception 'Falta el identificador del equipo' using errcode = '22023';
  end if;

  -- Derived from the token, exactly as it is for a punch. Null for the
  -- administrator account, which is a valid session with no workday behind it.
  v_employee := internal.caller_employee_id();

  -- 1. Anything that went quiet for longer than the window was not this launch.
  --    It is closed at the last moment we know somebody was there.
  update attendance.app_sessions s
     set ended_at   = s.last_seen_at,
         end_reason = 'expired'
   where s.auth_user_id = v_uid
     and s.device_id    = v_device
     and s.ended_at is null
     and s.last_seen_at < now() - c_idle;

  -- 2. With nothing open, a session this device closed moments ago is this one.
  --    Guarded on there being nothing open: reopening otherwise would leave two
  --    and the unique index above would refuse the whole call.
  if not exists (
    select 1 from attendance.app_sessions s
     where s.auth_user_id = v_uid and s.device_id = v_device and s.ended_at is null
  ) then
    update attendance.app_sessions s
       set ended_at     = null,
           end_reason   = null,
           last_seen_at = now()
     where s.id = (
       select prior.id
         from attendance.app_sessions prior
        where prior.auth_user_id = v_uid
          and prior.device_id    = v_device
          and prior.end_reason   = 'app_closed'
          and prior.ended_at     > now() - c_resume
        order by prior.ended_at desc
        limit 1
     );
  end if;

  -- 3. Resume what is open, or start a new one. The conflict target names the
  --    partial index, so two tabs racing to open produce one session rather
  --    than one session and one error.
  insert into attendance.app_sessions (
    auth_user_id, employee_id, device_id,
    ip, user_agent, platform, time_zone, locale, app_version
  ) values (
    v_uid, v_employee, v_device,
    internal.request_ip(), internal.request_user_agent(),
    left(nullif(trim(p_platform),    ''), 120),
    left(nullif(trim(p_time_zone),   ''),  60),
    left(nullif(trim(p_locale),      ''),  20),
    left(nullif(trim(p_app_version), ''),  40)
  )
  on conflict (auth_user_id, device_id) where ended_at is null
  do update set
    last_seen_at = now(),
    -- coalesce and not excluded: a keep-alive that omits a field must not blank
    -- out what the first call already recorded.
    employee_id  = coalesce(excluded.employee_id, app_sessions.employee_id),
    ip           = coalesce(excluded.ip,          app_sessions.ip),
    user_agent   = coalesce(excluded.user_agent,  app_sessions.user_agent),
    platform     = coalesce(excluded.platform,    app_sessions.platform),
    time_zone    = coalesce(excluded.time_zone,   app_sessions.time_zone),
    locale       = coalesce(excluded.locale,      app_sessions.locale),
    app_version  = coalesce(excluded.app_version, app_sessions.app_version)
  returning * into v_session;

  -- The device is kept in step with the same table a punch would have written
  -- to, so a machine that opens the application every morning without ever
  -- punching is still revocable.
  if v_employee is not null then
    insert into attendance.devices (employee_id, device_id, user_agent)
    values (v_employee, v_device, internal.request_user_agent())
    on conflict (employee_id, device_id) do update
      set last_seen_at = now(),
          user_agent   = coalesce(excluded.user_agent, devices.user_agent);

    select d.revoked_at is not null into v_revoked
      from attendance.devices d
     where d.employee_id = v_employee and d.device_id = v_device;
  end if;

  -- A revoked device is reported, not refused. Refusing would leave the screen
  -- unable to explain itself, and the attempt is worth recording either way --
  -- the engine still refuses the punch, which is where it matters.
  return jsonb_build_object(
    'session_id',     v_session.id,
    'started_at',     v_session.started_at,
    'resumed',        v_session.started_at < v_session.last_seen_at,
    'device_revoked', coalesce(v_revoked, false),
    'server_time',    now()
  );
end;
$fn$;

comment on function public.open_session(text, text, text, text, text) is
  'Abre o retoma la sesion de la aplicacion en un equipo. La cuenta sale del token: nunca se acepta como parametro.';

revoke all     on function public.open_session(text, text, text, text, text) from public, anon;
grant  execute on function public.open_session(text, text, text, text, text) to authenticated;

-- =========================================================== touch_session ===
-- Proof that the application is still open, sent every five minutes. Separate
-- from heartbeat() on purpose: that one is about a workday and only beats while
-- one is open, and a session exists whether or not anybody clocked in.
--
-- It answers whether the session was still open, which is what lets the client
-- notice it was swept and open a new one instead of reporting into a row that
-- has already been closed.

create or replace function public.touch_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid;
  v_rows integer;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception 'No hay sesion activa' using errcode = '42501';
  end if;

  update attendance.app_sessions s
     set last_seen_at = now()
   where s.id           = p_session_id
     -- The ownership check is the whole security of a SECURITY DEFINER writer
     -- that takes an id from the client.
     and s.auth_user_id = v_uid
     and s.ended_at is null;

  get diagnostics v_rows = row_count;

  return jsonb_build_object('active', v_rows = 1, 'server_time', now());
end;
$fn$;

comment on function public.touch_session(uuid) is
  'Senal de vida de la sesion de la aplicacion. Devuelve active=false si ya estaba cerrada, para que el cliente abra otra.';

revoke all     on function public.touch_session(uuid) from public, anon;
grant  execute on function public.touch_session(uuid) to authenticated;

-- =========================================================== close_session ===
-- The hour the log exists for. Called on sign-out, and on the browser's
-- `pagehide` for a window being closed -- best effort, because a machine that
-- loses power never gets to say anything. That case is what the sweeper below
-- is for, and it is why an unreported close is recorded as `expired` at
-- last_seen_at rather than invented as now().
--
-- Closing twice keeps the first close: a `pagehide` that fires after an
-- explicit sign-out must not overwrite the reason with a vaguer one.

create or replace function public.close_session(
  p_session_id uuid,
  p_reason     text default 'sign_out'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid;
  v_reason  text;
  v_session attendance.app_sessions;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception 'No hay sesion activa' using errcode = '42501';
  end if;

  -- `expired` is the sweeper's word and no client may claim it: it means "we
  -- never heard from them again", which a client reporting in contradicts.
  v_reason := case p_reason when 'app_closed' then 'app_closed' else 'sign_out' end;

  update attendance.app_sessions s
     set ended_at     = coalesce(s.ended_at, now()),
         end_reason   = coalesce(s.end_reason, v_reason),
         -- Only while it was still open. A second close is a duplicate report,
         -- not a sighting, and moving `last_seen_at` past `ended_at` would make
         -- the row say the device was heard from after it stopped.
         last_seen_at = case
                          when s.ended_at is null then greatest(s.last_seen_at, now())
                          else s.last_seen_at
                        end
   where s.id           = p_session_id
     and s.auth_user_id = v_uid
  returning * into v_session;

  return jsonb_build_object(
    'closed',      v_session.id is not null,
    'ended_at',    v_session.ended_at,
    'end_reason',  v_session.end_reason,
    'server_time', now()
  );
end;
$fn$;

comment on function public.close_session(uuid, text) is
  'Cierra la sesion de la aplicacion. Idempotente: un segundo cierre conserva la hora y el motivo del primero.';

revoke all     on function public.close_session(uuid, text) from public, anon;
grant  execute on function public.close_session(uuid, text) to authenticated;

-- ==================================================== expire_stale_sessions ===
-- The backstop. A window closed by pulling the plug, a browser killed by the
-- operating system and a machine that simply stopped never call
-- close_session(), and a log full of sessions that are still open weeks later
-- answers nothing.
--
-- ended_at = last_seen_at, never now(): the last thing anybody knows is the
-- last report. Stamping now() would credit the person with every hour the
-- sweeper waited.

create or replace function attendance.expire_stale_sessions(p_idle_minutes integer default 120)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_closed integer;
begin
  if p_idle_minutes < 15 then
    raise exception 'La ventana de inactividad no baja de 15 minutos (se pidio %)', p_idle_minutes
      using hint = 'El cliente reporta cada 5 minutos: por debajo de 15 se cerrarian sesiones vivas';
  end if;

  update attendance.app_sessions s
     set ended_at   = s.last_seen_at,
         end_reason = 'expired'
   where s.ended_at is null
     and s.last_seen_at < now() - make_interval(mins => p_idle_minutes);

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$fn$;

comment on function attendance.expire_stale_sessions(integer) is
  'Cierra las sesiones que dejaron de reportarse, a la hora de su ultimo reporte. Nunca a la hora en que corre.';

revoke all on function attendance.expire_stale_sessions(integer) from public, anon, authenticated;

-- ============================================================= my_sessions ===
-- The employee's own access log, shown to them on their own screen.
--
-- Showing it is not decoration. This records where somebody signed in from and
-- when they stopped, and the person it is about is the one who should be able
-- to read it without asking anybody. SECURITY INVOKER, so what comes back is
-- whatever the policy above hands the caller and nothing more.

create or replace function public.my_sessions(p_limit integer default 12)
returns table (
  id           uuid,
  device_id    text,
  started_at   timestamptz,
  ended_at     timestamptz,
  end_reason   text,
  last_seen_at timestamptz,
  active       boolean,
  ip           text,
  platform     text,
  time_zone    text,
  user_agent   text
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select s.id, s.device_id, s.started_at, s.ended_at, s.end_reason, s.last_seen_at,
         s.ended_at is null,
         host(s.ip),
         s.platform, s.time_zone, s.user_agent
    from attendance.app_sessions s
   where s.auth_user_id = (select auth.uid())
   order by s.started_at desc
   limit greatest(1, least(coalesce(p_limit, 12), 100));
$fn$;

comment on function public.my_sessions(integer) is
  'Accesos recientes de la propia cuenta: equipo, desde donde, apertura y cierre.';

revoke all     on function public.my_sessions(integer) from public, anon;
grant  execute on function public.my_sessions(integer) to authenticated;

-- ======================================================= employee_sessions ===
-- The same log, for whoever is entitled to look at somebody else's. No role
-- check is written here: the policy on app_sessions is can_view_employee(), so
-- a manager gets their department and HR gets everyone. Writing the rule again
-- would be a second definition of it.

create or replace function public.employee_sessions(
  p_employee_id uuid,
  p_from        date    default null,
  p_to          date    default null,
  p_limit       integer default 100
)
returns table (
  id           uuid,
  device_id    text,
  started_at   timestamptz,
  ended_at     timestamptz,
  end_reason   text,
  last_seen_at timestamptz,
  active       boolean,
  ip           text,
  platform     text,
  time_zone    text,
  user_agent   text
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_zone text;
  v_to   date;
  v_from date;
begin
  v_zone := internal.time_zone_of(p_employee_id);
  v_to   := coalesce(p_to, (now() at time zone v_zone)::date);
  v_from := coalesce(p_from, v_to - 29);

  if v_from > v_to then
    raise exception 'La fecha inicial no puede ser posterior a la final' using errcode = '22023';
  end if;

  if v_to - v_from > 92 then
    raise exception 'El rango no puede exceder 92 dias' using errcode = '22023';
  end if;

  return query
    select s.id, s.device_id, s.started_at, s.ended_at, s.end_reason, s.last_seen_at,
           s.ended_at is null,
           host(s.ip),
           s.platform, s.time_zone, s.user_agent
      from attendance.app_sessions s
     where s.employee_id = p_employee_id
       and (s.started_at at time zone v_zone)::date between v_from and v_to
     order by s.started_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$fn$;

comment on function public.employee_sessions(uuid, date, date, integer) is
  'Accesos de un empleado sobre un rango de a lo mas 92 dias. El alcance lo decide RLS, no una comprobacion escrita aqui.';

revoke all     on function public.employee_sessions(uuid, date, date, integer) from public, anon;
grant  execute on function public.employee_sessions(uuid, date, date, integer) to authenticated;


-- ================================================== the sweeper's schedule ===
-- Every half hour against a two-hour window: the window decides what counts as
-- gone, this only decides how soon the record says so.
--
-- unschedule before schedule so the migration can be replayed without leaving
-- two jobs. cron.unschedule raises when the job does not exist, which is the
-- normal case the first time, hence the exception block.

do $do$
begin
  begin
    perform cron.unschedule('attendance_expire_app_sessions');
  exception when others then
    null;
  end;
end
$do$;

select cron.schedule(
  'attendance_expire_app_sessions',
  '*/30 * * * *',
  $cron$ select attendance.expire_stale_sessions(120); $cron$
);

-- ============================================================== my_summary ===
-- What the employee's own screen shows about the last few weeks: hours against
-- what was expected, how many days started on time, the run of complete days,
-- the hour they usually arrive.
--
-- Every one of those is a judgement, and every one of them is made here. The
-- client renders the numbers and never derives one, for the same reason the
-- board never works out who was late: whether an arrival counted as late
-- depends on the schedule, the grace period and the department's threshold, and
-- `attendance.evaluate_alerts()` is the only thing that resolves all three.
-- This function counts the alerts it raised; it does not second-guess them.
--
-- A `late_entry` that HR dismissed is not counted. `dismissed` is HR saying the
-- alert was not worth anything -- somebody on holiday, a schedule that was
-- wrong -- and holding it against the person afterwards would make the decision
-- pointless. The other three states all count: acknowledged and resolved both
-- mean it happened.
--
-- SECURITY INVOKER, like the other four readers. It touches `workdays` and
-- `alerts`, and the policies on both are already `can_view_employee()`, which
-- for an employee resolves to their own rows. A definer version would have to
-- reimplement that scope and could get it wrong quietly.

create or replace function public.my_summary(p_days integer default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_employee_id uuid;
  v_zone        text;
  v_today       date;
  v_from        date;
  v_days        integer;
  v_result      jsonb;
begin
  v_employee_id := internal.caller_employee_id();

  if v_employee_id is null then
    raise exception 'Esta cuenta no esta ligada a un empleado activo'
      using errcode = '42501';
  end if;

  -- The same 92-day ceiling `my_history()` holds to, and for the same reason:
  -- a payroll dispute over a quarter is the widest question anybody asks, and
  -- an uncapped range is an accident waiting for the day the table is large.
  v_days  := greatest(7, least(coalesce(p_days, 30), 92));
  v_zone  := internal.time_zone_of(v_employee_id);
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
           exists (
             select 1
               from attendance.alerts a
              where a.employee_id = v_employee_id
                and a.alert_date  = c.work_date
                and a.kind        = 'late_entry'
                and a.state      <> 'dismissed'
           )                                                    as late
      from calendar c
      left join lateral internal.resolve_schedule(v_employee_id, c.work_date) s on true
      left join attendance.workdays w
             on w.employee_id = v_employee_id
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
    'series',           s.items
  )
    into v_result
    from totals t, streak k, series s;

  return v_result;
end;
$fn$;

comment on function public.my_summary(integer) is
  'Resumen de la propia asistencia sobre un rango de a lo mas 92 dias: horas contra lo esperado, puntualidad, racha y serie diaria.';

revoke all     on function public.my_summary(integer) from public, anon;
grant  execute on function public.my_summary(integer) to authenticated;

-- ================================================================== my_day ===
-- Replaced, not extended: same contract with five fields added.
--
-- The engine accumulates the counters by difference at each punch, so between
-- punches they do not move. That is right for the record and wrong for a screen
-- somebody is looking at: four hours into a shift with no break, `worked_seconds`
-- is still zero.
--
-- The fix is not for the client to add up the difference itself -- that is the
-- state machine leaking into the browser, and the browser's copy is the one
-- that is wrong when they disagree. Instead the database says what is running
-- (`counting`), since when (`counting_since`), and what the totals are with
-- that interval included (`worked_seconds_live`, `break_seconds_live`). The
-- screen ticks forward from `server_time` and resyncs on every refresh; it
-- never decides which counter a break belongs to.
--
-- `expected_seconds` comes with it so the screen can draw progress against the
-- day without working out what the schedule meant.

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
  v_last_at     timestamptz;
  v_counting    text;
  v_running     integer := 0;
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

  -- The instant the current stretch has been running from: the last punch. The
  -- same ordering the engine uses to find it, so the two never disagree about
  -- which punch is last.
  select p.occurred_at into v_last_at
    from attendance.punches p
   where p.workday_id = v_workday.id
   order by p.occurred_at desc, p.created_at desc
   limit 1;

  v_counting := case v_state
                  when 'working'  then 'worked'
                  when 'on_break' then 'break'
                  else null                  -- not_started and finished: nothing runs
                end;

  if v_counting is not null and v_last_at is not null then
    -- greatest(0, ...) for the same reason the engine uses it: a clock that
    -- jumped must not produce a counter that runs backwards on screen.
    v_running := greatest(0, extract(epoch from (now() - v_last_at))::integer);
  end if;

  return jsonb_build_object(
    'server_time',    now(),
    'employee_id',    v_employee_id,
    'date',           v_date,
    'time_zone',      v_zone,

    'state',          v_state,
    'next_actions',   to_jsonb(internal.allowed_punches(v_state)),

    'worked_seconds', coalesce(v_workday.worked_seconds, 0),
    'break_seconds',  coalesce(v_workday.break_seconds, 0),

    -- The same two totals with the stretch that is still running included, and
    -- the two facts the screen needs to keep them moving between refreshes.
    'counting',            v_counting,
    'counting_since',      case when v_counting is null then null else v_last_at end,
    'worked_seconds_live', coalesce(v_workday.worked_seconds, 0)
                           + case when v_counting = 'worked' then v_running else 0 end,
    'break_seconds_live',  coalesce(v_workday.break_seconds, 0)
                           + case when v_counting = 'break'  then v_running else 0 end,

    -- What the schedule asks for today, in working seconds. Null on a day it
    -- does not cover, so the screen says so instead of drawing progress
    -- against a target nobody set.
    'expected_seconds', case
      when v_schedule.id is null then null
      else greatest(0,
             extract(epoch from (v_schedule.exit_expected - v_schedule.entry_expected))::integer
             - v_schedule.break_max_minutes * 60)
    end,

    'opened_at',      v_workday.opened_at,
    'closed_at',      v_workday.closed_at,
    'last_heartbeat', v_workday.last_heartbeat,
    'has_offline',    coalesce(v_workday.has_offline, false),
    'needs_review',   coalesce(v_workday.needs_review, false),

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

    -- Explicit column list, not p.*: `authenticated` was never granted geo_lat
    -- or geo_lng, so a star here would fail outright. That is the privacy
    -- promise working, not an inconvenience to route around.
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
  'Todo lo que necesita la pantalla de marcaje para hoy: estado, acciones legales, contadores en curso, horario y marcajes.';

revoke all     on function public.my_day() from public, anon;
grant  execute on function public.my_day() to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The new surface is published and only the writers elevate:
--   select p.proname,
--          case p.prosecdef when true then 'definer' else 'invoker' end as security
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('open_session', 'touch_session', 'close_session',
--                        'my_sessions', 'employee_sessions', 'my_summary', 'my_day')
--    order by p.prosecdef, p.proname;
--   -- Expected: my_sessions, employee_sessions, my_summary and my_day are
--   -- 'invoker'; the three session writers are 'definer'.
--
--   -- 2. The access log is not writable by the client:
--   select privilege_type from information_schema.role_table_grants
--    where table_schema = 'attendance' and table_name = 'app_sessions'
--      and grantee = 'authenticated';
--   -- Expected: SELECT, and nothing else.
--
--   -- 3. The sweeper is scheduled:
--   select jobname, schedule, active from cron.job
--    where jobname = 'attendance_expire_app_sessions';
--
--   -- 4. A session that went quiet is closed at its last report, not at now():
--   select id, last_seen_at, ended_at, end_reason from attendance.app_sessions
--    where end_reason = 'expired' order by ended_at desc limit 5;
--   -- Expected: ended_at equals last_seen_at on every row.
