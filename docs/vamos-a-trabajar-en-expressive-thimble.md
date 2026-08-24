# Checador de Home Office — Plan de arquitectura e implementación

## Contexto

La empresa se va a home office y no hay forma de saber si el personal remoto
inició su jornada, tomó sus pausas o cerró su turno. Hoy eso se resolvería por
WhatsApp, sin registro confiable ni nada que RH pueda auditar después.

Se necesita que el empleado marque entrada, pausa, regreso y salida desde su
casa, que **la hora oficial la ponga el servidor y no la computadora del
empleado**, que RH vea en vivo quién está trabajando, y que reciba alertas
cuando alguien no marcó dentro de su ventana de horario o perdió conexión. El
registro debe ser defendible: si mañana hay una aclaración de nómina, la bitácora
tiene que sostenerse.

**Este proyecto no arranca en vacío.** El proyecto Supabase `pimsa_ti`
(`cyjpucvvekzfpvvonuld`, Postgres 17.6, us-east-1) ya es un sistema de TI en
producción — mesa de ayuda con 45 tickets y 117 eventos, inventario de 18
equipos, responsivas, mantenimientos, compras y caja — y ya contiene dos piezas
que este proyecto debe reutilizar en lugar de reinventar:

- **`public.empleados`** (31 registros): `nombre`, `correo` único,
  `departamento`, `puesto`, `extension`, `estado`.
- **`public.config_correo`**: configuración de envío ya funcionando, con soporte
  `smtp_basico` / `graph_app` / `oauth_interactivo`, credenciales de Azure y
  plantillas con variables `{{...}}`.

### Decisiones tomadas con el usuario

| Tema | Decisión |
|---|---|
| Arquitectura | **Todo en Supabase.** Sin motor Python (ver §1) |
| Cliente | PWA instalable en React, funciona offline y sincroniza |
| Base de datos | Misma base de `pimsa_ti`, en un **esquema propio `checador`** |
| Empleados | Reutilizar `public.empleados` **y normalizar departamentos** a catálogo con llave foránea |
| Autenticación | Correo + contraseña propios, restablecibles por RH/admin, sesión persistente |
| Horarios | Ventana por departamento, con excepciones por empleado |
| Geolocalización | Coordenadas guardadas, purga automática a 90 días |
| Tamaño | 20–100 personas; roles empleado / jefe / RH / admin |
| Zona horaria | `America/Mexico_City` |
| Alcance semana 1 | Núcleo completo: marcaje + offline + tablero RH + alertas |
| Compatibilidad | Windows (ver §7) |
| **Pendiente** | Plan Pro para respaldos — decisión de negocio, no bloquea (§8) |

### Tres aclaraciones sobre lo pedido

1. **No se guarda la contraseña en el equipo.** Se guarda una *sesión
   persistente* que se renueva sola: el empleado no reescribe su contraseña en
   semanas, pero si se pierde el equipo RH revoca la sesión y el acceso muere
   ahí. Guardar la contraseña real dejaría credenciales corporativas en disco.

2. **Renunciar a Python no baja la seguridad, la sube.** Con un motor Python
   había un servidor de aplicación que *podía* ser rodeado; aquí las reglas viven
   dentro de Postgres, donde nada las puede saltar, y el sello de tiempo lo pone
   el reloj de la propia base. Está detallado en §2 y §6.

3. **Lo que sí se pierde:** el ecosistema de Python para reportes (pandas,
   openpyxl). Generar Excel en Deno se hace con SheetJS y es menos cómodo. Es el
   único costo real y cae en la semana 2, no en el núcleo.

---

## 1. Arquitectura: tres capas con una frontera clara

Verificado en la documentación de Supabase: **Edge Functions solo corren
TypeScript sobre Deno; no existe runtime de Python.** De ahí la regla que
gobierna todo el diseño:

| Capa | Responsabilidad | Regla que no se rompe |
|---|---|---|
| **Postgres** | Reglas de negocio, sello de tiempo, invariantes, alertas | Es la única que decide. Nada la puede rodear |
| **Edge Functions** (Deno/TS) | Hablar con el mundo exterior: correo, altas de usuario, exportar | **Nunca** contiene reglas de negocio. Solo orquesta |
| **PWA** (React/TS) | Interfaz | Cero lógica. Solo llama funciones y pinta datos |

Esto reemplaza al motor Python con algo más fuerte: una regla escrita en una
función `SECURITY DEFINER` de Postgres no se puede evadir ni con un token válido
ni llamando la API REST directo, porque el cliente **no tiene permiso de
escritura sobre ninguna tabla**.

---

## 2. El corazón: la hora y la inmutabilidad

1. **Handshake de tiempo.** `checador.hora_servidor()` devuelve `now()`. La PWA
   calcula `desvio = hora_servidor − hora_local` y lo guarda junto a una
   referencia monótona (`performance.now()`, que no se altera si el usuario mueve
   el reloj de Windows).

2. **Marcaje en línea.** La PWA llama `checador.marcar(...)`. La función
   **ignora cualquier hora que mande el cliente** para el registro oficial:
   `ocurrio_en := now()` del servidor. La hora del cliente se guarda aparte en
   `reportado_cliente`, solo como dato de auditoría. `origen = 'linea'`.

3. **Marcaje sin conexión.** Se encola en IndexedDB con la hora estimada usando
   el último desvío conocido. Al reconectar, `checador.sincronizar(p_eventos
   jsonb)` los procesa **en orden cronológico, no en orden de llegada**, con
   `origen = 'offline'`, `retraso_sync_seg` y `desvio_reloj_ms`. Si el desvío o
   el retraso rebasan el umbral, entra con `requiere_revision = true` y aparece
   marcado en el tablero para que RH lo apruebe o corrija.

4. **Nunca se confía en silencio en el reloj del cliente.** Un marcaje offline es
   la palabra del empleado: el sistema lo acepta, lo etiqueta y lo pone a la
   vista. Ocultarlo haría inútil todo el registro.

5. **Idempotencia.** `clave_idempotencia uuid UNIQUE NOT NULL`. Una red inestable
   puede reintentar el mismo marcaje diez veces sin duplicar nada.

6. **Append-only de verdad.** Sobre `checador.marcajes` se hace
   `REVOKE UPDATE, DELETE` — nadie los modifica, ni el cliente ni el rol de
   servicio. Toda corrección es una fila nueva en `checador.ajustes` con autor y
   motivo obligatorio. Una tabla editable no sirve como evidencia.

7. **Máquina de estados**, validada dentro de `marcar()`:
   `no_iniciada → trabajando ⇄ en_pausa → finalizada`.
   `entrada` solo desde `no_iniciada`; `pausa_inicio` solo desde `trabajando`;
   `pausa_fin` solo desde `en_pausa`; `salida` desde `trabajando` o `en_pausa`
   (cerrando la pausa abierta). Lo fuera de orden se rechaza con mensaje claro.

---

## 3. Modelo de datos

Se siguen **las convenciones que ya usa `pimsa_ti`**, para que el código nuevo se
lea igual que el existente: nombres en español, `id uuid default
gen_random_uuid()`, `num integer` con secuencia para folios legibles, `text` con
`CHECK` en vez de enums, `timestamptz default now()`, `jsonb default '{}'`, RLS
activo en todas las tablas, y bitácora al estilo de `ticket_eventos`.

### Cambios en `public` (compartido, aditivos)

| Objeto | Cambio |
|---|---|
| `public.departamentos` | **Nueva.** `nombre` único, `zona_horaria` default `America/Mexico_City`, `activo` |
| `public.empleados` | **+** `departamento_id` → `departamentos`, **+** `auth_user_id` único → `auth.users`, **+** `rol text CHECK ('empleado','jefe','rh','admin')` |

### Esquema `checador`

| Tabla | Campos clave |
|---|---|
| `horarios` | `alcance ('departamento'\|'empleado')`, `departamento_id`, `empleado_id`, `vigente_desde/hasta`, `dias int[]`, `entrada_desde`, `entrada_hasta`, `entrada_esperada`, `salida_esperada`, `tolerancia_min`, `pausa_max_min` |
| `jornadas` | `empleado_id`, `fecha`, `estado`, `abierta_en`, `cerrada_en`, `segundos_trabajados`, `segundos_pausa`, `ultimo_latido`. `UNIQUE (empleado_id, fecha)` |
| `marcajes` | **Append-only.** `tipo`, `ocurrio_en`, `registrado_en`, `reportado_cliente`, `origen`, `clave_idempotencia` único, `desvio_reloj_ms`, `retraso_sync_seg`, `requiere_revision`, `ip`, `agente`, `dispositivo_id`, `geo_lat`, `geo_lng`, `geo_precision_m`, `geo_purga_en` |
| `ajustes` | `marcaje_id`, `valor_anterior`, `valor_nuevo`, `motivo` **NOT NULL**, `ajustado_por` |
| `alertas` | `tipo`, `severidad`, `fecha`, `detalle jsonb`, `estado`, `notificada_en`, `reconocida_por`, `nota`. **`UNIQUE (empleado_id, fecha, tipo)`** |
| `reglas_alerta` | Por departamento: `tipo`, `activa`, `umbral_min`, `destinos` |
| `dispositivos` | `dispositivo_id`, `primera_vez`, `ultima_vez`, `revocado_en` — para revocar un equipo perdido |
| `consentimientos` | `version_aviso`, `aceptado_en`, `ip` — requisito de la geolocalización |
| `eventos` | Bitácora: `tipo`, `entidad`, `entidad_id`, `autor`, `antes jsonb`, `despues jsonb`, `ip` |

Tipos de alerta: `entrada_tarde`, `falta_entrada`, `pausa_excedida`,
`falta_salida`, `sin_conexion`, `revisar_offline`, `reloj_alterado`.

Índices: `marcajes(empleado_id, ocurrio_en DESC)`, único en
`clave_idempotencia`, `jornadas(fecha, empleado_id)`, `alertas(estado, fecha)`,
e índice parcial `WHERE requiere_revision`.

### Migración de departamentos, sin romper la mesa de ayuda

`empleados.departamento` es texto libre y lo consume el sistema de tickets que ya
está en producción. Se usa **expand / contract**, sin ningún paso destructivo
esta semana:

1. **Paso 0 — inspeccionar.** Listar los valores distintos y unificar variantes a
   mano (`"Ventas"` vs `"ventas "`) *antes* de crear la restricción única.
   > No pude leer los valores reales: la API de administración de Supabase
   > respondía 503 al momento de planear. Es la primera tarea del día 1.
2. **Expandir.** Crear `departamentos`, sembrarlo, agregar `departamento_id`,
   rellenarlo por coincidencia de nombre.
3. **Sincronizar.** Un trigger mantiene la columna `departamento` (texto) al día
   desde `departamento_id`, **así el código de tickets sigue funcionando sin
   tocarlo**.
4. **Contraer (después, no esta semana).** Migrar el código de tickets a
   `departamento_id` y recién entonces eliminar la columna de texto.

---

## 4. La API: funciones de Postgres

El cliente no escribe tablas; llama funciones. Toda función es `SECURITY
DEFINER` con **`SET search_path = ''`** y nombres calificados por completo — sin
eso, un `search_path` manipulado permite secuestrar la función, y es justo lo que
marca el linter de seguridad de Supabase.

| Función | Quién puede | Qué hace |
|---|---|---|
| `hora_servidor()` | autenticado | Devuelve `now()` para el handshake de reloj |
| `marcar(...)` | autenticado (solo él mismo) | Valida estado, sella hora, inserta, devuelve la jornada |
| `sincronizar(jsonb)` | autenticado (solo él mismo) | Ingesta offline en orden cronológico, calcula desvío y marca revisión |
| `latido()` | autenticado | Señal de vida cada 5 min con jornada abierta |
| `ver_ubicacion(marcaje_id)` | rh, admin | Devuelve coordenadas **y registra la consulta** en `eventos` |
| `ajustar_marcaje(...)` | rh, admin | Crea el ajuste con motivo obligatorio |
| `atender_alerta(...)` | jefe, rh, admin | Reconocer / resolver / descartar |
| `evaluar_alertas()` | solo cron | Genera alertas idempotentes |
| `purgar_geolocalizacion()` | solo cron | Borra coordenadas con más de 90 días |

El `empleado_id` **siempre se deriva del token** (`auth.uid()` →
`empleados.auth_user_id`), nunca de un parámetro. Así nadie marca en nombre de
otro. Un tope por minuto dentro de `marcar()` frena abuso automatizado.

**Vistas de lectura:** `v_mi_jornada` (lo propio), `v_tablero` (tablero en vivo,
**sin coordenadas**), `v_alertas_abiertas`.

---

## 5. Alertas y tareas programadas

`pg_cron` 1.6.4, `pg_net` 0.20.3 y `supabase_vault` ya están disponibles en el
proyecto. La evaluación **no necesita Edge Function**: es SQL puro.

| Frecuencia | Trabajo |
|---|---|
| Cada minuto | `select checador.evaluar_alertas();` — SQL puro, sin salir de la base |
| Cada 2 min | `net.http_post(...)` → Edge Function `alertas-notificar`, que envía los correos pendientes |
| Diario | `select checador.purgar_geolocalizacion();` |
| Diario | Respaldo (§8) |

Las alertas son **idempotentes** por el único `(empleado_id, fecha, tipo)`: el
evaluador corre cada minuto sin inundar a RH de duplicados.

`alertas-notificar` **reutiliza `public.config_correo`** — mismo SMTP/Graph y
mismo estilo de plantillas `{{variables}}` que ya usa la mesa de ayuda. No se
construye un sistema de correo nuevo.

Los secretos que el cron necesita para llamar la función van en **Vault**
(`vault.create_secret`), nunca escritos dentro del `cron.schedule`.

---

## 6. Seguridad y confidencialidad

Lo que realmente protege el sistema, en orden de importancia:

1. **El cliente no puede escribir.** A `authenticated` se le da `SELECT` (filtrado
   por RLS) y **ningún** `INSERT`/`UPDATE`/`DELETE` sobre las tablas de
   `checador`. El único camino de escritura son las funciones. Un empleado con su
   token válido pegándole directo a la API REST de Postgres no puede insertar un
   marcaje falso.
2. **RLS en todas las tablas**, con el patrón que ya usa el proyecto: el empleado
   ve lo suyo, el jefe su departamento, RH todo.
3. **Coordenadas con privilegio de columna.** `REVOKE SELECT (geo_lat, geo_lng)`
   a `authenticated`; el único acceso es `ver_ubicacion()`, que **deja rastro en
   la bitácora**. Un `SELECT` normal no se puede auditar de forma confiable; una
   función sí. Así "cada consulta queda registrada" es una garantía técnica, no
   una promesa.
4. **Append-only** en marcajes + bitácora `eventos` de toda acción
   administrativa.
5. **`SET search_path = ''`** en cada `SECURITY DEFINER`.
6. **Endurecimiento de Auth:** mínimo 12 caracteres exigiendo mayúscula,
   minúscula, dígito y símbolo; reautenticación para cambiar contraseña; MFA para
   RH y admin; CAPTCHA opcional en login. Supabase almacena las contraseñas con
   bcrypt y sal por usuario. El **bloqueo de contraseñas filtradas
   (HaveIBeenPwned) solo existe en plan Pro** — otro argumento para §8.
7. **Solo la llave publishable llega al navegador.** La llave secreta vive
   únicamente como variable de entorno de las Edge Functions.
8. **`get_advisors` (security y performance) después de cada migración**, y se
   corrige todo lo que marque. Es el linter oficial y detecta RLS faltante y
   `search_path` mutable.

### Hallazgo de seguridad en lo que ya existe

`public.config_correo` guarda `smtp_pass`, `azure_client_secret` y
`oauth_refresh_token` como **texto plano**. Con RLS activo no es una fuga, pero
cualquiera con acceso al dashboard o a un respaldo los lee. Recomendación:
moverlos a Vault y dejar en la tabla solo la referencia. No bloquea el checador,
pero conviene arreglarlo mientras se está en el código.

### Privacidad (verificar con RH y jurídico — esto no es asesoría legal)

Guardar coordenadas con retención de 90 días obliga a tres cosas, ya incluidas:
aviso de privacidad con **consentimiento explícito registrado**
(`checador.consentimientos`), acceso restringido y **auditado** vía
`ver_ubicacion()`, y purga automática diaria. Vale confirmar el encuadre frente a
la reforma de teletrabajo de la LFT (Cap. XII Bis), la NOM-037-STPS-2023 y la
LFPDPPP (derechos ARCO, finalidad limitada).

---

## 7. Compatibilidad con Windows

Entorno verificado en la máquina: **Python 3.14.6, Node 24.18.1, npm 11.16.0,
git 2.55, uv 0.12.5. Sin Docker. Sin pnpm.**

| Tema | Cómo se resuelve |
|---|---|
| Supabase CLI | Instalar **local al proyecto** (`npm i -D supabase`), no global. Funciona nativo en Windows |
| Migraciones | `supabase db push` — es una llamada remota, **no necesita Docker** |
| Desplegar funciones | `supabase functions deploy --use-api`. La documentación confirma que el CLI cae a despliegue por API cuando no hay Docker |
| Probar SQL | **pgTAP** (ya disponible en el proyecto) contra la base. Sin Docker |
| Probar TS | `deno test` — Deno instala nativo en Windows. Sin Docker |
| Lo que sí requiere Docker | Solo `supabase start` y `supabase functions serve` (emulación local completa). Opcional: instalar Docker Desktop después, para paridad de entorno |
| Fin de línea | **`.gitattributes` con `* text=auto eol=lf`** y `*.sql`/`*.ts` forzados a LF. Sin esto, CRLF de Windows rompe scripts y ensucia cada diff |
| Scripts npm | Sin `rm -rf` ni encadenados estilo bash; usar scripts de Node para que corran igual en cmd, PowerShell y CI |

---

## 8. Respaldos: la decisión pendiente

Verificado en la documentación: **el plan gratuito no tiene respaldos
automáticos.** Supabase recomienda explícitamente a los proyectos gratuitos
exportar con `supabase db dump` y guardar copias fuera. Los respaldos diarios
empiezan en Pro ($25 USD/mes por organización, 7 días de historia). PITR es un
complemento aparte de ~$100/mes y **no hace falta** aquí.

También: los proyectos gratuitos **se pausan tras 7 días de baja actividad** (uso
diario lo evita, pero una semana de vacaciones no).

Hoy la mesa de ayuda — 45 tickets, 117 eventos, inventario, responsivas — **no
tiene ningún respaldo**. Meterle encima el registro de asistencia sube la
apuesta: un registro de asistencia sin respaldo es indefendible ante una
aclaración de nómina.

- **Recomendación: subir la organización a Pro.** $25/mes cubre los dos sistemas
  internos, elimina el riesgo de pausa y habilita el bloqueo de contraseñas
  filtradas.
- **Si se queda en gratis:** se incluye `.github/workflows/respaldo.yml` con
  `supabase db dump` diario y retención. Corre en GitHub, no en tu equipo, así
  que no depende de que tu máquina esté encendida.

Esto **no bloquea el desarrollo** — se puede activar cualquier día. Sí debe
decidirse antes de que el sistema entre en uso real.

---

## 9. Estructura de carpetas

Monorepo en `Desarrollos_Internos/checador/`, en español para que combine con el
código existente.

```
checador/
├─ README.md  CLAUDE.md  .gitattributes  .gitignore  .env.example
├─ docs/
│  ├─ arquitectura.md   modelo-datos.md   seguridad.md
│  ├─ aviso-de-privacidad.md   runbook.md
│  └─ decisiones/ADR-0001-todo-en-supabase.md
├─ supabase/
│  ├─ config.toml
│  ├─ migrations/                       # una migración por paso, versionada
│  │  ├─ 0001_departamentos_catalogo.sql
│  │  ├─ 0002_empleados_vinculo_auth_y_rol.sql
│  │  ├─ 0003_checador_esquema_y_tablas.sql
│  │  ├─ 0004_checador_funciones_marcaje.sql
│  │  ├─ 0005_checador_rls_y_privilegios.sql
│  │  ├─ 0006_checador_horarios_y_alertas.sql
│  │  └─ 0007_checador_cron_y_purga.sql
│  ├─ functions/
│  │  ├─ deno.json
│  │  ├─ _shared/  (cors.ts, supabase.ts, correo.ts, validacion.ts)
│  │  ├─ alertas-notificar/index.ts     # reutiliza config_correo
│  │  ├─ admin-usuarios/index.ts        # alta, reset, revocar sesión
│  │  └─ reportes-exportar/index.ts     # semana 2
│  └─ tests/
│     ├─ sql/   (marcaje.test.sql, horarios.test.sql, alertas.test.sql, rls.test.sql)
│     └─ deno/  (correo.test.ts, validacion.test.ts)
├─ web/
│  ├─ package.json  vite.config.ts  tsconfig.json  index.html
│  ├─ public/  (manifest.webmanifest, iconos)
│  └─ src/
│     ├─ main.tsx  App.tsx  rutas.tsx
│     ├─ funciones/
│     │  ├─ acceso/          # login, sesión persistente, cambio de contraseña
│     │  ├─ marcaje/         # pantalla de marcaje + estado de jornada
│     │  ├─ tablero/         # tablero en vivo de RH
│     │  ├─ alertas/         # bandeja
│     │  └─ administracion/  # empleados, departamentos, horarios, resets
│     └─ compartido/
│        ├─ supabase/  (cliente.ts, tipos.gen.ts)   # tipos generados de la BD
│        ├─ offline/   (cola.ts, sincronizar.ts, reloj.ts)
│        └─ ui/  hooks/  lib/
└─ .github/workflows/
   ├─ ci.yml          # deno lint/test + pgTAP + build de la PWA
   └─ respaldo.yml    # db dump diario (si se queda en plan gratuito)
```

**Stack de la PWA:** React 19 + TypeScript + Vite, `vite-plugin-pwa` (Workbox),
TanStack Query, **Dexie** (IndexedDB) para la cola offline, Tailwind CSS v4 +
shadcn/ui, `react-hook-form` + `zod`. Los tipos de TypeScript se **generan desde
la base** (`supabase gen types`), así el frontend no puede desincronizarse del
modelo sin que falle el build.

**Tablero en vivo:** aquí sí conviene **Supabase Realtime** suscrito a
`checador.jornadas` (protegido por RLS), con *polling* de respaldo. Es una
ventaja concreta de esta arquitectura sobre la que tenía motor Python, donde
Realtime habría obligado a exponer tablas al cliente.

**Hospedaje:** la PWA son archivos estáticos → **Cloudflare Pages** (gratis,
HTTPS, sin cold start). No hace falta ningún servidor de aplicación: eso es lo
que se ganó al dejar Python.

---

## 10. Plan de la semana

| Día | Entregable |
|---|---|
| **1** | **Paso 0:** leer los valores reales de `empleados.departamento` y correr `get_advisors` (hoy daban 503). Repo, `.gitattributes`, CLI local, migraciones 0001–0002 (catálogo de departamentos + trigger de sincronía + `auth_user_id` + `rol`), alta de las 31 cuentas de acceso, endurecimiento de Auth, CI. |
| **2** | Migraciones 0003–0005: esquema `checador`, tablas, RLS y privilegios, `hora_servidor()`, `marcar()` con máquina de estados e idempotencia. **Pruebas pgTAP antes de que exista interfaz.** |
| **3** | PWA: login con sesión persistente, pantalla de marcaje, cola en IndexedDB, `sincronizar()`, service worker, indicador de conexión y de pendientes. |
| **4** | Horarios por departamento + excepciones, `evaluar_alertas()`, trabajos de `pg_cron`, Edge Function `alertas-notificar` sobre `config_correo`, pantalla de consentimiento de privacidad. |
| **5** | Tablero de RH (tabla en vivo con Realtime, filtros, detalle del día), administración (empleados, horarios, reset vía `admin-usuarios`), purga de geo, despliegue a Cloudflare Pages, repaso de advisors. |
| Semana 2 | Exportar XLSX, aprobación de ajustes, MFA para RH, reportes por periodo, y mover los secretos de `config_correo` a Vault. |

---

## 11. Verificación

**Automática**
- `supabase test db` (pgTAP): máquina de estados incluidas las transiciones
  inválidas, idempotencia de `marcar()`, precedencia de horarios
  empleado > departamento, idempotencia de alertas, y **pruebas de RLS**
  simulando el token de un empleado para comprobar que no ve filas de otro.
- `deno lint` + `deno test` para los ayudantes de TypeScript.
- `npm run build` + `tsc --noEmit` de la PWA. Todo en `ci.yml`.

**Manual, extremo a extremo (el criterio real de que funciona)**
1. Marcar entrada → `ocurrio_en` es la hora del servidor y `reportado_cliente`
   quedó guardada aparte.
2. **Prueba de escritura directa (la más importante).** Con la sesión de un
   empleado normal y la llave publishable, intentar por `curl` un `INSERT` a
   `checador.marcajes` por la API REST, y llamar `marcar()` mandando un
   `ocurrio_en` falso. **Ambos deben fallar.** Si esto pasa, todo §6 es papel.
3. **Prueba offline:** con jornada abierta, apagar el Wi-Fi, marcar pausa y
   regreso, reconectar. Ambos deben aparecer con `origen = 'offline'`, su
   retraso, y visibles como tal en el tablero.
4. **Prueba de reloj alterado:** offline, adelantar el reloj de Windows 2 horas y
   marcar. Al sincronizar debe entrar con `requiere_revision = true`, **no**
   aceptarse en silencio.
5. **Prueba de alertas:** asignar a un empleado de prueba una ventana ya vencida,
   correr `evaluar_alertas()` tres veces → **una sola** alerta, correo enviado, y
   RH puede reconocerla y resolverla.
6. **Prueba de confidencialidad:** un jefe intenta leer `geo_lat` por la API →
   rechazado. RH consulta `ver_ubicacion()` → funciona **y queda la fila en la
   bitácora**.
7. **Prueba de sesión:** cerrar y reabrir el navegador → sigue dentro. Revocar
   desde administración → fuera al instante.
8. **Prueba de no regresión:** abrir la mesa de ayuda y confirmar que tickets,
   inventario y responsivas siguen funcionando después de la migración de
   departamentos.
9. Instalar la PWA en Android y en Windows; auditoría Lighthouse.

---

## 12. Riesgos

| Riesgo | Mitigación |
|---|---|
| Plan gratuito sin respaldos, con datos de nómina encima | §8: Pro, o respaldo diario por GitHub Actions. Debe decidirse antes de uso real |
| Normalizar departamentos toca producción | Expand/contract con trigger de sincronía; **ningún paso destructivo esta semana**. Prueba de no regresión obligatoria |
| Lógica en plpgsql es menos legible que en Python | `COMMENT ON FUNCTION` en cada función, `docs/modelo-datos.md`, y pruebas pgTAP que sirven de especificación viva |
| Marcajes offline no verificables | No se resuelve técnicamente: se etiquetan, se calcula el desvío y quedan a la vista de RH |
| Límites de CPU/tiempo en Edge Functions | Se quedan delgadas; la evaluación de alertas vive en SQL, no en la función |
| Secretos en texto plano en `config_correo` | Mover a Vault en semana 2; queda documentado desde ya |
| Compartir `auth.users` con la mesa de ayuda | Un solo `rol` por empleado gobierna ambos sistemas; documentar la matriz de roles en `docs/seguridad.md` |
| API de Supabase con 503 al planear | Paso 0 del día 1 vuelve a validar valores de departamento y advisors antes de migrar |
