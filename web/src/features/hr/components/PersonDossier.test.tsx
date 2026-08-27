import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeDossier, EmployeeSummary, TeamMember } from '../../../lib/types';
import { PersonDossier } from './PersonDossier';

// `RecordBody` fetches its own summary and access log. Its content is covered by
// the admin panel's tests; here it only has to not blow up.
const employeeSummary = vi.fn<() => Promise<EmployeeSummary>>();
const employeeSessions = vi.fn<() => Promise<[]>>();

vi.mock('../../../lib/api', () => ({
  api: {
    employeeSummary: () => employeeSummary(),
    employeeSessions: () => employeeSessions(),
  },
}));

function member(over: Partial<TeamMember> & { employee_id: string }): TeamMember {
  return {
    employee_name: 'Ana Ruiz',
    department: 'Sistemas',
    work_date: '2026-08-27',
    state: 'working',
    opened_at: '2026-08-27T15:02:00Z',
    closed_at: null,
    worked_seconds: 7200,
    break_seconds: 0,
    last_heartbeat: null,
    has_offline: false,
    needs_review: false,
    entry_expected: '09:00:00',
    exit_expected: '18:00:00',
    ...over,
  };
}

function dossier(over: Partial<EmployeeDossier> = {}): EmployeeDossier {
  return {
    server_time: '2026-08-27T19:00:00Z',
    days: 30,
    from: '2026-07-29',
    to: '2026-08-27',
    employee: {
      employee_id: 'a',
      employee_name: 'Ana Ruiz',
      email: 'ana@example.com',
      job_title: 'Analista',
      department: 'Sistemas',
      state: 'activo',
      time_zone: 'America/Mexico_City',
      has_account: true,
    },
    summary: {} as EmployeeSummary,
    sessions: [
      {
        id: 's1',
        started_at: '2026-08-27T15:00:00Z',
        last_seen_at: '2026-08-27T18:00:00Z',
        ended_at: '2026-08-27T18:00:00Z',
        end_reason: 'expired',
        seconds: 10800,
        ip: '187.190.1.20',
        platform: 'Windows',
        time_zone: 'America/Mexico_City',
        app_version: '1.0.0',
        device_id: 'd1',
      },
    ],
    devices: [
      {
        device_id: 'd1',
        user_agent: 'Mozilla/5.0 Windows',
        first_seen_at: '2026-08-01T15:00:00Z',
        last_seen_at: '2026-08-27T18:00:00Z',
        revoked_at: null,
      },
    ],
    alerts: [
      {
        id: 'al1',
        alert_date: '2026-08-26',
        kind: 'late_entry',
        severity: 'medium',
        state: 'dismissed',
        details: {},
        note: 'Se justificó',
        created_at: '2026-08-26T16:00:00Z',
      },
    ],
    adjustments: [
      {
        id: 'aj1',
        kind: 'void_punch',
        reason: 'Marcaje de prueba durante el piloto',
        work_date: '2026-08-26',
        old_value: null,
        new_value: null,
        created_at: '2026-08-27T18:50:00Z',
        actor: 'Eva de Personal',
      },
    ],
    connectivity: {
      counts: { connection_lost: 1 },
      items: [
        {
          id: 'ev1',
          session_id: 's1',
          kind: 'connection_lost',
          occurred_at: '2026-08-27T17:45:00Z',
          client_reported_at: '2026-08-27T17:20:00Z',
          detail: { seconds: 1500 },
        },
      ],
    },
    punches: [
      {
        id: 'p1',
        work_date: '2026-08-26',
        kind: 'clock_in',
        occurred_at: '2026-08-26T15:00:00Z',
        client_reported_at: null,
        source: 'offline',
        needs_review: false,
        voided_at: '2026-08-27T18:50:00Z',
        void_reason: 'Marcaje de prueba durante el piloto',
      },
    ],
    ...over,
  };
}

function draw(over: Partial<Parameters<typeof PersonDossier>[0]> = {}) {
  const onSelect = vi.fn<(id: string | null) => void>();
  render(
    <PersonDossier
      team={[member({ employee_id: 'a' }), member({ employee_id: 'b', employee_name: 'Beto Lara' })]}
      selectedId="a"
      onSelect={onSelect}
      dossier={dossier()}
      error={null}
      loading={false}
      days={30}
      onDays={vi.fn()}
      timeZone="America/Mexico_City"
      {...over}
    />,
  );
  return { onSelect };
}

beforeEach(() => {
  employeeSummary.mockRejectedValue(new Error('not under test'));
  employeeSessions.mockResolvedValue([]);
});

describe('PersonDossier', () => {
  it('asks for a person before showing anybody', () => {
    draw({ selectedId: null, dossier: null });

    expect(screen.getByText(/Elige a una persona/)).toBeInTheDocument();
  });

  it('lets a person be found by name or department', async () => {
    const { onSelect } = draw({ selectedId: null, dossier: null });

    await userEvent.type(screen.getByRole('searchbox'), 'Beto');

    expect(screen.getByText('Beto Lara')).toBeInTheDocument();
    expect(screen.queryByText('Ana Ruiz')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Beto Lara/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('shows the hour the device saw a drop, and says the other one was the report', () => {
    draw();

    expect(screen.getByText('Perdió la conexión')).toBeInTheDocument();
    // 17:20 UTC is 11:20 in Mexico City -- the device's own hour. The report
    // arrived 25 minutes later, and both are on screen because only one of them
    // is when it happened.
    expect(screen.getByText(/11:20/)).toBeInTheDocument();
    expect(screen.getByText(/reportado 11:45/)).toBeInTheDocument();
  });

  it('never claims a session that stopped reporting was closed on purpose', () => {
    draw();

    // The honest label. An expired session is compatible with a closed lid, a
    // dead battery, a lost network and a killed application, and says none of
    // them.
    expect(screen.getByText('Dejó de reportarse')).toBeInTheDocument();
    expect(screen.queryByText('Cerró la aplicación')).not.toBeInTheDocument();
  });

  it('keeps an alert HR dismissed in the history', () => {
    draw();

    expect(screen.getByText('Entrada tardía')).toBeInTheDocument();
    expect(screen.getByText('Descartada')).toBeInTheDocument();
    expect(screen.getByText(/no solo las abiertas/)).toBeInTheDocument();
  });

  it('shows what somebody changed and the reason they had to give', () => {
    draw();

    expect(screen.getByText('Marcaje anulado')).toBeInTheDocument();
    expect(screen.getAllByText('Marcaje de prueba durante el piloto').length).toBeGreaterThan(0);
    expect(screen.getByText(/Eva de Personal/)).toBeInTheDocument();
  });

  it('leaves a voided punch visible, marked with why', () => {
    draw();

    const row = screen.getByRole('row', { name: /Entrada/ });
    expect(within(row).getByText('anulado')).toBeInTheDocument();
    // Hiding it would leave a zeroed counter with nothing to explain it.
    expect(within(row).getByText('sincronizado')).toBeInTheDocument();
  });

  it('says plainly when somebody has no way to punch at all', () => {
    draw({
      dossier: dossier({
        employee: { ...dossier().employee, has_account: false },
        sessions: [],
        punches: [],
      }),
    });

    expect(screen.getByText(/no tiene cuenta/)).toBeInTheDocument();
  });

  it('offers nothing to press: it is a page to read', () => {
    draw();

    const buttons = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    // Only the two people in the picker. No reset, no revoke, no dismiss.
    expect(buttons.filter((label) => /anular|revocar|reiniciar|descartar/i.test(label))).toEqual([]);
  });

  it('lists people one per row rather than as a wrapping cloud of chips', () => {
    draw({ selectedId: null, dossier: null });

    // jsdom has no layout, so what is pinned here is the cause rather than the
    // symptom: the picker had inherited `.review__list`, a wrapping flex row
    // that is right for Revisión's handful of short chips and turns a roster of
    // thirty-one names into ragged pairs. Its own class is a vertical stack.
    const list = screen.getByRole('list');
    expect(list).toHaveClass('dossier__people');
    expect(list).not.toHaveClass('review__list');

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('dossier__person');
    }
  });

  it('reports a failure instead of drawing an empty person', () => {
    draw({ dossier: null, error: 'No se pudo leer el expediente.' });

    expect(screen.getByText('No se pudo leer el expediente.')).toBeInTheDocument();
    expect(screen.queryByText('Sesiones')).not.toBeInTheDocument();
  });
});
