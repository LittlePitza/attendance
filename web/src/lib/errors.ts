/**
 * The database answered, and said no.
 *
 * The message is the one the engine raised, already written in Spanish to be
 * read on screen -- `Ya registraste tu entrada hoy`, not an error code. It is
 * shown to the employee as it arrives.
 */
export class RpcError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** The request never reached the database. Nothing was decided either way. */
export class NetworkUnavailableError extends Error {
  constructor(message = 'Sin conexion con el servidor') {
    super(message);
    this.name = 'NetworkUnavailableError';
  }
}

/**
 * The two fields the decision reads, and nothing else.
 *
 * Narrower than `PostgrestError` on purpose: this is the whole contract the
 * predicate depends on, so a caller -- or a test stating a case -- does not
 * have to build an error class around fields nothing here looks at.
 */
export interface FailedRequest {
  readonly code?: string | undefined;
  readonly message: string;
}

/**
 * Telling a refusal apart from a failure to ask.
 *
 * This matters more than it looks. A refusal is final -- the punch was illegal
 * and must be shown to the employee, never retried. A transport failure decided
 * nothing, so the punch belongs in the offline queue. Getting it backwards
 * either loses a legitimate punch or retries an illegal one forever.
 *
 * PostgREST attaches a SQLSTATE to anything the database itself rejected, so
 * the presence of a code is the reliable signal. Only when there is none do we
 * fall back to reading the message, and only for the shapes `fetch` produces.
 */
export function isTransportFailure(error: FailedRequest): boolean {
  if (error.code !== undefined && error.code !== '') {
    return false;
  }
  return /failed to fetch|network|load failed|timeout|aborted/i.test(error.message);
}
