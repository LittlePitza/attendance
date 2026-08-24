# Security policy

This repository describes a system that stores **personal data of employees**:
names, departments, working hours and, when consent has been recorded,
coarse geolocation. Treat every finding here as touching real people's records.

## Reporting a vulnerability

Do **not** open an issue. Issues are readable by everyone with access to the
repository, and a report is usually a working exploit.

Contact the maintainer directly and give it a day before escalating. Include
what you did, what happened, and whether you reached data that was not yours.

## What counts as a vulnerability here

The security model rests on a small number of promises. Anything that breaks one
of them is a vulnerability, not a bug:

- **Punching for someone else.** `employee_id` is derived from the token, never
  accepted as a parameter. Any path that lets a caller choose whose record they
  write is critical.
- **Writing a table directly.** `authenticated` holds `SELECT` only. An
  `INSERT`, `UPDATE` or `DELETE` reaching an `attendance` table over the REST
  API is critical.
- **Altering the past.** `attendance.punches` is append-only, enforced by
  trigger. A punch that changes after the fact invalidates the record as
  evidence.
- **Choosing your own timestamp.** The server sets `occurred_at`. A client value
  that ends up there instead of in `client_reported_at` is critical.
- **Reading data outside your scope.** `internal.can_view_employee()` is the one
  rule. An employee reaching another employee's rows, or coordinates reaching
  the client at all, is critical.

CI checks the four structural invariants on every push, but it cannot prove the
absence of a path around them. Reports are welcome.

## Secrets

If a credential is ever committed, assume it is compromised: rotate it first,
then remove it. Rotating after cleaning the history is the wrong order — the
value was already fetched.

The secret key and the database connection string live in Edge Function
environment variables and GitHub Actions secrets. Only the publishable key
belongs in the browser.
