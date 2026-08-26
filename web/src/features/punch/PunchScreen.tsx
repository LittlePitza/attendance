import { useCallback, useState, type JSX } from 'react';
import { useOnline } from '../../hooks/useOnline';
import { deviceId } from '../../lib/device';
import { recordPunch } from '../../lib/punching';
import type { MySummary, PunchKind } from '../../lib/types';
import {
  IconChart,
  IconClock,
  IconExit,
  IconFlame,
  IconMark,
  IconOffline,
  IconTarget,
  IconTeam,
} from '../shell/icons';
import { DayHero } from './components/DayHero';
import { DayTimeline } from './components/DayTimeline';
import { FortnightChart } from './components/FortnightChart';
import { SessionList } from './components/SessionList';
import { StatTile } from './components/StatTile';
import { PUNCH_HISTORY_LABELS, firstName, formatClock, formatTimeOfDay, plural } from './labels';
import { recentDays, weekToDate } from './live';
import { useClockSkew } from './useClockSkew';
import { useHeartbeat } from './useHeartbeat';
import { useMyDay } from './useMyDay';
import { useMyRecord } from './useMyRecord';
import { usePunchQueue } from './usePunchQueue';

interface Notice {
  readonly tone: 'ok' | 'warning' | 'error';
  readonly text: string;
}

/**
 * The whole employee-facing application.
 *
 * It holds no rule about attendance. Every button comes from
 * `day.next_actions`; every figure in the panels beside it comes from
 * `my_summary()`, which is where punctuality, the streak and hours against
 * expected are all decided. What this file does is lay them out and keep them
 * current -- the same division the board follows, for the same reason: a second
 * copy of a rule is a copy that will eventually disagree with the first, and
 * the browser's is always the one that is wrong.
 *
 * Nothing is optimistic. After a punch the screen asks `my_day()` again rather
 * than predicting the new state, and bumps the panels beside it, because a day
 * that just finished changes the streak and the fortnight too.
 */
export function PunchScreen({
  onSignOut,
  onOpenBoard = null,
  name = null,
  deviceRevoked = false,
}: {
  readonly onSignOut: () => void;
  /** Present only for an account that also has a team to look at. */
  readonly onOpenBoard?: (() => void) | null;
  /** Used for the greeting. Null when the profile could not be loaded. */
  readonly name?: string | null;
  /** HR revoked this machine. The engine refuses its punches; say so up front. */
  readonly deviceRevoked?: boolean;
}): JSX.Element {
  const online = useOnline();
  const { day, fetchedAt, error, loading, refresh } = useMyDay();

  // Bumped after an accepted punch, which is what makes the record panels
  // reload. A finished day changes the streak, and a panel still showing the
  // figures from before the button was pressed reads as a bug.
  const [recordKey, setRecordKey] = useState(0);
  const record = useMyRecord(recordKey);

  const reload = useCallback((): void => {
    void refresh();
  }, [refresh]);

  const queue = usePunchQueue(online, reload);
  const workdayIsOpen = day?.state === 'working' || day?.state === 'on_break';

  useClockSkew(online);
  useHeartbeat(online && workdayIsOpen);

  const [busyKind, setBusyKind] = useState<PunchKind | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const take = useCallback(
    async (kind: PunchKind): Promise<void> => {
      setBusyKind(kind);
      setNotice(null);

      try {
        const outcome = await recordPunch(kind);

        if (outcome.status === 'recorded') {
          setNotice({ tone: 'ok', text: `${PUNCH_HISTORY_LABELS[kind]} registrada. Listo.` });
          await refresh();
          setRecordKey((key) => key + 1);
        } else if (outcome.status === 'queued') {
          setNotice({
            tone: 'warning',
            text: 'Sin conexión. El marcaje quedó guardado en este equipo y se enviará solo.',
          });
          await queue.recount();
        } else {
          // The engine's own words, written to be read on this screen.
          setNotice({ tone: 'error', text: outcome.message });
          await refresh();
        }
      } finally {
        setBusyKind(null);
      }
    },
    [queue, refresh],
  );

  const onPunch = useCallback((kind: PunchKind): void => void take(kind), [take]);

  if (loading && day === null) {
    return (
      <main className="app app--centered">
        <p className="muted">Cargando tu jornada…</p>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="appbar">
        <span className="appbar__brand">
          <span className="appbar__mark">
            <IconMark />
          </span>
          Checador
        </span>

        <span className="appbar__side">
          <span className={`signal signal--${online ? 'live' : 'off'}`}>
            <span className="signal__dot" aria-hidden="true" />
            {online ? 'En línea' : 'Sin conexión'}
          </span>

          {onOpenBoard !== null && (
            <button className="button button--ghost" type="button" onClick={onOpenBoard}>
              <span className="button__icon">
                <IconTeam />
              </span>
              Equipo
            </button>
          )}

          <button className="button button--ghost" type="button" onClick={onSignOut}>
            <span className="button__icon">
              <IconExit />
            </span>
            Salir
          </button>
        </span>
      </header>

      {deviceRevoked && (
        <p className="notice notice--error" role="alert">
          Recursos Humanos dio de baja este equipo. Puedes ver tu información, pero los marcajes
          desde aquí serán rechazados.
        </p>
      )}

      {!online && (
        <p className="notice notice--warning" role="status">
          <span className="notice__icon">
            <IconOffline />
          </span>
          Sin conexión. Puedes marcar: se guarda aquí y se envía en cuanto vuelva la señal.
        </p>
      )}

      {error !== null && (
        <p className="notice notice--warning" role="status">
          {error}
        </p>
      )}

      {day === null ? (
        <p className="notice notice--error" role="alert">
          No se pudo cargar tu jornada. Revisa tu conexión e intenta de nuevo.
        </p>
      ) : (
        <div className="grid">
          <div className="grid__main">
            <DayHero
              day={day}
              fetchedAt={fetchedAt}
              name={firstName(name)}
              busyKind={busyKind}
              onPunch={onPunch}
            />

            {notice !== null && (
              // Keyed by its text so a second punch replays the entrance
              // animation instead of silently swapping the words underneath
              // somebody who is still looking at the first one.
              <p key={notice.text} className={`notice notice--${notice.tone} notice--pop`} role="alert">
                {notice.text}
              </p>
            )}

            {queue.pending > 0 && (
              <p className="notice notice--warning" role="status">
                {plural(queue.pending, 'marcaje esperando a enviarse.', 'marcajes esperando a enviarse.')}
              </p>
            )}

            {queue.rejected.length > 0 && (
              <section className="notice notice--error" role="alert">
                <p>Estos marcajes no se pudieron registrar. Avisa a Recursos Humanos:</p>
                <ul className="rejected">
                  {queue.rejected.map((item) => (
                    <li key={item.event.idempotency_key}>
                      {PUNCH_HISTORY_LABELS[item.event.kind]}
                      {' — '}
                      {formatTimeOfDay(item.event.occurred_at, day.time_zone)}: {item.reason}
                    </li>
                  ))}
                </ul>
                <button className="button button--quiet" type="button" onClick={queue.dismissRejected}>
                  Entendido
                </button>
              </section>
            )}

            <section className="card">
              <h2 className="card__title">Tu día</h2>
              <DayTimeline punches={day.punches} timeZone={day.time_zone} />
            </section>
          </div>

          <div className="grid__side">
            <StatRow summary={record.summary} error={record.summaryError} />

            <section className="card">
              <h2 className="card__title">Últimos 14 días</h2>
              {record.summary === null ? (
                <p className="blank">{record.summaryError ?? 'Cargando…'}</p>
              ) : (
                <FortnightChart
                  days={recentDays(record.summary)}
                  timeZone={record.summary.time_zone}
                />
              )}
            </section>

            <section className="card">
              <h2 className="card__title">Tus accesos</h2>
              <p className="card__note">
                Dónde y cuándo se abrió la aplicación con tu cuenta.
              </p>
              {record.sessionsError !== null && record.sessions.length === 0 ? (
                <p className="blank">{record.sessionsError}</p>
              ) : (
                <SessionList
                  sessions={record.sessions}
                  deviceId={deviceId()}
                  timeZone={day.time_zone}
                />
              )}
            </section>
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * The four figures, or the reason there are none.
 *
 * Every one of them was decided in `my_summary()`. This chooses the words and
 * the order, which is all a screen should be choosing about somebody's
 * attendance record.
 */
function StatRow({
  summary,
  error,
}: {
  readonly summary: MySummary | null;
  readonly error: string | null;
}): JSX.Element {
  if (summary === null) {
    return (
      <section className="card">
        <p className="blank">{error ?? 'Cargando tu resumen…'}</p>
      </section>
    );
  }

  const week = weekToDate(summary);
  const entryMinutes = minutesOfDay(summary.average_entry);

  return (
    <div className="tiles">
      <StatTile
        index={0}
        icon={<IconClock />}
        label="Esta semana"
        value={week.worked}
        format={formatClock}
        caption={
          week.expected > 0 ? `de ${formatClock(week.expected)} esperadas` : 'sin horario esta semana'
        }
      />

      <StatTile
        index={1}
        icon={<IconTarget />}
        label="Puntualidad"
        value={summary.punctuality_pct ?? 0}
        format={(value) => (summary.punctuality_pct === null ? '—' : `${String(value)}%`)}
        caption={`${String(summary.on_time_days)} de ${plural(summary.days_worked, 'día', 'días')} a tiempo`}
        tone={toneFor(summary.punctuality_pct)}
      />

      <StatTile
        index={2}
        icon={<IconFlame />}
        label="Racha"
        value={summary.streak_days}
        format={String}
        caption={plural(summary.streak_days, 'día completo seguido', 'días completos seguidos')}
        tone={summary.streak_days >= 5 ? 'good' : 'plain'}
      />

      <StatTile
        index={3}
        icon={<IconChart />}
        label="Entrada promedio"
        value={entryMinutes ?? 0}
        format={(value) => (entryMinutes === null ? '—' : asClock(value))}
        caption={`en los últimos ${plural(summary.days, 'día', 'días')}`}
      />
    </div>
  );
}

/**
 * Green above nine in ten, amber below three in four, plain in between.
 *
 * A threshold on a colour, not on the figure: the percentage itself is the
 * database's and is shown exactly as it arrives. This only decides whether the
 * tile is worth looking twice at, which is a presentation question -- and one
 * chosen to be forgiving, because a single late day in a short month can drag
 * the figure a long way.
 */
function toneFor(percent: number | null): 'plain' | 'good' | 'warn' {
  if (percent === null) {
    return 'plain';
  }
  if (percent >= 90) {
    return 'good';
  }
  return percent < 75 ? 'warn' : 'plain';
}

/** `09:04` as `544`, so the figure can count up to it like any other. */
function minutesOfDay(clock: string | null): number | null {
  if (clock === null) {
    return null;
  }

  const [hours, minutes] = clock.split(':').map((part) => Number.parseInt(part, 10));
  if (hours === undefined || minutes === undefined || !Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

/** And back again, at every frame of the count. */
function asClock(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
