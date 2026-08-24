-- 0005_checador_esquema_y_tablas.sql
--
-- Esquema y tablas del checador.
--
-- Decision de diseno: las tablas viven en el esquema "checador", que NO se
-- expone en la API. La superficie publica se limita a vistas y funciones
-- especificas en "public". Asi el cliente no puede tocar las tablas ni
-- intentandolo, y RLS queda como segunda linea en lugar de unica linea.
--
-- Se otorga SELECT a authenticated sobre las tablas porque las vistas van a usar
-- security_invoker = true: se evaluan con los privilegios de quien consulta, de
-- modo que RLS aplica de verdad. Nunca se otorga INSERT, UPDATE ni DELETE: el
-- unico camino de escritura son las funciones.
--
-- Limitacion conocida y deliberada de esta version: no se modelan jornadas que
-- cruzan la medianoche (salida_esperada debe ser posterior a entrada_esperada).
-- El personal de oficina en home office no las necesita; si mas adelante entra
-- produccion por turnos, hay que revisar jornadas y horarios.

create schema if not exists checador;

comment on schema checador is
  'Datos del checador de asistencia. NO expuesto en la API: el acceso pasa por vistas y funciones en public.';

grant usage on schema checador to authenticated, service_role;

-- ============================================================== horarios ===
-- Precedencia al resolver el horario de una persona: empleado > departamento >
-- global. El nivel global existe porque 8 de los 31 empleados no tienen
-- departamento asignado y sin el se quedarian sin reglas ni alertas.

create table if not exists checador.horarios (
  id               uuid        primary key default gen_random_uuid(),
  alcance          text        not null,
  departamento_id  uuid        references public.departamentos (id) on delete cascade,
  empleado_id      uuid        references public.empleados (id)     on delete cascade,
  nombre           text        not null,
  dias             smallint[]  not null default '{1,2,3,4,5}',
  entrada_desde    time        not null,
  entrada_hasta    time        not null,
  entrada_esperada time        not null,
  salida_esperada  time        not null,
  tolerancia_min   integer     not null default 10,
  pausa_max_min    integer     not null default 60,
  vigente_desde    date        not null default current_date,
  vigente_hasta    date,
  activo           boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint horarios_alcance_valido
    check (alcance in ('global', 'departamento', 'empleado')),

  -- Cada alcance exige exactamente las llaves que le corresponden.
  constraint horarios_alcance_coherente check (
       (alcance = 'global'       and departamento_id is null     and empleado_id is null)
    or (alcance = 'departamento' and departamento_id is not null and empleado_id is null)
    or (alcance = 'empleado'     and empleado_id     is not null and departamento_id is null)
  ),

  constraint horarios_ventana_coherente
    check (entrada_desde <= entrada_hasta),
  constraint horarios_esperada_en_ventana
    check (entrada_esperada between entrada_desde and entrada_hasta),
  constraint horarios_salida_posterior
    check (salida_esperada > entrada_esperada),
  constraint horarios_vigencia_coherente
    check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  constraint horarios_tolerancia_razonable
    check (tolerancia_min between 0 and 120),
  constraint horarios_pausa_razonable
    check (pausa_max_min between 0 and 480),

  -- Dias ISO: 1 = lunes ... 7 = domingo.
  constraint horarios_dias_validos check (
        dias <@ array[1,2,3,4,5,6,7]::smallint[]
    and array_length(dias, 1) between 1 and 7
  )
);

comment on table checador.horarios is
  'Ventanas de horario. Precedencia al resolver: empleado > departamento > global.';
comment on column checador.horarios.dias is
  'Dias ISO en que aplica: 1 = lunes ... 7 = domingo.';
comment on column checador.horarios.entrada_desde is
  'Antes de esta hora no se espera la entrada. Marcar antes no genera alerta, solo se registra.';
comment on column checador.horarios.entrada_hasta is
  'Pasada esta hora sin entrada se levanta la alerta falta_entrada.';
comment on column checador.horarios.tolerancia_min is
  'Minutos de gracia sobre entrada_esperada antes de considerar retardo.';

-- Un solo horario vigente por alcance: evita que dos reglas activas se
-- contradigan y que la resolucion dependa del azar.
create unique index if not exists horarios_global_unico
  on checador.horarios (alcance)
  where alcance = 'global' and activo and vigente_hasta is null;

create unique index if not exists horarios_departamento_unico
  on checador.horarios (departamento_id)
  where alcance = 'departamento' and activo and vigente_hasta is null;

create unique index if not exists horarios_empleado_unico
  on checador.horarios (empleado_id)
  where alcance = 'empleado' and activo and vigente_hasta is null;

-- ============================================================== jornadas ===
-- Una fila por empleado y dia. Es el estado que consulta el tablero, para no
-- recalcular la jornada a partir de los marcajes en cada consulta.

create table if not exists checador.jornadas (
  id                  uuid        primary key default gen_random_uuid(),
  empleado_id         uuid        not null references public.empleados (id) on delete restrict,
  fecha               date        not null,
  estado              text        not null default 'no_iniciada',
  horario_id          uuid        references checador.horarios (id) on delete set null,
  zona_horaria        text        not null default 'America/Mexico_City',
  abierta_en          timestamptz,
  cerrada_en          timestamptz,
  segundos_trabajados integer     not null default 0,
  segundos_pausa      integer     not null default 0,
  ultimo_latido       timestamptz,
  tiene_offline       boolean     not null default false,
  requiere_revision   boolean     not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint jornadas_unica_por_dia unique (empleado_id, fecha),
  constraint jornadas_estado_valido
    check (estado in ('no_iniciada', 'trabajando', 'en_pausa', 'finalizada')),
  constraint jornadas_cierre_posterior
    check (cerrada_en is null or abierta_en is null or cerrada_en >= abierta_en),
  constraint jornadas_segundos_no_negativos
    check (segundos_trabajados >= 0 and segundos_pausa >= 0)
);

comment on table checador.jornadas is
  'Estado de la jornada de cada empleado por dia. Derivada de los marcajes, mantenida por las funciones de marcaje.';
comment on column checador.jornadas.tiene_offline is
  'Verdadero si algun marcaje del dia llego por sincronizacion. Se muestra en el tablero.';

create index if not exists jornadas_fecha_idx
  on checador.jornadas (fecha desc, empleado_id);
create index if not exists jornadas_estado_idx
  on checador.jornadas (estado)
  where estado in ('trabajando', 'en_pausa');
create index if not exists jornadas_revision_idx
  on checador.jornadas (fecha desc)
  where requiere_revision;

-- ============================================================== marcajes ===
-- APPEND-ONLY. No se modifican ni se borran: las correcciones son filas nuevas
-- en checador.ajustes. Se hace cumplir con un trigger en la migracion 0006,
-- porque revocar privilegios no detiene al rol de servicio.

create table if not exists checador.marcajes (
  id                 uuid        primary key default gen_random_uuid(),
  jornada_id         uuid        not null references checador.jornadas (id) on delete restrict,
  empleado_id        uuid        not null references public.empleados (id) on delete restrict,
  tipo               text        not null,

  -- La hora oficial. La pone el servidor, nunca el cliente.
  ocurrio_en         timestamptz not null,
  registrado_en      timestamptz not null default now(),
  -- Lo que dijo el equipo del empleado. Solo para auditar: jamas es la oficial.
  reportado_cliente  timestamptz,

  origen             text        not null default 'linea',
  clave_idempotencia uuid        not null,
  desvio_reloj_ms    integer,
  retraso_sync_seg   integer,
  requiere_revision  boolean     not null default false,
  motivo_revision    text,

  ip                 inet,
  agente             text,
  dispositivo_id     text,

  geo_lat            numeric(9,6),
  geo_lng            numeric(9,6),
  geo_precision_m    numeric(8,2),
  geo_purga_en       date,

  created_at         timestamptz not null default now(),

  constraint marcajes_tipo_valido
    check (tipo in ('entrada', 'pausa_inicio', 'pausa_fin', 'salida')),
  constraint marcajes_origen_valido
    check (origen in ('linea', 'offline')),

  -- Una red inestable puede reintentar el mismo marcaje muchas veces.
  constraint marcajes_idempotencia_unica unique (clave_idempotencia),

  constraint marcajes_geo_completa
    check ((geo_lat is null) = (geo_lng is null)),
  constraint marcajes_geo_en_rango check (
    geo_lat is null
    or (geo_lat between -90 and 90 and geo_lng between -180 and 180)
  ),
  -- Un marcaje offline sin hora del cliente no se puede ubicar en el tiempo.
  constraint marcajes_offline_con_hora
    check (origen = 'linea' or reportado_cliente is not null),
  constraint marcajes_revision_con_motivo
    check (not requiere_revision or motivo_revision is not null)
);

comment on table checador.marcajes is
  'Registro de marcajes. APPEND-ONLY: no se modifica ni se borra. Las correcciones van en checador.ajustes.';
comment on column checador.marcajes.ocurrio_en is
  'Hora oficial. En linea la pone now() del servidor; offline es la estimada del cliente y la fila queda marcada.';
comment on column checador.marcajes.reportado_cliente is
  'Hora que reporto el equipo del empleado. Solo auditoria: nunca es la hora oficial.';
comment on column checador.marcajes.desvio_reloj_ms is
  'Diferencia conocida entre el reloj del equipo y el del servidor al momento de marcar.';
comment on column checador.marcajes.geo_purga_en is
  'Fecha en que se borran las coordenadas de esta fila. Retencion de 90 dias.';

create index if not exists marcajes_empleado_fecha_idx
  on checador.marcajes (empleado_id, ocurrio_en desc);
create index if not exists marcajes_jornada_idx
  on checador.marcajes (jornada_id, ocurrio_en);
create index if not exists marcajes_revision_idx
  on checador.marcajes (ocurrio_en desc)
  where requiere_revision;
create index if not exists marcajes_purga_geo_idx
  on checador.marcajes (geo_purga_en)
  where geo_lat is not null;

-- ================================================================ ajustes ===
-- Toda correccion de RH queda aqui, con motivo obligatorio. Es lo que hace
-- defendible el registro: nada se edita en silencio.

create table if not exists checador.ajustes (
  id              uuid        primary key default gen_random_uuid(),
  marcaje_id      uuid        references checador.marcajes (id) on delete restrict,
  jornada_id      uuid        not null references checador.jornadas (id) on delete restrict,
  tipo            text        not null,
  valor_anterior  timestamptz,
  valor_nuevo     timestamptz,
  motivo          text        not null,
  ajustado_por    uuid        not null references auth.users (id) on delete restrict,
  created_at      timestamptz not null default now(),

  constraint ajustes_tipo_valido
    check (tipo in ('corregir_hora', 'aprobar_offline', 'rechazar_offline',
                    'agregar_marcaje', 'anular_marcaje')),
  constraint ajustes_motivo_sustancial
    check (length(trim(motivo)) >= 10)
);

comment on table checador.ajustes is
  'Bitacora de correcciones de RH sobre marcajes y jornadas. Motivo obligatorio de al menos 10 caracteres.';

create index if not exists ajustes_jornada_idx on checador.ajustes (jornada_id, created_at desc);
create index if not exists ajustes_marcaje_idx on checador.ajustes (marcaje_id);

-- ================================================================ alertas ===

create table if not exists checador.alertas (
  id              uuid        primary key default gen_random_uuid(),
  empleado_id     uuid        not null references public.empleados (id) on delete cascade,
  fecha           date        not null,
  tipo            text        not null,
  severidad       text        not null default 'media',
  detalle         jsonb       not null default '{}',
  estado          text        not null default 'abierta',
  notificada_en   timestamptz,
  reconocida_por  uuid        references auth.users (id) on delete set null,
  reconocida_en   timestamptz,
  resuelta_en     timestamptz,
  nota            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- La clave de la idempotencia: el evaluador corre cada minuto y no debe
  -- inundar a RH con la misma alerta repetida.
  constraint alertas_unica_por_dia unique (empleado_id, fecha, tipo),

  constraint alertas_tipo_valido check (tipo in (
    'entrada_tarde', 'falta_entrada', 'pausa_excedida',
    'falta_salida', 'sin_conexion', 'revisar_offline', 'reloj_alterado'
  )),
  constraint alertas_severidad_valida
    check (severidad in ('baja', 'media', 'alta')),
  constraint alertas_estado_valido
    check (estado in ('abierta', 'reconocida', 'resuelta', 'descartada'))
);

comment on table checador.alertas is
  'Alertas para RH. El unico (empleado, fecha, tipo) hace idempotente al evaluador.';

create index if not exists alertas_abiertas_idx
  on checador.alertas (fecha desc, severidad)
  where estado = 'abierta';
create index if not exists alertas_sin_notificar_idx
  on checador.alertas (created_at)
  where notificada_en is null;

-- ========================================================== reglas_alerta ===
-- Que alertas estan activas y con que umbral, por departamento. Sin fila, se
-- usan los valores por defecto de la funcion evaluadora.

create table if not exists checador.reglas_alerta (
  id              uuid        primary key default gen_random_uuid(),
  departamento_id uuid        references public.departamentos (id) on delete cascade,
  tipo            text        not null,
  activa          boolean     not null default true,
  umbral_min      integer     not null default 15,
  destinos        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint reglas_alerta_tipo_valido check (tipo in (
    'entrada_tarde', 'falta_entrada', 'pausa_excedida',
    'falta_salida', 'sin_conexion', 'revisar_offline', 'reloj_alterado'
  )),
  constraint reglas_alerta_umbral_razonable
    check (umbral_min between 0 and 1440)
);

-- departamento_id nulo = regla global. El indice unico debe tratar el nulo como
-- un valor, cosa que UNIQUE no hace: de ahi los dos indices parciales.
create unique index if not exists reglas_alerta_por_departamento
  on checador.reglas_alerta (departamento_id, tipo)
  where departamento_id is not null;
create unique index if not exists reglas_alerta_global
  on checador.reglas_alerta (tipo)
  where departamento_id is null;

comment on column checador.reglas_alerta.destinos is
  'Correos adicionales a notificar, separados por coma. Nulo usa los destinos por defecto de config_correo.';

-- =========================================================== dispositivos ===
-- Permite revocar el acceso de un equipo perdido sin tocar la cuenta.

create table if not exists checador.dispositivos (
  id             uuid        primary key default gen_random_uuid(),
  empleado_id    uuid        not null references public.empleados (id) on delete cascade,
  dispositivo_id text        not null,
  agente         text,
  primera_vez    timestamptz not null default now(),
  ultima_vez     timestamptz not null default now(),
  revocado_en    timestamptz,
  revocado_por   uuid        references auth.users (id) on delete set null,

  constraint dispositivos_unico unique (empleado_id, dispositivo_id)
);

comment on table checador.dispositivos is
  'Equipos desde los que marca cada persona. Revocar aqui bloquea el equipo sin cerrar la cuenta.';

-- ========================================================= consentimientos ===
-- Requisito de la geolocalizacion: consentimiento explicito y registrado, con
-- version del aviso para saber que acepto cada quien.

create table if not exists checador.consentimientos (
  id             uuid        primary key default gen_random_uuid(),
  empleado_id    uuid        not null references public.empleados (id) on delete cascade,
  version_aviso  text        not null,
  aceptado       boolean     not null,
  aceptado_en    timestamptz not null default now(),
  ip             inet,

  constraint consentimientos_unico unique (empleado_id, version_aviso)
);

comment on table checador.consentimientos is
  'Consentimiento del aviso de privacidad por persona y version. Requisito para tratar geolocalizacion.';

-- ================================================================ eventos ===
-- Bitacora general, con la misma forma que public.ticket_eventos para que se lea
-- igual que el resto del proyecto. Aqui cae TODA accion administrativa,
-- incluida cada consulta de coordenadas.

create table if not exists checador.eventos (
  id          uuid        primary key default gen_random_uuid(),
  tipo        text        not null,
  entidad     text        not null,
  entidad_id  uuid,
  autor       uuid        references auth.users (id) on delete set null,
  cuerpo      text,
  antes       jsonb,
  despues     jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);

comment on table checador.eventos is
  'Bitacora de acciones administrativas del checador, incluida cada consulta de coordenadas.';

create index if not exists eventos_entidad_idx on checador.eventos (entidad, entidad_id, created_at desc);
create index if not exists eventos_autor_idx   on checador.eventos (autor, created_at desc);
create index if not exists eventos_tipo_idx    on checador.eventos (tipo, created_at desc);

-- ================================================ actualizacion de updated_at ===

create trigger horarios_touch       before update on checador.horarios
  for each row execute function public.touch_updated_at();
create trigger jornadas_touch       before update on checador.jornadas
  for each row execute function public.touch_updated_at();
create trigger alertas_touch        before update on checador.alertas
  for each row execute function public.touch_updated_at();
create trigger reglas_alerta_touch  before update on checador.reglas_alerta
  for each row execute function public.touch_updated_at();

-- ================================================== alcance de visibilidad ===
-- Un solo lugar decide quien puede ver los datos de quien. Tenerlo centralizado
-- evita que cada politica reimplemente la regla y que una se equivoque.

create or replace function interno.puede_ver_empleado(p_empleado_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select case interno.rol_actual()
    when 'admin'    then true
    when 'rh'       then true
    when 'jefe'     then exists (
                          select 1
                            from public.empleados e
                           where e.id = p_empleado_id
                             and e.departamento_id is not null
                             and e.departamento_id = interno.departamento_actual()
                        )
    when 'empleado' then p_empleado_id = interno.empleado_actual()
    else false   -- invitado y cualquier rol futuro no contemplado: sin acceso
  end;
$fn$;

comment on function interno.puede_ver_empleado(uuid) is
  'Unica regla de alcance de visibilidad: admin y rh ven todo, jefe su departamento, empleado solo lo suyo.';

revoke all    on function interno.puede_ver_empleado(uuid) from public;
grant  execute on function interno.puede_ver_empleado(uuid) to authenticated;

-- ==================================================================== RLS ===
-- SELECT filtrado por RLS para que las vistas con security_invoker funcionen.
-- Nunca INSERT, UPDATE ni DELETE: el unico camino de escritura son las
-- funciones de las migraciones siguientes.

alter table checador.horarios         enable row level security;
alter table checador.jornadas         enable row level security;
alter table checador.marcajes         enable row level security;
alter table checador.ajustes          enable row level security;
alter table checador.alertas          enable row level security;
alter table checador.reglas_alerta    enable row level security;
alter table checador.dispositivos     enable row level security;
alter table checador.consentimientos  enable row level security;
alter table checador.eventos          enable row level security;

grant select on all tables in schema checador to authenticated;

-- Horarios y reglas: los ve cualquiera autenticado (el empleado necesita saber
-- a que hora se espera que entre). Escribirlos es cosa de rh y admin, y pasa
-- por funciones.
create policy horarios_lectura on checador.horarios
  for select to authenticated using (true);

create policy reglas_alerta_lectura on checador.reglas_alerta
  for select to authenticated
  using ((select interno.rol_actual()) in ('jefe', 'rh', 'admin'));

-- Datos de personas: alcance segun rol.
create policy jornadas_lectura on checador.jornadas
  for select to authenticated using (interno.puede_ver_empleado(empleado_id));

create policy marcajes_lectura on checador.marcajes
  for select to authenticated using (interno.puede_ver_empleado(empleado_id));

create policy alertas_lectura on checador.alertas
  for select to authenticated using (interno.puede_ver_empleado(empleado_id));

create policy dispositivos_lectura on checador.dispositivos
  for select to authenticated using (interno.puede_ver_empleado(empleado_id));

create policy consentimientos_lectura on checador.consentimientos
  for select to authenticated using (interno.puede_ver_empleado(empleado_id));

-- Ajustes: se llega por la jornada, asi que se hereda su alcance.
create policy ajustes_lectura on checador.ajustes
  for select to authenticated
  using (exists (
    select 1 from checador.jornadas j
     where j.id = ajustes.jornada_id
       and interno.puede_ver_empleado(j.empleado_id)
  ));

-- La bitacora solo la ve admin: contiene quien consulto que.
create policy eventos_lectura on checador.eventos
  for select to authenticated
  using ((select interno.rol_actual()) = 'admin');

-- ----------------------------------------------------------- como verificarlo ---
--   -- Ninguna tabla del checador debe tener privilegios de escritura para
--   -- authenticated:
--   select table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'checador' and grantee = 'authenticated'
--      and privilege_type <> 'SELECT';
--   -- Esperado: 0 filas.
