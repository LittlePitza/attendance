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

/**
 * The sentence to show when a read that refreshes itself fails.
 *
 * The punch screen re-throws what it does not recognise, and that is right
 * there: a person is standing in front of it, waiting, and will see that
 * nothing happened. A board left open on a wall has nobody waiting on it, so an
 * unrecognised failure has to say something and be logged -- re-thrown into a
 * detached promise it would become an unhandled rejection nobody ever reads,
 * and the screen would go on showing yesterday as though it were current.
 */
export function describeReadFailure(error: unknown): string {
  if (error instanceof NetworkUnavailableError) {
    return 'Sin conexión. Se muestra la última lectura.';
  }
  if (error instanceof RpcError) {
    return error.message;
  }

  console.error(error);
  return 'No se pudo actualizar. Se muestra la última lectura.';
}
