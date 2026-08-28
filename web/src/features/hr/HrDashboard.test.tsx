import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '../../lib/errors';
import type {
  AttendanceReport,
  EmployeeSummary,
  OpenAlert,
  Profile,
  ReportScope,
  TeamMember,
} from '../../lib/types';
import { HrDashboard } from './HrDashboard';

const teamDay = vi.fn<() => Promise<TeamMember[]>>();
const openAlerts = vi.fn<() => Promise<OpenAlert[]>>();
const employeeSummary = vi.fn<(id: string, days?: number) => Promise<EmployeeSummary>>();
const employeeSessions = vi.fn<() => Promise<[]>>();
const attendanceReport =
  vi.fn<(scope: ReportScope, anchor?: string) => Promise<AttendanceReport>>();

/**
 * Today, in the zone the board itself reads dates in.
 *
 * Not a fixed date. `team_day()` answers for whatever today is, and the header
 * compares that against now -- so a hardcoded fixture claims to be showing an
 * older day and the controls correctly refuse to step forward. `sv-SE` formats
 * as ISO, and no zone argument means the runner's own, which is exactly the one
 * the component resolves.
 */
const TODAY = new Intl.DateTimeFormat('sv-SE').format(new Date());

/**
 * Only the network is faked. The hooks, the filtering, the aggregation and the
 * rendering all run for real, so what is under test is the board somebody
 * actually reads rather than a pile of mocks agreeing with each other.
 */
vi.mock('../../lib/api', () => ({
  api: {
    teamDay: () => teamDay(),
    openAlerts: () => openAlerts(),
    employeeSummary: (id: string, days?: number) => employeeSummary(id, days),
    employeeSessions: () => employeeSessions(),
    attendanceReport: (scope: ReportScope, anchor?: string) => attendanceReport(scope, anchor),
    serverTime: () => Promise.resolve({ utc: '2026-08-24T15:00:00Z', epoch_ms: 1787000000000 }),
  },
}));

function member(over: Partial<TeamMember> & { employee_id: string }): TeamMember {
  return {
    employee_name: 'Ana Ruiz',
    department: 'Sistemas',
    work_date: TODAY,
    state: 'working',
    opened_at: '2026-08-24T15:02:00Z',
    closed_at: null,
    worked_seconds: 7200,
    break_seconds: 0,
    last_heartbeat: '2026-08-24T17:00:00Z',
    has_offline: false,
    needs_review: false,
    entry_expected: '09:00:00',
    exit_expected: '18:00:00',
    ...over,
  };
}

function record(over: Partial<EmployeeSummary> = {}): EmployeeSummary {
  return {
    employee_id: '1',
    employee_name: 'Ana Ruiz',
    employee_state: 'activo',
    server_time: '2026-08-27T15:00:00Z',
    time_zone: 'America/Mexico_City',
    from: '2026-07-29',
    to: '2026-08-27',
    days: 30,
    worked_seconds: 27_000,
    break_seconds: 3600,
    expected_seconds: 28_800,
    days_scheduled: 22,
    days_worked: 4,
    days_complete: 3,
    late_days: 1,
    on_time_days: 3,
    absent_days: 0,
    punctuality_pct: 75,
    average_entry: '09:04',
    streak_days: 3,
    offline_days: 0,
    no_connection_alerts: 0,
    expired_sessions: 0,
    weeks: [
      {
        week_start: '2026-08-24',
        days_scheduled: 5,
        days_worked: 4,
        days_complete: 3,
        worked_seconds: 27_000,
        break_seconds: 3600,
        expected_seconds: 28_800,
        late_days: 1,
      },
    ],
    series: [],
    ...over,
  };
}

const profile: Profile = {
  role: 'hr',
  employee_id: '30000000-0000-4000-8000-000000000001',
  name: 'Recursos Humanos',
  department_id: null,
  department: null,
};

function show(): void {
  render(<HrDashboard profile={profile} onSignOut={() => undefined} onOpenMyDay={null} />);
}

/**
 * The sidebar link, not the counter card -- both are buttons reading "Alertas",
 * and that is on purpose: one navigates, the other filters to the same place.
 */
function navLink(name: RegExp | string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Secciones' })).getByRole('button', { name });
}

/**
 * A closed week, so the stepper's forward control is enabled and can be tested.
 * The panel's own rendering is covered in ReportsPanel.test.tsx; here the report
 * only has to carry bounds for the stepping assertions to be about.
 */
function periodReport(): AttendanceReport {
  return {
    server_time: '2026-08-31T12:00:00Z',
    time_zone: 'America/Mexico_City',
    scope: 'week',
    anchor: '2026-08-26',
    from: '2026-08-24',
    to: '2026-08-30',
    days: 7,
    closed: true,
    totals: {
      people: 0,
      people_home_office: 0,
      people_met: 0,
      people_partial: 0,
      people_missed: 0,
      people_pending: 0,
      people_not_scheduled: 0,
      days_scheduled: 0,
      days_scheduled_past: 0,
      days_worked: 0,
      days_complete: 0,
      worked_seconds: 0,
      break_seconds: 0,
      expected_seconds: 0,
      expected_seconds_elapsed: 0,
      late_days: 0,
      absent_days: 0,
      incomplete_days: 0,
      offline_days: 0,
      alerts_total: 0,
      punctuality_pct: null,
    },
    alerts_by_kind: [],
    people: [],
    standouts: { punctual: [], most_late: [], most_absent: [], most_hours: [] },
  };
}

beforeEach(() => {
  teamDay.mockResolvedValue([
    member({ employee_id: '1', employee_name: 'Ana Ruiz', state: 'working' }),
    member({ employee_id: '2', employee_name: 'Beto Lara', state: 'on_break', department: 'Compras' }),
    member({ employee_id: '3', employee_name: 'Carla Sosa', state: 'not_started', opened_at: null }),
  ]);
  openAlerts.mockResolvedValue([]);
  employeeSummary.mockResolvedValue(record());
  employeeSessions.mockResolvedValue([]);
  attendanceReport.mockResolvedValue(periodReport());
});

describe('HrDashboard', () => {
  it('shows everyone, with the state the database reported', async () => {
    show();

    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.getByText('Beto Lara')).toBeInTheDocument();
    expect(screen.getByText('Carla Sosa')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '3 personas' })).toBeInTheDocument();
  });

  it('filters the board when a counter is used as a filter', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    await userEvent.click(screen.getByRole('button', { name: /En pausa/ }));

    await waitFor(() => expect(screen.queryByText('Ana Ruiz')).not.toBeInTheDocument());
    expect(screen.getByText('Beto Lara')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1 de 3 personas' })).toBeInTheDocument();
  });

  it('lets the same counter turn its own filter back off', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    const pausa = screen.getByRole('button', { name: /En pausa/ });
    await userEvent.click(pausa);
    await waitFor(() => expect(pausa).toHaveAttribute('aria-pressed', 'true'));

    await userEvent.click(pausa);
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
  });

  it('searches by name and by department', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    await userEvent.type(screen.getByRole('searchbox'), 'compras');

    await waitFor(() => expect(screen.queryByText('Ana Ruiz')).not.toBeInTheDocument());
    expect(screen.getByText('Beto Lara')).toBeInTheDocument();
  });

  it('shows only people who registered an entry when Home Office is selected', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    const homeOffice = screen.getByRole('button', { name: 'Solo Home Office' });
    await userEvent.click(homeOffice);

    expect(homeOffice).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.getByText('Beto Lara')).toBeInTheDocument();
    expect(screen.queryByText('Carla Sosa')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2 de 3 personas' })).toBeInTheDocument();
  });

  it('opens the selected employee record without exposing administrative actions', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    const select = screen.getByRole('button', { name: 'Abrir ficha de Ana Ruiz, Sistemas, trabajando' });
    await userEvent.click(select);

    expect(select).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('heading', { name: 'Ana Ruiz' })).toBeInTheDocument();
    expect(screen.getByText('Horas trabajadas')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(employeeSummary).toHaveBeenCalledWith('1', 30);
    expect(screen.queryByRole('button', { name: 'Editar ficha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reiniciar jornada' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dar de baja' })).toBeNull();
  });

  it('reports how many days of the week were taken as Home Office', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    await userEvent.click(screen.getByRole('button', { name: 'Abrir ficha de Ana Ruiz, Sistemas, trabajando' }));

    const weeks = await screen.findByRole('table', { name: 'Resumen semanal' });
    expect(within(weeks).getByRole('columnheader', { name: 'Home Office' })).toBeInTheDocument();

    const week = within(weeks).getByRole('row', { name: /24 ago/ });
    expect(within(week).getByText('4 días')).toBeInTheDocument();
  });

  it('reloads the record when the selection moves to another person', async () => {
    // Beto's read is held open, so the assertions land in the window where the
    // heading already says Beto and the figures have not arrived yet.
    let releaseBeto = (): void => undefined;
    const betoPending = new Promise<EmployeeSummary>((resolve) => {
      releaseBeto = () =>
        resolve(record({ employee_id: '2', employee_name: 'Beto Lara', punctuality_pct: 40 }));
    });

    employeeSummary.mockImplementation((id: string) =>
      id === '1'
        ? Promise.resolve(
            record({ employee_id: '1', employee_name: 'Ana Ruiz', punctuality_pct: 75 }),
          )
        : betoPending,
    );

    show();
    await screen.findByText('Ana Ruiz');

    await userEvent.click(screen.getByRole('button', { name: 'Abrir ficha de Ana Ruiz, Sistemas, trabajando' }));
    expect(await screen.findByText('75%')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Abrir ficha de Beto Lara, Compras, en pausa' }));

    // The heading and the figures have to describe the same person. Beto's name
    // over Ana's punctuality is the worst kind of wrong: it looks right.
    const box = await screen.findByRole('region', { name: 'Beto Lara' });
    expect(within(box).queryByText('75%')).not.toBeInTheDocument();

    releaseBeto();
    expect(await within(box).findByText('40%')).toBeInTheDocument();
  });

  it('takes focus when the record opens and hands it back on Escape', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    const opener = screen.getByRole('button', {
      name: 'Abrir ficha de Ana Ruiz, Sistemas, trabajando',
    });
    await userEvent.click(opener);

    // The record renders after the whole board, so without this a keyboard user
    // would have to tab past every remaining row to reach what they just asked
    // for.
    const box = await screen.findByRole('region', { name: 'Ana Ruiz' });
    await waitFor(() => expect(box).toHaveFocus());

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: 'Ana Ruiz' })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('says so plainly when a filter matches nobody', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    await userEvent.type(screen.getByRole('searchbox'), 'nadie con este nombre');

    expect(await screen.findByText(/Nadie coincide con este filtro/)).toBeInTheDocument();
  });

  it('counts what it can judge and keeps the rest one click away', async () => {
    openAlerts.mockResolvedValue([
      {
        id: 'a1',
        employee_id: '3',
        employee_name: 'Carla Sosa',
        alert_date: TODAY,
        kind: 'missing_entry',
        severity: 'high',
        state: 'open',
        details: { entry_until: '09:30', minutes_overdue: 42 },
        created_at: '2026-08-24T15:40:00Z',
        notified_at: null,
      },
      {
        id: 'a2',
        employee_id: '1',
        employee_name: 'Ana Ruiz',
        alert_date: TODAY,
        kind: 'late_entry',
        severity: 'medium',
        state: 'open',
        details: { minutes_late: 18, arrived_at: '09:18' },
        created_at: '2026-08-24T15:20:00Z',
        notified_at: null,
      },
      {
        id: 'a3',
        employee_id: '2',
        employee_name: 'Beto Lara',
        alert_date: TODAY,
        kind: 'clock_tampered',
        severity: 'high',
        state: 'open',
        details: { skew_minutes: 22 },
        created_at: '2026-08-24T15:30:00Z',
        notified_at: null,
      },
    ]);

    show();
    await screen.findByText('Ana Ruiz');

    // Home Office means nobody is expected to punch every day, so the absence
    // steps aside. The late entry and the moved clock are both evidence.
    const stats = screen.getByRole('region', { name: 'Resumen del día' });
    const counter = within(stats).getByRole('button', { name: /Alertas/ });
    await waitFor(() => expect(counter).toHaveAccessibleName(/Alertas2.*2 personas/));

    await userEvent.click(navLink(/Alertas/));

    expect(await screen.findByText('Entrada tardía')).toBeInTheDocument();
    expect(screen.getByText('Reloj fuera de hora')).toBeInTheDocument();
    expect(screen.queryByText('Sin entrada')).not.toBeInTheDocument();
    expect(screen.getByText(/1 alerta oculta/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Solo las que cuentan' }));

    expect(await screen.findByText('Sin entrada')).toBeInTheDocument();
    expect(screen.getByText('Entrada tardía')).toBeInTheDocument();

    // The subtitle counts what is on screen. Describing one alta while showing
    // two altas and a media is the summary disagreeing with its own list.
    expect(screen.getByText('2 altas · 1 media · 0 bajas')).toBeInTheDocument();
  });

  it('counts alerts on the row of the person they belong to', async () => {
    openAlerts.mockResolvedValue([
      {
        id: 'a1',
        employee_id: '3',
        employee_name: 'Carla Sosa',
        alert_date: TODAY,
        kind: 'late_entry',
        severity: 'high',
        state: 'open',
        details: { minutes_late: 42, arrived_at: '09:42' },
        created_at: '2026-08-24T15:40:00Z',
        notified_at: null,
      },
    ]);

    show();
    await screen.findByText('Carla Sosa');

    // The board itself carries the count, so somebody scanning rows does not
    // have to hold the alert list in their head at the same time.
    expect(await screen.findByText('1 alerta')).toBeInTheDocument();

    // The alert itself lives in its own view, one click away.
    await userEvent.click(navLink(/Alertas/));

    const panel = await screen.findByRole('heading', { name: 'Alertas abiertas' });
    const card = panel.closest('section');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('Entrada tardía')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/42 min/)).toBeInTheDocument();
  });

  it('moves between the team and the alerts, and marks where you are', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    const alertsLink = navLink(/Alertas/);
    await userEvent.click(alertsLink);

    expect(await screen.findByRole('heading', { name: 'Alertas abiertas' })).toBeInTheDocument();
    expect(alertsLink).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('Ana Ruiz')).not.toBeInTheDocument();

    await userEvent.click(navLink('Equipo'));
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
  });

  it('offers no way to close an alert, because closing one is not a screen decision', async () => {
    openAlerts.mockResolvedValue([
      {
        id: 'a1',
        employee_id: '1',
        employee_name: 'Ana Ruiz',
        alert_date: TODAY,
        kind: 'late_entry',
        severity: 'medium',
        state: 'open',
        details: { minutes_late: 18, arrived_at: '09:23' },
        created_at: '2026-08-24T15:40:00Z',
        notified_at: null,
      },
    ]);

    show();
    await screen.findByText('Ana Ruiz');
    await userEvent.click(navLink(/Alertas/));
    await screen.findByText('Entrada tardía');

    expect(screen.queryByRole('button', { name: /descartar|cerrar|resolver/i })).toBeNull();
  });

  it('keeps the last board on screen when a refresh fails, and says that it did', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    teamDay.mockRejectedValueOnce(new RpcError('permiso denegado', '42501'));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar ahora' }));

    // A failed refresh must not blank the room's monitor -- and must not leave
    // it silently showing an hour-old board as though it were current either.
    expect(await screen.findByText('permiso denegado')).toBeInTheDocument();
    expect(screen.getByText('Ana Ruiz')).toBeInTheDocument();
  });

  it('reports a failure it does not recognise instead of losing it', async () => {
    // Nobody is standing in front of this screen waiting for it, so an
    // unexpected error has to be visible and logged rather than re-thrown into
    // a promise nothing is listening to.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    show();
    await screen.findByText('Ana Ruiz');

    teamDay.mockRejectedValueOnce(new Error('boom'));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar ahora' }));

    expect(await screen.findByText(/No se pudo actualizar/)).toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
  });

  it('will not step past today', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    expect(screen.getByRole('button', { name: 'Día siguiente' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Hoy' })).toBeDisabled();
  });

  it('opens the day before, and offers the way back', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    await userEvent.click(screen.getByRole('button', { name: 'Día anterior' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Hoy' })).not.toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Día siguiente' })).not.toBeDisabled();
    // Yesterday is done with, so the counter says so rather than "todavía".
    expect(screen.getByText('No marcaron')).toBeInTheDocument();
  });
  /* -------------------------------------------------------------- reports ---
   * The panel itself is covered in ReportsPanel.test.tsx. What is checked here
   * is the one piece of logic the board kept: how a period is stepped.
   */

  it('asks for nothing until the report is opened', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    // A month across everybody is the heaviest query the client makes, and the
    // board mounts whether or not anybody wants a report.
    expect(attendanceReport).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Reportes/ }));

    await waitFor(() => expect(attendanceReport).toHaveBeenCalledWith('week', undefined));
  });

  it('steps a period from the bounds the database returned, not by calendar maths', async () => {
    show();
    await screen.findByText('Ana Ruiz');
    await userEvent.click(screen.getByRole('button', { name: /Reportes/ }));
    await screen.findByText(/24 ago/);

    await userEvent.click(screen.getByRole('button', { name: /Semana anterior/ }));

    // The day before `from`, which is inside the previous period whatever the
    // scope is and however many days the month had. 31 January plus a month is
    // the bug this avoids.
    await waitFor(() => expect(attendanceReport).toHaveBeenLastCalledWith('week', '2026-08-23'));

    await userEvent.click(screen.getByRole('button', { name: /Semana siguiente/ }));
    await waitFor(() => expect(attendanceReport).toHaveBeenLastCalledWith('week', '2026-08-31'));
  });

  it('changes the scope without inventing what the new period is', async () => {
    show();
    await screen.findByText('Ana Ruiz');
    await userEvent.click(screen.getByRole('button', { name: /Reportes/ }));
    await screen.findByText(/24 ago/);

    await userEvent.click(screen.getByRole('button', { name: 'Mes' }));

    // The anchor it already had, and a new scope. The bounds are the database's
    // to work out.
    await waitFor(() => expect(attendanceReport).toHaveBeenLastCalledWith('month', undefined));
  });

  it('hides the day controls on a screen that is not about a day', async () => {
    show();
    await screen.findByText('Ana Ruiz');
    await userEvent.click(screen.getByRole('button', { name: /Reportes/ }));
    await screen.findByText(/24 ago/);

    expect(screen.queryByRole('button', { name: 'Día anterior' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('leaves out the people who have no way to punch, and says how many', async () => {
    teamDay.mockResolvedValue([
      member({ employee_id: '1', has_account: true }),
      member({ employee_id: '2', employee_name: 'Beto Lara', has_account: false }),
      member({ employee_id: '3', employee_name: 'Carla Sosa', has_account: false }),
    ]);
    show();

    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.queryByText('Beto Lara')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1 persona' })).toBeInTheDocument();

    // Counted where they were hidden. Twenty-three people vanishing with no
    // trace is how a roster of thirty-two silently becomes nine.
    expect(screen.getByText(/2 personas sin cuenta no aparecen/)).toBeInTheDocument();
  });

  it('brings them back on one press', async () => {
    teamDay.mockResolvedValue([
      member({ employee_id: '1', has_account: true }),
      member({ employee_id: '2', employee_name: 'Beto Lara', has_account: false }),
    ]);
    show();
    await screen.findByText('Ana Ruiz');

    await userEvent.click(screen.getByRole('button', { name: 'Incluir sin cuenta' }));

    expect(screen.getByText('Beto Lara')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2 personas' })).toBeInTheDocument();
  });

  it('says nothing about accounts when everybody has one', async () => {
    teamDay.mockResolvedValue([
      member({ employee_id: '1', has_account: true }),
      member({ employee_id: '2', employee_name: 'Beto Lara', has_account: true }),
    ]);
    show();
    await screen.findByText('Ana Ruiz');

    expect(screen.queryByText(/sin cuenta/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Incluir sin cuenta' }),
    ).not.toBeInTheDocument();
  });

  it('does not empty itself while a migration is behind the bundle', async () => {
    // No `has_account` at all: the shape `team_day()` returns until the
    // migration lands. Comparing to `true` here would have blanked the board
    // for everybody in that window.
    show();

    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.getByText('Beto Lara')).toBeInTheDocument();
    expect(screen.getByText('Carla Sosa')).toBeInTheDocument();
    expect(screen.queryByText(/sin cuenta/)).not.toBeInTheDocument();
  });

  it('keeps the whole roster on the screens that are not about a day', async () => {
    teamDay.mockResolvedValue([
      member({ employee_id: '1', has_account: true }),
      member({ employee_id: '2', employee_name: 'Beto Lara', has_account: false }),
    ]);
    show();
    await screen.findByText('Ana Ruiz');

    // Expedientes is about what the record holds for one person, and "no
    // account, therefore nothing" is an answer somebody opens it to get.
    await userEvent.click(navLink(/Expedientes/));

    expect(await screen.findByRole('button', { name: /Beto Lara/ })).toBeInTheDocument();
    expect(screen.getByText(/sin cuenta/)).toBeInTheDocument();
  });
});
