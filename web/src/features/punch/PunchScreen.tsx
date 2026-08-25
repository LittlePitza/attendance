import { useCallback, useState, type JSX } from 'react';
import { useOnline } from '../../hooks/useOnline';
import { recordPunch } from '../../lib/punching';
import type { MyDay, PunchKind } from '../../lib/types';
import {
  PUNCH_HISTORY_LABELS,
  PUNCH_LABELS,
  STATE_LABELS,
  formatDuration,
  formatTimeOfDay,
} from './labels';
import { useClockSkew } from './useClockSkew';
import { useHeartbeat } from './useHeartbeat';
import { useMyDay } from './useMyDay';
import { usePunchQueue } from './usePunchQueue';

interface Notice {
  readonly tone: 'ok' | 'warning' | 'error';
  readonly text: string;
}

/**
 * The whole employee-facing application.
 *
 * Every button on it comes from `day.next_actions`, which the database sends.
 * The screen does not know that a break follows an entry, or that a finished
 * day accepts nothing: it renders what it is offered and shows what comes back.
 * That is the reason the read API returns those actions at all.
 */
export function PunchScreen({ onSignOut }: { onSignOut: () => void }): JSX.Element {
  const online = useOnline();
  const { day, error, loading, refresh } = useMyDay();

  const reload = useCallback((): void => {
    void refresh();
  }, [refresh]);

  const queue = usePunchQueue(online, reload);
  const workdayIsOpen = day?.state === 'working' || day?.state === 'on_break';

  useClockSkew(online);
  useHeartbeat(online && workdayIsOpen);

  const [busyKind, setBusyKind] = useState<PunchKind | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function take(kind: PunchKind): Promise<void> {
    setBusyKind(kind);
    setNotice(null);

    try {
      const outcome = await recordPunch(kind);

      if (outcome.status === 'recorded') {
        setNotice({ tone: 'ok', text: 'Listo. Quedó registrado.' });
        await refresh();
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
  }

  if (loading && day === null) {
    return (
      <main className="screen screen--centered">
        <p className="muted">Cargando tu jornada…</p>
      </main>
    );
  }

  return (
    <main className="screen">
      <header className="header">
        <div>
          <h1 className="header__title">Checador</h1>
          {day !== null && <p className="header__date">{longDate(day)}</p>}
        </div>
        <button className="button button--quiet" type="button" onClick={onSignOut}>
          Salir
        </button>
      </header>

      {!online && (
        <p className="notice notice--warning" role="status">
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
        <>
          <section className="card state" aria-live="polite">
            <p className="state__label">{STATE_LABELS[day.state]}</p>
            <dl className="counters">
              <div className="counter">
                <dt>Trabajado</dt>
                <dd>{formatDuration(day.worked_seconds)}</dd>
              </div>
              <div className="counter">
                <dt>En pausa</dt>
                <dd>{formatDuration(day.break_seconds)}</dd>
              </div>
            </dl>
            {day.schedule === null ? (
              <p className="muted">Hoy no tienes horario asignado.</p>
            ) : (
              <p className="muted">
                Tu horario: entrada {day.schedule.entry_expected}, salida{' '}
                {day.schedule.exit_expected}.
              </p>
            )}
          </section>

          {notice !== null && (
            <p className={`notice notice--${notice.tone}`} role="alert">
              {notice.text}
            </p>
          )}

          <section className="actions">
            {day.next_actions.length === 0 ? (
              <p className="muted">Tu jornada de hoy ya está cerrada.</p>
            ) : (
              day.next_actions.map((kind) => (
                <button
                  key={kind}
                  className="button button--primary button--large"
                  type="button"
                  disabled={busyKind !== null}
                  onClick={() => void take(kind)}
                >
                  {busyKind === kind ? 'Registrando…' : PUNCH_LABELS[kind]}
                </button>
              ))
            )}
          </section>

          {queue.pending > 0 && (
            <p className="notice notice--warning" role="status">
              {queue.pending === 1
                ? '1 marcaje esperando a enviarse.'
                : `${String(queue.pending)} marcajes esperando a enviarse.`}
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
              <button
                className="button button--quiet"
                type="button"
                onClick={queue.dismissRejected}
              >
                Entendido
              </button>
            </section>
          )}

          <section className="card">
            <h2 className="card__title">Marcajes de hoy</h2>
            {day.punches.length === 0 ? (
              <p className="muted">Todavía no has marcado nada hoy.</p>
            ) : (
              <ol className="punches">
                {day.punches.map((punch) => (
                  <li key={punch.id} className="punch">
                    <span className="punch__time">
                      {formatTimeOfDay(punch.occurred_at, day.time_zone)}
                    </span>
                    <span className="punch__kind">{PUNCH_HISTORY_LABELS[punch.kind]}</span>
                    {punch.source === 'offline' && <span className="tag">sin conexión</span>}
                    {punch.needs_review && <span className="tag tag--review">por revisar</span>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function longDate(day: MyDay): string {
  // `day.date` is a plain date from Postgres, already in the employee's own
  // zone. Pinning it to midday UTC and formatting it as UTC keeps a browser in
  // a different zone from shifting it to the day before.
  return new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${day.date}T12:00:00Z`));
}
