import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useOnline } from '../../hooks/useOnline';
import { storedClockSkewMs } from '../../lib/clock';
import type { Profile, WorkdayState } from '../../lib/types';
import { useClockSkew } from '../punch/useClockSkew';
import { AlertsPanel } from './components/AlertsPanel';
import { ArrivalsChart } from './components/ArrivalsChart';
import {
  IconAlert,
  IconBreak,
  IconChevron,
  IconDone,
  IconMenu,
  IconPending,
  IconRefresh,
  IconSearch,
  IconWorking,
} from './components/icons';
import { Sidebar, type BoardView } from './components/Sidebar';
import { StatCard } from './components/StatCard';
import { TeamBoard } from './components/TeamBoard';
import './hr.css';
import { formatClock, formatLongDate, plural } from './labels';
import {
  countBySeverity,
  cumulativeArrivals,
  departmentsOf,
  employeesWithAlerts,
  entryHistogram,
  filterAlerts,
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

  const [view, setView] = useState<BoardView>('team');
  const [date, setDate] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<WorkdayState | 'all'>('all');
  const [department, setDepartment] = useState<string>('all');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

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
  const severities = useMemo(() => countBySeverity(alerts.alerts), [alerts.alerts]);

  const arrivals = useMemo(
    () => cumulativeArrivals(entryHistogram(team, timeZone)),
    [team, timeZone],
  );

  const visible = useMemo(
    () => filterTeam(team, { query, state, department }),
    [team, query, state, department],
  );

  const visibleAlerts = useMemo(() => filterAlerts(alerts.alerts, query), [alerts.alerts, query]);

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

  const pickState = useCallback((next: WorkdayState): void => {
    setView('team');
    setState((current) => (current === next ? 'all' : next));
  }, []);

  const clearFilters = useCallback((): void => {
    setState('all');
    setDepartment('all');
    setQuery('');
  }, []);

  // The search box is the one control somebody reaches for repeatedly, and this
  // board is read on a keyboard at a desk.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loading && team.length === 0) {
    return <BoardSkeleton />;
  }

  const filtering = state !== 'all' || department !== 'all' || query !== '';

  return (
    <div className={`hr${sidebarOpen ? ' hr--open' : ''}`}>
      <Sidebar
        view={view}
        onView={setView}
        alertCount={alerts.alerts.length}
        profile={profile}
        loadedAt={loadedAt}
        online={online}
        onOpenMyDay={onOpenMyDay}
        onSignOut={onSignOut}
      />

      <div className="main">
        <header className="topbar">
          <button
            className="btn btn--icon"
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label="Mostrar u ocultar el menú"
            aria-expanded={sidebarOpen}
          >
            <IconMenu />
          </button>

          <label className="search">
            <span className="search__icon">
              <IconSearch />
            </span>
            <span className="sr-only">Buscar por nombre o departamento</span>
            <input
              ref={searchRef}
              className="field"
              type="search"
              value={query}
              placeholder="Buscar…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="kbd" aria-hidden="true">
              ⌘K
            </span>
          </label>

          <span className="topbar__spacer" />

          <div className="panel__tools" role="group" aria-label="Cambiar de día">
            <button
              className="btn btn--icon"
              type="button"
              onClick={() => step(-1)}
              aria-label="Día anterior"
            >
              <IconChevron direction="left" />
            </button>
            <button className="btn" type="button" onClick={() => setDate(null)} disabled={isToday}>
              Hoy
            </button>
            <button
              className="btn btn--icon"
              type="button"
              onClick={() => step(1)}
              disabled={isToday}
              aria-label="Día siguiente"
            >
              <IconChevron direction="right" />
            </button>
            <button
              className="btn btn--icon"
              type="button"
              onClick={reloadAll}
              aria-label="Actualizar ahora"
            >
              <IconRefresh />
            </button>
          </div>
        </header>

        <main className="content">
          {!online && (
            <p className="note note--warn" role="status">
              Sin conexión. Se muestra la última lectura.
            </p>
          )}

          {error !== null && online && (
            <p className="note note--warn" role="status">
              {error}
            </p>
          )}

          <section className="stats" aria-label="Resumen del día">
            <StatCard
              index={0}
              label="Trabajando"
              value={summary.byState.working}
              caption={`de ${plural(summary.total, 'persona activa', 'personas activas')}`}
              icon={<IconWorking />}
              pill={{ text: share(summary.byState.working, summary.total), tone: 'good' }}
              selected={state === 'working'}
              onSelect={() => pickState('working')}
            />
            <StatCard
              index={1}
              label="En pausa"
              value={summary.byState.on_break}
              caption={`${formatClock(summary.breakSeconds)} acumuladas`}
              icon={<IconBreak />}
              pill={{ text: share(summary.byState.on_break, summary.total), tone: 'warn' }}
              selected={state === 'on_break'}
              onSelect={() => pickState('on_break')}
            />
            <StatCard
              index={2}
              label="Sin iniciar"
              value={summary.byState.not_started}
              caption={isToday ? 'Todavía no marcan' : 'No marcaron'}
              icon={<IconPending />}
              pill={{ text: share(summary.byState.not_started, summary.total), tone: 'mute' }}
              selected={state === 'not_started'}
              onSelect={() => pickState('not_started')}
            />
            <StatCard
              index={3}
              label="Terminada"
              value={summary.byState.finished}
              caption={`${formatClock(summary.workedSeconds)} trabajadas`}
              icon={<IconDone />}
              pill={{ text: share(summary.byState.finished, summary.total), tone: 'info' }}
              selected={state === 'finished'}
              onSelect={() => pickState('finished')}
            />
            <StatCard
              index={4}
              label="Alertas"
              value={alerts.alerts.length}
              caption={
                alerts.alerts.length === 0
                  ? 'Nada pendiente'
                  : plural(employeesWithAlerts(alerts.alerts), 'persona', 'personas')
              }
              icon={<IconAlert />}
              {...(severities.high > 0
                ? { pill: { text: `${String(severities.high)} altas`, tone: 'bad' as const } }
                : {})}
              selected={view === 'alerts'}
              onSelect={() => setView(view === 'alerts' ? 'team' : 'alerts')}
            />
          </section>

          {view === 'team' ? (
            <>
              <section className="panel">
                <div className="panel__head">
                  <div>
                    <h2 className="panel__title">Llegadas</h2>
                    <p className="panel__subtitle">
                      Cuántas personas habían entrado a cada hora · {formatLongDate(shownDate)}
                      {isToday && <LiveClock timeZone={timeZone} />}
                    </p>
                  </div>
                  <ul className="legend panel__tools">
                    <li>
                      <span className="swatch" />
                      Han entrado
                    </li>
                    <li>
                      <span className="swatch swatch--soft" />
                      Plantilla activa ({summary.total})
                    </li>
                  </ul>
                </div>
                <div className="panel__body">
                  <ArrivalsChart points={arrivals} total={summary.total} />
                </div>
              </section>

              <section className="panel">
                <div className="panel__head">
                  <div>
                    <h2 className="panel__title">
                      {visible.length === summary.total
                        ? plural(summary.total, 'persona', 'personas')
                        : `${String(visible.length)} de ${plural(summary.total, 'persona', 'personas')}`}
                    </h2>
                    <p className="panel__subtitle">
                      Estado, entrada contra horario, tiempo trabajado y en pausa.
                    </p>
                  </div>

                  <div className="panel__tools">
                    <label>
                      <span className="sr-only">Filtrar por departamento</span>
                      <select
                        className="field"
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
                    {filtering && (
                      <button className="btn" type="button" onClick={clearFilters}>
                        Limpiar
                      </button>
                    )}
                  </div>
                </div>

                <TeamBoard team={visible} timeZone={timeZone} alertsByEmployee={alertsByEmployee} />
              </section>
            </>
          ) : (
            <section className="panel">
              <div className="panel__head">
                <div>
                  <h2 className="panel__title">Alertas abiertas</h2>
                  <p className="panel__subtitle">
                    {alerts.alerts.length === 0
                      ? 'Nada que revisar.'
                      : `${plural(severities.high, 'alta', 'altas')} · ${plural(
                          severities.medium,
                          'media',
                          'medias',
                        )} · ${plural(severities.low, 'baja', 'bajas')}`}
                  </p>
                </div>
                {query !== '' && (
                  <div className="panel__tools">
                    <button className="btn" type="button" onClick={clearFilters}>
                      Limpiar
                    </button>
                  </div>
                )}
              </div>

              <AlertsPanel alerts={visibleAlerts} timeZone={timeZone} boardDate={shownDate} />
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function share(part: number, total: number): string {
  return total === 0 ? '0%' : `${String(Math.round((part / total) * 100))}%`;
}

/**
 * The server's clock, not this computer's.
 *
 * An attendance board showing the reader's own clock would disagree with every
 * timestamp beside it whenever that clock drifted. The measured skew is the
 * same one the punch screen records, read back from storage.
 */
function LiveClock({ timeZone }: { readonly timeZone: string }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const serverNow = new Date(now - storedClockSkewMs());

  return (
    <>
      {' · '}
      <time className="clock" dateTime={serverNow.toISOString()}>
        {new Intl.DateTimeFormat('es-MX', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
          timeZone,
        }).format(serverNow)}
      </time>
    </>
  );
}

function BoardSkeleton(): JSX.Element {
  return (
    <div className="hr hr--collapsed">
      <div className="main">
        <main className="content" aria-busy="true">
          <p className="sr-only">Cargando el tablero…</p>
          <div className="stats">
            {[0, 1, 2, 3, 4].map((index) => (
              <div className="skeleton skeleton--stat" key={index} />
            ))}
          </div>
          <div className="skeleton skeleton--panel" />
        </main>
      </div>
    </div>
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
