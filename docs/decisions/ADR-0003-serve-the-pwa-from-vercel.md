# ADR-0003 — The PWA is served from Vercel

- **Date:** 2026-08-25
- **Status:** Accepted
- **Scope:** `web/`, `web/vercel.json`

## Context

[ADR-0001](ADR-0001-all-in-supabase.md) settled that there is no application
server and ends with the line *"the PWA is static files"*. It never said where
those files are served from, because at the time nothing needed them to be
anywhere: the client ran on `localhost` and the only deployed component was the
database.

A pilot changes that. An employee cannot install a progressive web app from a
developer's laptop, and a service worker will not register without HTTPS. The
files have to live on a real origin before anybody can be asked to try the
system.

Supabase does not host static sites. Storage can serve a file, but it serves it
from a bucket path with no custom domain, no control over response headers and
no build step -- which means no service worker scope at the origin root, so the
PWA would not be installable. So this was never a question of whether to leave
Supabase; it is a question of which host receives what Supabase was never going
to hold.

## Decision

The PWA is deployed to **Vercel**, as a static build with **Root Directory
`web`**. Its configuration lives in `web/vercel.json` and is committed, not
entered into the dashboard.

Nothing else moves. Postgres keeps every rule, `alerts-notify` stays an Edge
Function on Supabase, and the evaluator stays on `pg_cron`.

## Rationale

**The company already runs Vercel.** `ti-hub`, the IT help desk that shares this
database, deploys there. That is one account, one billing relationship and one
set of habits rather than two, and it is the same reasoning that named this
repository after the sibling's precedent.

**It adds no layer that can hold a rule.** This is the property that mattered
most. Vercel is serving files here -- no functions, no middleware, no `api/`
directory. There is no place on the Vercel side for a business rule to be
written by accident, so the boundary ADR-0001 drew is untouched. A deployment
that offered a runtime would have been the wrong shape even if nothing used it
on day one.

**The configuration is in the repository.** Build command, output directory,
cache headers and the content security policy are in `web/vercel.json`, which
means they are reviewed, versioned and survive somebody clicking through project
settings. A dashboard setting is not part of the record.

**The environment variables compose without a change to the build.**
`web/vite.config.ts` sets `envDir: '..'` so that one `.env` at the repository
root serves local development. On Vercel there is no `.env` at all: Vite merges
`process.env` entries carrying the `VITE_` prefix and gives them priority over
any file. `ci.yml` already builds the bundle exactly this way, so the mechanism
was proven before it was relied upon.

## Accepted cost

**The origin is public.** Anyone who finds the URL gets the login screen. That
was already the security model -- RLS and `SECURITY DEFINER` functions decide
what a token can reach, and the publishable key grants nothing on its own -- but
it is now reachable from the open internet rather than from a laptop, and that
is a real change in exposure even though it is not a change in privilege.

**Preview deployments are a decision, not a default.** Vercel builds a public URL
for every branch. Given production environment variables, each one would be a
working attendance application pointing at real employee records. The variables
are therefore set on the **Production environment only**: a preview builds and
then refuses to start, which is `requireEnv()` in `web/src/lib/supabase.ts`
doing exactly what it was written to do.

**One more thing to keep current.** A second platform is a second set of
deprecations, quotas and settings to audit. It is a small surface -- a static
build and a JSON file -- but it is not zero.

## Consequences

- **The content security policy is written against what the client actually
  does**, which means it has to be revisited when the client does something new.
  Two cases are already known: `connect-src` allows `https://*.supabase.co` but
  no `wss:`, so adding Supabase Realtime means adding it there in the same
  commit; and `Permissions-Policy` denies `geolocation`, because the punch
  screen does not collect coordinates today. `attendance.punches` has the
  columns and the consent table exists, so the day that feature is built the
  header changes with it -- or the browser will refuse silently and the reason
  will be nowhere near the code.
- **`connect-src` names the two font hosts, and that is not redundant.** They
  are already in `style-src` and `font-src`, which is what the *page* needs, and
  stopping there was the first version of this file. But the catch-all header
  rule also matches `/sw.js`, so the service worker is served this policy and a
  worker's own `connect-src` governs the `fetch()` calls it makes -- and
  workbox's runtime caching fetches exactly those two origins. Without them the
  font loads on the first visit and then stops the moment the service worker
  takes control, which is precisely the offline caching that
  [CONTRIBUTING.md](../../CONTRIBUTING.md) cites as how the one external asset
  pays for itself. Anybody tidying this line as duplication would reintroduce
  the bug.
- **`sw.js` and `manifest.webmanifest` are served `must-revalidate`**, and
  everything under `/assets/` and the hashed `workbox-*.js` are `immutable`. A
  cached service worker that never revalidates is a client pinned to an old
  build, which for `registerType: 'autoUpdate'` would defeat the whole point.
- **A catch-all rewrite sends unmatched paths to `index.html`.** The application
  has no router and only one route, so this is not about deep links: it is so
  that an unmatched path behaves the same online as it does offline, where the
  service worker's navigation fallback already answers with the shell.
- The Free plan's pause is unaffected. The client would stay up while the
  database underneath it is paused, which looks worse than an outage, not
  better. `keepalive.yml` remains the thing that prevents it.
