/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * The version in `package.json`, substituted at build time.
 *
 * It goes into the session row so the access log says which build wrote it --
 * worth having the day a fault turns out to affect only the machines that never
 * took an update. Declared here because it is a `define`, not an env variable:
 * it is replaced in the source rather than read at runtime.
 */
declare const __APP_VERSION__: string;
