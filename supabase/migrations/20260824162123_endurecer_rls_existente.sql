-- 0003_endurecer_rls_existente.sql
--
-- REQUISITO BLOQUEANTE. Debe aplicarse ANTES de crear las 31 cuentas de empleado.
--
-- El problema encontrado:
-- las 19 tablas de public tienen RLS activo, pero las 19 politicas son
-- identicas y totalmente permisivas:
--
--     FOR ALL TO authenticated USING (true) WITH CHECK (true)
--
-- Es decir, cualquier cuenta autenticada puede leer, insertar, modificar y
-- borrar toda fila de toda tabla. Hoy no causa dano porque existe una sola
-- cuenta. En el momento en que el checador cree las 31 cuentas de empleado,
-- cada empleado tendria acceso total, desde el navegador y por la API REST
-- autogenerada, a tickets, inventario, facturas, caja chica y personal.
--
-- Los advisors de Supabase no lo detectan: el linter verifica que RLS este
-- ENCENDIDO, no que las politicas sean RESTRICTIVAS.
--
-- El arreglo es deliberadamente minimo. Las tablas de la mesa de ayuda pasan a
-- ser exclusivas de admin, que es EXACTAMENTE el acceso efectivo de hoy (la
-- unica cuenta quedo como admin en 0002). Para la cuenta actual no cambia nada;
-- para las cuentas nuevas se cierra todo. No se amplia ningun permiso.
--
-- Nota de rendimiento: cada llamada a rol_actual() va envuelta en (select ...).
-- Asi Postgres la evalua una vez por sentencia y no una vez por fila, que es la
-- causa clasica de politicas RLS lentas.

-- --------------------------------------------- mesa de ayuda: solo admin (18) ---

do $do$
declare
  v_tabla  text;
  v_tablas text[] := array[
    'equipos', 'mantenimientos', 'tickets', 'ticket_eventos', 'config_correo',
    'responsivas', 'plantillas_responsiva', 'campos_inventario', 'proveedores',
    'facturas', 'caja_movimientos', 'servicios', 'incidentes', 'proyectos',
    'tareas', 'solicitudes_compra', 'solicitud_opciones', 'solicitud_enlaces'
  ];
begin
  foreach v_tabla in array v_tablas loop
    -- Quita la politica permisiva original.
    execute format('drop policy if exists %I on public.%I',
                   v_tabla || '_autenticados', v_tabla);

    -- Idempotencia: permite reaplicar la migracion sin conflicto.
    execute format('drop policy if exists %I on public.%I',
                   v_tabla || '_solo_admin', v_tabla);

    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using ((select public.rol_actual()) = ''admin'') '
      'with check ((select public.rol_actual()) = ''admin'')',
      v_tabla || '_solo_admin', v_tabla);
  end loop;

  raise notice 'Endurecidas % tablas de la mesa de ayuda a solo admin.',
    array_length(v_tablas, 1);
end
$do$;

-- ----------------------------------------------------- empleados: por alcance ---
-- Esta tabla si la necesita el checador: RH ve a todos, el jefe ve su area y
-- cada persona se ve a si misma. Varias politicas SELECT permisivas se combinan
-- con OR, que es justo lo que se busca aqui.

drop policy if exists empleados_autenticados    on public.empleados;
drop policy if exists empleados_ver_el_propio   on public.empleados;
drop policy if exists empleados_jefe_ve_su_area on public.empleados;
drop policy if exists empleados_rh_admin_todo   on public.empleados;

create policy empleados_ver_el_propio
  on public.empleados
  for select to authenticated
  using (auth_user_id = auth.uid());

create policy empleados_jefe_ve_su_area
  on public.empleados
  for select to authenticated
  using (
        (select public.rol_actual()) = 'jefe'
    and departamento_id is not null
    and departamento_id = (select public.departamento_actual())
  );

create policy empleados_rh_admin_todo
  on public.empleados
  for all to authenticated
  using      ((select public.rol_actual()) in ('rh', 'admin'))
  with check ((select public.rol_actual()) in ('rh', 'admin'));

-- ------------------------------------------------ departamentos: lectura libre ---
-- Los nombres de departamento no son dato sensible y la interfaz los necesita
-- para pintar cualquier pantalla. Escribirlos es otra cosa.

drop policy if exists departamentos_lectura       on public.departamentos;
drop policy if exists departamentos_rh_admin_todo on public.departamentos;

create policy departamentos_lectura
  on public.departamentos
  for select to authenticated
  using (true);

create policy departamentos_rh_admin_todo
  on public.departamentos
  for all to authenticated
  using      ((select public.rol_actual()) in ('rh', 'admin'))
  with check ((select public.rol_actual()) in ('rh', 'admin'));

grant insert, update, delete on public.departamentos to authenticated;

-- ------------------------------------------------------------------ pendiente ---
-- public.config_correo guarda smtp_pass, azure_client_secret y
-- oauth_refresh_token en TEXTO PLANO. Con estas politicas solo admin los lee,
-- pero siguen viajando al navegador y apareciendo en cualquier respaldo.
--
-- El arreglo correcto es moverlos a Vault (planeado para la semana 2). Existe
-- un paso intermedio: revocar la LECTURA de esas columnas a authenticated,
-- dejando la escritura, para volverlos campos de solo-escritura. NO se aplica
-- aqui porque si la interfaz actual hace "select *" sobre la tabla, dejaria de
-- funcionar. Requiere revisar ese codigo primero.
--
--   revoke select (smtp_pass, azure_client_secret, oauth_refresh_token)
--     on public.config_correo from authenticated;

-- ----------------------------------------------------------- como verificarlo ---
--   -- 1. No debe quedar ninguna politica permisiva:
--   select tablename, policyname, cmd, qual
--     from pg_policies
--    where schemaname = 'public' and qual = 'true' and cmd = 'ALL';
--   -- Esperado: 0 filas.
--
--   -- 2. La cuenta actual sigue siendo admin:
--   select rol from public.usuarios_rol;
--   -- Esperado: admin
