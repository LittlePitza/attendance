-- Test-only contract for the shared public schema owned by ti-hub.
--
-- This file is never copied into supabase/migrations. The local workspace
-- assembler places it before the Attendance migration history so a disposable
-- database can reproduce the shared objects those migrations depend on.
-- It intentionally models only the columns and policies required by this
-- repository. It contains no production data and is not an authoritative copy
-- of the ti-hub schema.

-- `correo` and `puesto` are part of the contract because public.list_accounts()
-- reads them: the account an employee signs in with is created from the address
-- the help desk maintains here, never from one the client sent. `correo` is
-- `not null` in production and stays `not null` here, so a fixture cannot make
-- the address optional in a way production would not allow.
create table public.empleados (
  id           uuid        primary key default gen_random_uuid(),
  nombre       text        not null,
  correo       text        not null,
  puesto       text,
  departamento text,
  estado       text        not null default 'activo',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.empleados enable row level security;
grant select, insert, update, delete on public.empleados to authenticated;

create policy empleados_autenticados
  on public.empleados
  for all to authenticated
  using (true)
  with check (true);

-- The earliest Attendance migrations replace the original permissive policies
-- on these help-desk tables. Minimal stubs are sufficient to verify that policy
-- hardening and all later Attendance migrations apply cleanly.
do $baseline$
declare
  table_name  text;
  policy_name text;
begin
  foreach table_name in array array[
    'equipos', 'mantenimientos', 'tickets', 'ticket_eventos', 'config_correo',
    'responsivas', 'plantillas_responsiva', 'campos_inventario', 'proveedores',
    'facturas', 'caja_movimientos', 'servicios', 'incidentes', 'proyectos',
    'tareas', 'solicitudes_compra', 'solicitud_opciones', 'solicitud_enlaces'
  ] loop
    execute format(
      'create table public.%I ('
      'id uuid primary key default gen_random_uuid(), '
      'created_at timestamptz not null default now())',
      table_name
    );
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated',
      table_name
    );

    policy_name := case table_name
      when 'plantillas_responsiva' then 'plantillas_autenticados'
      else table_name || '_autenticados'
    end;

    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (true) with check (true)',
      policy_name,
      table_name
    );
  end loop;
end
$baseline$;
