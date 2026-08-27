import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { AdminPanel } from '../admin/AdminPanel';
import { useOnline } from '../../hooks/useOnline';
import { storedClockSkewMs } from '../../lib/clock';
import type { CallerRole, Profile, ReportScope, WorkdayState } from '../../lib/types';
import { useClockSkew } from '../punch/useClockSkew';
import { AlertsPanel } from './components/AlertsPanel';
import { ArrivalsChart } from './components/ArrivalsChart';
import { ReviewPanel } from './components/ReviewPanel';
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
import { ReportsPanel } from './components/ReportsPanel';
import { TEAM_RECORD_ID, TeamMemberRecord } from './components/TeamMemberRecord';
import './hr.css';
import { formatClock, formatLongDate, plural } from './labels';
import {
  countBySeverity,
  cumulativeArrivals,
  departmentsOf,
  employeesWithAlerts,
  countable,
  entryHistogram,
  filterAlerts,
  filterTeam,
  summarise,
} from './summary';
import { useEmployeeDay } from './useEmployeeDay';
import { useOpenAlerts } from './useOpenAlerts';
import { useReport } from './useReport';
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
/**
 * Who is offered the configuration screen. It mirrors the gate in
 * `internal.require_role()` rather than deciding anything: the database refuses
 * `list_accounts()` to everybody else, so this only chooses what to draw.
 */
const CONFIGURING_ROLES: readonly CallerRole[] = ['hr', 'admin'];

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
  const [homeOfficeOnly, setHomeOfficeOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [countableOnly, setCountableOnly] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reportScope, setReportScope] = useState<ReportScope>('week');
  const [reportAnchor, setReportAnchor] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const { team, error, loading, loadedAt, refresh } = useTeamDay(date, online);
  const alerts = useOpenAlerts(date, online);
  const employeeDay = useEmployeeDay(reviewing, date);
  const period = useReport(reportScope, reportAnchor, view === 'reports');

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

  const arrivals = useMemo(
    () => cumulativeArrivals(entryHistogram(team, timeZone)),
    [team, timeZone],
  );

  const visible = useMemo(
    () => filterTeam(team, { query, state, department, homeOfficeOnly }),
    [team, query, state, department, homeOfficeOnly],
  );

  /**
   * What this tool can actually judge is what it counts.
   *
   * The rest are not discarded -- `hiddenAlerts` says how many stepped aside
   * and the toggle brings them back -- because an alert that vanishes with no
   * trace is the way an alert gets lost.
   */
  const countedAlerts = useMemo(() => countable(alerts.alerts), [alerts.alerts]);

  const visibleAlerts = useMemo(
    () => filterAlerts(alerts.alerts, query, countableOnly),
    [alerts.alerts, query, countableOnly],
  );

  const hiddenAlerts = alerts.alerts.length - countedAlerts.length;

  /**
   * The alerts the panel is describing right now.
   *
   * The toggle can widen the list to every kind, and a heading still counting
   * only the countable ones would be the summary disagreeing with the rows
   * underneath it.
   */
  const shownAlerts = countableOnly ? countedAlerts : alerts.alerts;

  const severities = useMemo(() => countBySeverity(shownAlerts), [shownAlerts]);

  /**
   * The day's counter answers for the day, not for the alert view's toggle.
   *
   * Its figure, its caption and its pill all read `countedAlerts`, so the card
   * can never show a count of one beside a pill claiming a severity that count
   * does not include.
   */
  const countedSeverities = useMemo(() => countBySeverity(countedAlerts), [countedAlerts]);

  /**
   * The selected person, resolved against the board rather than remembered.
   *
   * A filter or a change of day can take the row away, and a record left open
   * for somebody who is no longer listed would be describing a person the
   * reader can no longer see.
   */
  const selected = useMemo(
    () => visible.find((member) => member.employee_id === selectedId) ?? null,
    [visible, selectedId],
  );

  const toggleSelected = useCallback((employeeId: string): void => {
    setSelectedId((current) => (current === employeeId ? null : employeeId));
  }, []);

  /**
   * Close the record and put focus back where it came from.
   *
   * Without this the row's button unmounts nothing but the panel does, and a
   * keyboard user is left on `document.body` with no place in the board.
   */
  const closeRecord = useCallback((): void => {
    const opener = selectedId;
    setSelectedId(null);
    if (opener !== null) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(`[data-employee="${opener}"]`)?.focus();
      });
    }
  }, [selectedId]);

  const alertsByEmployee = useMemo(() => {
    const counts = new Map<string, number>();
    for (const alert of countedAlerts) {
      counts.set(alert.employee_id, (counts.get(alert.employee_id) ?? 0) + 1);
    }
    return counts;
  }, [countedAlerts]);

  const step = useCallback((days: number): void => setDate(shiftDate(shownDate, days)), [shownDate]);

  const alertsRefresh = alerts.refresh;
  const reloadAll = useCallback((): void => {
    void refresh();
    void alertsRefresh();
  }, [refresh, alertsRefresh]);

  // After a decision the screen asks again rather than predicting the answer.
  // All three reads move: the workday's flag may have cleared, the alert may
  // have left the open list, and the punch now carries a verdict.
  const dayRefresh = employeeDay.refresh;
  const afterDecision = useCallback((): void => {
    void refresh();
    void alertsRefresh();
    void dayRefresh();
  }, [refresh, alertsRefresh, dayRefresh]);

  const pickState = useCallback((next: WorkdayState): void => {
    setView('team');
    setState((current) => (current === next ? 'all' : next));
  }, []);

  /**
   * Stepping a period, using the bounds the database returned rather than
   * calendar arithmetic done here.
   *
   * The day before a period's first day is always inside the previous period,
   * and the day after its last is always inside the next one -- whatever the
   * scope and however many days the month happened to have. Adding a month to
   * an anchor in the browser is where 31 January becomes a bug.
   */
  const stepPeriod = useCallback(
    (direction: -1 | 1): void => {
      const bounds = period.report;
      if (bounds === null) {
        return;
      }
      const edge = new Date(`${direction === -1 ? bounds.from : bounds.to}T00:00:00Z`);
      edge.setUTCDate(edge.getUTCDate() + direction);
      setReportAnchor(edge.toISOString().slice(0, 10));
    },
    [period.report],
  );

  const clearFilters = useCallback((): void => {
    setState('all');
    setDepartment('all');
    setHomeOfficeOnly(false);
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

  const filtering =
    state !== 'all' || department !== 'all' || homeOfficeOnly || query !== '';
  // The configuration screen is not a view of a day, so the day's counters and
  // its toolbar have nothing to say about it.
  // Neither the configuration screen nor the report is a view of a day, so the
  // day's counters, its search box and its date stepper have nothing to say
  // about either. The report carries its own period control instead.
  const dayScoped = view === 'team' || view === 'alerts' || view === 'review';

  return (
    <div className={`hr${sidebarOpen ? ' hr--open' : ''}`}>
      <Sidebar
        view={view}
        onView={setView}
        alertCount={countedAlerts.length}
        reviewCount={summary.needsReview}
        canAdminister={CONFIGURING_ROLES.includes(profile.role)}
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

          {dayScoped && (
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
          )}

          <span className="topbar__spacer" />

          <div className="panel__tools" role="group" aria-label="Cambiar de día" hidden={!dayScoped}>
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

          {dayScoped && (
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
              value={countedAlerts.length}
              caption={
                countedAlerts.length === 0
                  ? 'Nada pendiente'
                  : plural(employeesWithAlerts(countedAlerts), 'persona', 'personas')
              }
              icon={<IconAlert />}
              {...(countedSeverities.high > 0
                ? {
                    pill: {
                      text: plural(countedSeverities.high, 'alta', 'altas'),
                      tone: 'bad' as const,
                    },
                  }
                : {})}
              selected={view === 'alerts'}
              onSelect={() => setView(view === 'alerts' ? 'team' : 'alerts')}
            />
          </section>
          )}

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
                    <button
                      className={homeOfficeOnly ? 'btn btn--on' : 'btn'}
                      type="button"
                      aria-pressed={homeOfficeOnly}
                      onClick={() => setHomeOfficeOnly((active) => !active)}
                    >
                      Solo Home Office
                    </button>
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

                <TeamBoard
                  team={visible}
                  timeZone={timeZone}
                  alertsByEmployee={alertsByEmployee}
                  selectedId={selected === null ? null : selected.employee_id}
                  onSelect={toggleSelected}
                  recordId={TEAM_RECORD_ID}
                />
              </section>

              {selected !== null && (
                /* Keyed by employee: without it React reuses the instance and
                 * the new name renders over the previous person's figures until
                 * the read lands -- a box that looks right and is not. */
                <TeamMemberRecord
                  key={selected.employee_id}
                  member={selected}
                  onClose={closeRecord}
                />
              )}
            </>
          ) : view === 'alerts' ? (
            <section className="panel">
              <div className="panel__head">
                <div>
                  <h2 className="panel__title">Alertas abiertas</h2>
                  <p className="panel__subtitle">
                    {shownAlerts.length === 0
                      ? 'Nada que revisar.'
                      : `${plural(severities.high, 'alta', 'altas')} · ${plural(
                          severities.medium,
                          'media',
                          'medias',
                        )} · ${plural(severities.low, 'baja', 'bajas')}`}
                  </p>
                </div>
                <div className="panel__tools">
                  {(hiddenAlerts > 0 || !countableOnly) && (
                    <button
                      className={countableOnly ? 'btn btn--on' : 'btn'}
                      type="button"
                      /* Stable label, moving state. A caption that flipped
                        * alongside `aria-pressed` would announce the next
                        * action and the current state at once, contradicting
                        * itself. */
                      aria-pressed={countableOnly}
                      onClick={() => setCountableOnly((only) => !only)}
                    >
                      Solo las que cuentan
                    </button>
                  )}
                  {query !== '' && (
                    <button className="btn" type="button" onClick={clearFilters}>
                      Limpiar
                    </button>
                  )}
                </div>
              </div>

              {/* The live region is always in the tree and only its text
                * changes. Mounting it together with its message is one of the
                * two reliable ways to make a status announcement never fire. */}
              <p className="note" role="status" aria-live="polite">
                {countableOnly && hiddenAlerts > 0
                  ? `${plural(hiddenAlerts, 'alerta oculta', 'alertas ocultas')} de otro tipo. ` +
                    'Pulsa «Solo las que cuentan» para verlas. En Home Office no se espera que ' +
                    'todos marquen cada día, así que una ausencia no prueba nada: aquí cuentan ' +
                    'las entradas tardías y los relojes fuera de hora.'
                  : ''}
              </p>

              <AlertsPanel alerts={visibleAlerts} timeZone={timeZone} boardDate={shownDate} />
            </section>
          ) : view === 'reports' ? (
            <ReportsPanel
              report={period.report}
              scope={reportScope}
              onScope={setReportScope}
              onStep={stepPeriod}
              onToday={() => setReportAnchor(null)}
              atLatest={period.report !== null && !period.report.closed}
              error={period.error}
              loading={period.loading}
            />
          ) : view === 'review' ? (
            <ReviewPanel
              team={team}
              alerts={alerts.alerts}
              day={employeeDay.day}
              dayError={employeeDay.error}
              dayLoading={employeeDay.loading}
              selected={reviewing}
              onSelect={setReviewing}
              timeZone={timeZone}
              onDecided={afterDecision}
            />
          ) : (
            <AdminPanel />
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
