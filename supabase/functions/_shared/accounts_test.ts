import { assertEquals, assertMatch, assertThrows } from 'jsr:@std/assert@1';
import {
  BadRequestError,
  loginAddress,
  parseRequest,
  TEMPORARY_PASSWORD_LENGTH,
  temporaryPassword,
} from './accounts.ts';

const EMPLOYEE = '45322c40-3556-40de-bcc3-86d6eb972b1f';

Deno.test('a creation names the person and the role, and nothing else', () => {
  assertEquals(
    parseRequest({ action: 'create', employee_id: EMPLOYEE, role: 'employee' }),
    { action: 'create', employeeId: EMPLOYEE, role: 'employee' },
  );
});

Deno.test('an email in the body is ignored, not honoured', () => {
  // The address comes from public.empleados. Accepting one here would let a
  // caller create an account for one person carrying another's login.
  const parsed = parseRequest({
    action: 'create',
    employee_id: EMPLOYEE,
    role: 'employee',
    email: 'somebody.else@example.invalid',
  });

  assertEquals(Object.keys(parsed).sort(), ['action', 'employeeId', 'role']);
});

Deno.test('refuses a role that does not exist', () => {
  assertThrows(
    () => parseRequest({ action: 'create', employee_id: EMPLOYEE, role: 'superadmin' }),
    BadRequestError,
  );
});

Deno.test('refuses an action that does not exist', () => {
  assertThrows(
    () => parseRequest({ action: 'delete', employee_id: EMPLOYEE }),
    BadRequestError,
  );
});

Deno.test('refuses an employee id that is not a uuid', () => {
  assertThrows(
    () => parseRequest({ action: 'reset_password', employee_id: 'me' }),
    BadRequestError,
  );
});

Deno.test('refuses a body that is not an object', () => {
  assertThrows(() => parseRequest('create'), BadRequestError);
  assertThrows(() => parseRequest(null), BadRequestError);
  assertThrows(() => parseRequest([{ action: 'create' }]), BadRequestError);
});

Deno.test('a revocation carries a reason the database would also accept', () => {
  assertEquals(
    parseRequest({
      action: 'revoke',
      employee_id: EMPLOYEE,
      reason: '  Dejo la empresa el viernes  ',
    }),
    { action: 'revoke', employeeId: EMPLOYEE, reason: 'Dejo la empresa el viernes' },
  );
});

Deno.test('refuses a revocation whose reason the database would refuse', () => {
  // Refusing here matters: the alternative is banning the account and then
  // being told the reason was too short, leaving access removed and unrecorded.
  assertThrows(
    () => parseRequest({ action: 'revoke', employee_id: EMPLOYEE, reason: 'ya no' }),
    BadRequestError,
  );
});

Deno.test('a reset needs nothing but the person', () => {
  assertEquals(
    parseRequest({ action: 'reset_password', employee_id: EMPLOYEE }),
    { action: 'reset_password', employeeId: EMPLOYEE },
  );
});

Deno.test('a temporary password is long and free of ambiguous glyphs', () => {
  const password = temporaryPassword();

  assertEquals(password.length, TEMPORARY_PASSWORD_LENGTH);
  // Somebody reads this out and somebody else types it. 0/O, 1/l/I and 5/S are
  // the pairs that cost a phone call.
  assertMatch(password, /^[A-HJ-NP-RT-Za-km-z2-9]+$/);
});

Deno.test('the alphabet spans all three classes and nothing else', () => {
  // Walking the whole alphabet, so this describes what a password can be made
  // of rather than what one particular draw happened to contain. No class is
  // forced into a result, so the guarantee is about the alphabet or it is
  // about nothing.
  const everySymbol = temporaryPassword(56, byteStream(0));

  assertMatch(everySymbol, /[A-Z]/);
  assertMatch(everySymbol, /[a-z]/);
  assertMatch(everySymbol, /[2-9]/);
  // 0/O, 1/l/I and 5/S are the pairs that cost a phone call. Each pair loses
  // its letter rather than its digit, so `5` stays and `S` goes. A symbol is
  // one more thing to spell out to somebody holding a different keyboard, and
  // `\W` is what says none survived into the alphabet.
  assertEquals(/[OIlS01\W_]/.test(everySymbol), false);
});

Deno.test('refuses to generate a password shorter than the agreed minimum', () => {
  assertThrows(() => temporaryPassword(8), Error);
});

/** A byte source that advances, so a rejected byte is not handed back forever. */
function byteStream(from: number): (count: number) => Uint8Array {
  let next = from;
  return (count) =>
    Uint8Array.from({ length: count }, () => {
      const byte = next;
      next = next === 255 ? 0 : next + 1;
      return byte;
    });
}

Deno.test('every symbol in the alphabet is reachable', () => {
  const password = temporaryPassword(56, byteStream(0));

  assertEquals(new Set(password).size, 56, 'each of the 56 symbols exactly once');
});

Deno.test('bytes in the biased tail are discarded, not folded back', () => {
  // With 56 symbols the usable range is 0..223. Feeding 224..255 first means a
  // correct generator produces nothing from them and starts at the first symbol
  // once the stream wraps; a plain `% 56` would emit 'ABCDEFGH…' from the tail
  // and make those symbols a third likelier than the rest.
  assertEquals(temporaryPassword(12, byteStream(224)), 'ABCDEFGHJKLM');
});

Deno.test('the login address comes from the catalogue, lowercased', () => {
  assertEquals(
    loginAddress('  Sistemas@PlasticosPimsa.com ', 'Luis'),
    'sistemas@plasticospimsa.com',
  );
});

Deno.test('an unusable catalogue address is refused by name', () => {
  // public.empleados.correo is not null, but it is maintained for people who may
  // never have had a mailbox. "Present" is not "usable as a login".
  for (const bad of ['', '   ', 'planta2', 'a b@c.com', 'nobody@localhost']) {
    assertThrows(() => loginAddress(bad, 'Manuel Rivera'), BadRequestError);
  }
});
