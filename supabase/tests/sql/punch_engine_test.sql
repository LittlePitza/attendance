-- punch_engine_test.sql
--
-- Verificacion del motor de marcaje: maquina de estados, sello de tiempo,
-- idempotencia, append-only, privacidad e ingesta offline.
--
-- Como correrlo:
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sql/punch_engine_test.sql
--
-- Se puede correr contra la base real sin miedo: TODO ocurre dentro de una
-- transaccion que termina en ROLLBACK. No queda ni un marcaje, ni una jornada,
-- ni un vinculo de cuenta. Deliberadamente no usa pgTAP: instalarlo publicaria
-- cientos de funciones de prueba como endpoints REST en public, y sin Docker no
-- hay entorno local donde aislarlo.
--
-- Falla ruidosamente: si una sola comprobacion no pasa, lanza una excepcion y
-- psql sale con codigo distinto de cero, que es lo que necesita el CI.

\set ON_ERROR_STOP on

begin;

create temporary table test_results (
  n        serial,
  name     text,
  expected text,
  got      text,
  passed   boolean
) on commit drop;

do $test$
declare
  v_emp1 uuid; v_emp2 uuid; v_uid uuid;
  v_r jsonb; v_k1 uuid := gen_random_uuid();
  v_punch_id uuid; v_count int; v_text text;
  v_client_time timestamptz := '2001-01-01 00:00:00+00';
  v_occurred timestamptz;
  v_original_role text;
begin
  select id into v_uid  from auth.users limit 1;
  select id into v_emp1 from public.empleados where estado = 'activo' order by nombre limit 1;
  select id into v_emp2 from public.empleados where estado = 'activo' and id <> v_emp1
   order by nombre limit 1;

  if v_uid is null or v_emp2 is null then
    raise exception 'Faltan datos base: se necesita al menos 1 cuenta y 2 empleados activos';
  end if;

  -- Se guarda el rol original para devolverlo al final. El ROLLBACK del archivo
  -- ya lo desharia todo, pero esto hace que la prueba tambien sea correcta si
  -- alguien ejecuta el bloque suelto desde el editor SQL del panel, donde no
  -- hay rollback. Dejar la cuenta administradora convertida en 'hr' seria
  -- dejarla sin acceso.
  select role into v_original_role from public.user_roles where auth_user_id = v_uid;

  -- ======================================================== FASE A: en linea ===
  update public.empleados set auth_user_id = v_uid where id = v_emp1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  -- La entrada abre la jornada.
  v_r := public.punch('clock_in', v_k1, v_client_time, null, null, 19.43, -99.13, 12.5);
  insert into test_results(name, expected, got, passed) values
    ('clock_in abre la jornada', 'working', v_r->>'state', v_r->>'state' = 'working');

  -- La hora oficial la pone el servidor, no el cliente.
  v_occurred := (v_r->>'occurred_at')::timestamptz;
  insert into test_results(name, expected, got, passed) values
    ('occurred_at es la hora del servidor', '< 60s de now()',
     round(abs(extract(epoch from (now() - v_occurred))))::text || 's',
     abs(extract(epoch from (now() - v_occurred))) < 60);

  -- La del cliente se guarda aparte, solo para auditar.
  select client_reported_at into v_occurred
    from attendance.punches where idempotency_key = v_k1;
  insert into test_results(name, expected, got, passed) values
    ('la hora del cliente se guarda aparte', v_client_time::text, v_occurred::text,
     v_occurred = v_client_time);

  -- Sin consentimiento registrado, las coordenadas se descartan.
  insert into test_results(name, expected, got, passed) values
    ('geo descartada sin consentimiento', 'false', v_r->>'geo_saved',
     (v_r->>'geo_saved') = 'false');

  -- Transiciones invalidas.
  begin
    v_r := public.punch('clock_in', gen_random_uuid());
    insert into test_results(name, expected, got, passed) values
      ('segunda entrada rechazada', 'error', 'la acepto', false);
  exception when others then
    insert into test_results(name, expected, got, passed) values
      ('segunda entrada rechazada', 'error', left(sqlerrm, 45), true);
  end;

  v_r := public.punch('break_start', gen_random_uuid());
  insert into test_results(name, expected, got, passed) values
    ('break_start pausa la jornada', 'on_break', v_r->>'state', v_r->>'state' = 'on_break');

  begin
    v_r := public.punch('break_start', gen_random_uuid());
    insert into test_results(name, expected, got, passed) values
      ('doble break_start rechazado', 'error', 'lo acepto', false);
  exception when others then
    insert into test_results(name, expected, got, passed) values
      ('doble break_start rechazado', 'error', left(sqlerrm, 45), true);
  end;

  v_r := public.punch('break_end', gen_random_uuid());
  insert into test_results(name, expected, got, passed) values
    ('break_end reanuda', 'working', v_r->>'state', v_r->>'state' = 'working');

  v_r := public.punch('clock_out', gen_random_uuid());
  insert into test_results(name, expected, got, passed) values
    ('clock_out cierra la jornada', 'finished', v_r->>'state', v_r->>'state' = 'finished');

  -- Idempotencia: repetir la misma clave no duplica ni falla.
  v_r := public.punch('clock_in', v_k1);
  select count(*) into v_count from attendance.punches where idempotency_key = v_k1;
  insert into test_results(name, expected, got, passed) values
    ('idempotencia no duplica', 'repeated=true y 1 fila',
     'repeated=' || (v_r->>'repeated') || ' y ' || v_count || ' fila(s)',
     (v_r->>'repeated') = 'true' and v_count = 1);

  -- Append-only: ni el rol de servicio puede modificar un marcaje.
  select id into v_punch_id from attendance.punches where idempotency_key = v_k1;
  begin
    update attendance.punches set occurred_at = now() where id = v_punch_id;
    insert into test_results(name, expected, got, passed) values
      ('UPDATE sobre punches bloqueado', 'error', 'lo permitio', false);
  exception when others then
    insert into test_results(name, expected, got, passed) values
      ('UPDATE sobre punches bloqueado', 'error', left(sqlerrm, 45), true);
  end;

  begin
    delete from attendance.punches where id = v_punch_id;
    insert into test_results(name, expected, got, passed) values
      ('DELETE sobre punches bloqueado', 'error', 'lo permitio', false);
  exception when others then
    insert into test_results(name, expected, got, passed) values
      ('DELETE sobre punches bloqueado', 'error', left(sqlerrm, 45), true);
  end;

  -- ========================================================= FASE B: offline ===
  update public.empleados set auth_user_id = null   where id = v_emp1;
  update public.empleados set auth_user_id = v_uid  where id = v_emp2;

  -- Lote deliberadamente desordenado, con un reloj adelantado y una fecha rota.
  -- Si la funcion no reordenara por hora, la maquina de estados rechazaria
  -- casi todo: que pasen los cuatro es la prueba de que reordena.
  v_r := public.sync_punches(jsonb_build_array(
    jsonb_build_object('kind','break_end',   'occurred_at',(now() - interval '20 min')::text,
                       'idempotency_key', gen_random_uuid()),
    jsonb_build_object('kind','clock_in',    'occurred_at',(now() - interval '40 min')::text,
                       'idempotency_key', gen_random_uuid(), 'clock_skew_ms', 600000),
    jsonb_build_object('kind','clock_out',   'occurred_at',(now() - interval '10 min')::text,
                       'idempotency_key', gen_random_uuid()),
    jsonb_build_object('kind','break_start', 'occurred_at',(now() - interval '30 min')::text,
                       'idempotency_key', gen_random_uuid()),
    jsonb_build_object('kind','clock_in',    'occurred_at','no-es-una-fecha',
                       'idempotency_key', gen_random_uuid())
  ));

  insert into test_results(name, expected, got, passed) values
    ('lote desordenado se ordena solo', '4 aceptados, 1 rechazado',
     (v_r->>'accepted') || ' aceptados, ' || (v_r->>'rejected') || ' rechazado',
     (v_r->>'accepted') = '4' and (v_r->>'rejected') = '1');

  select state into v_text from attendance.workdays where employee_id = v_emp2;
  insert into test_results(name, expected, got, passed) values
    ('estado final tras el lote', 'finished', v_text, v_text = 'finished');

  select count(*) into v_count from attendance.punches
   where employee_id = v_emp2 and source = 'offline';
  insert into test_results(name, expected, got, passed) values
    ('los cuatro quedan marcados como offline', '4', v_count::text, v_count = 4);

  -- Un reloj desviado mas de 2 minutos no se acepta en silencio.
  select count(*) into v_count from attendance.punches
   where employee_id = v_emp2 and needs_review and review_reason like '%Reloj%';
  insert into test_results(name, expected, got, passed) values
    ('reloj alterado marcado para revision', '1', v_count::text, v_count = 1);

  select needs_review::text into v_text from attendance.workdays where employee_id = v_emp2;
  insert into test_results(name, expected, got, passed) values
    ('la jornada hereda needs_review', 'true', v_text, v_text = 'true');

  -- El latido no revive una jornada ya cerrada.
  v_r := public.heartbeat();
  insert into test_results(name, expected, got, passed) values
    ('heartbeat no revive jornada cerrada', 'recorded=false',
     'recorded=' || (v_r->>'recorded'), (v_r->>'recorded') = 'false');

  -- ============================================================ alcance RLS ===
  update public.empleados set auth_user_id = null  where id = v_emp2;
  update public.empleados set auth_user_id = v_uid where id = v_emp1;

  update public.user_roles set role = 'employee' where auth_user_id = v_uid;
  insert into test_results(name, expected, got, passed) values
    ('employee se ve a si mismo', 'true',
     internal.can_view_employee(v_emp1)::text, internal.can_view_employee(v_emp1) is true);
  insert into test_results(name, expected, got, passed) values
    ('employee NO ve a otro', 'false',
     internal.can_view_employee(v_emp2)::text, internal.can_view_employee(v_emp2) is false);

  update public.user_roles set role = 'hr' where auth_user_id = v_uid;
  insert into test_results(name, expected, got, passed) values
    ('hr ve a cualquiera', 'true',
     internal.can_view_employee(v_emp2)::text, internal.can_view_employee(v_emp2) is true);

  perform set_config('request.jwt.claims',
                     json_build_object('sub', gen_random_uuid())::text, true);
  insert into test_results(name, expected, got, passed) values
    ('cuenta sin rol cae en guest', 'guest',
     internal.caller_role(), internal.caller_role() = 'guest');
  insert into test_results(name, expected, got, passed) values
    ('guest no ve a nadie', 'false',
     internal.can_view_employee(v_emp1)::text, internal.can_view_employee(v_emp1) is false);

  -- ========================================================== restauracion ===
  update public.user_roles set role = v_original_role where auth_user_id = v_uid;
  update public.empleados  set auth_user_id = null    where id in (v_emp1, v_emp2);
end
$test$;

-- Informe legible.
\echo ''
\echo '=== Verificacion del motor de marcaje ==='
select n,
       name       as prueba,
       expected   as esperado,
       got        as obtenido,
       case when passed then 'PASA' else '*** FALLA ***' end as veredicto
  from test_results
 order by n;

-- Si algo fallo, revienta con codigo distinto de cero para que el CI lo note.
do $verdict$
declare
  v_failed int;
  v_total  int;
begin
  select count(*) filter (where not passed), count(*) into v_failed, v_total
    from test_results;

  if v_failed > 0 then
    raise exception '% de % comprobaciones fallaron', v_failed, v_total;
  end if;

  raise notice 'Las % comprobaciones pasaron.', v_total;
end
$verdict$;

-- Nada de esto se queda. Ni los marcajes, ni las jornadas, ni el vinculo de
-- cuenta que se uso para simular el token, ni el cambio temporal de rol.
rollback;
