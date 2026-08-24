# Runbook

Operación del día a día. Lo que hay que hacer, en qué orden, y cómo comprobar
que salió bien.

---

## Puesta en marcha (una sola vez)

Estos pasos **faltan** y son requisito para que el sistema se use de verdad.

### 1. Secretos de GitHub Actions

`Settings → Secrets and variables → Actions`:

| Secreto | De dónde sale |
|---|---|
| `SUPABASE_DB_URL` | Panel de Supabase → Project Settings → Database → Connection string (modo **Session**) |
| `BACKUP_PASSPHRASE` | `openssl rand -base64 48`. **Guardarla también fuera de GitHub** |

Sin el primero fallan respaldo, latido y CI. Sin el segundo, el respaldo se
niega a subir nada antes que subirlo sin cifrar.

### 2. Endurecer Auth en el panel

`Authentication → Providers → Email` y `Authentication → Policies`. Lo de
`supabase/config.toml` describe el entorno local; **no se aplica solo al
proyecto remoto**.

- Longitud mínima: **12**.
- Caracteres requeridos: mayúscula, minúscula, dígito y símbolo.
- Registro abierto: **desactivado**. Las cuentas las crea RH.
- Confirmación por correo: desactivada (las altas son internas).
- MFA para las cuentas `hr` y `admin`.

El bloqueo de contraseñas filtradas no se puede activar en el plan gratuito.
Ver [free-plan.md](free-plan.md).

### 3. Crear las cuentas de prueba

Se acordó empezar con **2 o 3**, no con las 31. Por cada una:

```sql
-- 1. Crear la cuenta desde el panel (Authentication → Users → Add user),
--    con contraseña generada al azar y "Auto Confirm User".

-- 2. Ligarla con la ficha del empleado y darle rol.
update public.empleados
   set auth_user_id = '<uuid-de-la-cuenta>'
 where correo = 'persona@plasticospimsa.com';

insert into public.user_roles (auth_user_id, role, note)
values ('<uuid-de-la-cuenta>', 'employee', 'Cuenta de prueba');
```

Comprobar que quedó bien:

```sql
select e.nombre, e.correo, ur.role
  from public.empleados e
  join public.user_roles ur on ur.auth_user_id = e.auth_user_id
 where e.auth_user_id is not null;
```

### 4. Probar la restauración de un respaldo

Contra un proyecto Supabase distinto, no contra producción. Un respaldo que
nunca se restauró es una hipótesis.

---

## Revisión semanal (5 minutos)

```sql
-- 1. Consumo contra las cuotas del plan gratuito.
select * from attendance.free_plan_usage;

-- 2. Los trabajos programados siguen vivos y sin fallar.
select jobname, schedule, active from cron.job order by jobname;

select j.jobname, d.status, d.start_time, d.return_message
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
 where d.status <> 'succeeded'
 order by d.start_time desc
 limit 20;

-- 3. Marcajes que esperan revisión de RH.
select count(*) from attendance.punches where needs_review;
```

Y en GitHub, `Actions`: que **Respaldo diario** y **Latido** estén en verde. Un
latido rojo varios días seguidos significa que el proyecto puede pausarse.

---

## Después de cada migración

Obligatorio, sin excepción:

```
get_advisors(project_id, type: "security")
get_advisors(project_id, type: "performance")
```

Hallazgos que **son el diseño** y no se corrigen:

- `punch`, `sync_punches` y `heartbeat` marcadas como *SECURITY DEFINER
  ejecutable por authenticated*. Son el único camino de escritura; tienen que
  elevar privilegios.
- *Leaked password protection disabled*: exclusivo del plan Pro.
- `unused_index` sobre tablas nuevas: aún no reciben consultas.

Y una comprobación que el linter **no** hace, porque sólo verifica que RLS esté
encendido, no que las políticas sean restrictivas:

```sql
select tablename, policyname from pg_policies
 where schemaname = 'public' and permissive = 'PERMISSIVE'
   and (qual = 'true' or qual is null)
   and policyname <> 'departments_read';
-- Esperado: 0 filas. departments_read es libre a propósito.
```

---

## Correr las pruebas

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
     -f supabase/tests/sql/punch_engine_test.sql
```

Es seguro contra la base real: todo ocurre dentro de una transacción que
termina en `ROLLBACK`, y el bloque restaura el estado por su cuenta antes de
terminar. No deja marcajes, ni jornadas, ni vínculos de cuenta.

---

## Incidentes

### El proyecto se pausó

Panel de Supabase → seleccionar el proyecto → **Resume project**. Hay 90 días
desde la pausa para hacerlo con todos los datos intactos. Después, revisar por
qué falló el latido.

### Un empleado no puede marcar

Por orden de probabilidad:

```sql
-- 1. ¿La cuenta está ligada a una ficha de empleado activa?
select e.nombre, e.estado, ur.role
  from public.empleados e
  left join public.user_roles ur on ur.auth_user_id = e.auth_user_id
 where e.auth_user_id = '<uuid>';
-- Sin fila, o estado <> 'activo': ahí está. punch() lo rechaza a propósito.

-- 2. ¿Su equipo está revocado?
select device_id, revoked_at from attendance.devices
 where employee_id = '<uuid-empleado>' and revoked_at is not null;

-- 3. ¿En qué estado quedó su jornada?
select work_date, state, opened_at, closed_at
  from attendance.workdays
 where employee_id = '<uuid-empleado>'
 order by work_date desc limit 5;
```

El mensaje de error que ve el empleado ya dice el estado actual — por eso están
redactados en español.

### Hay que corregir un marcaje

**No se edita.** `attendance.punches` es append-only y el disparador rechaza
cualquier `UPDATE`, incluso desde el rol de servicio. La corrección es una fila
nueva en `attendance.adjustments`, con motivo obligatorio de al menos 10
caracteres. Es lo que hace defendible el registro: nada se cambia en silencio.

### Revocar el equipo de alguien que perdió su laptop

```sql
update attendance.devices
   set revoked_at = now(), revoked_by = auth.uid()
 where employee_id = '<uuid-empleado>' and device_id = '<id-del-equipo>';
```

Bloquea ese equipo sin cerrar la cuenta. Desde ese momento `punch()` lo rechaza.

---

## Aplicar una migración

No hay CLI configurado (sin `config.toml` enlazado ni contraseña de base), así
que las migraciones se aplican por MCP de Supabase.

1. Escribir el SQL en `supabase/migrations/_pendiente_<nombre>.sql`.
2. Aplicar con `apply_migration` (nombre en `snake_case`, sin marca de tiempo).
3. Leer con `list_migrations` la versión que asignó.
4. **Renombrar el archivo a `<versión>_<nombre>.sql`.**

El paso 4 no es cosmético: `apply_migration` asigna la versión por la hora de
ejecución, ignorando el nombre del archivo. Si no se renombra, repositorio y
base quedan derivados en silencio. Ya pasó una vez.
