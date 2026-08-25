/**
 * Who gets told.
 *
 * `attendance.alert_rules.recipients` is where this belongs, and the evaluator
 * copies it onto the row at enqueue time so the address is fixed at the moment
 * the alert was raised. When no rule is configured the column is null -- and
 * today that is every notification, because `alert_rules` is empty and a
 * missing row means "use the default threshold", never "disabled".
 *
 * So the fallback below is not a corner case, it is the only path that runs
 * until somebody configures a rule. It is a deployment setting,
 * ALERTS_DEFAULT_RECIPIENTS, and there is deliberately no second fallback:
 * `public.config_correo` holds the help desk's own distribution list, and
 * borrowing it would quietly mail attendance alerts to the IT ticket queue.
 * That is both wrong and hard to notice, which is the worst combination.
 *
 * With nothing configured this throws. The error is reported through
 * `complete_notification()`, lands in `last_error` where the runbook's weekly
 * check looks, and the row gives up after eight attempts instead of being
 * delivered somewhere nobody expects.
 */
export class NoRecipientsError extends Error {
  constructor() {
    super(
      'No recipients: the alert rule carries none and ALERTS_DEFAULT_RECIPIENTS is unset. ' +
        'Set a global row in attendance.alert_rules, or the function secret.',
    );
    this.name = 'NoRecipientsError';
  }
}

/**
 * Both sources are comma-separated free text typed by a person, so both are
 * parsed the same way and neither is trusted to be tidy.
 */
export function resolveRecipients(
  fromRule: string | null,
  fallback: string | undefined,
): string[] {
  const addresses = parseAddresses(fromRule) ?? parseAddresses(fallback ?? null);

  if (addresses === null) {
    throw new NoRecipientsError();
  }
  return addresses;
}

/** Null when the source yields nothing usable, so the caller can fall through. */
function parseAddresses(source: string | null): string[] | null {
  if (source === null) {
    return null;
  }

  const seen = new Set<string>();
  const addresses: string[] = [];

  for (const candidate of source.split(',')) {
    const address = candidate.trim();

    // A shape check, not validation: the mail provider decides what it accepts.
    // This only drops the empties a trailing comma leaves behind, and anything
    // with a space in it, which is a typo rather than an address.
    if (address === '' || !address.includes('@') || /\s/.test(address)) {
      continue;
    }

    const key = address.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    addresses.push(address);
  }

  return addresses.length === 0 ? null : addresses;
}
