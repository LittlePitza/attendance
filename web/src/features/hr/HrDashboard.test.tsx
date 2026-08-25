import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '../../lib/errors';
import type { OpenAlert, Profile, TeamMember } from '../../lib/types';
import { HrDashboard } from './HrDashboard';

const teamDay = vi.fn<() => Promise<TeamMember[]>>();
const openAlerts = vi.fn<() => Promise<OpenAlert[]>>();

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

beforeEach(() => {
  teamDay.mockResolvedValue([
    member({ employee_id: '1', employee_name: 'Ana Ruiz', state: 'working' }),
    member({ employee_id: '2', employee_name: 'Beto Lara', state: 'on_break', department: 'Compras' }),
    member({ employee_id: '3', employee_name: 'Carla Sosa', state: 'not_started', opened_at: null }),
  ]);
  openAlerts.mockResolvedValue([]);
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

  it('says so plainly when a filter matches nobody', async () => {
    show();
    await screen.findByText('Ana Ruiz');

    await userEvent.type(screen.getByRole('searchbox'), 'nadie con este nombre');

    expect(await screen.findByText(/Nadie coincide con este filtro/)).toBeInTheDocument();
  });

  it('shows open alerts against the person they belong to', async () => {
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
    ]);

    show();

    const panel = await screen.findByRole('heading', { name: 'Alertas abiertas' });
    const card = panel.closest('section');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('Sin entrada')).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/42 min/)).toBeInTheDocument();

    // And the row for that person carries the count, so the board and the panel
    // do not have to be read against each other.
    expect(screen.getByText('1 alerta')).toBeInTheDocument();
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
});
