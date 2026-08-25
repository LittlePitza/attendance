import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { composeMessage } from './message.ts';
import { ALERT_KINDS, type AlertKind, type NotificationPayload } from './types.ts';

function payload(kind: AlertKind, details: Record<string, unknown>): NotificationPayload {
  return {
    alert_id: '11111111-1111-1111-1111-111111111111',
    kind,
    severity: 'medium',
    alert_date: '2026-08-24',
    employee_id: '22222222-2222-2222-2222-222222222222',
    employee_name: 'Ana Ruiz',
    department: 'Sistemas',
    time_zone: 'America/Mexico_City',
    details,
  };
}

/** What the evaluator writes for each kind, mirrored from the migration. */
const DETAILS: Readonly<Record<AlertKind, Record<string, unknown>>> = {
  late_entry: { minutes_late: 18, expected_at: '09:00', arrived_at: '09:23', grace_minutes: 5 },
  missing_entry: { entry_until: '09:30', minutes_overdue: 42 },
  break_exceeded: { break_minutes: 75, allowed_minutes: 60, still_on_break: true },
  missing_exit: { exit_expected: '18:00', minutes_overdue: 90, state: 'working' },
  no_connection: { minutes_silent: 35, last_signal_at: '14:05' },
  review_offline: { punches_flagged: 2, reason: 'reloj desfasado' },
  clock_tampered: { skew_minutes: 7, threshold_minutes: 2 },
};

Deno.test('every kind the database can raise composes a message', () => {
  // A kind with no case would fall through and send an empty body. Walking the
  // whole list means adding one to the CHECK constraint without adding it here
  // fails a test rather than mailing HR a blank sentence.
  for (const kind of ALERT_KINDS) {
    const { subject, text } = composeMessage(payload(kind, DETAILS[kind]));

    assertStringIncludes(subject, 'Ana Ruiz');
    assertStringIncludes(text, 'Ana Ruiz \u00b7 Sistemas');
    assertEquals(text.includes('undefined'), false, `${kind} rendered undefined`);
    assertEquals(text.includes('?'), false, `${kind} left a measurement unrendered`);
  }
});

Deno.test('says what happened, in the numbers the evaluator measured', () => {
  const { text } = composeMessage(payload('late_entry', DETAILS.late_entry));
  assertStringIncludes(text, 'Entr\u00f3 a las 09:23');
  assertStringIncludes(text, '18 min despu\u00e9s');
  assertStringIncludes(text, '09:00');
});

Deno.test('reads the workday state in Spanish, not as the database spells it', () => {
  const { text } = composeMessage(payload('missing_exit', DETAILS.missing_exit));
  assertStringIncludes(text, 'qued\u00f3 trabajando');
});

Deno.test('a break still running reads differently from one already over', () => {
  const running = composeMessage(payload('break_exceeded', DETAILS.break_exceeded)).text;
  const over = composeMessage(
    payload('break_exceeded', { ...DETAILS.break_exceeded, still_on_break: false }),
  ).text;

  assertStringIncludes(running, 'Sigue en pausa.');
  assertStringIncludes(over, 'Ya regres\u00f3.');
});

Deno.test('an employee with no department is named without a dangling separator', () => {
  const { text } = composeMessage({
    ...payload('missing_entry', DETAILS.missing_entry),
    department: null,
  });

  // The name line stands alone. With a department it would read
  // `Ana Ruiz · Sistemas`, so finding the name followed by the line break is
  // what proves the separator was not left hanging.
  assertEquals(text.split('\n')[0], 'Ana Ruiz');
});

Deno.test('a missing measurement still produces a sendable message', () => {
  // The evaluator always writes every field, so this should not happen. If it
  // ever does, an odd sentence beats eight retries and a failed notification.
  const { text } = composeMessage(payload('clock_tampered', { skew_minutes: null }));
  assertStringIncludes(text, '? min fuera de hora');
});
