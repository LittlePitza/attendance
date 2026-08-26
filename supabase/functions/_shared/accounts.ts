/**
 * The parts of account provisioning that are decisions rather than requests.
 *
 * Everything in this file is pure, and that is on purpose: it is the half of
 * `admin-accounts` worth testing, and the half that would otherwise only ever
 * run against a live Auth service. Parsing the request, choosing a temporary
 * password and deciding what may be echoed back to HR are all decisions; making
 * the account is a call, and it lives in `index.ts`.
 *
 * What is NOT here, and must not arrive: any rule about who may do this. The
 * gate is `internal.require_role()` in the database, reached through
 * `public.link_employee_account()`. An Edge Function that also decided it would
 * be a second definition of the rule, and the two would eventually disagree.
 */

export const ACCOUNT_ACTIONS = ['create', 'reset_password', 'revoke'] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

export const ACCOUNT_ROLES = ['employee', 'manager', 'hr', 'admin'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/**
 * The reason the database asks for is at least ten characters. Checking it here
 * as well saves creating an Auth account for a revocation the database is about
 * to refuse -- which would leave an orphan `auth.users` row behind.
 */
export const MIN_REASON_LENGTH = 10;

export interface CreateRequest {
  readonly action: 'create';
  readonly employeeId: string;
  readonly role: AccountRole;
}

export interface ResetRequest {
  readonly action: 'reset_password';
  readonly employeeId: string;
}

export interface RevokeRequest {
  readonly action: 'revoke';
  readonly employeeId: string;
  readonly reason: string;
}

export type AccountRequest = CreateRequest | ResetRequest | RevokeRequest;

/**
 * A bad request is a bug in the client or a hand-rolled call, never something an
 * employee sees, so these messages are in English -- the same rule
 * `web/src/lib/supabase.ts` follows for a missing environment variable. What HR
 * reads on screen comes from the database, in Spanish.
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Parses the body into one of three shapes, or refuses.
 *
 * `employee_id` is the only identifier accepted, and the address the account is
 * created with is read from `public.empleados` rather than taken from here. That
 * is rule 4 of this repository applied to provisioning: an identifier the client
 * supplied is never the one that decides. A caller who could name the email
 * could create an account for one person carrying another's address.
 */
export function parseRequest(body: unknown): AccountRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestError('Expected a JSON object');
  }

  const fields = body as Record<string, unknown>;
  const action = fields['action'];

  if (typeof action !== 'string' || !isAction(action)) {
    throw new BadRequestError(
      `action must be one of: ${ACCOUNT_ACTIONS.join(', ')}`,
    );
  }

  const employeeId = fields['employee_id'];
  if (typeof employeeId !== 'string' || !isUuid(employeeId)) {
    throw new BadRequestError('employee_id must be a uuid');
  }

  if (action === 'create') {
    const role = fields['role'];
    if (typeof role !== 'string' || !isRole(role)) {
      throw new BadRequestError(`role must be one of: ${ACCOUNT_ROLES.join(', ')}`);
    }
    return { action, employeeId, role };
  }

  if (action === 'revoke') {
    const reason = fields['reason'];
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
      throw new BadRequestError(
        `reason must be at least ${String(MIN_REASON_LENGTH)} characters`,
      );
    }
    return { action, employeeId, reason: reason.trim() };
  }

  return { action, employeeId };
}

function isAction(value: string): value is AccountAction {
  return (ACCOUNT_ACTIONS as readonly string[]).includes(value);
}

function isRole(value: string): value is AccountRole {
  return (ACCOUNT_ROLES as readonly string[]).includes(value);
}

/** PostgREST would refuse a malformed uuid anyway; refusing first is cheaper. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Temporary passwords are read off a screen and typed into another device, so
 * the alphabet is the one that survives that trip: no lookalike glyphs, and no
 * symbols at all.
 *
 * Leaving symbols out is the decision worth writing down. A symbol earns its
 * place in a password somebody keeps; this one lives for as long as it takes to
 * read it down a phone line and type it once, and `!` against `¡` on a Spanish
 * keyboard costs a second phone call. The length is what carries the strength
 * instead: 16 characters out of 56 is about 93 bits, which no policy this
 * account will ever meet asks to be beaten by punctuation.
 */
const UPPERCASE = 'ABCDEFGHJKLMNPQRTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const ALPHABET = `${UPPERCASE}${LOWERCASE}${DIGITS}`;

export const TEMPORARY_PASSWORD_LENGTH = 16;

/**
 * A temporary password, from the platform's cryptographic source.
 *
 * Rejection sampling rather than `% ALPHABET.length`: 256 is not a multiple of
 * 56, so the plain modulo makes the first 32 symbols a third likelier than the
 * rest -- and a biased password generator is the kind of defect that is
 * invisible until somebody looks for it. Discarding the tail costs a few extra
 * bytes and nothing else.
 *
 * Every character comes from the one alphabet, and no class is forced into the
 * result. Forcing one would mean placing it at a known index and then shuffling
 * to hide that -- two more moving parts around the one thing here that must not
 * be subtly wrong -- to guarantee a property nothing checks: Auth is asked for a
 * minimum length, never for a character class.
 */
export function temporaryPassword(
  length: number = TEMPORARY_PASSWORD_LENGTH,
  randomBytes: (count: number) => Uint8Array = cryptoBytes,
): string {
  if (length < 12) {
    throw new Error('A temporary password shorter than 12 characters is not acceptable');
  }

  return randomCharacters(length, ALPHABET, randomBytes);
}

function randomCharacters(
  length: number,
  alphabet: string,
  randomBytes: (count: number) => Uint8Array,
): string {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let password = '';

  while (password.length < length) {
    // Asking for the whole remainder at once, plus a margin for what rejection
    // will discard, so a 16-character password is one or two calls rather than
    // sixteen.
    for (const byte of randomBytes((length - password.length) * 2)) {
      if (byte >= limit) {
        continue;
      }
      password += alphabet[byte % alphabet.length];
      if (password.length === length) {
        break;
      }
    }
  }

  return password;
}

function cryptoBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

/**
 * The address an account is created with, checked before Auth is asked.
 *
 * `public.empleados.correo` is `not null`, but it is maintained by the help desk
 * for people who may never have had a mailbox, so "present" and "usable as a
 * login" are not the same thing. Finding out here produces a sentence naming the
 * person; finding out from Auth produces a validation error naming a field.
 */
export function loginAddress(email: string | null | undefined, name: string): string {
  const address = (email ?? '').trim();

  if (address === '' || !/^[^\s@,]+@[^\s@,.]+(\.[^\s@,.]+)+$/.test(address)) {
    throw new BadRequestError(
      `${name} has no usable email address in public.empleados. ` +
        'Correct it there first: the account is created with that address.',
    );
  }

  return address.toLowerCase();
}
