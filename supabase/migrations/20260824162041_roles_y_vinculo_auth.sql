-- 0002_roles_y_vinculo_auth.sql
--
-- Introduce el control de acceso por rol y liga cada empleado con su cuenta.
--
-- Por que los roles NO viven en public.empleados:
-- al planear se asumio empleados.rol, pero los datos reales lo desmienten. La
-- unica cuenta que existe hoy no corresponde a ningun empleado del catalogo
-- (ningun correo de empleados coincide con auth.users). Los roles pertenecen a
-- las CUENTAS, no a las personas, asi que necesitan su propia tabla. Ademas asi
-- una persona puede existir en el catalogo sin tener acceso al sistema, que es
-- el caso de la mayoria hoy.

-- ----------------------------------------------------------- roles de cuenta ---

create table if not exists public.usuarios_rol (
  auth_user_id uuid        primary key references auth.users (id) on delete cascade,
  rol          text        not null,
  nota         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint usuarios_rol_valido
    check (rol in ('empleado', 'jefe', 'rh', 'admin'))
);

comment on table public.usuarios_rol is
  'Rol de cada cuenta de acceso. Fuente unica de verdad para autorizacion.';
comment on column public.usuarios_rol.rol is
  'empleado: solo lo suyo | jefe: su departamento | rh: todos + ajustes | admin: todo + configuracion';

-- Corrige el hallazgo del linter de Supabase (function_search_path_mutable).
-- La funcion solo asigna now() a una columna, asi que fijar search_path no
-- cambia su comportamiento: es el mismo cuerpo con el parametro asegurado.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at = now();
  return new;
end
$fn$;

drop trigger if exists usuarios_rol_touch on public.usuarios_rol;
create trigger usuarios_rol_touch
  before update on public.usuarios_rol
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------- vinculo empleado <-> cuenta ---

alter table public.empleados
  add column if not exists auth_user_id uuid
  references auth.users (id) on delete set null;

comment on column public.empleados.auth_user_id is
  'Cuenta de acceso de esta persona. Nulo mientras no tenga login. Nunca se confia en el correo para identificar: se usa esta llave.';

create unique index if not exists empleados_auth_user_id_unico
  on public.empleados (auth_user_id)
  where auth_user_id is not null;

-- ------------------------------------------------------ funciones de identidad ---
-- STABLE para que Postgres las evalue una vez por sentencia dentro de las
-- politicas RLS. SECURITY DEFINER porque deben poder leer usuarios_rol y
-- empleados sin quedar atrapadas en las politicas de esas mismas tablas
-- (si no, la politica se llamaria a si misma). search_path fijo y nombres
-- calificados: sin eso, un search_path manipulado permite secuestrar la funcion.

create or replace function public.rol_actual()
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select ur.rol from public.usuarios_rol ur where ur.auth_user_id = auth.uid()),
    'invitado'   -- sin rol asignado = sin permisos. Minimo privilegio por defecto.
  );
$fn$;

comment on function public.rol_actual() is
  'Rol de la cuenta que hace la peticion. Devuelve invitado si no tiene rol asignado.';

create or replace function public.empleado_actual()
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

comment on function public.empleado_actual() is
  'Empleado activo ligado a la cuenta que hace la peticion. Es el unico origen valido del empleado_id: nunca se acepta como parametro.';

create or replace function public.departamento_actual()
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select e.departamento_id
    from public.empleados e
   where e.auth_user_id = auth.uid()
     and e.estado = 'activo';
$fn$;

comment on function public.departamento_actual() is
  'Departamento del solicitante. Base del alcance del rol jefe.';

revoke all on function public.rol_actual()          from public, anon;
revoke all on function public.empleado_actual()     from public, anon;
revoke all on function public.departamento_actual() from public, anon;
grant execute on function public.rol_actual()          to authenticated;
grant execute on function public.empleado_actual()     to authenticated;
grant execute on function public.departamento_actual() to authenticated;

-- --------------------------------------------------------------------- siembra ---
-- La cuenta que ya existia opera la mesa de ayuda y hoy tiene acceso total.
-- Se le asigna admin para que 0003 no le quite nada: el endurecimiento debe ser
-- invisible para ella y bloqueante para las 31 cuentas nuevas.

do $do$
declare
  v_total integer;
begin
  select count(*) into v_total from auth.users;

  if v_total = 1 then
    insert into public.usuarios_rol (auth_user_id, rol, nota)
    select u.id, 'admin',
           'Cuenta unica preexistente a la migracion 0002. Conserva el acceso total que ya tenia.'
      from auth.users u
    on conflict (auth_user_id) do nothing;

  elsif v_total > 1 then
    raise notice
      'Hay % cuentas de acceso. No se asigna admin automaticamente. Asigna los roles a mano en public.usuarios_rol ANTES de aplicar 0003, o te quedaras fuera.',
      v_total;
  end if;
end
$do$;

-- ------------------------------------------------------------------------- RLS ---

alter table public.usuarios_rol enable row level security;

grant select on public.usuarios_rol to authenticated;

-- Cada cuenta puede ver su propio rol: la interfaz necesita saber que mostrar.
create policy usuarios_rol_ver_el_propio
  on public.usuarios_rol
  for select to authenticated
  using (auth_user_id = auth.uid());

-- Solo admin administra roles. Se envuelve en (select ...) para que Postgres lo
-- evalue una vez por sentencia y no una vez por fila.
create policy usuarios_rol_admin_lee
  on public.usuarios_rol
  for select to authenticated
  using ((select public.rol_actual()) = 'admin');

create policy usuarios_rol_admin_escribe
  on public.usuarios_rol
  for all to authenticated
  using ((select public.rol_actual()) = 'admin')
  with check ((select public.rol_actual()) = 'admin');

grant insert, update, delete on public.usuarios_rol to authenticated;
