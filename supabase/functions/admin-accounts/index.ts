import {
  type AccountRequest,
  BadRequestError,
  loginAddress,
  parseRequest,
  temporaryPassword,
} from '../_shared/accounts.ts';

/**
 * Creating, resetting and revoking the accounts employees sign in with.
 *
 * This function exists for one reason: `auth.users` belongs to Auth, and only
 * the Admin API may write to it. Everything else about provisioning -- who may
 * do it, which roles they may hand out, whether a person is active, whether an
 * account is already somebody else's, and the audit trail -- is decided by
 * `public.link_employee_account()`, `public.set_account_role()` and
 * `public.unlink_employee_account()` in the database. That is
 * `CONTRIBUTING.md` rule 1 applied here: Edge Functions talk to the outside
 * world and hold no business rules.
 *
 * **Two identities, on purpose.**
 *
 *   * The **caller's token** makes every database call. So the role gate checks
 *     the HR person, and `auth.uid()` in the audit row *is* the HR person. A
 *     service key doing it would record that a key did it, which is the same as
 *     recording nothing.
 *   * The **service key** makes every Auth call, and one read: the employee's
 *     row, because the address an account is created with must come from
 *     `public.empleados` and never from the request body.
 *
 * **The failure path is the interesting part.** Creating an account is two
 * writes to two systems with no transaction across them. If Auth accepts and the
 * database then refuses -- a race, a role the caller may not grant -- the
 * account is deleted again before answering. An orphan in `auth.users` is worse
 * than a refusal: it holds the address hostage, so the second attempt fails for
 * a reason that has nothing to do with the first.
 */

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SERVICE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = requiredEnv('SUPABASE_ANON_KEY');

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing ${name}. It is part of the function's environment, not the repository.`,
    );
  }
  return value;
}

/**
 * `*` is the right answer here and not laziness. The browser attaches no cookie
 * and no credential of its own: every request has to carry a bearer token the
 * caller obtained by signing in, and the database re-checks the role behind it.
 * A same-origin allowlist would add a deployment setting that protects nothing,
 * and would break the moment the PWA moves to its own domain.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
} as const;

interface EmployeeRow {
  readonly nombre: string;
  readonly correo: string | null;
  readonly estado: string;
  readonly auth_user_id: string | null;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // `verify_jwt` already turned away anything without a valid token. What it
  // cannot know is whose token it is, and every employee has one.
  const caller = request.headers.get('authorization') ?? '';
  if (!caller.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let asked: AccountRequest;
  try {
    asked = parseRequest(await request.json().catch(() => null));
  } catch (error) {
    return json({ error: describe(error) }, error instanceof BadRequestError ? 400 : 500);
  }

  try {
    // Fails closed, and fails first: `list_accounts()` raises 42501 for anybody
    // who is not HR or admin. Doing it before touching Auth is what keeps a
    // refused caller from leaving an account behind.
    await callRpc(caller, 'list_accounts', {});

    const employee = await readEmployee(asked.employeeId);

    switch (asked.action) {
      case 'create':
        return await create(caller, asked.employeeId, asked.role, employee);
      case 'reset_password':
        return await resetPassword(caller, asked.employeeId, employee);
      case 'revoke':
        return await revoke(caller, asked.employeeId, asked.reason, employee);
    }
  } catch (error) {
    if (error instanceof BadRequestError) {
      return json({ error: error.message }, 400);
    }
    if (error instanceof UpstreamError) {
      // The database writes its refusals in Spanish because HR reads them.
      // Passing them through beats inventing kinder ones that say less.
      return json({ error: error.message }, error.status);
    }
    return json({ error: describe(error) }, 500);
  }
});

/** An account, and then the link that makes it somebody's. */
async function create(
  caller: string,
  employeeId: string,
  role: string,
  employee: EmployeeRow,
): Promise<Response> {
  // The database checks all three of these too, and it is the one that decides.
  // Checking here as well means a refusal costs no Auth account.
  if (employee.estado !== 'activo') {
    throw new BadRequestError(`${employee.nombre} no esta activo en el catalogo de empleados`);
  }
  if (employee.auth_user_id !== null) {
    throw new BadRequestError(`${employee.nombre} ya tiene una cuenta de acceso`);
  }

  const email = loginAddress(employee.correo, employee.nombre);
  const password = temporaryPassword();

  const created = await callAuth('POST', 'admin/users', {
    email,
    password,
    // No confirmation mail: this project's mail account is configured in
    // `public.config_correo` for the help desk, not in Auth, and the Free plan's
    // built-in sender is rate limited to a handful an hour. HR hands the
    // password over in person, which is also how the laptop gets handed over.
    email_confirm: true,
    user_metadata: {
      // The PWA reads this and refuses to go anywhere until the person has
      // chosen their own password. Until it clears, HR knows this one.
      must_change_password: true,
      employee_id: employeeId,
    },
  });

  const authUserId = created['id'];
  if (typeof authUserId !== 'string') {
    throw new Error('Auth created a user without returning its id');
  }

  try {
    await callRpc(caller, 'link_employee_account', {
      p_employee_id: employeeId,
      p_auth_user_id: authUserId,
      p_role: role,
    });
  } catch (error) {
    // Two systems, no transaction. The account is undone so the address is free
    // for the next attempt, and the original refusal is what gets reported.
    await deleteAuthUser(authUserId);
    throw error;
  }

  return json({
    employee_id: employeeId,
    employee_name: employee.nombre,
    email,
    role,
    // Shown once. It is never logged, and the reset action is the only way back
    // to it -- deliberately, because a password HR can re-read at will is a
    // password HR owns.
    temporary_password: password,
  }, 200);
}

/** A new temporary password for somebody who cannot sign in. */
async function resetPassword(
  caller: string,
  employeeId: string,
  employee: EmployeeRow,
): Promise<Response> {
  if (employee.auth_user_id === null) {
    throw new BadRequestError(`${employee.nombre} no tiene cuenta de acceso`);
  }

  const password = temporaryPassword();

  await callAuth('PUT', `admin/users/${employee.auth_user_id}`, {
    password,
    // GoTrue merges `user_metadata` rather than replacing it, so `employee_id`
    // set at creation survives this.
    user_metadata: { must_change_password: true },
  });

  // The password is already changed by now, so a failure here must not read as a
  // failed reset. It is reported and the answer still carries the password:
  // losing the audit row is bad, telling HR the reset failed when it did not is
  // worse -- they would run it again and hand out a password that no longer
  // works.
  let recorded = true;
  try {
    await callRpc(caller, 'record_password_reset', { p_employee_id: employeeId });
  } catch (error) {
    recorded = false;
    console.error(`Password reset for ${employeeId} was not recorded: ${describe(error)}`);
  }

  return json({
    employee_id: employeeId,
    employee_name: employee.nombre,
    temporary_password: password,
    recorded,
  }, 200);
}

/** Access taken away: unlinked in the database, then locked out of Auth. */
async function revoke(
  caller: string,
  employeeId: string,
  reason: string,
  employee: EmployeeRow,
): Promise<Response> {
  if (employee.auth_user_id === null) {
    throw new BadRequestError(`${employee.nombre} no tiene cuenta de acceso`);
  }

  // First, because it is the step that is allowed to refuse: it holds the guards
  // against revoking your own account and against leaving the database with no
  // administrator, and it is what records the reason.
  await callRpc(caller, 'unlink_employee_account', {
    p_employee_id: employeeId,
    p_reason: reason,
  });

  // Belt to the database's braces. With no employee link `my_day()` already
  // refuses and with no role row the caller is a 'guest', so a failure here
  // leaves an account that can sign in and see nothing. Worth reporting, not
  // worth failing the revocation over -- the authoritative half is already done
  // and is not being rolled back.
  let lockedOut = true;
  try {
    await callAuth('PUT', `admin/users/${employee.auth_user_id}`, {
      // GoTrue takes a duration string. A century is "indefinitely" without
      // needing a delete, which would take the record of who decided what with
      // it: attendance.adjustments.adjusted_by is `on delete restrict`.
      ban_duration: '876000h',
    });
  } catch (error) {
    lockedOut = false;
    console.error(`Could not lock out ${employee.auth_user_id}: ${describe(error)}`);
  }

  return json({
    employee_id: employeeId,
    employee_name: employee.nombre,
    locked_out: lockedOut,
  }, 200);
}

/**
 * Carries the status through so a refusal from the database arrives at the
 * browser as a refusal and not as a 500. HR reading "no tienes permiso" is the
 * system working; HR reading "error interno" is the system hiding.
 */
class UpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/**
 * The employee's row, read with the service key.
 *
 * Elevated on purpose: the address the account is created with has to come from
 * the catalogue. Rule 4 of this repository says `employee_id` is never taken
 * from the client for punching; the same reasoning says the login address is
 * never taken from the client either. A caller who could name the email could
 * create an account for one person carrying another person's login.
 */
async function readEmployee(employeeId: string): Promise<EmployeeRow> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/empleados?id=eq.${employeeId}` +
      '&select=nombre,correo,estado,auth_user_id',
    { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } },
  );

  if (!response.ok) {
    throw new UpstreamError(await failureText(response), 502);
  }

  const rows = await response.json() as EmployeeRow[];
  const row = rows[0];

  if (row === undefined) {
    throw new BadRequestError('Esa persona no esta en el catalogo de empleados');
  }
  return row;
}

/** One RPC, as the caller. Their token is what the database gates on. */
async function callRpc(
  caller: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      authorization: caller,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    // PostgREST maps the SQLSTATEs these functions raise: 42501 to 403, 02000 to
    // 404, 23505 to 409, 22023 to 400. Passing the status through means the
    // client can tell "you may not" from "that is wrong" without parsing prose.
    throw new UpstreamError(await failureText(response), response.status);
  }

  return await response.json().catch(() => null);
}

/** One Admin API call, as the service role. Auth's table, Auth's key. */
async function callAuth(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const detail = await failureText(response);

    // The one Auth failure worth translating, because it is the one that will
    // actually happen: an address that already has an account. The help desk's
    // own administrator account is one of those.
    if (response.status === 422 && detail.includes('already been registered')) {
      throw new UpstreamError(
        'Ese correo ya tiene una cuenta de acceso. Ligala a la persona en vez de crear otra.',
        409,
      );
    }

    throw new UpstreamError(detail, response.status === 422 ? 400 : 502);
  }

  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

/**
 * Undoes a creation whose link was refused. A failure here is logged and
 * swallowed on purpose: the caller is already receiving the refusal that matters,
 * and replacing it with "and also the cleanup failed" would bury it. The orphan
 * is named in the log so somebody can remove it.
 */
async function deleteAuthUser(authUserId: string): Promise<void> {
  try {
    await callAuth('DELETE', `admin/users/${authUserId}`);
  } catch (error) {
    console.error(
      `Orphan auth user ${authUserId} could not be removed: ${describe(error)}. ` +
        'Delete it by hand before retrying, or the address stays taken.',
    );
  }
}

/**
 * Whatever the upstream said, without letting a key or a password into the
 * message. PostgREST answers with `{message, hint}`; GoTrue with
 * `{msg}` or `{error_description}`.
 */
async function failureText(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');

  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const message = body['message'] ?? body['msg'] ?? body['error_description'] ?? body['error'];
    const hint = body['hint'];

    if (typeof message === 'string' && message !== '') {
      return typeof hint === 'string' && hint !== '' ? `${message} (${hint})` : message;
    }
  } catch {
    // Not JSON. The status line is more use than an HTML error page.
  }

  return `${String(response.status)} ${response.statusText}`;
}

/** An `unknown` from a `catch` is not necessarily an Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}
