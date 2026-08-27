-- What happened *during* a session, not just when it began and ended.
--
-- `attendance.app_sessions` answers when somebody started using the application
-- and when they stopped. It cannot answer the question this table exists for:
-- **the application was open the whole afternoon, so why was it unreachable
-- between 11:20 and 11:45.** A session's `last_seen_at` goes stale and then
-- comes back, and the gap leaves no trace -- the row afterwards looks exactly
-- like one that was never interrupted.
--
-- Three things this is careful about, because a log that overstates what it
-- knows is worse than no log.
--
-- **An `offline` event cannot be sent while offline.** That is not a flaw to
-- work around, it is the shape of the problem: the only clock that saw the
-- moment the connection dropped is the client's. So the event is buffered on the
-- device and sent on reconnection, `occurred_at` is when the server heard it and
-- `client_reported_at` is when the client says it happened -- the same division
-- `attendance.punches` already makes, for the same reason. A reader who needs
-- the real hour reads the client's and knows whose word it is.
--
-- **It records observations, never intent.** A person who closed the window, one
-- whose laptop lost power, and one who pulled the network cable on purpose are
-- not distinguishable by anything that arrives here, and no `kind` pretends
-- otherwise. What the log gives is the surrounding evidence: a session that
-- ended `expired` with a `connection_lost` as its last event was unreachable
-- before it died, and one that ended `expired` with nothing after a
-- `foregrounded` simply stopped mid-use. HR draws the conclusion; this does not.
--
-- **It is pruned.** One row per connectivity blip per device is the kind of
-- table that is fine for a month and a problem for a year, so
-- `attendance.prune_session_events()` runs on the same cron that already prunes
-- the outbox and the audit log.

create table if not exists attendance.session_events (
  id           uuid        primary key default gen_random_uuid(),
  session_id   uuid        not null references attendance.app_sessions (id) on delete cascade,
  -- Denormalised from the session on purpose: every policy and every read here
  -- filters by employee, and joining `app_sessions` to find out who a row is
  -- about would put a join inside an RLS policy evaluated per row.
  employee_id  uuid                 references public.empleados (id) on delete cascade,

  kind         text        not null,

  -- When the server heard it. The only clock anybody can rely on.
  occurred_at  timestamptz not null default now(),
  -- When the device says it happened. Null when the two are the same moment.
  client_reported_at timestamptz,

  detail       jsonb       not null default '{}',
  created_at   timestamptz not null default now(),

  constraint session_events_kind_valid check (kind in (
    -- The device noticed it could not reach the network.
    'connection_lost',
    -- And that it could again. `detail` carries how long the device thinks it
    -- was gone, which is the client's arithmetic and is labelled as such.
    'connection_back',
    -- The window stopped being visible, and started again. A backgrounded tab
    -- is throttled by the browser, so a gap in reports that follows one of
    -- these is explained rather than suspicious.
    'backgrounded',
    'foregrounded',
    -- A report that reached the server but was refused, or a reply that never
    -- arrived. This is the client saying it tried; `detail` carries what it saw.
    'request_failed'
  )),

  -- A client timestamp in the future is a clock that is wrong, and a reader
  -- comparing it against `occurred_at` needs to know which direction. Only
  -- absurd values are refused: an hour of skew is real and worth recording.
  constraint session_events_client_time_sane
    check (client_reported_at is null
           or client_reported_at < occurred_at + interval '1 day')
);

comment on table attendance.session_events is
  'What happened during a session: connectivity, visibility and failed reports. Observations reported by the device, never intent.';
comment on column attendance.session_events.occurred_at is
  'When the server heard it. An offline event cannot be sent while offline, so this is later than the fact for exactly the events that matter most.';
comment on column attendance.session_events.client_reported_at is
  'When the device says it happened. Evidence, not proof -- the same standing punches.client_reported_at has.';

-- Read paths: the trail of one session, and everything about one person over a
-- window. Both are covered by this one index.
create index if not exists session_events_employee_idx
  on attendance.session_events (employee_id, occurred_at desc);
create index if not exists session_events_session_idx
  on attendance.session_events (session_id, occurred_at);

alter table attendance.session_events enable row level security;

-- Same rule as every other read in this schema: `can_view_employee()` decides,
-- so a manager sees their department and HR sees everyone. Wrapped in a select
-- so it is evaluated once per statement rather than once per row -- except the
-- argument is per row, which is why the call itself cannot be hoisted.
drop policy if exists session_events_read on attendance.session_events;
create policy session_events_read
  on attendance.session_events
  for select
  to authenticated
  using (internal.can_view_employee(employee_id));

-- The client never writes a table. `report_session_event()` is the only path in.
revoke all on attendance.session_events from anon;
grant select (id, session_id, employee_id, kind, occurred_at,
              client_reported_at, detail, created_at)
  on attendance.session_events to authenticated;

-- ==================================================== report_session_event ===
-- The only way a row gets in.
--
-- `SECURITY DEFINER`, because it writes -- and it takes a session id rather than
-- deriving one, so it has to prove the session is the caller's own. The check is
-- `auth_user_id`, not `employee_id`: the administrative account has no employee
-- row and still has sessions.
--
-- Silent on a session it cannot claim. A device flushing a buffer after a
-- reconnection may be reporting into a session the sweeper has since closed, and
-- raising would make the client's retry loop hammer a row it can never write.
-- The answer says what happened instead.

create or replace function public.report_session_event(
  p_session_id         uuid,
  p_kind               text,
  p_client_reported_at timestamptz default null,
  p_detail             jsonb       default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_session attendance.app_sessions;
  v_uid     uuid := auth.uid();
  v_id      uuid;
begin
  if v_uid is null then
    raise exception 'No hay sesion activa' using errcode = '42501';
  end if;

  if p_kind is null then
    raise exception 'Falta el tipo de evento' using errcode = '22023';
  end if;

  select s.* into v_session
    from attendance.app_sessions s
   where s.id = p_session_id
     and s.auth_user_id = v_uid;

  -- Not an error. A buffer flushed after a reconnection can name a session the
  -- sweeper already closed, and the device has no way to know that.
  if v_session.id is null then
    return jsonb_build_object('recorded', false, 'reason', 'unknown_session');
  end if;

  insert into attendance.session_events
    (session_id, employee_id, kind, client_reported_at, detail)
  values
    (v_session.id, v_session.employee_id, p_kind,
     p_client_reported_at, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  -- A device that just told us it is back is a device we have heard from. Not
  -- `touch_session()` -- that has its own answer about whether the session is
  -- still alive, and this one has already established that it is.
  update attendance.app_sessions s
     set last_seen_at = greatest(s.last_seen_at, now())
   where s.id = v_session.id
     and s.ended_at is null;

  return jsonb_build_object('recorded', true, 'event_id', v_id);
exception
  when check_violation then
    -- A refused `kind` is a client sending something this version does not know
    -- about, which is a deploy-window event rather than an emergency: the bundle
    -- may be ahead of the migration. Report it rather than failing the flush.
    return jsonb_build_object('recorded', false, 'reason', 'unknown_kind');
end;
$fn$;

comment on function public.report_session_event(uuid, text, timestamptz, jsonb) is
  'Records one client-observed event inside the caller own session. Refuses nothing loudly: an unknown session or kind is reported back so a buffer flush is not retried for ever.';

revoke all     on function public.report_session_event(uuid, text, timestamptz, jsonb) from public, anon;
grant  execute on function public.report_session_event(uuid, text, timestamptz, jsonb) to authenticated;

-- ==================================================== prune_session_events ===
-- One row per connectivity blip per device is fine for a month and a problem
-- for a year. Ninety days matches `prune_notification_outbox()`.

create or replace function attendance.prune_session_events(
  p_keep_days integer default 90
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_removed integer;
begin
  delete from attendance.session_events
   where occurred_at < now() - make_interval(days => greatest(1, p_keep_days));

  get diagnostics v_removed = row_count;
  return v_removed;
end;
$fn$;

comment on function attendance.prune_session_events(integer) is
  'Drops session events older than the retention window. Scheduled beside the other pruners.';

revoke all on function attendance.prune_session_events(integer) from public, anon, authenticated;

-- The other pruners already run daily; this joins them rather than adding a
-- schedule of its own.
select cron.schedule(
  'prune-session-events',
  '25 4 * * *',
  $cron$select attendance.prune_session_events();$cron$
)
where not exists (
  select 1 from cron.job where jobname = 'prune-session-events'
);

-- ================================================== employee_session_events ===
-- The trail under one person, for whoever may see them.
--
-- `SECURITY INVOKER`, like every read here: the policy on the table is what
-- decides whose events come back, and a definer version would have to
-- reimplement `can_view_employee()` and could get it wrong quietly.

create or replace function public.employee_session_events(
  p_employee_id uuid,
  p_from        date    default null,
  p_to          date    default null,
  p_limit       integer default 200
)
returns table (
  id                 uuid,
  session_id         uuid,
  kind               text,
  occurred_at        timestamptz,
  client_reported_at timestamptz,
  detail             jsonb
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select e.id, e.session_id, e.kind, e.occurred_at, e.client_reported_at, e.detail
    from attendance.session_events e
   where e.employee_id = p_employee_id
     and (p_from is null or e.occurred_at >= p_from::timestamptz)
     and (p_to   is null or e.occurred_at <  (p_to + 1)::timestamptz)
   order by e.occurred_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$fn$;

comment on function public.employee_session_events(uuid, date, date, integer) is
  'One person connectivity and visibility trail, newest first. INVOKER: the policy on session_events decides who may read whom.';

revoke all     on function public.employee_session_events(uuid, date, date, integer) from public, anon;
grant  execute on function public.employee_session_events(uuid, date, date, integer) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. The writer elevates and both readers do not.
--   select p.proname,
--          case p.prosecdef when true then 'definer' else 'invoker' end as security
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('report_session_event', 'employee_session_events');
--   -- Expected: report_session_event definer, employee_session_events invoker.
--
--   -- 2. The client cannot write the table directly.
--   select privilege_type from information_schema.role_table_grants
--    where grantee = 'authenticated' and table_schema = 'attendance'
--      and table_name = 'session_events';
--   -- Expected: SELECT only.
--
--   -- 3. The pruner is scheduled.
--   select jobname, schedule from cron.job where jobname = 'prune-session-events';
