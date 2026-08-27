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
--
-- Three of these are here because public.save_employee() and
-- public.retire_employee() would otherwise pass locally and fail in production:
--
--   * `unique (correo)` is what the duplicate-address refusal is written
--     against. Without it a suite proving somebody cannot take a colleague's
--     address proves only that this file forgot the constraint.
--   * `check (estado in ('activo', 'baja'))` is the whole reason "delete" is
--     spelled baja. A fixture that accepted any string would let a writer
--     invent a third state nothing else in the system reads.
--   * `extension` exists so the columns save_employee() deliberately leaves
--     alone are here to be left alone. There is no `updated_at`: production has
--     none on this table, and a fixture that grew one would make a writer
--     touching it look correct.
create table public.empleados (
  id           uuid        primary key default gen_random_uuid(),
  nombre       text        not null,
  correo       text        not null unique,
  puesto       text,
  departamento text,
  extension    text,
  estado       text        not null default 'activo'
    check (estado in ('activo', 'baja')),
  created_at   timestamptz not null default now()
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
