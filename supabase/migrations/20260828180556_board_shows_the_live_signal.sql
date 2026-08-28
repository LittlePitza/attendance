-- Say on the Equipo board whether an open workday is still reporting.
--
-- `team_day()` has always returned `last_heartbeat` and no screen ever drew it,
-- so a laptop that died at 11:20 looked exactly like somebody working: state
-- `working`, counter advancing, nothing said otherwise until `no_connection`
-- appeared twenty minutes later in a different tab. The signal was in the
-- payload the whole time; what was missing was one resolved answer to "is this
-- still reporting?".
--
-- That answer is a judgement, so it is resolved here rather than in the browser
-- -- the same reason the board never works out who was late. Two functions,
-- split the way `internal.week_start()` is split from `internal.week_start_dow()`
-- and for the same reason: the resolver reads a table, so it is `stable` and
-- runs once per row through a lateral; the banding is `immutable` and a single
-- expression, so the planner inlines it.

-- ================================================ internal.signal_lost_after ===
-- `SECURITY DEFINER`, like `internal.resolve_schedule()` and
-- `internal.time_zone_of()`, so `attendance.alert_rules` stays unreadable to
-- anybody the `alert_rules_read` policy excludes while an invoker function can
-- still resolve one number from it. It returns that number and nothing else:
-- granting `internal.alert_rule()` to `authenticated` would have published
-- `recipients` to every signed-in employee, which the policy exists to prevent.

create or replace function internal.signal_lost_after(p_department_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  -- Department over global over the evaluator's own default, which is the
  -- resolution `attendance.evaluate_alerts()` already performs. A missing row is
  -- not a disabled rule; it falls back to the default, exactly as it does there.
  --
  -- `active` is deliberately not consulted. Switching the alert off says "do not
  -- tell me about this", not "stop measuring": the board reports what the signal
  -- is doing and the rule governs whether that is worth raising. A department
  -- with the alert off still gets a truthful indicator.
  select coalesce(
    (select r.threshold_minutes
       from attendance.alert_rules r
      where r.kind = 'no_connection'
        and (r.department_id = p_department_id or r.department_id is null)
      order by case when r.department_id is not null then 1 else 2 end
      limit 1),
    20);
$fn$;

comment on function internal.signal_lost_after(uuid) is
  'Minutes of silence after which a workday counts as no longer reporting: department, then global, then the evaluator default of twenty. Ignores `active`, which governs the alert rather than the measurement.';

revoke all     on function internal.signal_lost_after(uuid) from public, anon;
grant  execute on function internal.signal_lost_after(uuid) to authenticated;

-- ===================================================== internal.signal_state ===

create or replace function internal.signal_state(
  p_seconds_since      integer,
  p_lost_after_minutes integer
)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_seconds_since is null or p_lost_after_minutes is null then null

    -- The same boundary `no_connection` fires on, so the board and the alert can
    -- never give two answers about one silence.
    when p_seconds_since >= p_lost_after_minutes * 60 then 'lost'

    -- Ten minutes: two of the PWA's five-minute beats. One missed beat is
    -- jitter, or a browser throttling a timer in a window that has been in the
    -- background all afternoon -- which is how this application is actually
    -- left open -- and not a machine that went away. `least` is what stops the
    -- two bands inverting when a department lowers the threshold below ten:
    -- there is simply no room left for `stale`, which is correct.
    when p_seconds_since <= least(600, p_lost_after_minutes * 60) then 'live'

    else 'stale'
  end;
$fn$;

comment on function internal.signal_state(integer, integer) is
  'Bands silence into live, stale or lost. The lost boundary is the no_connection threshold, so the board and the alert agree; live is two heartbeat intervals.';

revoke all     on function internal.signal_state(integer, integer) from public, anon;
grant  execute on function internal.signal_state(integer, integer) to authenticated;

-- ============================================================= team_day() ===
-- Reissued to add two columns, and a `returns table` cannot be widened in
-- place: the signature is the return type, so this is a drop and a recreate.
-- The drop is why the grant is reissued below -- it goes with the old function.

drop function if exists public.team_day(date);

create or replace function public.team_day(p_date date default null)
returns table (
  employee_id    uuid,
  employee_name  text,
  department     text,
  work_date      date,
  state          text,
  opened_at      timestamptz,
  closed_at      timestamptz,
  worked_seconds integer,
  break_seconds  integer,
  last_heartbeat timestamptz,
  has_offline    boolean,
  needs_review   boolean,
  entry_expected time,
  exit_expected  time,
  -- Whether this person has an account, and so whether they could have punched
  -- at all. The Equipo board shows only those who could; Expedientes marks the
  -- ones who could not, because a dossier that hid them would make a person the
  -- system has never been able to see look like a person with nothing to show.
  has_account    boolean,
  -- Both null unless the workday is open. The PWA only beats while it is, so
  -- for a day that never started or already finished there is no silence to
  -- measure -- and a column that read `lost` for everybody who went home would
  -- be reporting the close of business as a fault.
  seconds_since_signal integer,
  connection           text
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_date date;
begin
  -- Resolved in the caller's own zone: a board is read by one person, in one
  -- place, and a date that shifted per row would be unreadable.
  v_date := coalesce(
    p_date,
    (now() at time zone coalesce(
      internal.time_zone_of(internal.caller_employee_id()),
      'America/Mexico_City'))::date);

  return query
    select e.id,
           e.nombre,
           d.name,
           v_date,
           coalesce(w.state, 'not_started'),
           w.opened_at,
           w.closed_at,
           coalesce(w.worked_seconds, 0),
           coalesce(w.break_seconds, 0),
           w.last_heartbeat,
           coalesce(w.has_offline, false),
           coalesce(w.needs_review, false),
           s.entry_expected,
           s.exit_expected,
           e.auth_user_id is not null,
           sig.seconds_since,
           internal.signal_state(sig.seconds_since, sig.lost_after)
      from public.empleados e
      left join public.departments d on d.id = e.department_id
      left join attendance.workdays w
             on w.employee_id = e.id
            and w.work_date   = v_date
      left join lateral internal.resolve_schedule(e.id, v_date) s on true
      left join lateral (
        select
          -- A day opens before its first beat is due, so the opening hour is
          -- the first signal. Without that fallback every workday would read
          -- `lost` for its first five minutes. `evaluate_alerts()` takes the
          -- same fallback, for the same reason.
          --
          -- `on_break` is measured too. It describes the signal, not whether
          -- the silence is anybody's business: the alert deliberately ignores a
          -- break, because closing the laptop is what a break is for, and that
          -- judgement stays where it already lives.
          case when w.state in ('working', 'on_break')
               then greatest(0, extract(epoch from
                      (now() - coalesce(w.last_heartbeat, w.opened_at)))::integer)
          end as seconds_since,
          case when w.state in ('working', 'on_break')
               then internal.signal_lost_after(e.department_id)
          end as lost_after
      ) sig on true
     where e.estado = 'activo'
     order by e.nombre;
end;
$fn$;

comment on function public.team_day(date) is
  'Every active employee the caller may see, with their state on a given date, whether they have an account at all, and whether an open workday is still reporting. Scope comes from RLS, not from a role check written here. The row set is deliberately not filtered on has_account: three screens read this, and only one of them wants the short list.';

revoke all     on function public.team_day(date) from public, anon;
grant  execute on function public.team_day(date) to authenticated;
