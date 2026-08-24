# Vivir en el plan gratuito

Decisión tomada: **este proyecto se queda en el plan gratuito de Supabase.**
Este documento dice qué implica exactamente, qué se hizo para compensarlo, y
cuáles son las dos cosas que el plan gratuito **no** permite compensar.

---

## Las cuotas, y cuánto se usa de cada una

Verificadas en la documentación de Supabase, no de memoria.

| Recurso | Cuota gratuita | Uso estimado con 31 personas | Holgura |
|---|---|---|---|
| **Base de datos** | 500 MB por proyecto | 14 MB hoy · ~35 MB al año | Alta |
| **Egress** | 5 GB sin caché + 5 GB con caché al mes | ~150 MB/mes | Alta |
| **Edge Functions** | 500 000 invocaciones/mes | ~22 000/mes | Alta |
| **Realtime** | 2 000 000 mensajes/mes · 200 conexiones | ~15 000 mensajes · 35 conexiones | Alta |
| **Usuarios activos** | 50 000 al mes | 31 | Enorme |
| **Almacenamiento** | 1 GB | 0 (no se usa) | — |
| **Respaldos** | **Ninguno** | — | **Sin holgura** |
| **Pausa** | **A los 7 días de poca actividad** | — | **Sin holgura** |

La conclusión importante: **el tamaño no es el problema.** Con 31 personas
marcando cuatro veces al día, ninguna cuota de volumen se acerca al límite.
Los dos problemas reales son los respaldos y la pausa, y ninguno se resuelve
usando menos.

### Por qué 500 MB no aprieta

Un marcaje ocupa unos 250 bytes. 31 personas × 4 marcajes × 250 días hábiles =
31 000 filas al año, unos 8 MB con índices. La base tardaría **décadas** en
llegar a 500 MB por marcajes.

Ojo con un detalle: esta base **la comparte la mesa de ayuda** (`ti-hub`), con
sus tickets, inventario, responsivas, facturas y caja. Los 500 MB son de los
dos sistemas juntos. Hoy suman 14 MB, así que sigue sin apretar, pero el número
a vigilar es el total, no el del checador.

---

## Lo que crece sin techo (y ya está podado)

El riesgo real no es el registro de asistencia: son las tablas de operación que
crecen para siempre si nadie las corta. Tres tablas, tres tratamientos:

| Tabla | ¿Se limpia sola? | Qué se hizo |
|---|---|---|
| `net._http_response` | Sí, a las 6 horas | Nada. `pg_net` ya la purga |
| `cron.job_run_details` | **No** | Poda diaria a 7 días |
| `attendance.audit_events` | **No** | Poda semanal a 24 meses |

`cron.job_run_details` merece una nota: guarda una fila por cada ejecución de
cada trabajo. Con un trabajo por minuto son 43 200 filas al mes que no le
sirven a nadie pasada una semana. La documentación de Supabase la señala como
causa de fallos al actualizar la versión de Postgres.

### Lo que nunca se poda

`punches`, `workdays` y `adjustments` **no se tocan jamás**. Son el registro
laboral: la LFT obliga a conservarlos y son exactamente la evidencia que este
sistema existe para producir. Cualquier "optimización" que los recorte destruye
el propósito del proyecto.

Las coordenadas son la excepción, y no por espacio sino por privacidad: se
borran a los 90 días porque así se prometió en el aviso de privacidad. La fila
del marcaje se queda; sólo desaparece la ubicación.

Los tres trabajos están programados en `pg_cron`:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

| Trabajo | Horario (local) | Qué hace |
|---|---|---|
| `attendance_purge_geolocation` | Diario 03:00 | Borra coordenadas de más de 90 días |
| `attendance_prune_audit_events` | Domingos 03:30 | Bitácora a 24 meses |
| `attendance_prune_cron_history` | Diario 03:45 | Historial de cron a 7 días |

> `pg_cron` corre en **UTC**. Mexico_City es UTC−6, por eso los horarios en el
> cron dicen 09:00 y no 03:00.

---

## Problema 1: no hay respaldos

**El plan gratuito no hace respaldos.** Ni automáticos, ni descargables. Si la
base se corrompe o alguien borra algo, no hay a dónde volver.

Un registro de asistencia sin respaldo es indefendible en una aclaración de
nómina. Así que el respaldo lo hacemos nosotros: `.github/workflows/backup.yml`
corre todos los días a las 04:00, vuelca esquema, datos y roles por separado,
**los cifra** y los sube como artefacto.

### Por qué cifrado

El volcado contiene los datos personales de 31 personas y su asistencia
completa. Un artefacto de GitHub lo puede descargar cualquiera con acceso de
lectura al repositorio. Subirlo en claro sería una fuga esperando a ocurrir, y
choca de frente con lo que promete el aviso de privacidad.

Se cifra con GPG simétrico (AES-256) usando el secreto `BACKUP_PASSPHRASE`.

> **Si se pierde la frase, los respaldos son basura.** Guardarla fuera de
> GitHub — en el gestor de contraseñas de la empresa, no en el repositorio, no
> en un correo, no en este archivo.

### Retención, y otra cuota gratuita que vigilar

Los artefactos se guardan **30 días**, no 90. GitHub Free da 500 MB de
almacenamiento de artefactos; noventa copias lo desbordarían y GitHub empezaría
a rechazar subidas en silencio.

Para conservar más tiempo: **descargar la copia del día 1 de cada mes y
guardarla fuera** (Drive de la empresa, disco de respaldo). Eso da historia
anual sin pagar nada.

### Restaurar

```bash
gpg --decrypt --output respaldo.tar.gz respaldo-AAAAMMDD.tar.gz.gpg
tar -xzf respaldo.tar.gz
psql "$SUPABASE_DB_URL" -f roles.sql
psql "$SUPABASE_DB_URL" -f schema.sql
psql "$SUPABASE_DB_URL" -f data.sql
```

Conviene **probar una restauración completa al menos una vez** antes de que el
sistema entre en uso real, contra un proyecto Supabase distinto. Un respaldo
que nunca se restauró es una hipótesis, no un respaldo.

---

## Problema 2: la pausa por inactividad

Supabase pausa los proyectos gratuitos tras **7 días de poca actividad de base
de datos**. Su documentación es explícita: bastan unas pocas consultas de
usuario al día para quedar excluido.

En uso normal esto sobra: 31 personas marcando generan actividad de sobra. El
riesgo son los periodos muertos — la semana de vacaciones de diciembre, o el
tiempo entre hoy y el arranque real.

`.github/workflows/keepalive.yml` corre todos los días y hace una consulta
mínima sobre tablas reales. El respaldo diario también cuenta como actividad,
pero el latido va aparte a propósito: si el respaldo falla, el proyecto no debe
quedarse además sin latido.

### Si aun así se pausa

Hay **90 días** para restaurarlo con un botón desde el panel de Supabase, con
todos los datos intactos. Pasados los 90 días ya sólo queda descargar el
respaldo — que es justamente por lo que existe `backup.yml`.

---

## Lo que no se puede compensar

Dos cosas del plan Pro no tienen sustituto en el gratuito. Conviene saberlas,
no descubrirlas.

### 1. Bloqueo de contraseñas filtradas

El plan Pro consulta HaveIBeenPwned y rechaza contraseñas que aparecen en
filtraciones conocidas. En el gratuito **no se puede activar**, y aparece
permanentemente como advertencia en el advisor de seguridad. No es un descuido:
es el plan.

Lo que se hace en su lugar:

- Mínimo **12 caracteres** con mayúscula, minúscula, dígito y símbolo.
- Las cuentas las crea RH, no se registra nadie solo (`enable_signup = false`).
- Al alta, contraseña generada al azar y cambio obligatorio.
- Sesión persistente con rotación de refresh token, revocable por RH.

No es equivalente. Alguien puede seguir eligiendo `Password2026!`, que cumple
la regla y está en todas las listas de filtraciones. Es el costo aceptado.

### 2. Recuperación a un punto en el tiempo (PITR)

Sin PITR, la ventana de pérdida es **hasta 24 horas**: lo que haya pasado entre
el último respaldo de las 04:00 y el incidente. Para un checador de 31 personas
eso significa, en el peor caso, perder un día de marcajes — recuperable
preguntando, y con la bitácora de `adjustments` para dejar constancia de la
corrección.

Si algún día eso deja de ser aceptable, el camino es Pro ($25/mes por
organización), no más ingeniería.

---

## Cuándo dejar de estar en gratuito

Señales concretas, por si cambia el panorama:

- La base pasa de **350 MB** (70 % de la cuota). Revisar con
  `select * from attendance.free_plan_usage;`
- El egress mensual pasa de **3.5 GB**. Se ve en el panel, en Usage.
- Perder un día de datos deja de ser tolerable.
- Se necesita más de un entorno (staging), porque el gratuito da dos proyectos
  y uno ya lo ocupa producción.

Ninguna está cerca hoy.
