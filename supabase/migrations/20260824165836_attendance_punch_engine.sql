-- attendance_punch_engine.sql
--
-- El nucleo del sistema: la maquina de estados y el sello de tiempo.
--
-- Decision estructural: el marcaje en linea y la sincronizacion offline
-- comparten UNA sola funcion interna, internal.record_punch(). Si cada camino
-- tuviera su propia copia de la maquina de estados, tarde o temprano
-- divergirian y el offline aceptaria transiciones que el online rechaza. La
-- diferencia entre ambos se reduce a un parametro: quien decide occurred_at.
--
--   public.punch()        -> occurred_at = now() del servidor. source = 'online'
--   public.sync_punches() -> occurred_at = hora estimada del cliente, marcada
--                            como source = 'offline' y sujeta a revision
--
-- Append-only: no basta con no otorgar privilegios, porque el rol de servicio
-- los tiene de todos modos. Se hace cumplir con un disparador que bloquea
-- UPDATE y DELETE incluso para el servicio. La unica excepcion es la purga de
-- coordenadas, y esta acotada a que solo puedan quedar en nulo.
--
-- Los mensajes de error van en espanol a proposito: los lee el empleado en la
-- pantalla de la aplicacion.

-- ================================================= contexto de la peticion ===
-- PostgREST publica los encabezados HTTP en un ajuste de sesion. Fuera de
-- PostgREST no existe, y el contenido puede venir mal formado, asi que ambas
-- funciones tragan el error en lugar de tumbar el marcaje: perder la IP de
-- auditoria es preferible a que un empleado no pueda registrar su entrada.

create or replace function internal.request_ip()
returns inet
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_raw text;
begin
  v_raw := split_part(
    coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ''),
    ',', 1);
  return nullif(trim(v_raw), '')::inet;
exception
  when others then
    return null;
end;
$fn$;

create or replace function internal.request_user_agent()
returns text
language plpgsql
stable
set search_path = ''
as $fn$
begin
  return left(nullif(
    current_setting('request.headers', true)::jsonb ->> 'user-agent', ''), 400);
exception
  when others then
    return null;
end;
$fn$;

revoke all     on function internal.request_ip()         from public;
revoke all     on function internal.request_user_agent() from public;
grant  execute on function internal.request_ip()         to authenticated;
grant  execute on function internal.request_user_agent() to authenticated;

-- ====================================================== resolver el horario ===
-- Precedencia employee > department > global, expresada en el ORDER BY. El
-- nivel global no es un adorno: 8 de los 31 empleados no tienen departamento y
-- sin el se quedarian sin reglas ni alertas.

create or replace function internal.resolve_schedule(p_employee_id uuid, p_date date)
returns attendance.schedules
language sql
stable
security definer
set search_path = ''
as $fn$
  select s.*
    from attendance.schedules s
   where s.active
     and p_date >= s.valid_from
     and (s.valid_until is null or p_date <= s.valid_until)
     and extract(isodow from p_date)::smallint = any (s.days)
     and (
          (s.scope = 'employee'   and s.employee_id = p_employee_id)
       or (s.scope = 'department' and s.department_id = (
             select e.department_id from public.empleados e where e.id = p_employee_id))
       or (s.scope = 'global')
     )
   order by case s.scope
              when 'employee'   then 1
              when 'department' then 2
              else                   3
            end
   limit 1;
$fn$;

comment on function internal.resolve_schedule(uuid, date) is
  'Horario aplicable a un empleado en una fecha. Precedencia: employee > department > global.';

create or replace function internal.time_zone_of(p_employee_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select d.time_zone
       from public.empleados e
       join public.departments d on d.id = e.department_id
      where e.id = p_employee_id),
    'America/Mexico_City');
$fn$;

comment on function internal.time_zone_of(uuid) is
  'Zona horaria del departamento del empleado. Cae al default si no tiene departamento.';

revoke all     on function internal.resolve_schedule(uuid, date) from public;
revoke all     on function internal.time_zone_of(uuid)           from public;
grant  execute on function internal.resolve_schedule(uuid, date) to authenticated;
grant  execute on function internal.time_zone_of(uuid)           to authenticated;

-- ============================================== append-only sobre los punches ===

create or replace function internal.punches_append_only()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'attendance.punches es append-only: los marcajes no se borran'
      using errcode = '42501',
            hint    = 'Registra la correccion en attendance.adjustments';
  end if;

  -- Unica excepcion permitida: la purga de privacidad. Se exige que la bandera
  -- de sesion este puesta Y que el cambio se limite a dejar las coordenadas en
  -- nulo. Cualquier otra modificacion, aun con la bandera puesta, se rechaza.
  if coalesce(current_setting('attendance.geo_purge', true), 'no') = 'yes'
     and new.geo_lat          is null
     and new.geo_lng          is null
     and new.occurred_at       = old.occurred_at
     and new.recorded_at       = old.recorded_at
     and new.kind              = old.kind
     and new.employee_id       = old.employee_id
     and new.workday_id        = old.workday_id
     and new.source            = old.source
     and new.idempotency_key   = old.idempotency_key
  then
    return new;
  end if;

  raise exception 'attendance.punches es append-only: los marcajes no se modifican'
    using errcode = '42501',
          hint    = 'Registra la correccion en attendance.adjustments';
end;
$fn$;

comment on function internal.punches_append_only() is
  'Bloquea UPDATE y DELETE sobre punches, incluso para el rol de servicio. Solo deja pasar la purga de coordenadas.';

drop trigger if exists punches_append_only on attendance.punches;
create trigger punches_append_only
  before update or delete on attendance.punches
  for each row execute function internal.punches_append_only();

-- ================================================ el registrador de marcajes ===
-- Aqui vive la maquina de estados, una sola vez.
--
--   not_started --clock_in--> working <--break_end-- on_break
--                             |    |  \--break_start-----^
--                             |    \--clock_out--> finished
--                             \--------clock_out---------^
--
-- Los contadores se acumulan por diferencia contra el marcaje anterior. Se usa
-- greatest(0, ...) porque un lote offline mal ordenado podria producir una
-- diferencia negativa, y un contador negativo corrompe el reporte de nomina.

create or replace function internal.record_punch(
  p_employee_id        uuid,
  p_kind               text,
  p_occurred_at        timestamptz,
  p_source             text,
  p_key                uuid,
  p_client_reported_at timestamptz default null,
  p_clock_skew_ms      integer     default null,
  p_sync_delay_seconds integer     default null,
  p_device_id          text        default null,
  p_geo_lat            numeric     default null,
  p_geo_lng            numeric     default null,
  p_geo_accuracy_m     numeric     default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_zone         text;
  v_date         date;
  v_schedule     attendance.schedules;
  v_workday      attendance.workdays;
  v_last         attendance.punches;
  v_existing     attendance.punches;
  v_new_state    text;
  v_delta_sec    integer := 0;
  v_punch_id     uuid;
  v_geo_lat      numeric := p_geo_lat;
  v_geo_lng      numeric := p_geo_lng;
  v_geo_accuracy numeric := p_geo_accuracy_m;
  v_geo_purge    date;
  v_needs_review boolean := false;
  v_review_why   text;
  v_has_consent  boolean;
begin
  -- ---------------------------------------------------------- validaciones ---
  if p_kind not in ('clock_in', 'break_start', 'break_end', 'clock_out') then
    raise exception 'Tipo de marcaje invalido: %', p_kind using errcode = '22023';
  end if;

  if p_key is null then
    raise exception 'Falta la clave de idempotencia' using errcode = '22023';
  end if;

  -- ---------------------------------------------------------- idempotencia ---
  -- Una red inestable reintenta. El segundo intento no debe crear otra fila ni
  -- fallar: devuelve el resultado del primero.
  select p.* into v_existing
    from attendance.punches p
   where p.idempotency_key = p_key;

  if found then
    if v_existing.employee_id <> p_employee_id then
      raise exception 'La clave de idempotencia pertenece a otro empleado'
        using errcode = '42501';
    end if;

    select w.* into v_workday
      from attendance.workdays w where w.id = v_existing.workday_id;

    return jsonb_build_object(
      'repeated',       true,
      'punch_id',       v_existing.id,
      'workday_id',     v_workday.id,
      'state',          v_workday.state,
      'occurred_at',    v_existing.occurred_at,
      'worked_seconds', v_workday.worked_seconds,
      'break_seconds',  v_workday.break_seconds
    );
  end if;

  -- ------------------------------------------------------- equipo revocado ---
  if p_device_id is not null and exists (
    select 1 from attendance.devices d
     where d.employee_id = p_employee_id
       and d.device_id   = p_device_id
       and d.revoked_at is not null
  ) then
    raise exception 'Este equipo fue revocado. Contacta a RH.'
      using errcode = '42501';
  end if;

  -- ------------------------------------------- jornada del dia (por su zona) ---
  v_zone := internal.time_zone_of(p_employee_id);
  v_date := (p_occurred_at at time zone v_zone)::date;

  v_schedule := internal.resolve_schedule(p_employee_id, v_date);

  insert into attendance.workdays (employee_id, work_date, time_zone, schedule_id)
  values (p_employee_id, v_date, v_zone, v_schedule.id)
  on conflict (employee_id, work_date) do update
    set schedule_id = coalesce(workdays.schedule_id, excluded.schedule_id)
  returning * into v_workday;

  -- --------------------------------------------------- maquina de estados ---
  select p.* into v_last
    from attendance.punches p
   where p.workday_id = v_workday.id
   order by p.occurred_at desc, p.created_at desc
   limit 1;

  if v_last.id is not null then
    v_delta_sec := greatest(0,
      extract(epoch from (p_occurred_at - v_last.occurred_at))::integer);
  end if;

  case p_kind
    when 'clock_in' then
      if v_workday.state <> 'not_started' then
        raise exception 'Ya registraste tu entrada hoy (estado actual: %)', v_workday.state
          using errcode = '22023';
      end if;
      v_new_state := 'working';

    when 'break_start' then
      if v_workday.state <> 'working' then
        raise exception 'Solo puedes iniciar una pausa mientras trabajas (estado actual: %)', v_workday.state
          using errcode = '22023';
      end if;
      v_new_state := 'on_break';
      v_workday.worked_seconds := v_workday.worked_seconds + v_delta_sec;

    when 'break_end' then
      if v_workday.state <> 'on_break' then
        raise exception 'No tienes una pausa abierta (estado actual: %)', v_workday.state
          using errcode = '22023';
      end if;
      v_new_state := 'working';
      v_workday.break_seconds := v_workday.break_seconds + v_delta_sec;

    when 'clock_out' then
      if v_workday.state not in ('working', 'on_break') then
        raise exception 'No tienes una jornada abierta (estado actual: %)', v_workday.state
          using errcode = '22023';
      end if;
      -- Salir con la pausa abierta la cierra: es un descuido comun y rechazarlo
      -- solo dejaria la jornada colgada.
      if v_workday.state = 'on_break' then
        v_workday.break_seconds := v_workday.break_seconds + v_delta_sec;
      else
        v_workday.worked_seconds := v_workday.worked_seconds + v_delta_sec;
      end if;
      v_new_state := 'finished';
  end case;

  -- ------------------------------------------ geolocalizacion y privacidad ---
  -- Sin consentimiento registrado, las coordenadas se descartan aqui mismo.
  -- Es la unica forma de que la promesa de privacidad sea tecnica y no verbal.
  if v_geo_lat is not null then
    select exists (
      select 1 from attendance.consents c
       where c.employee_id = p_employee_id and c.accepted
    ) into v_has_consent;

    if not v_has_consent then
      v_geo_lat      := null;
      v_geo_lng      := null;
      v_geo_accuracy := null;
    else
      v_geo_purge := (p_occurred_at at time zone v_zone)::date + 90;
    end if;
  end if;

  -- ------------------------------------------------- marcas de desconfianza ---
  if p_source = 'offline' then
    if abs(coalesce(p_clock_skew_ms, 0)) > 120000 then
      v_needs_review := true;
      v_review_why   := format(
        'Reloj del equipo desviado %s segundos respecto al servidor',
        round(abs(p_clock_skew_ms) / 1000.0));
    elsif coalesce(p_sync_delay_seconds, 0) > 43200 then
      v_needs_review := true;
      v_review_why   := format(
        'Marcaje sincronizado %s horas despues de ocurrir',
        round(p_sync_delay_seconds / 3600.0));
    end if;
  end if;

  -- ------------------------------------------------------------- el registro ---
  insert into attendance.punches (
    workday_id, employee_id, kind,
    occurred_at, client_reported_at,
    source, idempotency_key,
    clock_skew_ms, sync_delay_seconds,
    needs_review, review_reason,
    ip, user_agent, device_id,
    geo_lat, geo_lng, geo_accuracy_m, geo_purge_on
  ) values (
    v_workday.id, p_employee_id, p_kind,
    p_occurred_at, p_client_reported_at,
    p_source, p_key,
    p_clock_skew_ms, p_sync_delay_seconds,
    v_needs_review, v_review_why,
    internal.request_ip(), internal.request_user_agent(), p_device_id,
    v_geo_lat, v_geo_lng, v_geo_accuracy, v_geo_purge
  )
  returning id into v_punch_id;

  -- ------------------------------------------------------ estado de la jornada ---
  update attendance.workdays w
     set state          = v_new_state,
         opened_at      = coalesce(w.opened_at,
                            case when p_kind = 'clock_in' then p_occurred_at end),
         closed_at      = case when p_kind = 'clock_out' then p_occurred_at else w.closed_at end,
         worked_seconds = v_workday.worked_seconds,
         break_seconds  = v_workday.break_seconds,
         last_heartbeat = greatest(coalesce(w.last_heartbeat, p_occurred_at), p_occurred_at),
         has_offline    = w.has_offline  or (p_source = 'offline'),
         needs_review   = w.needs_review or v_needs_review
   where w.id = v_workday.id
  returning * into v_workday;

  -- -------------------------------------------------------- equipo conocido ---
  if p_device_id is not null then
    insert into attendance.devices (employee_id, device_id, user_agent)
    values (p_employee_id, p_device_id, internal.request_user_agent())
    on conflict (employee_id, device_id) do update
      set last_seen_at = now(),
          user_agent   = coalesce(excluded.user_agent, devices.user_agent);
  end if;

  return jsonb_build_object(
    'repeated',       false,
    'punch_id',       v_punch_id,
    'workday_id',     v_workday.id,
    'state',          v_workday.state,
    'occurred_at',    p_occurred_at,
    'source',         p_source,
    'needs_review',   v_needs_review,
    'review_reason',  v_review_why,
    'worked_seconds', v_workday.worked_seconds,
    'break_seconds',  v_workday.break_seconds,
    'geo_saved',      v_geo_lat is not null
  );
end;
$fn$;

comment on function internal.record_punch is
  'Maquina de estados de la jornada. Unico lugar donde se escriben marcajes. La usan public.punch y public.sync_punches.';

revoke all on function internal.record_punch(
  uuid, text, timestamptz, text, uuid, timestamptz, integer, integer, text,
  numeric, numeric, numeric) from public, anon, authenticated;

-- ======================================================= la hora del servidor ===
-- El cliente la usa para calcular su desvio antes de quedarse sin conexion.

create or replace function public.server_time()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select jsonb_build_object(
    'utc',      now(),
    'epoch_ms', (extract(epoch from now()) * 1000)::bigint
  );
$fn$;

comment on function public.server_time() is
  'Hora oficial del servidor. El cliente calcula con ella su desvio de reloj.';

revoke all     on function public.server_time() from public, anon;
grant  execute on function public.server_time() to authenticated;

-- ============================================================ marcar en linea ===
-- La identidad SIEMPRE sale del token. Cualquier hora que mande el cliente se
-- guarda en client_reported_at, solo para auditar: la oficial es now().

create or replace function public.punch(
  p_kind               text,
  p_idempotency_key    uuid,
  p_client_reported_at timestamptz default null,
  p_clock_skew_ms      integer     default null,
  p_device_id          text        default null,
  p_geo_lat            numeric     default null,
  p_geo_lng            numeric     default null,
  p_geo_accuracy_m     numeric     default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_employee_id uuid;
begin
  v_employee_id := internal.caller_employee_id();

  if v_employee_id is null then
    raise exception 'Esta cuenta no esta ligada a un empleado activo'
      using errcode = '42501',
            hint    = 'RH debe ligar la cuenta con la ficha del empleado';
  end if;

  return internal.record_punch(
    p_employee_id        => v_employee_id,
    p_kind               => p_kind,
    p_occurred_at        => now(),      -- la hora oficial, no la del cliente
    p_source             => 'online',
    p_key                => p_idempotency_key,
    p_client_reported_at => p_client_reported_at,
    p_clock_skew_ms      => p_clock_skew_ms,
    p_sync_delay_seconds => null,
    p_device_id          => p_device_id,
    p_geo_lat            => p_geo_lat,
    p_geo_lng            => p_geo_lng,
    p_geo_accuracy_m     => p_geo_accuracy_m
  );
end;
$fn$;

comment on function public.punch is
  'Registra un marcaje con la hora del servidor. El empleado se deriva del token: nunca se acepta como parametro.';

revoke all     on function public.punch(text, uuid, timestamptz, integer, text, numeric, numeric, numeric) from public, anon;
grant  execute on function public.punch(text, uuid, timestamptz, integer, text, numeric, numeric, numeric) to authenticated;

-- ================================================ sincronizacion sin conexion ===
-- La PWA encola los marcajes en IndexedDB mientras no hay red y los manda todos
-- juntos al reconectar. Tres decisiones que definen esta funcion:
--
-- 1. ORDEN CRONOLOGICO, no de llegada. El lote se ordena por la hora estimada
--    antes de procesarlo. Si se procesara como viene, un "break_end" que llego
--    primero seria rechazado por la maquina de estados aunque la secuencia real
--    fuera valida.
--
-- 2. UN EVENTO MALO NO TUMBA EL LOTE. Cada evento va en su propio bloque con
--    manejo de excepcion, que en plpgsql es una subtransaccion: si falla, se
--    deshace ese evento y los demas siguen. Devolver un error global obligaria
--    al cliente a reintentar todo y, por idempotencia, los buenos ya estarian
--    dentro. El cliente necesita saber cuales pasaron y cuales no.
--
-- 3. LA HORA ES LA DEL CLIENTE, Y SE DICE. Aqui no hay forma de sellar con el
--    reloj del servidor: el marcaje ocurrio antes. Se acepta la hora estimada,
--    se guarda igual en client_reported_at, se calcula el retraso real contra
--    now() y record_punch decide si merece revision. Es la palabra del
--    empleado, etiquetada como tal.

-- Parseo tolerante. Hace falta porque el ORDER BY que da el orden cronologico
-- se evalua ANTES de entrar al bloque de excepcion de cada evento: un solo
-- occurred_at mal formado abortaria el lote entero con un error de casteo, que
-- es justo lo que la funcion promete no hacer. Devolviendo null, el evento malo
-- se ordena al final y se rechaza solo, sin arrastrar a los demas.

create or replace function internal.parse_timestamptz(p_text text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  return p_text::timestamptz;
exception when others then
  return null;
end;
$fn$;

comment on function internal.parse_timestamptz(text) is
  'Convierte texto a timestamptz devolviendo null si no se puede. Permite ordenar un lote sin que un dato malo lo tumbe.';

revoke all     on function internal.parse_timestamptz(text) from public;
grant  execute on function internal.parse_timestamptz(text) to authenticated;

create or replace function public.sync_punches(p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_employee_id uuid;
  v_event       jsonb;
  v_results     jsonb := '[]'::jsonb;
  v_occurred    timestamptz;
  v_delay       integer;
  v_one         jsonb;
  v_accepted    integer := 0;
  v_rejected    integer := 0;
begin
  v_employee_id := internal.caller_employee_id();

  if v_employee_id is null then
    raise exception 'Esta cuenta no esta ligada a un empleado activo'
      using errcode = '42501',
            hint    = 'RH debe ligar la cuenta con la ficha del empleado';
  end if;

  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'Se espera un arreglo de eventos' using errcode = '22023';
  end if;

  -- Un lote desmedido es senal de error del cliente, no de una jornada real.
  if jsonb_array_length(p_events) > 200 then
    raise exception 'Lote demasiado grande: % eventos (maximo 200)',
      jsonb_array_length(p_events) using errcode = '22023';
  end if;

  for v_event in
    select e
      from jsonb_array_elements(p_events) as e
     order by internal.parse_timestamptz(e ->> 'occurred_at')  -- (1) orden cronologico
              nulls last
  loop
    begin      -- (2) subtransaccion por evento
      v_occurred := internal.parse_timestamptz(v_event ->> 'occurred_at');

      if v_occurred is null then
        raise exception 'occurred_at falta o no es una fecha valida: %',
          coalesce(v_event ->> 'occurred_at', '(ausente)') using errcode = '22023';
      end if;

      -- Un marcaje no puede ocurrir en el futuro. Se tolera un minuto de
      -- holgura por el desfase normal entre relojes.
      if v_occurred > now() + interval '1 minute' then
        raise exception 'La hora del marcaje esta en el futuro' using errcode = '22023';
      end if;

      v_delay := greatest(0, extract(epoch from (now() - v_occurred))::integer);

      v_one := internal.record_punch(
        p_employee_id        => v_employee_id,
        p_kind               => v_event ->> 'kind',
        p_occurred_at        => v_occurred,        -- (3) la del cliente, etiquetada
        p_source             => 'offline',
        p_key                => (v_event ->> 'idempotency_key')::uuid,
        p_client_reported_at => coalesce(
                                  internal.parse_timestamptz(v_event ->> 'client_reported_at'),
                                  v_occurred),
        p_clock_skew_ms      => (v_event ->> 'clock_skew_ms')::integer,
        p_sync_delay_seconds => v_delay,
        p_device_id          => v_event ->> 'device_id',
        p_geo_lat            => (v_event ->> 'geo_lat')::numeric,
        p_geo_lng            => (v_event ->> 'geo_lng')::numeric,
        p_geo_accuracy_m     => (v_event ->> 'geo_accuracy_m')::numeric
      );

      v_accepted := v_accepted + 1;
      v_results  := v_results || jsonb_build_array(
        jsonb_build_object(
          'idempotency_key', v_event ->> 'idempotency_key',
          'accepted',        true,
          'result',          v_one
        ));

    exception when others then
      -- El cliente necesita distinguir "no lo mandes de nuevo, esta mal" de un
      -- fallo temporal. Se devuelve el mensaje tal cual lo escribio la maquina
      -- de estados, que ya esta redactado para leerse en pantalla.
      v_rejected := v_rejected + 1;
      v_results  := v_results || jsonb_build_array(
        jsonb_build_object(
          'idempotency_key', v_event ->> 'idempotency_key',
          'accepted',        false,
          'error',           sqlerrm,
          'code',            sqlstate
        ));
    end;
  end loop;

  return jsonb_build_object(
    'accepted', v_accepted,
    'rejected', v_rejected,
    'events',   v_results
  );
end;
$fn$;

comment on function public.sync_punches(jsonb) is
  'Ingesta de marcajes offline en orden cronologico. Cada evento se procesa aparte: uno invalido no tumba el lote.';

revoke all     on function public.sync_punches(jsonb) from public, anon;
grant  execute on function public.sync_punches(jsonb) to authenticated;

-- ============================================================ senal de vida ===
-- La PWA la llama cada 5 minutos mientras la jornada esta abierta. Alimenta la
-- alerta no_connection: si el ultimo latido es viejo, el evaluador lo nota.
--
-- No crea la jornada: latir sin haber marcado entrada no significa nada, y
-- crearla dejaria filas vacias de todo el que abra la aplicacion sin marcar.

create or replace function public.heartbeat()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_employee_id uuid;
  v_zone        text;
  v_date        date;
  v_workday     attendance.workdays;
begin
  v_employee_id := internal.caller_employee_id();

  if v_employee_id is null then
    raise exception 'Esta cuenta no esta ligada a un empleado activo'
      using errcode = '42501';
  end if;

  v_zone := internal.time_zone_of(v_employee_id);
  v_date := (now() at time zone v_zone)::date;

  update attendance.workdays w
     set last_heartbeat = now()
   where w.employee_id = v_employee_id
     and w.work_date   = v_date
     and w.state in ('working', 'on_break')
  returning * into v_workday;

  return jsonb_build_object(
    'recorded',       v_workday.id is not null,
    'state',          coalesce(v_workday.state, 'not_started'),
    'workday_id',     v_workday.id,
    'worked_seconds', coalesce(v_workday.worked_seconds, 0),
    'break_seconds',  coalesce(v_workday.break_seconds, 0),
    'server',         now()
  );
end;
$fn$;

comment on function public.heartbeat() is
  'Senal de vida de una jornada abierta. Alimenta la alerta no_connection. No crea jornadas.';

revoke all     on function public.heartbeat() from public, anon;
grant  execute on function public.heartbeat() to authenticated;

-- ==================================================== horario global inicial ===
-- Sin este, las 8 personas sin departamento no tendrian reglas. Los valores son
-- un punto de partida razonable que RH ajusta desde la interfaz.

insert into attendance.schedules (
  scope, name, days,
  entry_from, entry_until, entry_expected, exit_expected,
  grace_minutes, break_max_minutes
)
select 'global', 'Jornada general de oficina', '{1,2,3,4,5}'::smallint[],
       '07:00', '10:00', '09:00', '18:00', 10, 60
 where not exists (
   select 1 from attendance.schedules where scope = 'global' and active
 );
