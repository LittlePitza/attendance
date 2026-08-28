import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { JSX } from 'react';
import type { OpenAlert } from '../../../lib/types';
import { AlertsPanel } from './AlertsPanel';

function alert(over: Partial<OpenAlert> = {}): OpenAlert {
  return {
    id: 'a1',
    employee_id: 'e1',
    employee_name: 'Ana Ruiz',
    alert_date: '2026-08-28',
    kind: 'late_entry',
    severity: 'medium',
    state: 'open',
    details: {
      expected_at: '09:00',
      grace_minutes: 10,
      arrived_at: '10:18',
      minutes_late: 18,
    },
    created_at: '2026-08-28T16:20:00Z',
    notified_at: null,
    ...over,
  };
}

it('opens the evidence behind an alert from a real button', async () => {
  const user = userEvent.setup();
  render(
    <AlertsPanel
      alerts={[alert()]}
      timeZone="America/Mexico_City"
      boardDate="2026-08-28"
    />,
  );

  const trigger = screen.getByRole('button', { name: /Entrada tardía.*Ana Ruiz/ });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).not.toHaveAttribute('aria-controls');
  expect(screen.queryByRole('region', { name: /Detalle de Entrada tardía de Ana Ruiz/ })).toBeNull();

  await user.click(trigger);

  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const detail = screen.getByRole('region', { name: 'Detalle de Entrada tardía de Ana Ruiz' });
  expect(trigger).toHaveAttribute('aria-controls', detail.id);
  expect(within(detail).getByText('Hora esperada')).toBeInTheDocument();
  expect(within(detail).getByText('09:00')).toBeInTheDocument();
  expect(within(detail).getByText('Tolerancia')).toBeInTheDocument();
  expect(within(detail).getByText('10 min')).toBeInTheDocument();
  expect(within(detail).getByText('Entrada registrada')).toBeInTheDocument();
  expect(within(detail).getByText('10:18')).toBeInTheDocument();
  expect(within(detail).getByText('18 min pasada la tolerancia')).toBeInTheDocument();
});

it('keeps other alert kinds one explicit click away and filters the four operational kinds', async () => {
  const user = userEvent.setup();
  render(
    <AlertsPanel
      alerts={[
        alert({ id: 'a1', kind: 'late_entry', employee_name: 'Ana Ruiz' }),
        alert({ id: 'a2', kind: 'early_exit', employee_name: 'Beto Lara' }),
        alert({ id: 'a3', kind: 'break_exceeded', employee_name: 'Carla Sosa' }),
        alert({ id: 'a4', kind: 'no_connection', employee_name: 'Diego Mora' }),
        alert({ id: 'a5', kind: 'clock_tampered', employee_name: 'Eva León' }),
      ]}
      timeZone="America/Mexico_City"
      boardDate="2026-08-28"
    />,
  );

  const kindFilters = screen.getByRole('group', { name: 'Filtrar por tipo' });
  expect(within(kindFilters).getByRole('button', { name: 'Todas 4' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(within(kindFilters).getByRole('button', { name: 'Entrada tardía 1' })).toBeInTheDocument();
  expect(within(kindFilters).getByRole('button', { name: 'Salida temprana 1' })).toBeInTheDocument();
  expect(within(kindFilters).getByRole('button', { name: 'Pausa excedida 1' })).toBeInTheDocument();
  expect(within(kindFilters).getByRole('button', { name: 'Sin señal 1' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Reloj fuera de hora.*Eva León/ })).toBeNull();

  const otherKinds = screen.getByRole('button', { name: 'Incluir otros tipos 1' });
  expect(otherKinds).toHaveAttribute('aria-pressed', 'false');
  await user.click(otherKinds);
  expect(screen.getByRole('button', { name: /Reloj fuera de hora.*Eva León/ })).toBeInTheDocument();

  await user.click(within(kindFilters).getByRole('button', { name: 'Pausa excedida 1' }));
  expect(screen.getByRole('button', { name: /Pausa excedida.*Carla Sosa/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Entrada tardía.*Ana Ruiz/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Reloj fuera de hora.*Eva León/ })).toBeNull();
});

it('keeps the queue counts visible when a name search has no matches', () => {
  render(
    <AlertsPanel
      alerts={[alert()]}
      query="nadie"
      timeZone="America/Mexico_City"
      boardDate="2026-08-28"
    />,
  );

  expect(screen.getByRole('button', { name: 'Todas 1' })).toBeInTheDocument();
  expect(screen.getByText('Ninguna alerta coincide con “nadie”.')).toBeInTheDocument();
  expect(screen.queryByText(/Todo el mundo dentro de su horario/)).toBeNull();
});

it('searches the name only, trimmed and case-insensitively', () => {
  const alerts = [
    alert({ id: 'a1', employee_name: 'Ana Ruiz', kind: 'late_entry' }),
    alert({
      id: 'a2',
      employee_name: 'Beto Lara',
      kind: 'early_exit',
      details: { expected_at: '18:00', left_at: '17:36', minutes_early: 24 },
    }),
  ];
  const panel = (query: string): JSX.Element => (
    <AlertsPanel
      alerts={alerts}
      query={query}
      timeZone="America/Mexico_City"
      boardDate="2026-08-28"
    />
  );

  const { rerender } = render(panel(' beto '));
  expect(screen.getByRole('button', { name: /Salida temprana.*Beto Lara/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Entrada tardía.*Ana Ruiz/ })).toBeNull();

  // "min" is in every detail sentence, so matching those would filter nothing.
  rerender(panel('min'));
  expect(screen.getByText('Ninguna alerta coincide con “min”.')).toBeInTheDocument();

  rerender(panel('   '));
  expect(screen.getByRole('button', { name: /Entrada tardía.*Ana Ruiz/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Salida temprana.*Beto Lara/ })).toBeInTheDocument();
});

it('explains the limits and recorded evidence for the other operational alerts', async () => {
  const user = userEvent.setup();
  render(
    <AlertsPanel
      alerts={[
        alert({
          id: 'a2',
          employee_name: 'Beto Lara',
          kind: 'early_exit',
          details: { expected_at: '18:00', left_at: '17:36', minutes_early: 24 },
        }),
        alert({
          id: 'a3',
          employee_name: 'Carla Sosa',
          kind: 'break_exceeded',
          details: { allowed_minutes: 60, break_minutes: 75, still_on_break: false },
        }),
        alert({
          id: 'a4',
          employee_name: 'Diego Mora',
          kind: 'no_connection',
          details: { last_signal_at: '09:30', minutes_silent: 30 },
        }),
      ]}
      timeZone="America/Mexico_City"
      boardDate="2026-08-28"
    />,
  );

  await user.click(screen.getByRole('button', { name: /Salida temprana.*Beto Lara/ }));
  let detail = screen.getByRole('region', { name: 'Detalle de Salida temprana de Beto Lara' });
  expect(within(detail).getByText('Salida esperada')).toBeInTheDocument();
  expect(within(detail).getByText('Salida registrada')).toBeInTheDocument();
  expect(within(detail).getByText('24 min antes de la hora esperada')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /Pausa excedida.*Carla Sosa/ }));
  detail = screen.getByRole('region', { name: 'Detalle de Pausa excedida de Carla Sosa' });
  expect(within(detail).getByText('60 min')).toBeInTheDocument();
  expect(within(detail).getByText('75 min')).toBeInTheDocument();
  expect(within(detail).getByText('15 min sobre lo permitido')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /Sin señal.*Diego Mora/ }));
  detail = screen.getByRole('region', { name: 'Detalle de Sin señal de Diego Mora' });
  expect(within(detail).getByText('Última conexión')).toBeInTheDocument();
  expect(within(detail).getByText('09:30')).toBeInTheDocument();
  expect(within(detail).getByText('30 min sin conexión')).toBeInTheDocument();
});
