import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { RpcError } from '../../lib/errors';
import type { AccountRow, AlertRuleRow, DepartmentRow, ScheduleRow } from '../../lib/types';
import { AdminPanel } from './AdminPanel';

const listAccounts = vi.fn<() => Promise<AccountRow[]>>();
const listDepartments = vi.fn<() => Promise<DepartmentRow[]>>();
const listSchedules = vi.fn<() => Promise<ScheduleRow[]>>();
const listAlertRules = vi.fn<() => Promise<AlertRuleRow[]>>();
const createAccount = vi.fn<(id: string, role: string) => Promise<unknown>>();
const setAccountRole = vi.fn<(id: string, role: string, reason: string) => Promise<unknown>>();
const revokeAccount = vi.fn<(id: string, reason: string) => Promise<unknown>>();
const saveAlertRule = vi.fn<(rule: Record<string, unknown>) => Promise<unknown>>();
const saveSchedule = vi.fn<(draft: Record<string, unknown>) => Promise<unknown>>();

vi.mock('../../lib/api', () => ({
  api: {
    listAccounts: () => listAccounts(),
    listDepartments: () => listDepartments(),
    listSchedules: () => listSchedules(),
    listAlertRules: () => listAlertRules(),
    createAccount: (id: string, role: string) => createAccount(id, role),
    setAccountRole: (id: string, role: string, reason: string) => setAccountRole(id, role, reason),
    revokeAccount: (id: string, reason: string) => revokeAccount(id, reason),
    resetPassword: (id: string) => Promise.resolve({ employee_id: id, employee_name: 'x' }),
    retireSchedule: () => Promise.resolve(null),
    saveSchedule: (draft: Record<string, unknown>) => saveSchedule(draft),
    saveAlertRule: (rule: Record<string, unknown>) => saveAlertRule(rule),
  },
}));

function account(over: Partial<AccountRow> & { employee_id: string }): AccountRow {
  return {
    employee_name: 'Ana Ruiz',
    employee_email: 'ana.ruiz@example.invalid',
    job_title: 'Analista',
    department_id: 'd1',
    department: 'Sistemas',
    has_account: false,
    role: null,
    account_email: null,
    last_sign_in_at: null,
    must_change_password: false,
    schedule_scope: 'global',
    schedule_name: 'Jornada general de oficina',
    ...over,
  };
}

function rule(over: Partial<AlertRuleRow> & { id: string; kind: AlertRuleRow['kind'] }): AlertRuleRow {
  return {
    department_id: null,
    department: 'Toda la empresa',
    active: true,
    threshold_minutes: 15,
    recipients: null,
    updated_at: '2026-08-26T12:00:00Z',
    ...over,
  };
}

const DEPARTMENTS: DepartmentRow[] = [
  { id: 'd1', name: 'Sistemas', time_zone: 'America/Mexico_City', active: true, employee_count: 2 },
];

beforeEach(() => {
  listAccounts.mockResolvedValue([
    account({ employee_id: '1' }),
    account({
      employee_id: '2',
      employee_name: 'Beto Lara',
      has_account: true,
      role: 'employee',
      account_email: 'beto.lara@example.invalid',
      last_sign_in_at: new Date().toISOString(),
    }),
  ]);
  listDepartments.mockResolvedValue(DEPARTMENTS);
  listSchedules.mockResolvedValue([]);
  listAlertRules.mockResolvedValue([rule({ id: 'r1', kind: 'late_entry' })]);
});

it('opens on who cannot sign in, because that is the question it answers', async () => {
  render(<AdminPanel />);

  expect(await screen.findByText('1 persona sin cuenta')).toBeInTheDocument();
  // The badge on the row, not the filter button that carries the same words.
  const rows = screen.getAllByRole('button', { pressed: false });
  expect(rows.some((row) => row.textContent?.includes('Ana Ruiz') === true)).toBe(true);
  expect(screen.getByText('Beto Lara').closest('button')?.textContent).toContain('Empleado');
});

it('shows a temporary password once, and says it cannot be read again', async () => {
  createAccount.mockResolvedValue({
    employee_id: '1',
    employee_name: 'Ana Ruiz',
    email: 'ana.ruiz@example.invalid',
    role: 'employee',
    temporary_password: 'Qw7kMvT2xhRd4Bpz',
  });

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Crear acceso' }));

  await waitFor(() => expect(screen.getByText('Qw7kMvT2xhRd4Bpz')).toBeInTheDocument());
  expect(createAccount).toHaveBeenCalledWith('1', 'employee');
  expect(screen.getByText(/No se puede volver a consultar/)).toBeInTheDocument();
});

it('will not change a role without the reason the database demands', async () => {
  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Beto Lara/ }));

  await userEvent.selectOptions(screen.getByLabelText('Rol'), 'manager');
  const save = screen.getByRole('button', { name: 'Guardar rol' });
  expect(save).toBeDisabled();

  // Nine characters: one short of what attendance.adjustments-style reasons ask
  // for, and the same bar the writers in this API check first.
  await userEvent.type(screen.getByLabelText('Motivo'), 'muy corto');
  expect(save).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Motivo'), ' de verdad');
  expect(save).toBeEnabled();

  await userEvent.click(save);
  await waitFor(() =>
    expect(setAccountRole).toHaveBeenCalledWith('2', 'manager', 'muy corto de verdad'),
  );
});

it('refuses to offer a role change that changes nothing', async () => {
  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Beto Lara/ }));
  await userEvent.type(screen.getByLabelText('Motivo'), 'Un motivo suficientemente largo');

  // The select still opens on the role they already hold, and the database
  // refuses that. Saying so first is kinder than a round trip.
  expect(screen.getByRole('button', { name: 'Guardar rol' })).toBeDisabled();
  expect(screen.getByText(/Ya tiene ese rol/)).toBeInTheDocument();
});

it('prints the database refusal rather than a kinder sentence of its own', async () => {
  createAccount.mockRejectedValue(
    new RpcError('Solo un administrador puede otorgar el rol de administrador'),
  );

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Crear acceso' }));

  expect(
    await screen.findByText('Solo un administrador puede otorgar el rol de administrador'),
  ).toBeInTheDocument();
});

it('warns that an alert nobody is named on goes nowhere', async () => {
  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('tab', { name: 'Alertas' }));

  const rules = await screen.findAllByText(/no se envía por correo/);
  expect(rules.length).toBeGreaterThan(0);
});

it('sends a blank recipient list as none, not as an empty string', async () => {
  listAlertRules.mockResolvedValue([
    rule({ id: 'r1', kind: 'late_entry', recipients: 'rh@example.invalid' }),
  ]);
  saveAlertRule.mockResolvedValue({ created: false });

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('tab', { name: 'Alertas' }));

  const row = screen.getByText('Entrada tardía').closest('.admin__rule');
  expect(row).not.toBeNull();

  const recipients = within(row as HTMLElement).getByLabelText('Destinatarios');
  await userEvent.clear(recipients);
  await userEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Guardar' }));

  await waitFor(() =>
    expect(saveAlertRule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'late_entry', recipients: null }),
    ),
  );
});

it('offers no threshold for the one alert that is not about waiting', async () => {
  listAlertRules.mockResolvedValue([
    rule({ id: 'r1', kind: 'review_offline', threshold_minutes: 0 }),
  ]);

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('tab', { name: 'Alertas' }));

  const row = screen.getByText('Por revisar').closest('.admin__rule');
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).queryByLabelText('Umbral')).toBeNull();
});

it('only offers a personal schedule to somebody who can actually punch', async () => {
  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('tab', { name: 'Horarios' }));
  await userEvent.click(screen.getByRole('button', { name: 'Nuevo horario' }));

  await userEvent.selectOptions(screen.getByLabelText('Aplica a'), 'employee');

  const options = within(screen.getByLabelText('Persona')).getAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual(['Elige a una…', 'Beto Lara']);
});
