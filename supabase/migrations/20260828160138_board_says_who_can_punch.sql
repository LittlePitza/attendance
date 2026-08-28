-- =============================================================================
-- The board says who can actually punch.
--
-- Thirty-two people are active and nine have an account. The other twenty-three
-- have no way to clock in, so the board listed them at `not_started` all day,
-- every day -- twenty-three rows that look like absence and are nothing of the
-- kind. It is the same observation the report already acts on, in its own words:
-- somebody who cannot punch cannot be late.
--
-- **The row set does not shrink, and that is the whole design decision.**
-- `team_day()` has three consumers, not one: the Equipo board, the Expedientes
-- person picker and the Revisión list. Filtering here would answer the question
-- that was asked about the board by silently removing twenty-three people from
-- two screens nobody asked about -- and Expedientes exists precisely to show
-- what the record holds about one person, including the person whose record is
-- "no account, therefore nothing". So the function reports the fact and each
-- screen decides what to draw with it.
--
-- That is not the client deciding a rule. Whether somebody can punch is decided
-- here, once, from the same column `evaluate_alerts()` and `attendance_report()`
-- read; which rows a screen paints is presentation, and the board already
-- filters by name, state and department without anybody calling that a business
-- rule.
--
-- **The board has to say what it is not showing.** Twenty-three people
-- disappearing without trace is how a roster silently becomes nine people, so
-- the count is on screen and one press brings them back -- the same treatment
-- the three alert kinds the board hides already get.
--
-- What this deliberately does not change: `estado = 'activo'` stays. A retired
-- person who worked this morning is still absent from the board, which the
-- report handles differently -- it keeps anybody with a workday in the window.
-- Widening the board to match is a separate change with its own argument, and
-- this one is about narrowing.
-- =============================================================================

-- ============================================================= team_day() ===
-- Reissued to add one column, and a `returns table` cannot be widened in place:
-- the signature is the return type, so this is a drop and a recreate. The drop
-- is why the grant is reissued below -- it goes with the old function.

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
  has_account    boolean
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
           e.auth_user_id is not null
      from public.empleados e
      left join public.departments d on d.id = e.department_id
      left join attendance.workdays w
             on w.employee_id = e.id
            and w.work_date   = v_date
      left join lateral internal.resolve_schedule(e.id, v_date) s on true
     where e.estado = 'activo'
     order by e.nombre;
end;
$fn$;

comment on function public.team_day(date) is
  'Every active employee the caller may see, with their state on a given date and whether they have an account at all. Scope comes from RLS, not from a role check written here. The row set is deliberately not filtered on has_account: three screens read this, and only one of them wants the short list.';

revoke all     on function public.team_day(date) from public, anon;
grant  execute on function public.team_day(date) to authenticated;

-- ----------------------------------------------------------- how to check it ---
--   -- 1. Everybody is still returned, and the new column separates them.
--   select count(*) filter (where has_account)     as pueden_marcar,
--          count(*) filter (where not has_account) as sin_cuenta,
--          count(*)                                as total
--     from public.team_day();
--
--   -- 2. It agrees with the population the report and the evaluator use.
--   select count(*) from public.empleados
--    where estado = 'activo' and auth_user_id is not null;
--   -- Expected: equal to pueden_marcar above, for an hr or admin caller.
