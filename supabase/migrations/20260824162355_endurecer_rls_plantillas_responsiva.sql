-- Corrige un defecto de la migracion anterior (endurecer_rls_existente).
--
-- Esa migracion quitaba las politicas permisivas buscandolas por nombre,
-- asumiendo la convencion "<tabla>_autenticados". La suposicion falla: la
-- politica de plantillas_responsiva se llama "plantillas_autenticados". El drop
-- no la alcanzo, la politica permisiva sobrevivio junto a la nueva de admin, y
-- como las politicas permisivas se combinan con OR, esa tabla seguia
-- completamente abierta a cualquier cuenta autenticada.
--
-- Lo detecto la verificacion posterior, no el resultado de la migracion: la
-- migracion reporto exito. De ahi la regla de contar las politicas permisivas
-- restantes despues de cada cambio, en lugar de confiar en que no hubo error.
--
-- Se verifico antes de aplicar esto que la tabla ya tenia
-- plantillas_responsiva_solo_admin, asi que al quitar la permisiva queda
-- protegida y nadie se queda fuera.

drop policy if exists plantillas_autenticados on public.plantillas_responsiva;

-- ----------------------------------------------------------- como verificarlo ---
--   select count(*) from pg_policies
--    where schemaname = 'public' and cmd = 'ALL' and qual = 'true';
--   -- Esperado: 0
