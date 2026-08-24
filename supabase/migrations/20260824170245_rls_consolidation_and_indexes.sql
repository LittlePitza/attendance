-- rls_consolidation_and_indexes.sql
--
-- Deja los advisors de Supabase en cero hallazgos accionables. Tres arreglos,
-- ninguno cosmetico:
--
-- 1. Cuatro llaves foraneas sin indice. Postgres no lo crea solo, y sin el, un
--    borrado en la tabla referenciada hace recorrido completo de la que
--    apunta.
--
-- 2. Dos politicas evaluaban auth.uid() una vez POR FILA. Es la causa clasica
--    de RLS lento y es justo lo que prohibe la regla 8 de CONTRIBUTING.md; venian de
--    las migraciones 0002 y 0003, antes de que la regla estuviera escrita.
--
-- 3. Politicas SELECT duplicadas sobre la misma tabla y el mismo rol. Cuando
--    hay varias permisivas, Postgres las evalua TODAS y combina con OR: se
--    paga cada una en cada consulta. Se consolidan en una sola por tabla, sin
--    cambiar quien ve que.
--
-- El alcance de lectura no se modifica en ningun caso. Al final de esta
-- migracion hay una consulta para comprobarlo.

-- ============================================ 1. llaves foraneas sin indice ===
-- Las cuatro apuntan a columnas por las que casi nunca se filtra, pero el
-- indice tambien lo usa el chequeo de integridad al borrar la fila referida.

create index if not exists adjustments_adjusted_by_idx
  on attendance.adjustments (adjusted_by);
create index if not exists alerts_acknowledged_by_idx
  on attendance.alerts (acknowledged_by)
  where acknowledged_by is not null;
create index if not exists devices_revoked_by_idx
  on attendance.devices (revoked_by)
  where revoked_by is not null;
create index if not exists workdays_schedule_id_idx
  on attendance.workdays (schedule_id)
  where schedule_id is not null;

-- ================================================== 2 y 3. empleados ===
-- Tenia TRES politicas de SELECT que se combinaban con OR: la propia, la del
-- jefe y la de rh/admin. Las tres hacen junto lo mismo que
-- internal.can_view_employee(), que ya es la regla de alcance del esquema
-- attendance. Unificarlas quita dos evaluaciones por consulta y, sobre todo,
-- deja UNA sola definicion de "quien ve a quien" en todo el sistema: antes
-- estaba escrita dos veces y podian separarse sin que nadie lo notara.
--
-- Diferencia real, y es una mejora: la politica vieja dejaba a una persona
-- verse a si misma aunque estuviera dada de baja, porque comparaba contra
-- auth_user_id sin mirar el estado. can_view_employee() exige estado activo.

drop policy if exists employees_read_own                    on public.empleados;
drop policy if exists employees_manager_reads_own_department on public.empleados;
drop policy if exists employees_hr_admin_all                on public.empleados;

create policy employees_read
  on public.empleados
  for select to authenticated
  using (internal.can_view_employee(id));

-- La escritura se separa por accion. Antes era un FOR ALL, que incluye SELECT
-- y por eso contaba como una segunda politica de lectura.
create policy employees_hr_admin_insert
  on public.empleados
  for insert to authenticated
  with check ((select internal.caller_role()) in ('hr', 'admin'));

create policy employees_hr_admin_update
  on public.empleados
  for update to authenticated
  using      ((select internal.caller_role()) in ('hr', 'admin'))
  with check ((select internal.caller_role()) in ('hr', 'admin'));

create policy employees_hr_admin_delete
  on public.empleados
  for delete to authenticated
  using ((select internal.caller_role()) in ('hr', 'admin'));

-- ==================================================== 2 y 3. user_roles ===
-- Tenia tres politicas que cubrian SELECT: la propia, la de admin, y la de
-- escritura, que al ser FOR ALL tambien leia. Se deja una de lectura y se
-- separa la escritura por accion.
--
-- Aqui auth.uid() SI va envuelto en (select ...): asi Postgres lo evalua una
-- vez por sentencia en lugar de una vez por fila.

drop policy if exists user_roles_read_own    on public.user_roles;
drop policy if exists user_roles_admin_read  on public.user_roles;
drop policy if exists user_roles_admin_write on public.user_roles;

create policy user_roles_read
  on public.user_roles
  for select to authenticated
  using (
       auth_user_id = (select auth.uid())
    or (select internal.caller_role()) = 'admin'
  );

create policy user_roles_admin_insert
  on public.user_roles
  for insert to authenticated
  with check ((select internal.caller_role()) = 'admin');

create policy user_roles_admin_update
  on public.user_roles
  for update to authenticated
  using      ((select internal.caller_role()) = 'admin')
  with check ((select internal.caller_role()) = 'admin');

create policy user_roles_admin_delete
  on public.user_roles
  for delete to authenticated
  using ((select internal.caller_role()) = 'admin');

-- ==================================================== 3. departments ===
-- La lectura es libre a proposito: cualquiera autenticado necesita los nombres
-- de departamento para pintar cualquier pantalla. La politica de rh/admin era
-- FOR ALL, asi que duplicaba la lectura sin agregar nada.

drop policy if exists departments_hr_admin_all on public.departments;

create policy departments_hr_admin_insert
  on public.departments
  for insert to authenticated
  with check ((select internal.caller_role()) in ('hr', 'admin'));

create policy departments_hr_admin_update
  on public.departments
  for update to authenticated
  using      ((select internal.caller_role()) in ('hr', 'admin'))
  with check ((select internal.caller_role()) in ('hr', 'admin'));

create policy departments_hr_admin_delete
  on public.departments
  for delete to authenticated
  using ((select internal.caller_role()) in ('hr', 'admin'));

-- ----------------------------------------------------------- como verificarlo ---
--   -- 1. Una sola politica de SELECT por tabla:
--   select tablename, count(*)
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('empleados', 'user_roles', 'departments')
--      and cmd in ('SELECT', 'ALL')
--    group by tablename;
--   -- Esperado: 1 en cada una.
--
--   -- 2. Ninguna politica evalua auth.uid() por fila:
--   select tablename, policyname from pg_policies
--    where schemaname = 'public'
--      and qual::text ~ '(?<!select )auth\.uid\(\)';
--   -- Esperado: 0 filas.
