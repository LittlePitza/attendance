-- 0004_esquema_interno_y_perfil.sql
--
-- Corrige dos hallazgos que introdujeron 0001 y 0002, reportados por los
-- advisors de Supabase despues de aplicarlas.
--
-- Hallazgo 1 (defecto real): empleados_sincronizar_departamento es una funcion
-- de disparo, pero al vivir en public quedo publicada como endpoint RPC
-- (/rest/v1/rpc/...) llamable incluso por anon, sin iniciar sesion. Invocarla
-- directo fallaria ("trigger functions can only be called as triggers"), asi que
-- el riesgo practico es nulo, pero no tiene por que estar en la superficie de
-- la API.
--
-- Hallazgo 2 (mas sutil): rol_actual, empleado_actual y departamento_actual
-- aparecen como SECURITY DEFINER llamables por authenticated. Y TIENEN que
-- serlo: las politicas RLS se evaluan con los privilegios de quien consulta, asi
-- que revocarles EXECUTE rompe las 23 politicas de golpe. Quitar el permiso no
-- es opcion.
--
-- La solucion no es silenciar la advertencia sino sacar las funciones de la
-- superficie de la API: se mueven a un esquema "interno" que NO esta expuesto
-- por PostgREST. Siguen siendo usables por RLS (basta USAGE + EXECUTE) pero
-- dejan de existir como endpoints.
--
-- Detalle que hace esto barato: ALTER FUNCTION ... SET SCHEMA conserva el OID de
-- la funcion, y tanto las politicas como los triggers dependen del OID, no del
-- nombre. Se mueven solas. No hay que reescribir ni una politica.
--
-- IMPORTANTE: el esquema interno NO debe agregarse a "Exposed schemas" en la
-- configuracion de la API del proyecto. Si se agrega, este arreglo se deshace.

create schema if not exists interno;

comment on schema interno is
  'Funciones internas: identidad y disparadores. Deliberadamente NO expuesto en la API. No agregarlo a Exposed schemas.';

-- authenticated necesita USAGE para que las politicas RLS puedan evaluar las
-- funciones de identidad. Otorgar USAGE sobre un esquema no lo expone en la API:
-- eso se configura aparte, en PostgREST.
grant usage on schema interno to authenticated, service_role;

-- ---------------------------------------------------------------- el traslado ---

alter function public.rol_actual()                         set schema interno;
alter function public.empleado_actual()                    set schema interno;
alter function public.departamento_actual()                set schema interno;
alter function public.empleados_sincronizar_departamento() set schema interno;
alter function public.departamentos_validar_zona()         set schema interno;

-- Las funciones de disparo no se invocan nunca de forma directa: Postgres no
-- verifica EXECUTE al ejecutar un trigger, asi que revocarlo no los afecta.
revoke all on function interno.empleados_sincronizar_departamento() from public;
revoke all on function interno.departamentos_validar_zona()         from public;

-- Las de identidad si las necesita RLS.
revoke all    on function interno.rol_actual()          from public;
revoke all    on function interno.empleado_actual()     from public;
revoke all    on function interno.departamento_actual() from public;
grant  execute on function interno.rol_actual()          to authenticated;
grant  execute on function interno.empleado_actual()     to authenticated;
grant  execute on function interno.departamento_actual() to authenticated;

-- ------------------------------------------------------- la unica RPC expuesta ---
-- La interfaz necesita saber quien es para decidir que pintar. En vez de dejar
-- tres funciones sueltas publicadas, se expone una sola, deliberada y acotada.
--
-- SECURITY INVOKER a proposito: no necesita elevar privilegios porque las
-- politicas de empleados ya permiten a cada persona ver su propia fila. Menos
-- privilegio, menos que auditar.
--
-- El left join contra (select 1) garantiza que siempre devuelva exactamente una
-- fila, incluso si la cuenta no tiene empleado ligado (el caso de la cuenta
-- administradora). Sin eso la interfaz no recibiria ni el rol.

create or replace function public.mi_perfil()
returns table (
  rol             text,
  empleado_id     uuid,
  nombre          text,
  departamento_id uuid,
  departamento    text
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select interno.rol_actual() as rol,
         e.id                 as empleado_id,
         e.nombre,
         e.departamento_id,
         e.departamento
    from (select 1) as siempre_una_fila
    left join public.empleados e
           on e.auth_user_id = auth.uid()
          and e.estado = 'activo';
$fn$;

comment on function public.mi_perfil() is
  'Perfil de la cuenta que consulta: su rol y, si la tiene, su ficha de empleado. Devuelve siempre una fila. Unica funcion de identidad publicada en la API.';

revoke all     on function public.mi_perfil() from public, anon;
grant  execute on function public.mi_perfil() to authenticated;

-- ----------------------------------------------------------- como verificarlo ---
--   -- 1. Ya no debe quedar ninguna funcion de identidad en public:
--   select p.proname, n.nspname
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where p.proname in ('rol_actual','empleado_actual','departamento_actual',
--                        'empleados_sincronizar_departamento','departamentos_validar_zona');
--   -- Esperado: las cinco en interno.
--
--   -- 2. Las politicas siguen apuntando a la funcion movida (por OID):
--   select count(*) from pg_policies
--    where schemaname = 'public' and qual like '%rol_actual%';
--   -- Esperado: 23
--
--   -- 3. El trigger sigue funcionando: un update que no cambia departamento
--   --    no debe alterarlo, y uno que si lo cambia debe sincronizar el texto.
