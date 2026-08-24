-- free_plan_maintenance.sql
--
-- Lo que el plan gratuito obliga a hacer bien.
--
-- Cuotas del plan gratuito (verificadas en la documentacion de Supabase):
--
--   Base de datos      500 MB por proyecto   <-- la restriccion que importa
--   Egress             5 GB sin cache + 5 GB con cache al mes
--   Edge Functions     500 000 invocaciones al mes
--   Realtime           2 000 000 mensajes, 200 conexiones simultaneas
--   Respaldos          NO HAY. Ni automaticos ni descargables.
--   Pausa              a los 7 dias de poca actividad de base de datos
--
-- Hoy la base ocupa 14 MB de 500 (2.7 %), y la comparte con la mesa de ayuda.
-- El problema no es el tamano actual: son las tres tablas que crecen sin techo
-- si nadie las poda. A 500 MB, "ya veremos" no es una estrategia.
--
--   net._http_response       se autolimita: pg_net la purga a las 6 horas.
--   cron.job_run_details     NO se autolimita. La documentacion de Supabase
--                            advierte que llega a tamanos enormes y que
--                            entorpece hasta las actualizaciones de version.
--   attendance.audit_events  crece con cada accion administrativa.
--
-- Lo que NUNCA se poda, y hay que decirlo explicito: punches, workdays y
-- adjustments. Son el registro laboral. La LFT obliga a conservarlos y son
-- justo la evidencia que este sistema existe para producir. Aqui solo se
-- recorta metadata de operacion, nunca el registro de asistencia.

-- ================================================================ extensiones ===
-- Estaban disponibles pero sin instalar, al contrario de lo que asumia el plan.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

grant usage on schema cron to postgres;

-- ====================================================== purga de coordenadas ===
-- El compromiso de privacidad: 90 dias y las coordenadas desaparecen. Se
-- calcula al insertar (punches.geo_purge_on) y se ejecuta aqui.
--
-- El disparador de append-only bloquea todo UPDATE sobre punches, incluso al
-- rol de servicio. La unica rendija es esta, y esta cerrada con dos llaves: la
-- bandera de sesion tiene que estar puesta Y el cambio tiene que limitarse a
-- dejar las coordenadas en nulo. Cualquier otra modificacion se rechaza aunque
-- la bandera este puesta.

create or replace function attendance.purge_geolocation()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_purged integer;
begin
  perform set_config('attendance.geo_purge', 'yes', true);

  update attendance.punches
     set geo_lat        = null,
         geo_lng        = null,
         geo_accuracy_m = null
   where geo_lat is not null
     and geo_purge_on is not null
     and geo_purge_on <= current_date;

  get diagnostics v_purged = row_count;

  perform set_config('attendance.geo_purge', 'no', true);

  -- Queda constancia de la purga: si manana alguien pregunta por que no hay
  -- coordenadas de hace cuatro meses, la respuesta esta escrita.
  if v_purged > 0 then
    insert into attendance.audit_events (kind, entity, body)
    values ('geo_purge', 'punches',
            format('Purga automatica de coordenadas: %s marcajes', v_purged));
  end if;

  return v_purged;
end;
$fn$;

comment on function attendance.purge_geolocation() is
  'Borra las coordenadas con mas de 90 dias. Unica excepcion permitida al append-only de punches.';

revoke all on function attendance.purge_geolocation() from public, anon, authenticated;

-- ================================================== poda de la bitacora ===
-- audit_events registra quien hizo que, incluida cada consulta de coordenadas.
-- Es metadata de operacion, no el registro laboral, asi que si se puede acotar.
-- 24 meses cubre de sobra cualquier aclaracion de nomina y deja la tabla en un
-- tamano previsible.

create or replace function attendance.prune_audit_events(p_keep_months integer default 24)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  if p_keep_months < 12 then
    raise exception 'La bitacora no se poda a menos de 12 meses (se pidio %)', p_keep_months
      using hint = 'Es la evidencia de quien consulto datos personales';
  end if;

  delete from attendance.audit_events
   where created_at < now() - make_interval(months => p_keep_months);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

comment on function attendance.prune_audit_events(integer) is
  'Poda la bitacora administrativa. Nunca por debajo de 12 meses. No toca punches ni workdays.';

revoke all on function attendance.prune_audit_events(integer) from public, anon, authenticated;

-- ============================================ poda del historial de pg_cron ===
-- cron.job_run_details guarda una fila por ejecucion y NO se limpia sola. Con
-- un trabajo por minuto son 43 200 filas al mes que no le sirven a nadie
-- pasada una semana. La documentacion de Supabase lo marca como causa de
-- fallos al actualizar la version de Postgres.

create or replace function internal.prune_cron_history(p_keep_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  delete from cron.job_run_details
   where end_time < now() - make_interval(days => p_keep_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

comment on function internal.prune_cron_history(integer) is
  'Recorta cron.job_run_details, que no se autolimita y llega a estorbar las actualizaciones de version.';

revoke all on function internal.prune_cron_history(integer) from public, anon, authenticated;

-- ================================================ vigilancia de las cuotas ===
-- Para no enterarse del limite el dia que se alcanza. La consulta el runbook.

create or replace view attendance.free_plan_usage as
select
  'Base de datos'                                                   as recurso,
  pg_size_pretty(pg_database_size(current_database()))              as usado,
  '500 MB'                                                          as limite,
  round(100.0 * pg_database_size(current_database())
        / (500 * 1024 * 1024), 1)                                   as pct
union all
select
  'Tabla ' || n.nspname || '.' || c.relname,
  pg_size_pretty(pg_total_relation_size(c.oid)),
  '-',
  round(100.0 * pg_total_relation_size(c.oid)
        / nullif(pg_database_size(current_database()), 0), 1)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r'
   and n.nspname in ('public', 'attendance', 'cron', 'net')
 order by pct desc nulls last
 limit 12;

comment on view attendance.free_plan_usage is
  'Consumo contra las cuotas del plan gratuito. Las 11 tablas mas pesadas y el total de la base.';

-- La vista lee catalogos del sistema: solo admin.
revoke all on attendance.free_plan_usage from public, anon, authenticated;

-- ================================================== trabajos programados ===
-- pg_cron corre en UTC. Mexico_City es UTC-6, asi que 09:00 UTC = 03:00 local,
-- de madrugada y sin nadie marcando.
--
-- unschedule antes de schedule para que la migracion se pueda reaplicar sin
-- duplicar trabajos. cron.unschedule falla si el trabajo no existe, de ahi el
-- bloque con excepcion.

do $do$
declare
  v_job text;
begin
  foreach v_job in array array[
    'attendance_purge_geolocation',
    'attendance_prune_audit_events',
    'attendance_prune_cron_history'
  ] loop
    begin
      perform cron.unschedule(v_job);
    exception when others then
      null;   -- no existia: es el caso normal la primera vez
    end;
  end loop;
end
$do$;

-- Diario 03:00 local. La purga de privacidad no puede saltarse ningun dia.
select cron.schedule(
  'attendance_purge_geolocation',
  '0 9 * * *',
  $cron$ select attendance.purge_geolocation(); $cron$
);

-- Domingos 03:30 local. Semanal basta: la bitacora crece despacio.
select cron.schedule(
  'attendance_prune_audit_events',
  '30 9 * * 0',
  $cron$ select attendance.prune_audit_events(24); $cron$
);

-- Diario 03:45 local. Este es el que evita que cron.job_run_details se dispare.
select cron.schedule(
  'attendance_prune_cron_history',
  '45 9 * * *',
  $cron$ select internal.prune_cron_history(7); $cron$
);

-- ----------------------------------------------------------- como verificarlo ---
--   -- 1. Los tres trabajos quedaron programados:
--   select jobname, schedule, active from cron.job order by jobname;
--
--   -- 2. Consumo contra la cuota:
--   select * from attendance.free_plan_usage;
--
--   -- 3. La purga respeta el append-only (debe fallar):
--   update attendance.punches set occurred_at = now();
