# ADR-0001 — Todo en Supabase, sin motor de aplicación

- **Fecha:** 2026-08-24
- **Estado:** Aceptada
- **Afecta a:** toda la arquitectura

## Contexto

El diseño inicial contemplaba un motor en Python que recibiera los marcajes,
aplicara las reglas de negocio y escribiera en la base. La empresa ya tiene un
proyecto Supabase (`pimsa_ti`) en producción con la mesa de ayuda de TI.

Al verificar la documentación apareció un hecho que decide el asunto: **las
Edge Functions de Supabase sólo ejecutan TypeScript sobre Deno. No existe
runtime de Python.** Mantener Python habría exigido hospedar aparte un servidor
de aplicación.

## Decisión

Las reglas de negocio viven **dentro de Postgres**, en funciones
`SECURITY DEFINER`. Las Edge Functions se limitan a hablar con el mundo
exterior (correo, altas de usuario, exportar) y no contienen ninguna regla. La
PWA no tiene lógica: llama funciones y pinta datos.

## Razones

**No baja la seguridad; la sube.** Con un motor de aplicación existe un
servidor que *puede* ser rodeado: quien consiga un token válido puede pegarle
directo a la API REST de Postgres y saltarse las reglas del motor. Aquí eso no
es posible, porque a `authenticated` no se le otorga **ningún** privilegio de
escritura sobre las tablas. El único camino es la función, y la función valida.

**El sello de tiempo lo pone el reloj de la propia base**, no un proceso
intermedio que podría estar desfasado o ser sustituido.

**Menos piezas que operar.** No hay servidor que desplegar, monitorear,
parchear ni pagar. La PWA son archivos estáticos.

## Costo aceptado

Se pierde el ecosistema de Python para reportes — `pandas`, `openpyxl`.
Generar XLSX en Deno se hace con SheetJS y es menos cómodo. Es el único costo
real y cae fuera del núcleo.

La lógica en `plpgsql` es menos legible que en Python. Se compensa con
`COMMENT ON` en cada función, este directorio de decisiones, y las pruebas de
`supabase/tests/sql/`, que sirven de especificación viva.

## Consecuencias

- Toda función lleva `SET search_path = ''` y nombres calificados por completo.
  Sin eso, un `search_path` manipulado permite secuestrarla.
- Los esquemas `internal` y `attendance` **no** se exponen en la API.
- El evaluador de alertas es SQL puro sobre `pg_cron`: no necesita salir de la
  base, y así no consume invocaciones de Edge Functions —relevante en el plan
  gratuito.
- Verificar cualquier cambio exige probar SQL, no sólo TypeScript.
