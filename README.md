# Checador de home office

Registro de asistencia para el personal remoto de **Plásticos PIMSA**.
El empleado marca entrada, pausa, regreso y salida desde su casa; **la hora
oficial la pone el servidor, no su computadora**; RH ve en vivo quién está
trabajando y recibe alertas cuando alguien no marcó dentro de su ventana.

El registro tiene que ser defendible: si mañana hay una aclaración de nómina,
la bitácora debe sostenerse sola.

| | |
|---|---|
| **Estado** | Base de datos completa y verificada · Cliente sin empezar |
| **Base** | Supabase `pimsa_ti` (`cyjpucvvekzfpvvonuld`), Postgres 17, us-east-1 |
| **Plan** | Gratuito — ver [docs/free-plan.md](docs/free-plan.md) |
| **Personas** | 31 empleados · 15 departamentos |
| **Zona horaria** | `America/Mexico_City` |

---

## Lo primero que hay que entender

**Esta base no está vacía.** La comparte con la mesa de ayuda de TI, que está
en producción: 45 tickets, inventario de 18 equipos, responsivas, compras y
caja chica. Ese sistema es [`ti-hub`](https://github.com/LittlePitza/ti-hub),
vive en otro repositorio y se despliega en Vercel.

Consecuencia práctica: **cualquier cambio en el esquema `public` puede romper
un sistema en producción que no está en este repositorio.** Por eso las tablas
de la mesa de ayuda siguen en español y no se tocan.

---

## Cómo está pensado

Tres capas con una frontera que no se cruza:

| Capa | Responsabilidad | Regla |
|---|---|---|
| **Postgres** | Reglas de negocio, sello de tiempo, invariantes | Es la única que decide |
| **Edge Functions** (Deno) | Hablar con el mundo: correo, altas, exportar | **Nunca** contiene reglas de negocio |
| **PWA** (React) | Interfaz | Cero lógica: llama funciones y pinta datos |

No hay servidor de aplicación. Se descartó un motor en Python porque las Edge
Functions de Supabase sólo corren TypeScript sobre Deno — y el resultado quedó
más fuerte, no más débil: una regla escrita en una función `SECURITY DEFINER`
no se puede evadir ni con un token válido ni pegándole directo a la API REST,
porque **el cliente no tiene permiso de escritura sobre ninguna tabla**.

### Las cinco reglas que sostienen todo

1. **La hora la pone el servidor.** `occurred_at := now()`. Lo que mande el
   cliente se guarda aparte, en `client_reported_at`, sólo para auditar.
2. **El cliente no escribe tablas.** `authenticated` tiene `SELECT` filtrado
   por RLS y **cero** `INSERT`/`UPDATE`/`DELETE`. El único camino son las
   funciones.
3. **El `employee_id` sale del token**, nunca de un parámetro. Así nadie marca
   en nombre de otro.
4. **Los marcajes son append-only**, por disparador y no sólo por permisos —
   el rol de servicio los tiene de todos modos. Las correcciones son filas
   nuevas en `adjustments`, con motivo obligatorio.
5. **Las coordenadas no son legibles.** No se revocan: nunca se otorgan.

### El marcaje sin conexión

Es el caso incómodo y se resolvió sin fingir que no existe. La PWA encola en
IndexedDB y al reconectar manda el lote a `sync_punches()`, que:

- lo **ordena cronológicamente** antes de procesarlo, no por orden de llegada;
- procesa **cada evento en su propia subtransacción**, para que uno inválido no
  tumbe el lote;
- guarda la hora del cliente **etiquetada como tal** (`source = 'offline'`), con
  el desvío de reloj y el retraso reales.

Si el reloj está desviado más de 2 minutos, o el marcaje llega más de 12 horas
tarde, entra con `needs_review = true` y aparece marcado para que RH lo apruebe.
**Un marcaje offline es la palabra del empleado**: el sistema lo acepta, lo
etiqueta y lo pone a la vista. Ocultarlo haría inútil todo el registro.

---

## El modelo de datos

### Esquema `attendance` — el checador

| Tabla | Qué guarda |
|---|---|
| `schedules` | Ventanas de horario. Precedencia: empleado > departamento > global |
| `workdays` | Una fila por persona y día. El estado que lee el tablero |
| `punches` | Los marcajes. **Append-only** |
| `adjustments` | Correcciones de RH, con motivo obligatorio |
| `alerts` | Alertas para RH. Único `(empleado, fecha, tipo)` = idempotentes |
| `alert_rules` | Qué alertas están activas y con qué umbral, por departamento |
| `devices` | Equipos desde los que marca cada quien. Revocables |
| `consents` | Consentimiento del aviso de privacidad, por persona y versión |
| `audit_events` | Bitácora: toda acción administrativa, incluida cada consulta de coordenadas |

### Esquema `internal` — identidad y disparadores

No expuesto en la API, y **no debe agregarse a "Exposed schemas"**.
`caller_role()`, `caller_employee_id()`, `caller_department_id()`,
`can_view_employee()`, `record_punch()`, `resolve_schedule()` y los disparadores.

### Esquema `public` — lo compartido

Las 19 tablas de la mesa de ayuda (en español, intocables) más:

- `departments` — catálogo normalizado
- `user_roles` — rol por **cuenta**, no por persona
- `empleados` — preexistente; este proyecto le añadió `department_id` y
  `auth_user_id`

### La máquina de estados

```
not_started ──clock_in──▶ working ◀──break_end── on_break
                          │    │                     ▲
                          │    └────break_start──────┘
                          │
                          └──clock_out──▶ finished
```

`clock_out` desde `on_break` cierra la pausa: es un descuido común y rechazarlo
sólo dejaría la jornada colgada. Todo lo demás fuera de orden se rechaza con un
mensaje que se puede leer en pantalla.

---

## La API

El cliente no escribe tablas: llama funciones.

| Función | Quién | Qué hace |
|---|---|---|
| `my_profile()` | autenticado | Su rol y su ficha. Única RPC de identidad publicada |
| `server_time()` | autenticado | Hora oficial, para calcular el desvío de reloj |
| `punch(...)` | autenticado | Marca con la hora del servidor |
| `sync_punches(jsonb)` | autenticado | Ingesta offline en orden cronológico |
| `heartbeat()` | autenticado | Señal de vida cada 5 min con jornada abierta |

### Roles

En `public.user_roles`, uno por **cuenta** — no por persona, porque existe una
cuenta administradora que no es empleado.

| Rol | Alcance |
|---|---|
| `employee` | Sólo sus propios registros |
| `manager` | Su departamento |
| `hr` | Todos, más ajustes y alertas |
| `admin` | Todo, más configuración |
| `guest` | Por defecto si no tiene rol: **sin permisos** |

Una sola función, `internal.can_view_employee()`, decide quién ve los datos de
quién. Está en un solo lugar a propósito: cuando la regla vivía duplicada en
varias políticas, podían separarse sin que nadie lo notara.

---

## Estructura del repositorio

```
checador/
├── README.md                    este archivo
├── CLAUDE.md                    guía para trabajar en el proyecto
├── .env.example                 variables; los secretos NO van aquí
│
├── docs/
│   ├── free-plan.md             cuotas del plan gratuito y cómo se compensan
│   ├── runbook.md               operación, incidentes, puesta en marcha
│   ├── original-plan.md         el plan de arquitectura inicial
│   └── decisions/               ADRs
│
├── supabase/
│   ├── config.toml              configuración del CLI
│   ├── migrations/              11 migraciones, todas aplicadas
│   └── tests/sql/               verificación del motor (23 comprobaciones)
│
└── .github/workflows/
    ├── backup.yml               respaldo diario cifrado
    ├── keepalive.yml            evita la pausa por inactividad
    └── ci.yml                   pruebas + invariantes de seguridad
```

Falta por crear, cuando toque: `web/` (la PWA) y `supabase/functions/`
(las Edge Functions). No hay carpetas vacías esperándolos porque git no
versiona directorios vacíos y desaparecerían al clonar.

---

## Idioma

**Código y estructura en inglés. Comentarios y documentación en español.**

- Esquemas, tablas, columnas, funciones, índices, políticas, archivos: inglés.
- Valores tipo enum (`'clock_in'`, `'working'`, `'hr'`): inglés.
- Comentarios del SQL, `COMMENT ON` y `docs/`: español.
- **Mensajes de error que ve el empleado: español.** Los lee gente que no habla
  inglés.

La excepción: las 19 tablas de la mesa de ayuda siguen en español porque
`ti-hub` depende de ellas. Por eso el modelo está mezclado a propósito —
`attendance.punches.employee_id` apunta a `public.empleados.id`. No es
incoherencia, es la frontera con lo que ya existía.

---

## Puesta en marcha

Requisitos: Node 24, git. **No hace falta Docker** — sólo lo necesitan
`supabase start` y `functions serve`, que emulan todo localmente y son
opcionales.

```bash
git clone <repo> && cd checador
cp .env.example .env          # rellenar VITE_SUPABASE_PUBLISHABLE_KEY
```

Después, los pasos que **faltan** para que el sistema se use de verdad están en
[docs/runbook.md](docs/runbook.md): secretos de GitHub Actions, endurecimiento
de Auth en el panel, y crear las cuentas de prueba.

### Comandos

```bash
# Aplicar migraciones (remoto, sin Docker)
npx supabase db push

# Desplegar Edge Functions sin Docker
npx supabase functions deploy --use-api

# Regenerar los tipos de TypeScript desde la base
npx supabase gen types typescript --linked > web/src/shared/supabase/types.gen.ts

# Correr la verificación del motor (seguro: hace ROLLBACK)
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
     -f supabase/tests/sql/punch_engine_test.sql
```

---

## Plan gratuito

Decisión tomada: **el proyecto se queda en el plan gratuito.** El detalle
completo está en [docs/free-plan.md](docs/free-plan.md); lo esencial:

**Las cuotas de volumen sobran.** La base usa 14 MB de 500. Con 31 personas
marcando cuatro veces al día, ningún límite de tamaño, egress, invocaciones o
Realtime se acerca al tope.

**Los dos problemas reales no se resuelven usando menos:**

| Problema | Compensación |
|---|---|
| No hay respaldos, ni automáticos ni descargables | `backup.yml`: volcado diario **cifrado** como artefacto |
| Pausa a los 7 días de poca actividad | `keepalive.yml`: consulta diaria |

**Y lo que se poda solo**, porque a 500 MB "ya veremos" no es estrategia:
`cron.job_run_details` a 7 días, `audit_events` a 24 meses, coordenadas a 90
días. `punches`, `workdays` y `adjustments` **no se podan nunca** — son el
registro laboral.

**Lo que no tiene sustituto:** el bloqueo de contraseñas filtradas
(HaveIBeenPwned) es exclusivo de Pro. Se compensa con mínimo 12 caracteres,
registro cerrado y MFA para RH — pero no es equivalente, y conviene saberlo.

---

## Verificación

La base pasa **23 comprobaciones** automatizadas
(`supabase/tests/sql/punch_engine_test.sql`), incluidas las que realmente
importan:

- La hora oficial es la del servidor, aunque el cliente mande una fecha de 2001.
- Un `UPDATE` o `DELETE` sobre un marcaje falla, incluso desde el rol de
  servicio.
- Repetir la misma clave de idempotencia no duplica ni falla.
- Un lote offline enviado al revés se acepta completo — sólo posible si
  reordena — y el evento corrupto se rechaza aparte.
- Un reloj adelantado 10 minutos entra marcado para revisión, no en silencio.
- Sin consentimiento registrado, las coordenadas se descartan.
- Empleado, jefe, RH, admin y cuenta sin rol ven exactamente lo que les toca.

Es seguro correrlo contra la base real: todo ocurre en una transacción que
termina en `ROLLBACK`.

### Lo que aún no está verificado

Las pruebas simulan el token dentro de la base. **Falta la prueba de extremo a
extremo con `curl`**: con la sesión de un empleado real y la llave publishable,
intentar un `INSERT` directo a `attendance.punches` por la API REST y llamar
`punch()` con una hora falsa. Ambos deben fallar. Hasta hacerla, la promesa de
la regla 2 está verificada por construcción pero no por experimento.

---

## Estado y qué sigue

| | |
|---|---|
| ✅ | Catálogo de departamentos, roles, vínculo con `auth` |
| ✅ | Endurecimiento de RLS de la mesa de ayuda |
| ✅ | Esquema `attendance`, RLS y privilegios |
| ✅ | Motor de marcaje: estados, idempotencia, append-only, offline |
| ✅ | Mantenimiento y respaldos del plan gratuito |
| ⬜ | Cuentas de acceso y endurecimiento de Auth |
| ⬜ | Horarios por departamento y evaluador de alertas |
| ⬜ | Edge Function de correo (sobre `config_correo`) |
| ⬜ | PWA: login, marcaje, cola offline, service worker |
| ⬜ | Tablero de RH y administración |

### Deuda conocida

- **Alias en español en 20 políticas de producción.** Se leen como
  `(SELECT internal.caller_role() AS rol_actual)`: Postgres congeló el alias de
  salida al crear la política. La llamada apunta bien y el comportamiento es
  idéntico. Se limpia cuando haya que tocar esas políticas por otro motivo, no
  antes.
- **`config_correo` guarda secretos en texto plano** (`smtp_pass`,
  `azure_client_secret`, `oauth_refresh_token`). Con RLS sólo los lee `admin`,
  pero viajan en cualquier respaldo. Mover a Vault.
- **`empleados.departamento` (texto) es obsoleta.** Existe sólo para no romper
  `ti-hub`; un disparador la mantiene sincronizada con `department_id`. Se
  elimina cuando ese código migre.
- **8 de 31 empleados no tienen departamento.** Los cubre el horario global,
  que existe justamente por eso.
