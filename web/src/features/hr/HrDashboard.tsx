import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useOnline } from '../../hooks/useOnline';
import { storedClockSkewMs } from '../../lib/clock';
import type { Profile, WorkdayState } from '../../lib/types';
import { useClockSkew } from '../punch/useClockSkew';
import { AlertsPanel } from './components/AlertsPanel';
import { EntryHistogram } from './components/EntryHistogram';
import {
  IconAlert,
  IconBreak,
  IconChevron,
  IconDone,
  IconPending,
  IconRefresh,
  IconSearch,
  IconWorking,
} from './components/icons';
import { StatCard } from './components/StatCard';
import { StateBar } from './components/StateBar';
import { TeamBoard } from './components/TeamBoard';
import './hr.css';
import { formatClock, formatLongDate, plural } from './labels';
import {
  countBySeverity,
  departmentsOf,
  employeesWithAlerts,
  entryHistogram,
  filterTeam,
  summarise,
} from './summary';
import { useOpenAlerts } from './useOpenAlerts';
import { useTeamDay } from './useTeamDay';

/**
 * The board HR and managers read.
 *
 * What anybody sees on it is decided by RLS: `team_day()` and `open_alerts()`
 * are `SECURITY INVOKER`, so a manager gets their department and HR gets
 * everyone without this file containing a single role check. The role decides
 * which screen opens and nothing else.
 *
 * Everything on it is a fact the database reported. The one thing the board
 * deliberately does not do is judge: it never works out who was late, because
 * that depends on a schedule, a grace period and a department threshold that
 * only `evaluate_alerts()` resolves. Lateness arrives as an alert.
 */
export function HrDashboard({
  profile,
  onSignOut,
  onOpenMyDay,
}: {
  readonly profile: Profile;
  readonly onSignOut: () => void;
  readonly onOpenMyDay: (() => void) | null;
}): JSX.Element {
  const online = useOnline();
  useClockSkew(online);

  const [date, setDate] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<WorkdayState | 'all'>('all');
  const [department, setDepartment] = useState<string>('all');

  const { team, error, loading, loadedAt, refresh } = useTeamDay(date, online);
  const alerts = useOpenAlerts(date, online);

  // The board is read by one person in one place, which is the same assumption
  // `team_day()` makes when it resolves its date. The browser's zone is that
  // person's zone.
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  // The date the database resolved, not one computed here -- stepping from the
  // server's idea of today is what keeps a browser an hour off from paging to
  // the wrong day. Only when there is no row at all is there nothing to read it
  // from, and then the browser's date is the only answer available.
  const shownDate = date ?? team[0]?.work_date ?? isoDateIn(new Date(), timeZone);
  const isToday = shownDate === isoDateIn(new Date(), timeZone);

  const summary = useMemo(() => summarise(team), [team]);
  const departments = useMemo(() => departmentsOf(team), [team]);
  const histogram = useMemo(() => entryHistogram(team, timeZone), [team, timeZone]);
  const severities = useMemo(() => countBySeverity(alerts.alerts), [alerts.alerts]);

  const visible = useMemo(
    () => filterTeam(team, { query, state, department }),
    [team, query, state, department],
  );

  const alertsByEmployee = useMemo(() => {
    const counts = new Map<string, number>();
    for (const alert of alerts.alerts) {
      counts.set(alert.employee_id, (counts.get(alert.employee_id) ?? 0) + 1);
    }
    return counts;
  }, [alerts.alerts]);

  const step = useCallback((days: number): void => setDate(shiftDate(shownDate, days)), [shownDate]);

  const alertsRefresh = alerts.refresh;
  const reloadAll = useCallback((): void => {
    void refresh();
    void alertsRefresh();
  }, [refresh, alertsRefresh]);

  const toggleState = useCallback(
    (next: WorkdayState): void => setState((current) => (current === next ? 'all' : next)),
    [],
  );

  const clearFilters = useCallback((): void => {
    setState('all');
    setDepartment('all');
    setQuery('');
  }, []);

  if (loading && team.length === 0) {
    return <BoardSkeleton />;
  }

  return (
    <main className="hr">
      <header className="hr__bar">
        <div className="hr__identity">
          <h1 className="hr__title">Equipo</h1>
          <p className="hr__subtitle">
            {formatLongDate(shownDate)}
            {isToday && <LiveClock timeZone={timeZone} online={online} />}
          </p>
        </div>

        <div className="hr__dates" role="group" aria-label="Cambiar de día">
          <button
            className="button button--icon"
            type="button"
            onClick={() => step(-1)}
            aria-label="Día anterior"
          >
            <IconChevron direction="left" />
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => setDate(null)}
            disabled={isToday}
          >
            Hoy
          </button>
          <button
            className="button button--icon"
            type="button"
            onClick={() => step(1)}
            disabled={isToday}
            aria-label="Día siguiente"
          >
            <IconChevron direction="right" />
          </button>
        </div>

        <div className="hr__actions">
          <button
            className="button button--icon"
            type="button"
            onClick={reloadAll}
            aria-label="Actualizar ahora"
          >
            <IconRefresh />
          </button>
          {onOpenMyDay !== null && (
            <button className="button button--quiet" type="button" onClick={onOpenMyDay}>
              Mi jornada
            </button>
          )}
          <button className="button button--quiet" type="button" onClick={onSignOut}>
            Salir
          </button>
        </div>
      </header>

      {!online && (
        <p className="notice notice--warning" role="status">
          Sin conexión. Se muestra la última lectura
          {loadedAt !== null && ` de las ${loadedAt.toLocaleTimeString('es-MX')}`}.
        </p>
      )}

      {error !== null && online && (
        <p className="notice notice--warning" role="status">
          {error}
        </p>
      )}

      <section className="hr__stats" aria-label="Resumen del día">
        <StatCard
          index={0}
          tone="working"
          label="Trabajando"
          value={summary.byState.working}
          caption={`de ${String(summary.total)} activos`}
          icon={<IconWorking />}
          selected={state === 'working'}
          onSelect={() => toggleState('working')}
        />
        <StatCard
          index={1}
          tone="break"
          label="En pausa"
          value={summary.byState.on_break}
          caption={`${formatClock(summary.breakSeconds)} acumuladas`}
          icon={<IconBreak />}
          selected={state === 'on_break'}
          onSelect={() => toggleState('on_break')}
        />
        <StatCard
          index={2}
          tone="pending"
          label="Sin iniciar"
          value={summary.byState.not_started}
          caption={isToday ? 'Todavía no marcan' : 'No marcaron'}
          icon={<IconPending />}
          selected={state === 'not_started'}
          onSelect={() => toggleState('not_started')}
        />
        <StatCard
          index={3}
          tone="done"
          label="Terminada"
          value={summary.byState.finished}
          caption={`${formatClock(summary.workedSeconds)} trabajadas`}
          icon={<IconDone />}
          selected={state === 'finished'}
          onSelect={() => toggleState('finished')}
        />
        <StatCard
          index={4}
          tone="alert"
          label="Alertas"
          value={alerts.alerts.length}
          caption={
            alerts.alerts.length === 0
              ? 'Nada pendiente'
              : `${plural(employeesWithAlerts(alerts.alerts), 'persona', 'personas')} · ${plural(
                  severities.high,
                  'alta',
                  'altas',
                )}`
          }
          icon={<IconAlert />}
        />
      </section>

      <div className="hr__split">
        <section className="card hr__panel">
          <h2 className="card__title">Reparto de la jornada</h2>
          <StateBar counts={summary.byState} total={summary.total} />
        </section>

        <section className="card hr__panel">
          <h2 className="card__title">Entradas por hora</h2>
          <EntryHistogram buckets={histogram} />
        </section>
      </div>

      <section className="card hr__panel">
        <div className="hr__panel-head">
          <h2 className="card__title">Alertas abiertas</h2>
          {alerts.alerts.length > 0 && (
            <span className="hr__panel-note">
              {plural(severities.high, 'alta', 'altas')} ·{' '}
              {plural(severities.medium, 'media', 'medias')} ·{' '}
              {plural(severities.low, 'baja', 'bajas')}
            </span>
          )}
        </div>
        <AlertsPanel alerts={alerts.alerts} timeZone={timeZone} boardDate={shownDate} />
      </section>

      <section className="card hr__panel">
        <div className="hr__panel-head">
          <h2 className="card__title">
            {visible.length === summary.total
              ? plural(summary.total, 'persona', 'personas')
              : `${String(visible.length)} de ${plural(summary.total, 'persona', 'personas')}`}
          </h2>

          <div className="hr__filters">
            <label className="search">
              <span className="search__icon">
                <IconSearch />
              </span>
              <span className="sr-only">Buscar por nombre o departamento</span>
              <input
                className="search__input"
                type="search"
                value={query}
                placeholder="Buscar…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>

            <label className="select">
              <span className="sr-only">Filtrar por departamento</span>
              <select
                className="select__input"
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
              >
                <option value="all">Todos los departamentos</option>
                {departments.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            {(state !== 'all' || department !== 'all' || query !== '') && (
              <button className="button button--quiet" type="button" onClick={clearFilters}>
                Limpiar
              </button>
            )}
          </div>
        </div>

        <TeamBoard team={visible} timeZone={timeZone} alertsByEmployee={alertsByEmployee} />
      </section>

      <p className="hr__footer">
        {profile.name ?? 'Cuenta administrativa'} · {profile.role}
        {loadedAt !== null && ` · actualizado ${loadedAt.toLocaleTimeString('es-MX')}`}
      </p>
    </main>
  );
}

/**
 * The server's clock, not this computer's.
 *
 * An attendance board that showed the reader's own clock would disagree with
 * every timestamp beside it whenever that clock drifted. The measured skew is
 * the same one the punch screen records, read back from storage.
 */
function LiveClock({ timeZone, online }: { timeZone: string; online: boolean }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const serverNow = new Date(now - storedClockSkewMs());

  return (
    <span className="hr__clock">
      <span className={`pulse${online ? '' : ' pulse--off'}`} aria-hidden="true" />
      <time dateTime={serverNow.toISOString()}>
        {new Intl.DateTimeFormat('es-MX', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
          timeZone,
        }).format(serverNow)}
      </time>
    </span>
  );
}

function BoardSkeleton(): JSX.Element {
  return (
    <main className="hr" aria-busy="true">
      <p className="sr-only">Cargando el tablero…</p>
      <div className="hr__stats">
        {[0, 1, 2, 3, 4].map((index) => (
          <div className="card skeleton skeleton--stat" key={index} />
        ))}
      </div>
      <div className="card skeleton skeleton--panel" />
      <div className="card skeleton skeleton--panel" />
    </main>
  );
}

/** The calendar date at an instant, in a named zone. `sv-SE` formats as ISO. */
function isoDateIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(at);
}

function shiftDate(isoDate: string, days: number): string {
  // Midday UTC so adding a day cannot land on the wrong side of a DST change.
  const at = new Date(`${isoDate}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
