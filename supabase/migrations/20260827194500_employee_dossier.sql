-- Everything the database knows about one person, in one answer.
--
-- The board's box shows a person's figures. **Revisión** shows one day's punches
-- with the access trail under it. Neither answers "show me this person" -- where
-- they have connected from, which machines, every alert whatever its state, what
-- HR has changed, and when the application could not reach the server. Reaching
-- that meant opening four screens and reading a fifth in the SQL editor.
--
-- **It re-derives nothing.** Hours against expected, punctuality, the streak,
-- the week by week and the day by day all arrive by calling
-- `public.employee_summary()`, which is already the thin wrapper over
-- `internal.attendance_summary()` that the employee's own screen and the board's
-- box read. A dossier that computed its own would be a third answer about one
-- person, and the drift would be invisible -- three screens each showing a
-- number and no way to tell which is right. What this adds is the four trails
-- the summary does not carry, and nothing else.
--
-- **The refusal comes for free, and it matters.** `employee_summary()` raises
-- `42501` for somebody the caller may not see, so the dossier does too, rather
-- than returning a shell full of empty arrays. Empty arrays read as "this person
-- has done nothing", which is a very different statement from "not yours to
-- see".
--
-- `SECURITY INVOKER`, like every read in this schema. The policies on
-- `app_sessions`, `devices`, `alerts`, `adjustments`, `punches` and
-- `session_events` are all `can_view_employee()`, so a manager gets their
-- department and HR gets everyone with no role check written here. Made definer,
-- it would answer about anybody to anybody and would have to reimplement six
-- policies to avoid it.

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
               'created_at', a.created_at
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
  'Everything about one person over a range: the summary as employee_summary() decides it, plus sessions, devices, every alert, adjustments, connectivity events and punches. INVOKER, so six policies decide who may read whom.';

revoke all     on function public.employee_dossier(uuid, integer) from public, anon;
grant  execute on function public.employee_dossier(uuid, integer) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. It refuses rather than answering with empty arrays.
--   --    As an employee, about a colleague: expect 42501.
--   select public.employee_dossier('<somebody else>'::uuid, 30);
--
--   -- 2. Its figures are the summary's figures, not a second opinion.
--   select (public.employee_dossier(id, 30) -> 'summary' ->> 'worked_seconds')
--          = (public.employee_summary(id, 30) ->> 'worked_seconds') as agree
--     from public.empleados where auth_user_id is not null limit 1;
--   -- Expected: true.
--
--   -- 3. It invokes.
--   select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'employee_dossier';
--   -- Expected: false.
