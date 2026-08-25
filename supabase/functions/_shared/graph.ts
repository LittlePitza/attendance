import type { MailConfig } from './types.ts';

/**
 * Sending through Microsoft Graph, with the application credentials the help
 * desk already uses.
 *
 * `config_correo.metodo` is `graph_app` on this installation, which is
 * client-credentials: the function authenticates as the registered application
 * and sends as a fixed mailbox, with no user and no refresh token involved.
 *
 * The other two methods the column allows -- `smtp_basico` and
 * `oauth_interactivo` -- are refused loudly rather than half-implemented. If
 * somebody switches the help desk to one of them, attendance mail stops with an
 * explanation sitting in `last_error`, which is a far better failure than a
 * quiet SMTP path nobody has ever run.
 */
export const SUPPORTED_METHOD = 'graph_app';

const TOKEN_SCOPE = 'https://graph.microsoft.com/.default';

/** Renewed a minute before it expires, so a send never races the expiry. */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * Module scope, so a warm isolate sending a batch of twenty asks Azure for one
 * token instead of twenty. A cold start simply finds it empty.
 */
let cachedToken: CachedToken | null = null;

export interface Outgoing {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
}

export async function sendMail(config: MailConfig, message: Outgoing): Promise<void> {
  if (config.method !== SUPPORTED_METHOD) {
    throw new Error(
      `Unsupported mail method '${config.method}'. This dispatcher implements '${SUPPORTED_METHOD}' only.`,
    );
  }

  const token = await accessToken(config);

  // `users/{sender}` and not `me`: there is no signed-in user in the
  // client-credentials flow, so the mailbox has to be named.
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.sender)}/sendMail`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: message.subject,
          body: { contentType: 'Text', content: message.text },
          toRecipients: message.to.map((address) => ({ emailAddress: { address } })),
          // No `from`. The mailbox in the URL is the sender, and naming it
          // again in the body would make delivery depend on the application
          // also holding SendAs. The display name comes from the mailbox.
        },
        // Alerts are machine-generated and nobody reads this mailbox's Sent
        // folder. The outbox row is the record that it was sent.
        saveToSentItems: false,
      }),
    },
  );

  // Graph answers 202 with an empty body: accepted for delivery.
  if (!response.ok) {
    throw new Error(`Graph sendMail failed: ${response.status} ${await problem(response)}`);
  }

  // The body is empty, but it must still be consumed or the connection leaks.
  await response.body?.cancel();
}

async function accessToken(config: MailConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken !== null && cachedToken.expiresAt > now) {
    return cachedToken.value;
  }

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'client_credentials',
        scope: TOKEN_SCOPE,
      }),
    },
  );

  if (!response.ok) {
    // Azure reports the reason in `error_description` and never echoes the
    // secret back, so this is safe to surface into `last_error`.
    throw new Error(`Azure token request failed: ${response.status} ${await problem(response)}`);
  }

  const body = await response.json() as { access_token?: string; expires_in?: number };
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new Error('Azure token response carried no access_token');
  }

  const lifetimeMs = (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000;
  cachedToken = {
    value: body.access_token,
    expiresAt: now + Math.max(0, lifetimeMs - EXPIRY_MARGIN_MS),
  };

  return cachedToken.value;
}

/**
 * Enough of a failure body to diagnose it, capped so a provider having a very
 * bad day cannot push an HTML error page into `last_error`, which is trimmed to
 * 2000 characters anyway.
 */
async function problem(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '(no body)';
  }
}

/** Used by tests to start from a cold isolate. */
export function forgetCachedToken(): void {
  cachedToken = null;
}
