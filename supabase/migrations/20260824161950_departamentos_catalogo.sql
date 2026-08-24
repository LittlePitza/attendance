-- 0001_departamentos_catalogo.sql
--
-- Normaliza public.empleados.departamento (hoy texto libre) a un catalogo con
-- llave foranea, sin romper la mesa de ayuda que ya esta en produccion.
--
-- Estrategia expand / contract:
--   1. Se crea el catalogo y se siembra con los valores que ya existen.
--   2. Se agrega empleados.departamento_id y se rellena.
--   3. Un trigger de sincronia BIDIRECCIONAL mantiene texto e id de acuerdo,
--      asi el codigo actual (que lee y escribe la columna de texto) sigue
--      funcionando sin tocarlo.
--   4. La columna de texto se elimina despues, en otra migracion, cuando el
--      codigo de tickets ya use departamento_id. En esta no se borra nada.
--
-- Verificado antes de escribir esto: los 15 departamentos existentes no tienen
-- variantes de mayusculas ni espacios, asi que la siembra es limpia. 8 de los 31
-- empleados no tienen departamento; quedan con departamento_id nulo a proposito
-- y el checador los cubre con el horario global (ver migracion de horarios).

-- ---------------------------------------------------------------- catalogo ---

create table if not exists public.departamentos (
  id           uuid        primary key default gen_random_uuid(),
  nombre       text        not null,
  zona_horaria text        not null default 'America/Mexico_City',
  activo       boolean     not null default true,
  created_at   timestamptz not null default now(),
  constraint departamentos_nombre_unico unique (nombre),
  constraint departamentos_nombre_no_vacio check (length(trim(nombre)) > 0)
);

comment on table public.departamentos is
  'Catalogo de departamentos. Fuente de verdad para horarios y alertas del checador.';
comment on column public.departamentos.zona_horaria is
  'Zona IANA con la que se calculan retardos y cortes de dia. Default America/Mexico_City.';

-- La zona horaria no se puede validar con CHECK porque pg_timezone_names no es
-- IMMUTABLE. Se valida con trigger, que es igual de estricto.
create or replace function public.departamentos_validar_zona()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names t where t.name = new.zona_horaria
  ) then
    raise exception 'Zona horaria invalida: %', new.zona_horaria
      using hint = 'Debe ser un nombre IANA, por ejemplo America/Mexico_City';
  end if;
  return new;
end;
$fn$;

drop trigger if exists departamentos_validar_zona on public.departamentos;
create trigger departamentos_validar_zona
  before insert or update of zona_horaria on public.departamentos
  for each row execute function public.departamentos_validar_zona();

-- ------------------------------------------------------------------ siembra ---

insert into public.departamentos (nombre)
select distinct trim(e.departamento)
  from public.empleados e
 where nullif(trim(e.departamento), '') is not null
on conflict (nombre) do nothing;

-- ------------------------------------------------------- columna en empleados ---

alter table public.empleados
  add column if not exists departamento_id uuid
  references public.departamentos (id) on delete set null;

comment on column public.empleados.departamento_id is
  'Llave foranea al catalogo. Se mantiene sincronizada con la columna de texto departamento.';
comment on column public.empleados.departamento is
  'OBSOLETA: se conserva por compatibilidad con la mesa de ayuda. Derivada de departamento_id.';

update public.empleados e
   set departamento_id = d.id
  from public.departamentos d
 where lower(trim(e.departamento)) = lower(trim(d.nombre))
   and e.departamento_id is null;

create index if not exists empleados_departamento_id_idx
  on public.empleados (departamento_id);

-- --------------------------------------------------- sincronia bidireccional ---

create or replace function public.empleados_sincronizar_departamento()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cambio_id    boolean;
  v_cambio_texto boolean;
begin
  v_cambio_id := (tg_op = 'INSERT' and new.departamento_id is not null)
              or (tg_op = 'UPDATE' and new.departamento_id is distinct from old.departamento_id);

  v_cambio_texto := (tg_op = 'INSERT' and new.departamento is not null)
                 or (tg_op = 'UPDATE' and new.departamento is distinct from old.departamento);

  -- El id tiene prioridad: si viene o cambia, el texto se deriva del catalogo.
  if v_cambio_id then
    if new.departamento_id is null then
      new.departamento := null;
    else
      select d.nombre into new.departamento
        from public.departamentos d
       where d.id = new.departamento_id;
    end if;
    return new;
  end if;

  -- Codigo antiguo: solo manda el texto. Se resuelve el id por nombre.
  if v_cambio_texto then
    if nullif(trim(new.departamento), '') is null then
      new.departamento_id := null;
    else
      select d.id into new.departamento_id
        from public.departamentos d
       where lower(trim(d.nombre)) = lower(trim(new.departamento));
      -- Si el nombre no esta en el catalogo se deja el id nulo a proposito:
      -- es mejor un dato incompleto que rechazar el alta de un empleado.
    end if;
  end if;

  return new;
end;
$fn$;

comment on function public.empleados_sincronizar_departamento() is
  'Mantiene empleados.departamento (texto, obsoleta) y departamento_id de acuerdo. El id manda.';

drop trigger if exists empleados_sincronizar_departamento on public.empleados;
create trigger empleados_sincronizar_departamento
  before insert or update on public.empleados
  for each row execute function public.empleados_sincronizar_departamento();

-- ---------------------------------------------------------------------- RLS ---
-- Las politicas de escritura se definen en 0003, donde ya existe rol_actual().

alter table public.departamentos enable row level security;
grant select on public.departamentos to authenticated;
