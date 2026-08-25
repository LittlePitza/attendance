import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { NoRecipientsError, resolveRecipients } from './recipients.ts';

/**
 * `alert_rules` is empty today, so every notification arrives with a null
 * recipient and takes the fallback path. That makes these the cases that
 * actually run in production, not the edge ones.
 */
Deno.test('the rule wins over the deployment default', () => {
  assertEquals(
    resolveRecipients('rh@example.com', 'fallback@example.com'),
    ['rh@example.com'],
  );
});

Deno.test('falls back when the rule carries no address', () => {
  assertEquals(resolveRecipients(null, 'rh@example.com'), ['rh@example.com']);
});

Deno.test('a rule that is present but empty still falls back', () => {
  // A row edited down to an empty string is not a decision to send nowhere.
  assertEquals(resolveRecipients('  , ,', 'rh@example.com'), ['rh@example.com']);
});

Deno.test('splits, trims and drops what cannot be an address', () => {
  assertEquals(
    resolveRecipients(' rh@example.com , jefe@example.com ,, not-an-address, a b@c.com', undefined),
    ['rh@example.com', 'jefe@example.com'],
  );
});

Deno.test('the same address twice is one recipient', () => {
  assertEquals(
    resolveRecipients('rh@example.com, RH@Example.com', undefined),
    ['rh@example.com'],
  );
});

Deno.test('refuses to invent a recipient when nothing is configured', () => {
  // The alternative would be mailing the help desk's own list, which is both
  // wrong and hard to notice.
  assertThrows(() => resolveRecipients(null, undefined), NoRecipientsError);
  assertThrows(() => resolveRecipients(null, '   '), NoRecipientsError);
});
