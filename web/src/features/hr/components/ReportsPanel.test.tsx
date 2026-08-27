import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AttendanceReport,
  ReportPerson,
  ReportScope,
  ReportTotals,
} from '../../../lib/types';
import { ReportsPanel } from './ReportsPanel';

/**
 * The panel is presentational on purpose, so it is tested directly: no api mock,
 * no hook, no board around it. What is being checked is that it prints the
 * verdict the database sent and never reaches one of its own.
 */

function totals(over: Partial<ReportTotals> = {}): ReportTotals {
  return {
    people: 3,
    people_home_office: 2,
    people_met: 1,
    people_partial: 1,
    people_missed: 1,
    people_pending: 0,
    people_not_scheduled: 0,
    days_scheduled: 15,
    days_scheduled_past: 10,
    days_worked: 8,
    days_complete: 8,
    worked_seconds: 230400,
    break_seconds: 10800,
    expected_seconds: 432000,
    expected_seconds_elapsed: 288000,
    late_days: 2,
    absent_days: 3,
    incomplete_days: 0,
    offline_days: 1,
    alerts_total: 2,
    punctuality_pct: 75,
    ...over,
  };
}

function person(over: Partial<ReportPerson> & { employee_id: string }): ReportPerson {
  return {
    employee_name: 'Ana Ruiz',
    department: 'Sistemas',
    employee_state: 'activo',
    days_scheduled: 5,
    days_scheduled_past: 5,
    days_worked: 5,
    days_complete: 5,
    worked_seconds: 144000,
    break_seconds: 3600,
    expected_seconds: 144000,
    expected_seconds_elapsed: 144000,
    deficit_seconds: 0,
    late_days: 0,
    absent_days: 0,
    incomplete_days: 0,
    offline_days: 0,
    punctuality_pct: 100,
    average_entry: '08:58',
    alerts_total: 0,
    alerts: {},
    compliance: 'met',
    reasons: [],
    ...over,
  };
}

function report(over: Partial<AttendanceReport> = {}): AttendanceReport {
  return {
    server_time: '2026-08-27T18:00:00Z',
    time_zone: 'America/Mexico_City',
    scope: 'week',
    anchor: '2026-08-26',
    from: '2026-08-24',
    to: '2026-08-30',
    days: 7,
    closed: false,
    totals: totals(),
    alerts_by_kind: [
      { kind: 'late_entry', severity: 'medium', total: 2, dismissed: 1, open: 2, people: 1 },
    ],
    people: [person({ employee_id: 'a' })],
    standouts: { punctual: [], most_late: [], most_absent: [], most_hours: [] },
    ...over,
  };
}

function draw(over: Partial<AttendanceReport> = {}, props: Partial<Parameters<typeof ReportsPanel>[0]> = {}) {
  const onScope = vi.fn<(next: ReportScope) => void>();
  const onStep = vi.fn<(direction: -1 | 1) => void>();
  const onToday = vi.fn();

  render(
    <ReportsPanel
      report={report(over)}
      scope="week"
      onScope={onScope}
      onStep={onStep}
      onToday={onToday}
      atLatest={false}
      error={null}
      loading={false}
      {...props}
    />,
  );

  return { onScope, onStep, onToday };
}

describe('ReportsPanel', () => {
  it('names the period from the bounds the database returned', () => {
    draw({ scope: 'month', from: '2026-07-01', to: '2026-07-31', closed: true });

    // Built from `from`, never from a date computed here. A month named in the
    // browser is where "this month" gets a second definition.
    expect(screen.getByText(/julio de 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/periodo cerrado/i)).toBeInTheDocument();
  });

  it('says a period is still running rather than presenting it as a result', () => {
    draw({ closed: false });

    expect(screen.getByText(/periodo en curso/i)).toBeInTheDocument();
    // While it runs, hours are measured against what has elapsed. Charging the
    // whole week's expectation on a Tuesday reports the calendar as a deficit.
    expect(screen.getByText(/de 80:00 esperadas hasta hoy/i)).toBeInTheDocument();
  });

  it('measures a closed period against the whole of it', () => {
    draw({ closed: true });

    expect(screen.getByText(/de 120:00 esperadas$/i)).toBeInTheDocument();
  });

  it('prints the verdict it was given and the reason underneath', () => {
    draw({
      people: [
        person({
          employee_id: 'b',
          employee_name: 'Beto Díaz',
          compliance: 'missed',
          absent_days: 2,
          late_days: 1,
          reasons: [
            { code: 'absent', count: 2 },
            { code: 'late', count: 1 },
          ],
        }),
      ],
    });

    const row = screen.getByRole('row', { name: /Beto Díaz/ });
    expect(within(row).getByText('No cumplió')).toBeInTheDocument();
    expect(within(row).getByText(/2 días sin entrada · 1 entrada tardía/)).toBeInTheDocument();
  });

  it('never calls a period met when none of it has happened yet', () => {
    draw({
      totals: totals({
        people: 1,
        people_met: 0,
        people_partial: 0,
        people_missed: 0,
        people_pending: 1,
      }),
      people: [
        person({
          employee_id: 'c',
          employee_name: 'Dora Luna',
          compliance: 'pending',
          days_scheduled_past: 0,
          days_worked: 0,
        }),
      ],
    });

    const row = screen.getByRole('row', { name: /Dora Luna/ });
    expect(within(row).getByText('En curso')).toBeInTheDocument();
    expect(screen.queryByText('Cumplió')).not.toBeInTheDocument();
  });

  it('spells out what an absence is not, because there is no leave table', () => {
    draw();

    expect(
      screen.getByText(/Todavía no hay registro de vacaciones ni permisos/i),
    ).toBeInTheDocument();
  });

  it('shows who stood out in both directions', () => {
    draw({
      standouts: {
        punctual: [{ employee_id: 'a', employee_name: 'Ana Ruiz', value: 5 }],
        most_late: [{ employee_id: 'b', employee_name: 'Beto Díaz', value: 3 }],
        most_absent: [{ employee_id: 'c', employee_name: 'Carla Vega', value: 2 }],
        most_hours: [],
      },
    });

    expect(screen.getByText('Puntualidad impecable')).toBeInTheDocument();
    expect(screen.getByText('Más entradas tardías')).toBeInTheDocument();
    expect(screen.getByText('Más días sin entrada')).toBeInTheDocument();
    // An empty list is left out rather than drawn as a heading with nothing
    // under it.
    expect(screen.queryByText('Más horas')).not.toBeInTheDocument();
  });

  it('separates the alerts it counts from the ones HR dismissed', () => {
    draw();

    const alert = screen.getByText('Entrada tardía').closest('li');
    expect(alert).not.toBeNull();
    expect(within(alert as HTMLElement).getByText(/1 descartadas/)).toBeInTheDocument();
    expect(within(alert as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  it('asks for a scope rather than for a pair of dates', async () => {
    const { onScope } = draw();

    await userEvent.click(screen.getByRole('button', { name: 'Mes' }));

    expect(onScope).toHaveBeenCalledWith('month');
  });

  it('steps the period and refuses to step past the current one', async () => {
    const { onStep } = draw({}, { atLatest: true });

    await userEvent.click(screen.getByRole('button', { name: /Semana anterior/ }));
    expect(onStep).toHaveBeenCalledWith(-1);

    expect(screen.getByRole('button', { name: /Semana siguiente/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Actual' })).toBeDisabled();
  });

  it('reports a failure without throwing away what was already read', () => {
    draw({}, { error: 'No se pudo leer el reporte.' });

    expect(screen.getByText('No se pudo leer el reporte.')).toBeInTheDocument();
    // The period that did load is still on screen.
    expect(screen.getByText('Ana Ruiz')).toBeInTheDocument();
  });
});
