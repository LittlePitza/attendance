-- attendance_schema.sql
--
-- Las tablas del checador, en su propio esquema. Reemplaza al esquema
-- "checador" que se elimino en la migracion anterior: mismo modelo, nombres en
-- ingles. Los comentarios siguen en espanol porque los lee RH.
--
-- El esquema "attendance" NO se expone en la API. El cliente no toca estas
-- tablas: lee por vistas y escribe por funciones. Aun asi todas llevan RLS,
-- porque un descuido de configuracion no debe convertirse en una fuga.
--
-- Nota sobre el modelo mezclado: employee_id apunta a public.empleados y
-- department_id a public.departments. La primera sigue en espanol porque la
-- consume ti-hub en produccion; no es incoherencia, es la frontera con el
-- sistema que ya existia.

create schema if not exists attendance;

comment on schema attendance is
  'Tablas del checador de asistencia. No expuesto en la API: se lee por vistas y se escribe por funciones.';

grant usage on schema attendance to authenticated, service_role;

-- ============================================================== schedules ===
-- Precedencia al resolver el horario de una persona: employee > department >
-- global. El nivel global existe porque 8 de los 31 empleados no tienen
-- departamento asignado y sin el se quedarian sin reglas ni alertas.

create table if not exists attendance.schedules (
  id                 uuid        primary key default gen_random_uuid(),
  scope              text        not null,
  department_id      uuid        references public.departments (id) on delete cascade,
  employee_id        uuid        references public.empleados (id)   on delete cascade,
  name               text        not null,
  days               smallint[]  not null default '{1,2,3,4,5}',
  entry_from         time        not null,
  entry_until        time        not null,
  entry_expected     time        not null,
  exit_expected      time        not null,
  grace_minutes      integer     not null default 10,
  break_max_minutes  integer     not null default 60,
  valid_from         date        not null default current_date,
  valid_until        date,
  active             boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint schedules_scope_valid
    check (scope in ('global', 'department', 'employee')),

  -- Cada alcance exige exactamente las llaves que le corresponden.
  constraint schedules_scope_coherent check (
       (scope = 'global'     and department_id is null     and employee_id is null)
    or (scope = 'department' and department_id is not null and employee_id is null)
    or (scope = 'employee'   and employee_id   is not null and department_id is null)
  ),

  constraint schedules_window_coherent
    check (entry_from <= entry_until),
  constraint schedules_expected_within_window
    check (entry_expected between entry_from and entry_until),
  constraint schedules_exit_after_entry
    check (exit_expected > entry_expected),
  constraint schedules_validity_coherent
    check (valid_until is null or valid_until >= valid_from),
  constraint schedules_grace_reasonable
    check (grace_minutes between 0 and 120),
  constraint schedules_break_reasonable
    check (break_max_minutes between 0 and 480),

  -- Dias ISO: 1 = lunes ... 7 = domingo.
  constraint schedules_days_valid check (
        days <@ array[1,2,3,4,5,6,7]::smallint[]
    and array_length(days, 1) between 1 and 7
  )
);

comment on table attendance.schedules is
  'Ventanas de horario. Precedencia al resolver: employee > department > global.';
comment on column attendance.schedules.days is
  'Dias ISO en que aplica: 1 = lunes ... 7 = domingo.';
comment on column attendance.schedules.entry_from is
  'Antes de esta hora no se espera la entrada. Marcar antes no genera alerta, solo se registra.';
comment on column attendance.schedules.entry_until is
  'Pasada esta hora sin entrada se levanta la alerta missing_entry.';
comment on column attendance.schedules.grace_minutes is
  'Minutos de gracia sobre entry_expected antes de considerar retardo.';

-- Un solo horario vigente por alcance: evita que dos reglas activas se
-- contradigan y que la resolucion dependa del azar.
create unique index if not exists schedules_global_unique
  on attendance.schedules (scope)
  where scope = 'global' and active and valid_until is null;

create unique index if not exists schedules_department_unique
  on attendance.schedules (department_id)
  where scope = 'department' and active and valid_until is null;

create unique index if not exists schedules_employee_unique
  on attendance.schedules (employee_id)
  where scope = 'employee' and active and valid_until is null;

-- =============================================================== workdays ===
-- Una fila por empleado y dia. Es el estado que consulta el tablero, para no
-- recalcular la jornada a partir de los marcajes en cada consulta.

create table if not exists attendance.workdays (
  id              uuid        primary key default gen_random_uuid(),
  employee_id     uuid        not null references public.empleados (id) on delete restrict,
  work_date       date        not null,
  state           text        not null default 'not_started',
  schedule_id     uuid        references attendance.schedules (id) on delete set null,
  time_zone       text        not null default 'America/Mexico_City',
  opened_at       timestamptz,
  closed_at       timestamptz,
  worked_seconds  integer     not null default 0,
  break_seconds   integer     not null default 0,
  last_heartbeat  timestamptz,
  has_offline     boolean     not null default false,
  needs_review    boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint workdays_unique_per_day unique (employee_id, work_date),
  constraint workdays_state_valid
    check (state in ('not_started', 'working', 'on_break', 'finished')),
  constraint workdays_close_after_open
    check (closed_at is null or opened_at is null or closed_at >= opened_at),
  constraint workdays_seconds_not_negative
    check (worked_seconds >= 0 and break_seconds >= 0)
);

comment on table attendance.workdays is
  'Estado de la jornada de cada empleado por dia. Derivada de los marcajes, mantenida por las funciones de marcaje.';
comment on column attendance.workdays.has_offline is
  'Verdadero si algun marcaje del dia llego por sincronizacion. Se muestra en el tablero.';

create index if not exists workdays_date_idx
  on attendance.workdays (work_date desc, employee_id);
create index if not exists workdays_state_idx
  on attendance.workdays (state)
  where state in ('working', 'on_break');
create index if not exists workdays_review_idx
  on attendance.workdays (work_date desc)
  where needs_review;

-- ================================================================ punches ===
-- APPEND-ONLY. No se modifican ni se borran: las correcciones son filas nuevas
-- en attendance.adjustments. Se hace cumplir con un disparador en la migracion
-- del motor, porque revocar privilegios no detiene al rol de servicio.

create table if not exists attendance.punches (
  id                  uuid        primary key default gen_random_uuid(),
  workday_id          uuid        not null references attendance.workdays (id) on delete restrict,
  employee_id         uuid        not null references public.empleados (id) on delete restrict,
  kind                text        not null,

  -- La hora oficial. La pone el servidor, nunca el cliente.
  occurred_at         timestamptz not null,
  recorded_at         timestamptz not null default now(),
  -- Lo que dijo el equipo del empleado. Solo para auditar: jamas es la oficial.
  client_reported_at  timestamptz,

  source              text        not null default 'online',
  idempotency_key     uuid        not null,
  clock_skew_ms       integer,
  sync_delay_seconds  integer,
  needs_review        boolean     not null default false,
  review_reason       text,

  ip                  inet,
  user_agent          text,
  device_id           text,

  geo_lat             numeric(9,6),
  geo_lng             numeric(9,6),
  geo_accuracy_m      numeric(8,2),
  geo_purge_on        date,

  created_at          timestamptz not null default now(),

  constraint punches_kind_valid
    check (kind in ('clock_in', 'break_start', 'break_end', 'clock_out')),
  constraint punches_source_valid
    check (source in ('online', 'offline')),

  -- Una red inestable puede reintentar el mismo marcaje muchas veces.
  constraint punches_idempotency_unique unique (idempotency_key),

  constraint punches_geo_complete
    check ((geo_lat is null) = (geo_lng is null)),
  constraint punches_geo_in_range check (
    geo_lat is null
    or (geo_lat between -90 and 90 and geo_lng between -180 and 180)
  ),
  -- Un marcaje offline sin hora del cliente no se puede ubicar en el tiempo.
  constraint punches_offline_has_time
    check (source = 'online' or client_reported_at is not null),
  constraint punches_review_has_reason
    check (not needs_review or review_reason is not null)
);

comment on table attendance.punches is
  'Registro de marcajes. APPEND-ONLY: no se modifica ni se borra. Las correcciones van en attendance.adjustments.';
comment on column attendance.punches.occurred_at is
  'Hora oficial. En linea la pone now() del servidor; offline es la estimada del cliente y la fila queda marcada.';
comment on column attendance.punches.client_reported_at is
  'Hora que reporto el equipo del empleado. Solo auditoria: nunca es la hora oficial.';
comment on column attendance.punches.clock_skew_ms is
  'Diferencia conocida entre el reloj del equipo y el del servidor al momento de marcar.';
comment on column attendance.punches.geo_purge_on is
  'Fecha en que se borran las coordenadas de esta fila. Retencion de 90 dias.';

create index if not exists punches_employee_time_idx
  on attendance.punches (employee_id, occurred_at desc);
create index if not exists punches_workday_idx
  on attendance.punches (workday_id, occurred_at);
create index if not exists punches_review_idx
  on attendance.punches (occurred_at desc)
  where needs_review;
create index if not exists punches_geo_purge_idx
  on attendance.punches (geo_purge_on)
  where geo_lat is not null;

-- ============================================================ adjustments ===
-- Toda correccion de RH queda aqui, con motivo obligatorio. Es lo que hace
-- defendible el registro: nada se edita en silencio.

create table if not exists attendance.adjustments (
  id           uuid        primary key default gen_random_uuid(),
  punch_id     uuid        references attendance.punches (id) on delete restrict,
  workday_id   uuid        not null references attendance.workdays (id) on delete restrict,
  kind         text        not null,
  old_value    timestamptz,
  new_value    timestamptz,
  reason       text        not null,
  adjusted_by  uuid        not null references auth.users (id) on delete restrict,
  created_at   timestamptz not null default now(),

  constraint adjustments_kind_valid
    check (kind in ('correct_time', 'approve_offline', 'reject_offline',
                    'add_punch', 'void_punch')),
  constraint adjustments_reason_substantial
    check (length(trim(reason)) >= 10)
);

comment on table attendance.adjustments is
  'Bitacora de correcciones de RH sobre marcajes y jornadas. Motivo obligatorio de al menos 10 caracteres.';

create index if not exists adjustments_workday_idx on attendance.adjustments (workday_id, created_at desc);
create index if not exists adjustments_punch_idx   on attendance.adjustments (punch_id);

-- ================================================================= alerts ===

create table if not exists attendance.alerts (
  id               uuid        primary key default gen_random_uuid(),
  employee_id      uuid        not null references public.empleados (id) on delete cascade,
  alert_date       date        not null,
  kind             text        not null,
  severity         text        not null default 'medium',
  details          jsonb       not null default '{}',
  state            text        not null default 'open',
  notified_at      timestamptz,
  acknowledged_by  uuid        references auth.users (id) on delete set null,
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- La clave de la idempotencia: el evaluador corre cada minuto y no debe
  -- inundar a RH con la misma alerta repetida.
  constraint alerts_unique_per_day unique (employee_id, alert_date, kind),

  constraint alerts_kind_valid check (kind in (
    'late_entry', 'missing_entry', 'break_exceeded',
    'missing_exit', 'no_connection', 'review_offline', 'clock_tampered'
  )),
  constraint alerts_severity_valid
    check (severity in ('low', 'medium', 'high')),
  constraint alerts_state_valid
    check (state in ('open', 'acknowledged', 'resolved', 'dismissed'))
);

comment on table attendance.alerts is
  'Alertas para RH. El unico (employee_id, alert_date, kind) hace idempotente al evaluador.';

create index if not exists alerts_open_idx
  on attendance.alerts (alert_date desc, severity)
  where state = 'open';
create index if not exists alerts_unnotified_idx
  on attendance.alerts (created_at)
  where notified_at is null;

-- ============================================================ alert_rules ===
-- Que alertas estan activas y con que umbral, por departamento. Sin fila, se
-- usan los valores por defecto de la funcion evaluadora.

create table if not exists attendance.alert_rules (
  id                 uuid        primary key default gen_random_uuid(),
  department_id      uuid        references public.departments (id) on delete cascade,
  kind               text        not null,
  active             boolean     not null default true,
  threshold_minutes  integer     not null default 15,
  recipients         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint alert_rules_kind_valid check (kind in (
    'late_entry', 'missing_entry', 'break_exceeded',
    'missing_exit', 'no_connection', 'review_offline', 'clock_tampered'
  )),
  constraint alert_rules_threshold_reasonable
    check (threshold_minutes between 0 and 1440)
);

-- department_id nulo = regla global. El indice unico debe tratar el nulo como
-- un valor, cosa que UNIQUE no hace: de ahi los dos indices parciales.
create unique index if not exists alert_rules_per_department
  on attendance.alert_rules (department_id, kind)
  where department_id is not null;
create unique index if not exists alert_rules_global
  on attendance.alert_rules (kind)
  where department_id is null;

comment on column attendance.alert_rules.recipients is
  'Correos adicionales a notificar, separados por coma. Nulo usa los destinos por defecto de config_correo.';

-- ================================================================ devices ===
-- Permite revocar el acceso de un equipo perdido sin tocar la cuenta.

create table if not exists attendance.devices (
  id             uuid        primary key default gen_random_uuid(),
  employee_id    uuid        not null references public.empleados (id) on delete cascade,
  device_id      text        not null,
  user_agent     text,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_by     uuid        references auth.users (id) on delete set null,

  constraint devices_unique unique (employee_id, device_id)
);

comment on table attendance.devices is
  'Equipos desde los que marca cada persona. Revocar aqui bloquea el equipo sin cerrar la cuenta.';

-- =============================================================== consents ===
-- Requisito de la geolocalizacion: consentimiento explicito y registrado, con
-- version del aviso para saber que acepto cada quien.

create table if not exists attendance.consents (
  id              uuid        primary key default gen_random_uuid(),
  employee_id     uuid        not null references public.empleados (id) on delete cascade,
  notice_version  text        not null,
  accepted        boolean     not null,
  accepted_at     timestamptz not null default now(),
  ip              inet,

  constraint consents_unique unique (employee_id, notice_version)
);

comment on table attendance.consents is
  'Consentimiento del aviso de privacidad por persona y version. Requisito para tratar geolocalizacion.';

-- =========================================================== audit_events ===
-- Bitacora general, con la misma forma que public.ticket_eventos para que se
-- lea igual que el resto del proyecto. Aqui cae TODA accion administrativa,
-- incluida cada consulta de coordenadas.

create table if not exists attendance.audit_events (
  id          uuid        primary key default gen_random_uuid(),
  kind        text        not null,
  entity      text        not null,
  entity_id   uuid,
  actor       uuid        references auth.users (id) on delete set null,
  body        text,
  before_data jsonb,
  after_data  jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);

comment on table attendance.audit_events is
  'Bitacora de acciones administrativas del checador, incluida cada consulta de coordenadas.';

create index if not exists audit_events_entity_idx on attendance.audit_events (entity, entity_id, created_at desc);
create index if not exists audit_events_actor_idx  on attendance.audit_events (actor, created_at desc);
create index if not exists audit_events_kind_idx   on attendance.audit_events (kind, created_at desc);

-- ================================================ actualizacion de updated_at ===
-- public.touch_updated_at() ya existia: la creo la mesa de ayuda y la comparten
-- sus tablas. Se reutiliza tal cual.

create trigger schedules_touch    before update on attendance.schedules
  for each row execute function public.touch_updated_at();
create trigger workdays_touch     before update on attendance.workdays
  for each row execute function public.touch_updated_at();
create trigger alerts_touch       before update on attendance.alerts
  for each row execute function public.touch_updated_at();
create trigger alert_rules_touch  before update on attendance.alert_rules
  for each row execute function public.touch_updated_at();

-- ================================================== alcance de visibilidad ===
-- Un solo lugar decide quien puede ver los datos de quien. Tenerlo centralizado
-- evita que cada politica reimplemente la regla y que una se equivoque.

create or replace function internal.can_view_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select case internal.caller_role()
    when 'admin'    then true
    when 'hr'       then true
    when 'manager'  then exists (
                          select 1
                            from public.empleados e
                           where e.id = p_employee_id
                             and e.department_id is not null
                             and e.department_id = internal.caller_department_id()
                        )
    when 'employee' then p_employee_id = internal.caller_employee_id()
    else false   -- guest y cualquier rol futuro no contemplado: sin acceso
  end;
$fn$;

comment on function internal.can_view_employee(uuid) is
  'Unica regla de alcance de visibilidad: admin y hr ven todo, manager su departamento, employee solo lo suyo.';

revoke all     on function internal.can_view_employee(uuid) from public;
grant  execute on function internal.can_view_employee(uuid) to authenticated;

-- ==================================================================== RLS ===
-- SELECT filtrado por RLS para que las vistas con security_invoker funcionen.
-- Nunca INSERT, UPDATE ni DELETE: el unico camino de escritura son las
-- funciones de las migraciones siguientes.

alter table attendance.schedules     enable row level security;
alter table attendance.workdays      enable row level security;
alter table attendance.punches       enable row level security;
alter table attendance.adjustments   enable row level security;
alter table attendance.alerts        enable row level security;
alter table attendance.alert_rules   enable row level security;
alter table attendance.devices       enable row level security;
alter table attendance.consents      enable row level security;
alter table attendance.audit_events  enable row level security;

grant select on attendance.schedules    to authenticated;
grant select on attendance.workdays     to authenticated;
grant select on attendance.adjustments  to authenticated;
grant select on attendance.alerts       to authenticated;
grant select on attendance.alert_rules  to authenticated;
grant select on attendance.devices      to authenticated;
grant select on attendance.consents     to authenticated;
grant select on attendance.audit_events to authenticated;

-- ------------------------------------------------- las coordenadas, aparte ---
-- Aqui NO se otorga SELECT sobre la tabla completa, sino columna por columna,
-- omitiendo geo_lat y geo_lng.
--
-- La diferencia importa: un REVOKE sobre columnas NO cancela un permiso
-- otorgado a nivel de tabla, asi que "grant select on punches" seguido de
-- "revoke select (geo_lat, geo_lng)" dejaria las coordenadas legibles. La unica
-- forma de que el privilegio no exista es no otorgarlo nunca.
--
-- Consecuencia deliberada: un "select *" sobre attendance.punches falla para
-- authenticated. El acceso a las coordenadas es exclusivamente por la funcion
-- auditada de la migracion siguiente, que deja rastro en audit_events.

grant select (
  id, workday_id, employee_id, kind,
  occurred_at, recorded_at, client_reported_at,
  source, idempotency_key, clock_skew_ms, sync_delay_seconds,
  needs_review, review_reason,
  ip, user_agent, device_id,
  geo_accuracy_m, geo_purge_on, created_at
) on attendance.punches to authenticated;

-- Horarios: los ve cualquiera autenticado, porque el empleado necesita saber a
-- que hora se espera que entre. Escribirlos es cosa de hr y admin, y pasa por
-- funciones.
create policy schedules_read on attendance.schedules
  for select to authenticated using (true);

create policy alert_rules_read on attendance.alert_rules
  for select to authenticated
  using ((select internal.caller_role()) in ('manager', 'hr', 'admin'));

-- Datos de personas: alcance segun rol.
create policy workdays_read on attendance.workdays
  for select to authenticated using (internal.can_view_employee(employee_id));

create policy punches_read on attendance.punches
  for select to authenticated using (internal.can_view_employee(employee_id));

create policy alerts_read on attendance.alerts
  for select to authenticated using (internal.can_view_employee(employee_id));

create policy devices_read on attendance.devices
  for select to authenticated using (internal.can_view_employee(employee_id));

create policy consents_read on attendance.consents
  for select to authenticated using (internal.can_view_employee(employee_id));

-- Ajustes: se llega por la jornada, asi que se hereda su alcance.
create policy adjustments_read on attendance.adjustments
  for select to authenticated
  using (exists (
    select 1 from attendance.workdays w
     where w.id = adjustments.workday_id
       and internal.can_view_employee(w.employee_id)
  ));

-- La bitacora solo la ve admin: contiene quien consulto que.
create policy audit_events_read on attendance.audit_events
  for select to authenticated
  using ((select internal.caller_role()) = 'admin');

-- ----------------------------------------------------------- como verificarlo ---
--   -- 1. Ninguna tabla del checador debe tener privilegios de escritura:
--   select table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'attendance' and grantee = 'authenticated'
--      and privilege_type <> 'SELECT';
--   -- Esperado: 0 filas.
--
--   -- 2. Las coordenadas no deben ser legibles por authenticated:
--   select column_name from information_schema.column_privileges
--    where table_schema = 'attendance' and table_name = 'punches'
--      and grantee = 'authenticated' and column_name in ('geo_lat', 'geo_lng');
--   -- Esperado: 0 filas.
