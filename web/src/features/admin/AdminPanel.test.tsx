import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { RpcError } from '../../lib/errors';
import type {
  AccountRow,
  AlertRuleRow,
  AppSession,
  AttendanceSettings,
  DepartmentRow,
  EmployeeRow,
  EmployeeSummary,
  ScheduleRow,
} from '../../lib/types';
import { AdminPanel } from './AdminPanel';

const listAccounts = vi.fn<() => Promise<AccountRow[]>>();
const listDepartments = vi.fn<() => Promise<DepartmentRow[]>>();
const listSchedules = vi.fn<() => Promise<ScheduleRow[]>>();
const listAlertRules = vi.fn<() => Promise<AlertRuleRow[]>>();
const attendanceSettings = vi.fn<() => Promise<AttendanceSettings | null>>();
const saveSettings = vi.fn<(dow: number) => Promise<AttendanceSettings>>();
const createAccount = vi.fn<(id: string, role: string) => Promise<unknown>>();
const setAccountRole = vi.fn<(id: string, role: string, reason: string) => Promise<unknown>>();
const revokeAccount = vi.fn<(id: string, reason: string) => Promise<unknown>>();
const saveAlertRule = vi.fn<(rule: Record<string, unknown>) => Promise<unknown>>();
const saveSchedule = vi.fn<(draft: Record<string, unknown>) => Promise<unknown>>();
const listEmployees = vi.fn<() => Promise<EmployeeRow[]>>();
const employeeSummary = vi.fn<(id: string, days?: number) => Promise<EmployeeSummary>>();
const employeeSessions = vi.fn<(id: string) => Promise<AppSession[]>>();
const saveEmployee = vi.fn<(draft: Record<string, unknown>) => Promise<unknown>>();
const retireEmployee = vi.fn<(id: string, reason: string) => Promise<unknown>>();
const restoreEmployee = vi.fn<(id: string, reason: string) => Promise<unknown>>();
const resetDay = vi.fn<(id: string, reason: string, date?: string) => Promise<unknown>>();

vi.mock('../../lib/api', () => ({
  api: {
    listAccounts: () => listAccounts(),
    listDepartments: () => listDepartments(),
    listSchedules: () => listSchedules(),
    listAlertRules: () => listAlertRules(),
    attendanceSettings: () => attendanceSettings(),
    saveSettings: (dow: number) => saveSettings(dow),
    createAccount: (id: string, role: string) => createAccount(id, role),
    setAccountRole: (id: string, role: string, reason: string) => setAccountRole(id, role, reason),
    revokeAccount: (id: string, reason: string) => revokeAccount(id, reason),
    resetPassword: (id: string) => Promise.resolve({ employee_id: id, employee_name: 'x' }),
    retireSchedule: () => Promise.resolve(null),
    saveSchedule: (draft: Record<string, unknown>) => saveSchedule(draft),
    saveAlertRule: (rule: Record<string, unknown>) => saveAlertRule(rule),
    listEmployees: () => listEmployees(),
    employeeSummary: (id: string, days?: number) => employeeSummary(id, days),
    employeeSessions: (id: string) => employeeSessions(id),
    saveEmployee: (draft: Record<string, unknown>) => saveEmployee(draft),
    retireEmployee: (id: string, reason: string) => retireEmployee(id, reason),
    restoreEmployee: (id: string, reason: string) => restoreEmployee(id, reason),
    resetDay: (id: string, reason: string, date?: string) => resetDay(id, reason, date),
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

function employee(over: Partial<EmployeeRow> & { employee_id: string }): EmployeeRow {
  return {
    employee_name: 'Ana Ruiz',
    employee_email: 'ana.ruiz@example.invalid',
    job_title: 'Analista',
    department_id: 'd1',
    department: 'Sistemas',
    state: 'activo',
    has_account: false,
    created_at: '2026-01-15T12:00:00Z',
    ...over,
  };
}

function summary(over: Partial<EmployeeSummary> = {}): EmployeeSummary {
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
    days_worked: 18,
    days_complete: 17,
    late_days: 2,
    on_time_days: 16,
    absent_days: 4,
    punctuality_pct: 89,
    average_entry: '09:04',
    streak_days: 5,
    offline_days: 3,
    no_connection_alerts: 1,
    expired_sessions: 2,
    weeks: [
      {
        week_start: '2026-08-24',
        days_scheduled: 5,
        days_worked: 4,
        days_complete: 4,
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

const DEPARTMENTS: DepartmentRow[] = [
  { id: 'd1', name: 'Sistemas', time_zone: 'America/Mexico_City', active: true, employee_count: 2 },
];

/** The panel opens on the roster, so the account tests say where they are. */
async function openAccounts(): Promise<void> {
  await userEvent.click(await screen.findByRole('tab', { name: 'Accesos' }));
}

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
  listEmployees.mockResolvedValue([
    employee({ employee_id: '1' }),
    employee({
      employee_id: '2',
      employee_name: 'Beto Lara',
      employee_email: 'beto.lara@example.invalid',
      has_account: true,
    }),
    employee({
      employee_id: '3',
      employee_name: 'Carmen Ortiz',
      employee_email: 'carmen.ortiz@example.invalid',
      state: 'baja',
    }),
  ]);
  employeeSummary.mockResolvedValue(summary());
  employeeSessions.mockResolvedValue([]);
  attendanceSettings.mockResolvedValue({
    week_start_dow: 4,
    updated_at: '2026-08-28T15:00:00Z',
    default_week_start_dow: 4,
  });
  saveSettings.mockResolvedValue({
    week_start_dow: 1,
    updated_at: '2026-08-28T16:00:00Z',
    default_week_start_dow: 4,
  });
});

it('the access tab opens on who cannot sign in, because that is the question it answers', async () => {
  render(<AdminPanel />);
  await openAccounts();

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
  await openAccounts();
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Crear acceso' }));

  await waitFor(() => expect(screen.getByText('Qw7kMvT2xhRd4Bpz')).toBeInTheDocument());
  expect(createAccount).toHaveBeenCalledWith('1', 'employee');
  expect(screen.getByText(/No se puede volver a consultar/)).toBeInTheDocument();
});

it('will not change a role without the reason the database demands', async () => {
  render(<AdminPanel />);
  await openAccounts();
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
  await openAccounts();
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
  await openAccounts();
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

/* ---------------------------------------------------------------- roster --- */

it('keeps the people who have left out of the way until they are asked for', async () => {
  render(<AdminPanel />);

  expect(await screen.findByText('2 personas activas · 1 baja')).toBeInTheDocument();
  expect(screen.queryByText('Carmen Ortiz')).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Ver bajas' }));
  expect(screen.getByText('Carmen Ortiz')).toBeInTheDocument();
});

it('lays out the figures the database decided, without working any of them out', async () => {
  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));

  // 27000 seconds is 7:30, and the expectation beside it is the database's.
  // Scoped to the tile, because the week below reports the same hours.
  const hours = (await screen.findByText('Horas trabajadas')).closest('.admin__stat');
  expect(within(hours as HTMLElement).getByText('7:30')).toBeInTheDocument();
  expect(screen.getByText('de 8:00 esperadas')).toBeInTheDocument();
  expect(screen.getByText('89%')).toBeInTheDocument();
  expect(screen.getByText('Entra en promedio 09:04')).toBeInTheDocument();

  // The week came grouped from Postgres, in the employee's zone.
  // Matched loosely: how a locale spells a short month is the locale's business.
  expect(screen.getByText(/Semana del 24/)).toBeInTheDocument();
  expect(employeeSummary).toHaveBeenCalledWith('1', 30);
});

it('counts a disconnection three ways, and none of them is its own judgement', async () => {
  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));

  expect(await screen.findByText(/1 alerta de señal/)).toBeInTheDocument();
  expect(screen.getByText(/3 días con marcajes sincronizados/)).toBeInTheDocument();
  expect(screen.getByText(/2 sesiones que dejó de reportarse/)).toBeInTheDocument();
});

it('says nothing was lost when nothing was', async () => {
  employeeSummary.mockResolvedValue(
    summary({ no_connection_alerts: 0, offline_days: 0, expired_sessions: 0 }),
  );

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));

  expect(await screen.findByText(/Ninguna en el rango/)).toBeInTheDocument();
});

it('will not reset a day without the reason the database demands', async () => {
  resetDay.mockResolvedValue({
    employee_id: '1',
    employee_name: 'Ana Ruiz',
    workday_id: 'w1',
    date: '2026-08-27',
    punches_voided: 4,
    state: 'not_started',
    worked_seconds: 0,
    break_seconds: 0,
    open_alerts: 2,
  });

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));

  const reset = await screen.findByRole('button', { name: 'Reiniciar jornada' });
  expect(reset).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Motivo'), 'muy corto');
  expect(reset).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Motivo'), ' de verdad');
  expect(reset).toBeEnabled();
  await userEvent.click(reset);

  // No date, so the database resolves today in the person's own zone.
  await waitFor(() =>
    expect(resetDay).toHaveBeenCalledWith('1', 'muy corto de verdad', undefined),
  );
});

it('reports what a reset did, and what it deliberately left alone', async () => {
  resetDay.mockResolvedValue({
    employee_id: '1',
    employee_name: 'Ana Ruiz',
    workday_id: 'w1',
    date: '2026-08-27',
    punches_voided: 4,
    state: 'not_started',
    worked_seconds: 0,
    break_seconds: 0,
    open_alerts: 2,
  });

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));
  await userEvent.type(screen.getByLabelText('Motivo'), 'Marcó la jornada equivocada');
  await userEvent.click(screen.getByRole('button', { name: 'Reiniciar jornada' }));

  expect(await screen.findByText(/Se anularon 4 marcajes/)).toBeInTheDocument();
  expect(screen.getByText(/No se borró ninguno/)).toBeInTheDocument();
  expect(screen.getByText(/2 alertas abiertas de ese día/)).toBeInTheDocument();
});

it('calls it dar de baja, and says on screen that the record survives', async () => {
  retireEmployee.mockResolvedValue({
    employee_id: '1',
    employee_name: 'Ana Ruiz',
    state: 'baja',
    access_revoked: true,
    open_alerts: 0,
  });

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: /Ana Ruiz/ }));

  expect(screen.queryByRole('button', { name: /Borrar/ })).toBeNull();
  expect(screen.getByText(/no borra a nadie/)).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText('Motivo'), 'Terminó su relación laboral');
  await userEvent.click(screen.getByRole('button', { name: 'Dar de baja' }));

  await waitFor(() =>
    expect(retireEmployee).toHaveBeenCalledWith('1', 'Terminó su relación laboral'),
  );
});

it('offers to reactivate somebody who left, and never to delete them', async () => {
  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: 'Ver bajas' }));
  await userEvent.click(screen.getByRole('button', { name: /Carmen Ortiz/ }));

  expect(await screen.findByRole('button', { name: 'Reactivar' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Dar de baja' })).toBeNull();
});

it('adds somebody without ever sending a state, because that takes a reason', async () => {
  saveEmployee.mockResolvedValue({ employee_id: '9', employee_name: 'Dora Nava', created: true });

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: 'Agregar' }));

  await userEvent.type(screen.getByLabelText('Nombre'), 'Dora Nava');
  await userEvent.type(screen.getByLabelText('Correo'), 'dora.nava@example.invalid');
  await userEvent.selectOptions(screen.getByLabelText('Departamento'), 'd1');
  await userEvent.click(screen.getByRole('button', { name: 'Agregar persona' }));

  await waitFor(() =>
    expect(saveEmployee).toHaveBeenCalledWith({
      name: 'Dora Nava',
      email: 'dora.nava@example.invalid',
      jobTitle: undefined,
      departmentId: 'd1',
    }),
  );
});

it("prints the database sentence when an address already belongs to somebody", async () => {
  saveEmployee.mockRejectedValue(new RpcError('Ese correo ya es de Beto Lara'));

  render(<AdminPanel />);
  await userEvent.click(await screen.findByRole('button', { name: 'Agregar' }));

  await userEvent.type(screen.getByLabelText('Nombre'), 'Dora Nava');
  await userEvent.type(screen.getByLabelText('Correo'), 'beto.lara@example.invalid');
  await userEvent.click(screen.getByRole('button', { name: 'Agregar persona' }));

  expect(await screen.findByText('Ese correo ya es de Beto Lara')).toBeInTheDocument();
});

async function openPeriods(): Promise<void> {
  await userEvent.click(await screen.findByRole('tab', { name: 'Periodos' }));
}

it('names the week the company actually works, not the ISO one', async () => {
  render(<AdminPanel />);
  await openPeriods();

  // Thursday to Wednesday, which no date library and no Postgres builtin knows.
  expect(await screen.findByText('De jueves a miércoles')).toBeInTheDocument();
});

it('says what moving the week start changes, before it is moved', async () => {
  render(<AdminPanel />);
  await openPeriods();
  await screen.findByText('De jueves a miércoles');

  // The blast radius is on screen beside the control rather than left to be
  // discovered: it changes a meaning on every screen at once.
  expect(screen.getByText(/Cambia lo que significa/)).toBeInTheDocument();
  expect(screen.getByText(/No mueve ningún dato/)).toBeInTheDocument();
});

it('will not save a day that was never chosen', async () => {
  render(<AdminPanel />);
  await openPeriods();
  await screen.findByText('De jueves a miércoles');

  expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
});

it('sends the ISO day the database expects', async () => {
  render(<AdminPanel />);
  await openPeriods();
  await screen.findByText('De jueves a miércoles');

  await userEvent.selectOptions(screen.getByLabelText('Primer día'), '1');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

  // 1 is Monday in ISO, which is what `save_settings` validates against.
  await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(1));
});

it('previews the chosen span without computing a single date', async () => {
  render(<AdminPanel />);
  await openPeriods();
  await screen.findByText('De jueves a miércoles');

  await userEvent.selectOptions(screen.getByLabelText('Primer día'), '7');

  // Sunday to Saturday. A real week's dates would be this file deriving a week
  // boundary, which is the one arithmetic the feature keeps in a single place.
  expect(screen.getByText(/De domingo a sábado/)).toBeInTheDocument();
});

it('prints the database sentence when the day is refused', async () => {
  saveSettings.mockRejectedValue(
    new RpcError('El dia de inicio de semana va de 1 (lunes) a 7 (domingo)'),
  );

  render(<AdminPanel />);
  await openPeriods();
  await screen.findByText('De jueves a miércoles');

  await userEvent.selectOptions(screen.getByLabelText('Primer día'), '2');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

  expect(
    await screen.findByText('El dia de inicio de semana va de 1 (lunes) a 7 (domingo)'),
  ).toBeInTheDocument();
});

it('confirms the save even when the reload has not caught up yet', async () => {
  // The reload keeps answering Thursday: a slow read, or one that failed on its
  // own. The write still succeeded, and a screen that stays silent about it
  // invites somebody to press Guardar a second time.
  attendanceSettings.mockResolvedValue({
    week_start_dow: 4,
    updated_at: '2026-08-28T15:00:00Z',
    default_week_start_dow: 4,
  });

  render(<AdminPanel />);
  await openPeriods();
  await screen.findByText('De jueves a miércoles');

  await userEvent.selectOptions(screen.getByLabelText('Primer día'), '1');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

  await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(1));
  expect(await screen.findByText(/Guardado/)).toBeInTheDocument();
});

it('says so rather than showing an empty control when the policy withholds it', async () => {
  // `settings_read` admits hr and admin. A manager reaching this tab gets null,
  // which is the policy working -- not a failure they can act on.
  attendanceSettings.mockResolvedValue(null);

  render(<AdminPanel />);
  await openPeriods();

  expect(await screen.findByText(/solo la puede ver Recursos Humanos/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Primer día')).not.toBeInTheDocument();
});
