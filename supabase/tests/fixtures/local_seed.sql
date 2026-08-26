-- Synthetic local-only data. Never use production exports as development seed.
-- The Auth row is a placeholder without a password; SQL tests simulate its JWT
-- claims directly and do not need a login-capable account.

insert into auth.users (id, email, raw_user_meta_data)
values (
  '10000000-0000-4000-8000-000000000001',
  'local.admin@example.invalid',
  '{}'::jsonb
);

insert into public.departments (id, name, time_zone, active)
values
  ('20000000-0000-4000-8000-000000000001', 'Local Engineering', 'America/Mexico_City', true),
  ('20000000-0000-4000-8000-000000000002', 'Local Operations',  'America/Mexico_City', true);

-- Two rows, and the suites depend on it being two: read_api_test.sql asserts
-- that HR sees everyone by counting them. A suite that needs a third employee
-- inserts it inside its own transaction.
insert into public.empleados (
  id,
  nombre,
  correo,
  puesto,
  departamento,
  estado,
  department_id,
  auth_user_id
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    'Empleado Local Uno',
    'local.uno@example.invalid',
    'Analista',
    'Local Engineering',
    'activo',
    '20000000-0000-4000-8000-000000000001',
    null
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'Empleado Local Dos',
    'local.dos@example.invalid',
    'Operador',
    'Local Operations',
    'activo',
    '20000000-0000-4000-8000-000000000002',
    null
  );

insert into public.user_roles (auth_user_id, role, note)
values (
  '10000000-0000-4000-8000-000000000001',
  'admin',
  'Synthetic administrator used only by the disposable local test database.'
);
