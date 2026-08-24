-- rename_to_english.sql
--
-- Cambia a ingles todo lo que creo este proyecto: nombres de esquemas, tablas,
-- columnas, funciones, indices, restricciones, disparadores, politicas y los
-- valores tipo enum de las restricciones CHECK.
--
-- Lo que NO se toca, a proposito: las 19 tablas de la mesa de ayuda
-- (empleados, tickets, equipos, config_correo, responsivas, facturas, caja...)
-- ya estan en produccion y las consume ti-hub, que vive en otro repositorio.
-- Renombrarlas rompe ese sistema. Se quedan en espanol hasta que su codigo
-- migre. Por eso a partir de aqui el modelo queda mezclado a proposito:
-- attendance.punches.employee_id apunta a public.empleados.id.
--
-- Los comentarios y la documentacion siguen en espanol: los lee RH.
--
-- ---------------------------------------------------------------------------
-- DOS TECNICAS DISTINTAS, Y LA RAZON DE CADA UNA
--
-- 1. El esquema "checador" se ELIMINA y se recrea en ingles en la migracion
--    siguiente. Se puede porque sus 9 tablas estan vacias (verificado antes de
--    escribir esto). Recrearlo cuesta mucho menos que renombrar mas de cien
--    columnas, y el resultado se lee como si siempre hubiera estado en ingles.
--
-- 2. Las funciones de identidad se RENOMBRAN, nunca se eliminan. 25 politicas
--    RLS -- casi todas sobre tablas de la mesa de ayuda en produccion --
--    dependen de internal.rol_actual(). Las politicas guardan el OID de la
--    funcion, no su nombre, asi que ALTER FUNCTION ... RENAME las deja
--    intactas, y CREATE OR REPLACE cambia el cuerpo conservando el mismo OID.
--    Un DROP + CREATE cambiaria el OID y se llevaria por delante las 25.

-- ================================================ 1. fuera el esquema viejo ===
-- Sus tablas estan vacias. Se recrea en ingles en la migracion siguiente.

drop schema if exists checador cascade;

-- Esta vivia en "interno", asi que el drop del esquema no se la lleva, pero su
-- cuerpo consulta tablas que acaban de desaparecer y las 6 politicas que la
-- usaban se fueron con ellas. Queda huerfana: se elimina y se recrea en ingles
-- junto con el esquema nuevo.
drop function if exists interno.puede_ver_empleado(uuid);

-- ====================================================== 2. esquema interno ===

alter schema interno rename to internal;

comment on schema internal is
  'Funciones internas: identidad y disparadores. Deliberadamente NO expuesto en la API. No agregarlo a Exposed schemas.';

-- Renombre, no reemplazo: conserva el OID y con el las 25 politicas RLS y los
-- disparadores que apuntan a estas funciones.
alter function internal.rol_actual()                         rename to caller_role;
alter function internal.empleado_actual()                    rename to caller_employee_id;
alter function internal.departamento_actual()                rename to caller_department_id;
alter function internal.empleados_sincronizar_departamento() rename to employees_sync_department;
alter function internal.departamentos_validar_zona()         rename to departments_validate_time_zone;

-- ================================================= 3. tablas compartidas ===

alter table public.departamentos rename to departments;

alter table public.departments rename column nombre       to name;
alter table public.departments rename column zona_horaria to time_zone;
alter table public.departments rename column activo       to active;

alter table public.departments
  rename constraint departamentos_nombre_unico to departments_name_unique;
alter table public.departments
  rename constraint departamentos_nombre_no_vacio to departments_name_not_empty;

alter table public.usuarios_rol rename to user_roles;

alter table public.user_roles rename column rol  to role;
alter table public.user_roles rename column nota to note;

-- La columna que este proyecto agrego a una tabla ajena. Es segura de renombrar
-- porque se creo ayer y ti-hub no la conoce: ese codigo sigue usando la columna
-- de texto empleados.departamento, que no se toca.
alter table public.empleados rename column departamento_id to department_id;

alter index public.empleados_departamento_id_idx rename to employees_department_id_idx;
alter index public.empleados_auth_user_id_unico  rename to employees_auth_user_id_unique;

alter trigger empleados_sincronizar_departamento on public.empleados
  rename to employees_sync_department;
alter trigger departamentos_validar_zona on public.departments
  rename to departments_validate_time_zone;
alter trigger usuarios_rol_touch on public.user_roles
  rename to user_roles_touch;

-- ==================================================== 4. valores de los roles ===
-- Los valores de una restriccion CHECK son parte de la estructura, asi que
-- tambien pasan a ingles. Hay que soltar la restriccion antes de traducir los
-- datos y volver a ponerla despues: al reves, el UPDATE la violaria.

alter table public.user_roles drop constraint usuarios_rol_valido;

update public.user_roles
   set role = case role
                when 'empleado' then 'employee'
                when 'jefe'     then 'manager'
                when 'rh'       then 'hr'
                else role            -- admin no cambia
              end;

alter table public.user_roles
  add constraint user_roles_role_valid
  check (role in ('employee', 'manager', 'hr', 'admin'));

comment on table public.user_roles is
  'Rol de cada cuenta de acceso. Fuente unica de verdad para autorizacion.';
comment on column public.user_roles.role is
  'employee: solo lo suyo | manager: su departamento | hr: todos mas ajustes | admin: todo mas configuracion';

-- ============================================= 5. cuerpos de las funciones ===
-- Ahora si: las tablas ya se llaman en ingles, y los cuerpos, que resuelven los
-- nombres en tiempo de ejecucion, tienen que apuntar a los nuevos.
-- CREATE OR REPLACE conserva el OID; las politicas no se enteran.

create or replace function internal.caller_role()
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select ur.role from public.user_roles ur where ur.auth_user_id = auth.uid()),
    'guest'   -- sin rol asignado = sin permisos. Minimo privilegio por defecto.
  );
$fn$;

comment on function internal.caller_role() is
  'Rol de la cuenta que hace la peticion. Devuelve guest si no tiene rol asignado.';

create or replace function internal.caller_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select e.id
    from public.empleados e
   where e.auth_user_id = auth.uid()
     and e.estado = 'activo';
$fn$;

comment on function internal.caller_employee_id() is
  'Empleado activo ligado a la cuenta que hace la peticion. Es el unico origen valido del employee_id: nunca se acepta como parametro.';

create or replace function internal.caller_department_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select e.department_id
    from public.empleados e
   where e.auth_user_id = auth.uid()
     and e.estado = 'activo';
$fn$;

comment on function internal.caller_department_id() is
  'Departamento del solicitante. Base del alcance del rol manager.';

create or replace function internal.employees_sync_department()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cambio_id    boolean;
  v_cambio_texto boolean;
begin
  v_cambio_id := (tg_op = 'INSERT' and new.department_id is not null)
              or (tg_op = 'UPDATE' and new.department_id is distinct from old.department_id);

  v_cambio_texto := (tg_op = 'INSERT' and new.departamento is not null)
                 or (tg_op = 'UPDATE' and new.departamento is distinct from old.departamento);

  -- El id tiene prioridad: si viene o cambia, el texto se deriva del catalogo.
  if v_cambio_id then
    if new.department_id is null then
      new.departamento := null;
    else
      select d.name into new.departamento
        from public.departments d
       where d.id = new.department_id;
    end if;
    return new;
  end if;

  -- Codigo antiguo: solo manda el texto. Se resuelve el id por nombre.
  if v_cambio_texto then
    if nullif(trim(new.departamento), '') is null then
      new.department_id := null;
    else
      select d.id into new.department_id
        from public.departments d
       where lower(trim(d.name)) = lower(trim(new.departamento));
      -- Si el nombre no esta en el catalogo se deja el id nulo a proposito:
      -- es mejor un dato incompleto que rechazar el alta de un empleado.
    end if;
  end if;

  return new;
end;
$fn$;

comment on function internal.employees_sync_department() is
  'Mantiene empleados.departamento (texto, obsoleta) y department_id de acuerdo. El id manda.';

create or replace function internal.departments_validate_time_zone()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names t where t.name = new.time_zone
  ) then
    raise exception 'Zona horaria invalida: %', new.time_zone
      using hint = 'Debe ser un nombre IANA, por ejemplo America/Mexico_City';
  end if;
  return new;
end;
$fn$;

-- El disparador se declaro sobre la columna zona_horaria, que ya no existe con
-- ese nombre. El renombre de columna actualiza la dependencia solo, pero se
-- vuelve a declarar para que el DDL del repositorio diga la verdad.
drop trigger if exists departments_validate_time_zone on public.departments;
create trigger departments_validate_time_zone
  before insert or update of time_zone on public.departments
  for each row execute function internal.departments_validate_time_zone();

-- ====================================== 6. politicas con valores de rol ===
-- Las 22 politicas que solo comparan contra 'admin' no cambian: ese valor no se
-- tradujo. Las tres que mencionan 'rh' o 'jefe' si, porque esos literales estan
-- escritos dentro de la expresion de la politica.

drop policy if exists empleados_jefe_ve_su_area on public.empleados;
create policy employees_manager_reads_own_department
  on public.empleados
  for select to authenticated
  using (
        (select internal.caller_role()) = 'manager'
    and department_id is not null
    and department_id = (select internal.caller_department_id())
  );

drop policy if exists empleados_rh_admin_todo on public.empleados;
create policy employees_hr_admin_all
  on public.empleados
  for all to authenticated
  using      ((select internal.caller_role()) in ('hr', 'admin'))
  with check ((select internal.caller_role()) in ('hr', 'admin'));

drop policy if exists departamentos_rh_admin_todo on public.departments;
create policy departments_hr_admin_all
  on public.departments
  for all to authenticated
  using      ((select internal.caller_role()) in ('hr', 'admin'))
  with check ((select internal.caller_role()) in ('hr', 'admin'));

-- Las demas solo cambian de nombre. ALTER POLICY ... RENAME no toca la
-- expresion, asi que no hay riesgo de alterar el alcance sin querer.
alter policy empleados_ver_el_propio      on public.empleados  rename to employees_read_own;
alter policy departamentos_lectura        on public.departments rename to departments_read;
alter policy usuarios_rol_ver_el_propio   on public.user_roles rename to user_roles_read_own;
alter policy usuarios_rol_admin_lee       on public.user_roles rename to user_roles_admin_read;
alter policy usuarios_rol_admin_escribe   on public.user_roles rename to user_roles_admin_write;

-- Las 18 de la mesa de ayuda: mismo alcance, nombre en ingles. Se renombran en
-- bloque porque son identicas salvo por la tabla.
do $do$
declare
  v_tabla text;
begin
  foreach v_tabla in array array[
    'equipos', 'mantenimientos', 'tickets', 'ticket_eventos', 'config_correo',
    'responsivas', 'plantillas_responsiva', 'campos_inventario', 'proveedores',
    'facturas', 'caja_movimientos', 'servicios', 'incidentes', 'proyectos',
    'tareas', 'solicitudes_compra', 'solicitud_opciones', 'solicitud_enlaces'
  ] loop
    if exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = v_tabla
         and policyname = v_tabla || '_solo_admin'
    ) then
      execute format('alter policy %I on public.%I rename to %I',
                     v_tabla || '_solo_admin', v_tabla, v_tabla || '_admin_only');
    end if;
  end loop;
end
$do$;

-- ============================================== 7. la RPC de identidad ===
-- Cambian los nombres de las columnas que devuelve, y eso es cambiar el tipo de
-- retorno: CREATE OR REPLACE no puede. Aqui si toca DROP + CREATE, y es seguro
-- porque ninguna politica ni disparador depende de esta funcion.

drop function if exists public.mi_perfil();

create or replace function public.my_profile()
returns table (
  role          text,
  employee_id   uuid,
  name          text,
  department_id uuid,
  department    text
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select internal.caller_role() as role,
         e.id                   as employee_id,
         e.nombre               as name,
         e.department_id,
         e.departamento         as department
    from (select 1) as siempre_una_fila
    left join public.empleados e
           on e.auth_user_id = auth.uid()
          and e.estado = 'activo';
$fn$;

comment on function public.my_profile() is
  'Perfil de la cuenta que consulta: su rol y, si la tiene, su ficha de empleado. Devuelve siempre una fila. Unica funcion de identidad publicada en la API.';

revoke all     on function public.my_profile() from public, anon;
grant  execute on function public.my_profile() to authenticated;

-- ----------------------------------------------------------- como verificarlo ---
--   -- 1. Las 25 politicas siguen apuntando a la funcion renombrada:
--   select count(*) from pg_policies
--    where qual::text like '%caller_role%' or with_check::text like '%caller_role%';
--   -- Esperado: 25
--
--   -- 2. No debe quedar rastro de los nombres viejos:
--   select count(*) from pg_policies
--    where qual::text like '%rol_actual%' or qual::text like '%''rh''%';
--   -- Esperado: 0
--
--   -- 3. La cuenta administradora conserva su rol:
--   select role from public.user_roles;
--   -- Esperado: admin
