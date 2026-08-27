import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '../../lib/errors';
import type { EmployeeDay, OpenAlert, Profile, TeamMember } from '../../lib/types';
import { HrDashboard } from './HrDashboard';

const teamDay = vi.fn<() => Promise<TeamMember[]>>();
const openAlerts = vi.fn<() => Promise<OpenAlert[]>>();
const employeeDay = vi.fn<(id: string, date?: string) => Promise<EmployeeDay>>();
const reviewPunch = vi.fn<(id: string, decision: string, reason: string) => Promise<unknown>>();
const decideAlert = vi.fn<(id: string, state: string, note: string) => Promise<unknown>>();

const TODAY = new Intl.DateTimeFormat('sv-SE').format(new Date());

vi.mock('../../lib/api', () => ({
  api: {
    teamDay: () => teamDay(),
    openAlerts: () => openAlerts(),
    employeeDay: (id: string, date?: string) => employeeDay(id, date),
    reviewPunch: (id: string, decision: string, reason: string) =>
      reviewPunch(id, decision, reason),
    decideAlert: (id: string, state: string, note: string) => decideAlert(id, state, note),
    serverTime: () => Promise.resolve({ utc: '2026-08-24T15:00:00Z', epoch_ms: 1787000000000 }),
    // A plain function rather than a spy: nothing here asserts on the access
    // trail, so a spy bought nothing -- and `restoreMocks` wipes a spy's
    // implementation between tests, which leaves the effect that calls this
    // holding `undefined` instead of a promise if it flushes across that
    // boundary. That failure appears only sometimes, which is the worst way for
    // a test to be wrong.
    employeeSessions: () => Promise.resolve([]),
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

const flaggedDay: EmployeeDay = {
  employee_id: '2',
  employee_name: 'Beto Lara',
  date: TODAY,
  time_zone: 'America/Mexico_City',
  workday_id: 'w2',
  state: 'working',
  opened_at: '2026-08-24T15:02:00Z',
  closed_at: null,
  worked_seconds: 3600,
  break_seconds: 0,
  has_offline: true,
  needs_review: true,
  punches: [
    {
      id: 'p1',
      kind: 'clock_in',
      occurred_at: '2026-08-24T15:02:00Z',
      source: 'offline',
      client_reported_at: '2026-08-24T15:12:00Z',
      clock_skew_ms: 600000,
      sync_delay_seconds: 1800,
      needs_review: true,
      review_reason: 'Reloj del equipo desviado 600 segundos respecto al servidor',
      decision: null,
    },
  ],
};

const profile: Profile = {
  role: 'hr',
  employee_id: null,
  name: 'Recursos Humanos',
  department_id: null,
  department: null,
};

function show(): void {
  render(<HrDashboard profile={profile} onSignOut={() => undefined} onOpenMyDay={null} />);
}

function navLink(name: RegExp | string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Secciones' })).getByRole('button', { name });
}

/** Open the review screen and select the flagged person. */
async function openReview(): Promise<void> {
  show();
  await screen.findByText('Ana Ruiz');
  await userEvent.click(navLink(/Revisión/));
  await userEvent.click(await screen.findByRole('button', { name: /Beto Lara/ }));
  await screen.findByText(/Reloj del equipo desviado/);
}

beforeEach(() => {
  teamDay.mockResolvedValue([
    member({ employee_id: '1', employee_name: 'Ana Ruiz' }),
    member({
      employee_id: '2',
      employee_name: 'Beto Lara',
      department: 'Compras',
      has_offline: true,
      needs_review: true,
    }),
  ]);
  openAlerts.mockResolvedValue([]);
  employeeDay.mockResolvedValue(flaggedDay);
  reviewPunch.mockResolvedValue({
    adjustment_id: 'a1',
    punch_id: 'p1',
    decision: 'approve_offline',
    workday_needs_review: false,
  });
  decideAlert.mockResolvedValue({ alert_id: 'x1', state: 'dismissed', kind: 'late_entry' });
});

describe('ReviewPanel', () => {
  it('lists only the days the database flagged', async () => {
    show();
    await screen.findByText('Ana Ruiz');
    await userEvent.click(navLink(/Revisión/));

    const picks = await screen.findAllByRole('button', { name: /Compras|Sistemas/ });
    expect(picks).toHaveLength(1);
    expect(picks[0]).toHaveTextContent('Beto Lara');
  });

  it('shows the evidence of how the punch arrived, not just when', async () => {
    await openReview();

    // The engine's own words for why it was not trusted.
    expect(screen.getByText(/Reloj del equipo desviado 600 segundos/)).toBeInTheDocument();
    expect(screen.getByText('Sincronizado')).toBeInTheDocument();
    expect(screen.getByText('600 segundos')).toBeInTheDocument();
  });

  it('will not send a decision without a reason worth reading', async () => {
    await openReview();

    const approve = screen.getByRole('button', { name: 'Aprobar' });
    expect(approve).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(/Por qué se aprueba/), 'corto');
    expect(approve).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(/Por qué se aprueba/), ' pero ya no lo es');
    expect(approve).toBeEnabled();
  });

  it('records the decision and asks the database again rather than predicting it', async () => {
    await openReview();

    await userEvent.type(
      screen.getByPlaceholderText(/Por qué se aprueba/),
      'Reloj mal configurado, hora verificada con el jefe',
    );
    employeeDay.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Aprobar' }));

    await waitFor(() => expect(reviewPunch).toHaveBeenCalledTimes(1));
    expect(reviewPunch).toHaveBeenCalledWith(
      'p1',
      'approve_offline',
      'Reloj mal configurado, hora verificada con el jefe',
    );

    // Nothing optimistic: the screen refetches instead of assuming.
    await waitFor(() => expect(employeeDay).toHaveBeenCalled());
  });

  it('repeats a refusal in the words the database wrote', async () => {
    reviewPunch.mockRejectedValue(
      new RpcError('Ese marcaje no quedo marcado para revision', '22023'),
    );

    await openReview();
    await userEvent.type(
      screen.getByPlaceholderText(/Por qué se aprueba/),
      'Un motivo suficientemente largo',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Aprobar' }));

    expect(await screen.findByText(/no quedo marcado para revision/)).toBeInTheDocument();
  });

  it('closes an alert with a note, which is the only way it can be closed', async () => {
    openAlerts.mockResolvedValue([
      {
        id: 'x1',
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
    await userEvent.click(navLink(/Revisión/));

    const dismiss = await screen.findByRole('button', { name: 'Descartada' });
    expect(dismiss).toBeDisabled();

    await userEvent.type(
      screen.getByPlaceholderText(/Qué se decidió/),
      'Traía permiso firmado por su jefe',
    );
    await userEvent.click(dismiss);

    await waitFor(() => expect(decideAlert).toHaveBeenCalledTimes(1));
    expect(decideAlert).toHaveBeenCalledWith('x1', 'dismissed', 'Traía permiso firmado por su jefe');
  });
});
