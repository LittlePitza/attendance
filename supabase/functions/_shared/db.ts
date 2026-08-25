import { Pool } from '@db/postgres';
import { SUPPORTED_METHOD } from './graph.ts';
import type { ClaimedNotification, MailConfig } from './types.ts';

/**
 * A direct connection, with the service role.
 *
 * Not `supabase-js`: `attendance` is deliberately absent from the exposed
 * schemas, so PostgREST cannot reach `claim_notifications()` or
 * `complete_notification()` however many privileges the caller holds. Publishing
 * `public` wrappers would put two more SECURITY DEFINER functions on the REST
 * surface for no gain -- nothing in a browser ever calls these. See
 * docs/decisions/ADR-0002-alert-delivery-outbox.md.
 *
 * `SUPABASE_DB_URL` is injected by the platform; it is never set by hand and
 * never appears in the repository.
 *
 * One connection, created lazily at module scope: a warm isolate reuses it
 * across invocations, and a cold one pays for it only if there is work.
 */
const pool = new Pool(requiredEnv('SUPABASE_DB_URL'), 1, true);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing ${name}. It is part of the function's environment, not the repository.`,
    );
  }
  return value;
}

async function withConnection<T>(use: (c: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    return await use(connection);
  } finally {
    // Back to the pool, not closed: releasing is what makes the next
    // invocation on this isolate free.
    connection.release();
  }
}

type PoolConnection = Awaited<ReturnType<typeof pool.connect>>;

/**
 * The mail account the help desk already configured. Read, never written: one
 * mail configuration, one place to change it.
 *
 * `activo` is respected because it is how the help desk turns mail off. Sending
 * attendance alerts through an account somebody has deliberately disabled would
 * be going around them.
 */
export async function loadMailConfig(): Promise<MailConfig> {
  const rows = await withConnection(async (connection) => {
    const result = await connection.queryObject<{
      activo: boolean;
      metodo: string;
      remitente: string | null;
      azure_tenant_id: string | null;
      azure_client_id: string | null;
      azure_client_secret: string | null;
    }>`
      select activo, metodo, remitente, azure_tenant_id, azure_client_id, azure_client_secret
        from public.config_correo
       where id = 1
    `;
    return result.rows;
  });

  const row = rows[0];
  if (row === undefined) {
    throw new Error('public.config_correo has no row 1: mail is not configured');
  }
  if (!row.activo) {
    throw new Error('Mail is disabled in public.config_correo (activo = false)');
  }
  if (row.metodo !== SUPPORTED_METHOD) {
    throw new Error(
      `public.config_correo.metodo is '${row.metodo}'; this dispatcher implements '${SUPPORTED_METHOD}' only`,
    );
  }

  const sender = row.remitente?.trim() ?? '';
  const tenantId = row.azure_tenant_id?.trim() ?? '';
  const clientId = row.azure_client_id?.trim() ?? '';
  const clientSecret = row.azure_client_secret ?? '';

  // Named individually: "mail is misconfigured" sends somebody to read six
  // columns, and the one that is empty is the whole answer.
  const missing = [
    sender === '' ? 'remitente' : null,
    tenantId === '' ? 'azure_tenant_id' : null,
    clientId === '' ? 'azure_client_id' : null,
    clientSecret === '' ? 'azure_client_secret' : null,
  ].filter((name) => name !== null);

  if (missing.length > 0) {
    throw new Error(`public.config_correo is missing: ${missing.join(', ')}`);
  }

  return { method: row.metodo, sender, tenantId, clientId, clientSecret };
}

/**
 * Claims a batch. The database picks what is due, skips what another dispatcher
 * holds, reclaims what an abandoned one left, and counts the attempt. This
 * function does not get an opinion about any of it.
 */
export async function claimNotifications(limit: number): Promise<ClaimedNotification[]> {
  return await withConnection(async (connection) => {
    const result = await connection.queryObject<ClaimedNotification>`
      select id, alert_id, channel, recipients, payload, attempts
        from attendance.claim_notifications(${limit})
    `;
    return result.rows;
  });
}

/**
 * Reports one outcome. `null` is success; anything else is the reason, which
 * the database stores and turns into a retry or a final failure.
 */
export async function completeNotification(id: string, error: string | null): Promise<void> {
  await withConnection(async (connection) => {
    await connection.queryObject`
      select attendance.complete_notification(${id}::uuid, ${error}::text)
    `;
  });
}
