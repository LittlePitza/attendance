# Living on the Free plan

Decision made: **this project stays on Supabase's Free plan.** This document
spells out exactly what that means, what was built to compensate, and the two
things the Free plan does **not** let you compensate for.

---

## The quotas, and how much of each we use

Verified against Supabase's documentation, not from memory.

| Resource | Free quota | Estimated use with 31 people | Headroom |
|---|---|---|---|
| **Database** | 500 MB per project | 14 MB today · ~35 MB per year | High |
| **Egress** | 5 GB uncached + 5 GB cached per month | ~150 MB/month | High |
| **Edge Functions** | 500,000 invocations/month | ~22,000/month | High |
| **Realtime** | 2,000,000 messages/month · 200 connections | ~15,000 messages · 35 connections | High |
| **Monthly active users** | 50,000 | 31 | Enormous |
| **Storage** | 1 GB | 0 (unused) | — |
| **Backups** | **None** | — | **No headroom** |
| **Pausing** | **After 7 days of low activity** | — | **No headroom** |

The important conclusion: **size is not the problem.** With 31 people punching
four times a day, no volume quota comes anywhere near its limit. The two real
problems are backups and pausing, and neither is solved by using less.

### Why 500 MB is not tight

A punch takes about 250 bytes. 31 people × 4 punches × 250 working days = 31,000
rows a year, roughly 8 MB with indexes. The database would take **decades** to
reach 500 MB from punches.

One thing to watch: this database **is shared with the help desk** (`ti-hub`) —
its tickets, inventory, handover forms, invoices and petty cash. The 500 MB
covers both systems together. Today they add up to 14 MB, so it is still not
tight, but the number to track is the total, not just the time clock's share.

---

## What grows without a ceiling (and is already pruned)

The real risk is not the attendance record: it is the operational tables that
grow forever if nobody trims them. Three tables, three treatments:

| Table | Self-cleaning? | What we did |
|---|---|---|
| `net._http_response` | Yes, after 6 hours | Nothing. `pg_net` already purges it |
| `cron.job_run_details` | **No** | Pruned daily to 7 days |
| `attendance.audit_events` | **No** | Pruned weekly to 24 months |

`cron.job_run_details` deserves a note: it stores one row per execution of every
job. With a job running every minute that is 43,200 rows a month that are of no
use to anyone after a week. Supabase's own documentation flags it as a cause of
failures during Postgres version upgrades.

### What is never pruned

`punches`, `workdays` and `adjustments` are **never touched**. They are the
labor record: Mexican labor law requires keeping them, and they are precisely
the evidence this system exists to produce. Any "optimization" that trims them
destroys the point of the project.

Coordinates are the exception, and not for space but for privacy: they are
deleted after 90 days because that is what the privacy notice promises. The
punch row stays; only the location disappears.

All three jobs are scheduled in `pg_cron`:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

| Job | Schedule (local) | What it does |
|---|---|---|
| `attendance_purge_geolocation` | Daily 03:00 | Deletes coordinates older than 90 days |
| `attendance_prune_audit_events` | Sundays 03:30 | Audit log down to 24 months |
| `attendance_prune_cron_history` | Daily 03:45 | Cron history down to 7 days |

> `pg_cron` runs in **UTC**. Mexico_City is UTC−6, which is why the cron
> expressions say 09:00 and not 03:00.

---

## Problem 1: there are no backups

**The Free plan does not take backups.** Not automatic, not downloadable. If the
database is corrupted or something gets deleted, there is nowhere to go back to.

An attendance record with no backup is indefensible in a payroll dispute. So we
take the backups ourselves: `.github/workflows/backup.yml` runs every day at
04:00, dumps schema, data and roles separately, **encrypts them**, and uploads
the result as an artifact.

### Why encrypted

The dump contains 31 people's personal data and their full attendance history.
A GitHub artifact can be downloaded by anyone with read access to the
repository. Uploading it in the clear would be a leak waiting to happen, and it
contradicts what the privacy notice promises.

It is encrypted with symmetric GPG (AES-256) using the `BACKUP_PASSPHRASE`
secret.

> **If the passphrase is lost, the backups are garbage.** Keep it outside
> GitHub — in the company password manager. Not in the repository, not in an
> email, not in this file.

### Retention, and another free quota to watch

Artifacts are kept for **30 days**, not 90. GitHub Free gives 500 MB of artifact
storage; ninety copies would overflow it and GitHub would start silently
rejecting uploads.

To keep history longer: **download the copy from the 1st of each month and
store it elsewhere** (company Drive, a backup disk). That gives a year of
history at no cost.

### Restoring

```bash
gpg --decrypt --output backup.tar.gz backup-YYYYMMDD.tar.gz.gpg
tar -xzf backup.tar.gz
psql "$SUPABASE_DB_URL" -f roles.sql
psql "$SUPABASE_DB_URL" -f schema.sql
psql "$SUPABASE_DB_URL" -f data.sql
```

It is worth **doing one full restore drill** before the system goes live,
against a different Supabase project. A backup that has never been restored is a
hypothesis, not a backup.

---

## Problem 2: pausing for inactivity

Supabase pauses Free plan projects after **7 days of low database activity**.
Their documentation is explicit: a few user queries a day are enough to stay
excluded.

In normal use this is a non-issue: 31 people punching generate plenty of
activity. The risk is the dead stretches — the week off in December, or the gap
between today and the actual rollout.

`.github/workflows/keepalive.yml` runs daily and issues a small query against
real tables. The daily backup also counts as activity, but the heartbeat is
kept separate on purpose: if the backup fails, the project should not also lose
its heartbeat.

### If it gets paused anyway

There is a **90-day window** to restore it with one button from the Supabase
dashboard, with all data intact. After 90 days the only option left is
downloading the backup — which is exactly why `backup.yml` exists.

---

## What cannot be compensated

Two Pro-plan features have no substitute on Free. Worth knowing rather than
discovering.

### 1. Leaked-password blocking

The Pro plan checks HaveIBeenPwned and rejects passwords that appear in known
breaches. On Free it **cannot be enabled**, and it shows up permanently as a
warning in the security advisor. That is not an oversight; it is the plan.

What we do instead:

- Minimum **12 characters** with uppercase, lowercase, digit and symbol.
- HR creates the accounts; nobody signs themselves up (`enable_signup = false`).
- Random password at creation, mandatory change on first use.
- Persistent session with refresh-token rotation, revocable by HR.

This is not equivalent. Someone can still choose `Password2026!`, which
satisfies the rule and appears in every breach list. That is the accepted cost.

### 2. Point-in-time recovery (PITR)

Without PITR the loss window is **up to 24 hours**: whatever happened between
the 04:00 backup and the incident. For a 31-person time clock that means, worst
case, losing one day of punches — recoverable by asking, with the `adjustments`
log to record the correction.

If that ever stops being acceptable, the answer is Pro ($25/month per
organization), not more engineering.

---

## When to leave the Free plan

Concrete signals, in case things change:

- The database passes **350 MB** (70% of quota). Check with
  `select * from attendance.free_plan_usage;`
- Monthly egress passes **3.5 GB**. Visible in the dashboard, under Usage.
- Losing a day of data stops being tolerable.
- A second environment (staging) is needed — Free gives two projects and
  production already takes one.

None of these is close today.
