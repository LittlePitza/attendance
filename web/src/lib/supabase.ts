import { createClient } from '@supabase/supabase-js';

/**
 * The one Supabase client in the application.
 *
 * Only the publishable key ever reaches the browser. It is not a secret and it
 * grants nothing on its own: every table is behind RLS and the write path is
 * `SECURITY DEFINER` functions that derive the employee from the token. What
 * would be a secret -- the service key, the connection string -- has no reason
 * to exist in this bundle and must never be added to it.
 *
 * Messages in this file are in English: a missing environment variable is a
 * deployment fault that an employee never sees. Anything that can reach the
 * screen is written in Spanish.
 */
function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in before building.`,
    );
  }
  return value;
}

export const supabase = createClient(
  requireEnv('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL),
  requireEnv('VITE_SUPABASE_PUBLISHABLE_KEY', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY),
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // There is no magic link and no OAuth provider: nothing ever arrives in
      // the URL, so there is no reason to parse it. Signup is closed; HR
      // creates the accounts.
      detectSessionInUrl: false,
    },
  },
);
