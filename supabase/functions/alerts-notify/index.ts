import { claimNotifications, completeNotification, loadMailConfig } from '../_shared/db.ts';
import { sendMail } from '../_shared/graph.ts';
import { composeMessage } from '../_shared/message.ts';
import { resolveRecipients } from '../_shared/recipients.ts';

/**
 * Drains `attendance.notification_outbox`.
 *
 * The whole of this function is: claim what the database says is due, talk to
 * the mail provider, report what happened. It owns *how* to send and nothing
 * else -- when to retry, how long to wait, when to give up and whether an alert
 * counts as notified are all decided in SQL, where they survive a deploy, a
 * restart and the Free plan's pauses.
 *
 * Delivery is at-least-once by design. A run that dies after handing a message
 * to Graph but before reporting leaves the row claimed; fifteen minutes later
 * another run reclaims it and may send a second copy. A duplicate is visible
 * and harmless, a missing notification is neither. See
 * docs/decisions/ADR-0002-alert-delivery-outbox.md.
 */

/**
 * Matches the default in `claim_notifications()`. Cron runs this every five
 * minutes, so twenty per run drains any realistic burst within one cycle, and a
 * genuine backlog drains over successive runs rather than in one long
 * invocation that risks the wall clock.
 */
const BATCH_SIZE = 20;

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!await callerIsServiceRole(request)) {
    // Deliberately not "wrong key": an unauthenticated caller learns nothing
    // about why.
    return json({ error: 'Unauthorized' }, 401);
  }

  // Loading the mail configuration before claiming anything is on purpose. If
  // mail is misconfigured, claiming first would mark twenty rows as `sending`,
  // burn an attempt on each and leave them to be reclaimed in fifteen minutes.
  // Failing here leaves the queue untouched.
  let mail;
  try {
    mail = await loadMailConfig();
  } catch (error) {
    return json({ error: describe(error) }, 500);
  }

  let claimed;
  try {
    claimed = await claimNotifications(BATCH_SIZE);
  } catch (error) {
    return json({ error: describe(error) }, 500);
  }

  let sent = 0;
  let failed = 0;

  // Sequential, not parallel: twenty messages is not worth the concurrency, and
  // Graph throttles per mailbox. A slow provider costs one run, not a queue.
  for (const notification of claimed) {
    let failure: string | null = null;

    try {
      const message = composeMessage(notification.payload);
      const to = resolveRecipients(
        notification.recipients,
        Deno.env.get('ALERTS_DEFAULT_RECIPIENTS'),
      );

      await sendMail(mail, { to, subject: message.subject, text: message.text });
    } catch (error) {
      failure = describe(error);
    }

    try {
      await completeNotification(notification.id, failure);
    } catch (error) {
      // The send may well have happened; only the report failed. Saying so
      // beats a silent catch, and the row is reclaimed in fifteen minutes.
      console.error(`Could not report notification ${notification.id}: ${describe(error)}`);
    }

    if (failure === null) {
      sent += 1;
    } else {
      failed += 1;
      // Addresses stay out of the log: this is somebody's personal data and the
      // reason is already stored on the row.
      console.error(`Notification ${notification.id} failed: ${failure}`);
    }
  }

  return json({ claimed: claimed.length, sent, failed }, 200);
});

/**
 * Only the service role may drain the queue. `verify_jwt` already turns away
 * anything without a valid token, but every employee has one of those -- and
 * this function reads recipient addresses and sends mail on the company's
 * behalf. The key is compared rather than the claims because it is the exact
 * credential cron presents, and comparing digests keeps the check from leaking
 * the token through how long it takes.
 */
async function callerIsServiceRole(request: Request): Promise<boolean> {
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (expected === undefined || expected === '') {
    return false;
  }

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (presented === '') {
    return false;
  }

  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return equalBytes(a, b);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

/** An `unknown` from a `catch` is not necessarily an Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
