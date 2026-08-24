# Checador — guía para trabajar en este proyecto

Sistema de registro de asistencia para personal en home office de Plásticos PIMSA.
Todo corre en Supabase: no hay servidor de aplicación.

## Dónde vive

Proyecto Supabase **`pimsa_ti`** (`cyjpucvvekzfpvvonuld`, Postgres 17, us-east-1).
**No es un proyecto vacío**: comparte la base con la mesa de ayuda de TI, que está
en producción (tickets, inventario, responsivas, compras, caja). Cualquier cambio
en `public` puede romperla.

- Tablas del checador → esquema **`attendance`**
- Catálogos compartidos (`empleados`, `departments`) → esquema `public`
- Funciones de identidad y disparadores → esquema **`internal`**

## Idioma

**El código y la estructura van en inglés. Los comentarios y la documentación,
en español.**

- Nombres de esquemas, tablas, columnas, funciones, índices, restricciones,
  políticas, archivos y carpetas: **inglés**.
- Valores tipo enum de los `CHECK` (`'clock_in'`, `'working'`, `'hr'`): **inglés**.
- Comentarios del SQL, `COMMENT ON` y `docs/`: **español**.
- **Mensajes de error que llegan a la pantalla del empleado: español.** Los lee
  gente que no habla inglés.

La excepción, y es deliberada: **las 19 tablas de la mesa de ayuda siguen en
español** (`empleados`, `tickets`, `equipos`, `config_correo`, `responsivas`,
`facturas`, `caja_movimientos`…). Están en producción y las consume `ti-hub`,
que vive en otro repositorio. Renombrarlas rompe ese sistema.

Por eso el modelo está mezclado a propósito: `attendance.punches.employee_id`
apunta a `public.empleados.id`. No es incoherencia, es la frontera con lo que ya
existía. Se resolverá cuando el código de ti-hub migre.

## Reglas que no se rompen

1. **Postgres decide, no el cliente.** Las reglas de negocio viven en funciones
   `SECURITY DEFINER`. Las Edge Functions solo hablan con el mundo exterior
   (correo, altas de usuario, exportar) y **nunca** contienen reglas de negocio.
   La PWA no tiene lógica: llama funciones y pinta datos.

2. **El cliente no escribe tablas.** A `authenticated` se le da `SELECT`
   (filtrado por RLS) y nunca `INSERT`/`UPDATE`/`DELETE` sobre las tablas del
   checador. El único camino de escritura son las funciones.

3. **La hora la pone el servidor.** `occurred_at := now()`. Cualquier hora que
   mande el cliente se guarda aparte, en `client_reported_at`, solo para auditar.

4. **El `employee_id` se deriva del token**, con `internal.caller_employee_id()`.
   Jamás se acepta como parámetro: así nadie marca en nombre de otro.

5. **`attendance.punches` es append-only.** Lo hace cumplir un disparador, no
   solo la falta de privilegios: el rol de servicio los tiene de todos modos.
   Las correcciones son filas nuevas en `attendance.adjustments`, con motivo
   obligatorio de al menos 10 caracteres.

6. **Toda función lleva `SET search_path = ''`** y nombres calificados por
   completo. Sin eso, un `search_path` manipulado permite secuestrarla.

7. **Nada de funciones sueltas en `public`.** Lo que vive en `public` queda
   publicado como endpoint REST. Las funciones internas van en `internal`, que
   **no debe agregarse a "Exposed schemas"**. La única RPC de identidad
   publicada es `public.my_profile()`.

   Lo que **sí** vive en `public` a propósito, porque el cliente tiene que
   poder llamarlo por REST: `my_profile()`, `server_time()`, `punch()`,
   `sync_punches()` y `heartbeat()`. Los advisors marcan las tres últimas como
   «SECURITY DEFINER ejecutable por authenticated»: **es el diseño**, no un
   hallazgo. Son el único camino de escritura y por eso deben elevar privilegios.

8. **En las políticas RLS, envolver las llamadas en `(select ...)`**:
   `using ((select internal.caller_role()) = 'admin')`. Así Postgres las evalúa una
   vez por sentencia y no una vez por fila.

## Convenciones de código

Se siguen las que ya usaba `pimsa_ti`, para que todo se lea igual:

- `snake_case` en inglés (ver **Idioma** arriba).
- `id uuid primary key default gen_random_uuid()`.
- `num integer` con secuencia cuando hace falta un folio legible.
- **`text` con `CHECK`** en lugar de tipos `enum`.
- `created_at timestamptz not null default now()`.
- `jsonb` con default `'{}'` o `'[]'` para datos flexibles.
- RLS activo en **todas** las tablas.
- Bitácora al estilo de `ticket_eventos`, en `attendance.audit_events`
  (`kind`, `actor`, `before_data`, `after_data`).

## Roles

En `public.user_roles`, uno por **cuenta** (no por persona: existe una cuenta
administradora que no es empleado).

| Rol | Alcance |
|---|---|
| `employee` | Solo sus propios registros |
| `manager` | Su departamento |
| `hr` | Todos, más ajustes y alertas |
| `admin` | Todo, más configuración |
| `guest` | Valor por defecto si no tiene rol: **sin permisos** |

## Comandos

No hay Docker instalado, y no hace falta:

```bash
npx supabase db push                      # aplicar migraciones (remoto)
npx supabase functions deploy --use-api   # desplegar funciones sin Docker
npx supabase gen types typescript --linked > web/src/shared/supabase/types.gen.ts
npx supabase test db                       # pruebas pgTAP
```

Docker solo se necesita para `supabase start` y `functions serve`, que emulan
todo localmente. Es opcional.

## Al terminar cualquier migración

Correr siempre los advisors y dejar el resultado en cero hallazgos nuevos:

```
get_advisors(project_id, type: "security")
get_advisors(project_id, type: "performance")
```

Ojo: el linter verifica que RLS esté **encendido**, no que las políticas sean
**restrictivas**. Una política `using (true)` pasa el linter y deja la tabla
abierta. Verificar a mano:

```sql
select tablename, policyname from pg_policies
 where schemaname = 'public' and cmd = 'ALL' and qual = 'true';
-- Esperado: 0 filas.
```

## Pendientes conocidos

- **Plan Pro ($25/mes):** el plan gratuito **no hace respaldos automáticos**.
  Debe decidirse antes de que el sistema entre en uso real. También habilita el
  bloqueo de contraseñas filtradas, la única advertencia que queda abierta.
- **`public.config_correo`** guarda `smtp_pass`, `azure_client_secret` y
  `oauth_refresh_token` en **texto plano**. Mover a Vault.
- **Columna `empleados.departamento` (texto)** es obsoleta: existe solo para no
  romper la mesa de ayuda. Un disparador la mantiene sincronizada con
  `department_id`. Se elimina cuando el código de ti-hub use el id.
- **8 de 31 empleados no tienen departamento.** Los cubre el horario global.
- **Alias en español dentro de 20 políticas de producción.** Se leen como
  `(SELECT internal.caller_role() AS rol_actual)`: Postgres congeló el alias de
  salida con el nombre que la función tenía al crearse la política. La llamada
  apunta bien y el comportamiento es idéntico; solo es una etiqueta. Se limpia
  la próxima vez que haya que tocar esas políticas, no antes: recrear 20
  políticas de tablas en producción por un alias no se paga.
- **Las 31 cuentas de acceso no existen todavía.** Se acordó crear 2 o 3 de
  prueba primero. `public.empleados.auth_user_id` está en cero.
- **`pg_cron`, `pg_net` y `pgtap` no están instalados**, solo disponibles. Las
  migraciones de alertas y purga necesitan `create extension` explícito.
