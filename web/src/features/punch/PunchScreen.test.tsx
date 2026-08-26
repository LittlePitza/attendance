import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkUnavailableError, RpcError } from '../../lib/errors';
import { clearPendingPunches, countPendingPunches } from '../../lib/queue';
import type { MyDay, MySummary, PunchKind } from '../../lib/types';
import { PunchScreen } from './PunchScreen';

const myDay = vi.fn<() => Promise<MyDay>>();
const punch = vi.fn();
const mySummary = vi.fn<() => Promise<MySummary>>();

/**
 * The network is the only thing faked. The hooks, the offline queue and the
 * punch action all run for real, so what is under test is the composition an
 * employee actually uses.
 *
 * The heartbeat, the clock check and the access log are plain functions rather
 * than spies, and that is load-bearing rather than tidiness. Nothing asserts on
 * any of them, so a spy bought nothing -- and `restoreMocks` wipes a spy's
 * implementation between tests, which made these return `undefined` to a
 * `.catch()` if the effect that calls them flushed across that boundary. It
 * passed locally and failed on CI, which is the worst way for a test to be
 * wrong. A function that always returns a promise cannot be caught mid-restore.
 */
vi.mock('../../lib/api', () => ({
  api: {
    myDay: () => myDay(),
    punch: (input: unknown) => punch(input),
    heartbeat: () => Promise.resolve({}),
    serverTime: () =>
      Promise.resolve({ utc: '2026-08-24T15:00:00Z', epoch_ms: 1_787_670_000_000 }),
    syncPunches: () => Promise.resolve({ accepted: 0, rejected: 0, events: [] }),
    mySummary: () => mySummary(),
    mySessions: () => Promise.resolve([]),
  },
}));

function day(overrides: Partial<MyDay> = {}): MyDay {
  return {
    server_time: '2026-08-24T15:00:00Z',
    employee_id: '30000000-0000-4000-8000-000000000001',
    date: '2026-08-24',
    time_zone: 'America/Mexico_City',
    state: 'not_started',
    next_actions: ['clock_in'],
    worked_seconds: 0,
    break_seconds: 0,
    counting: null,
    counting_since: null,
    worked_seconds_live: 0,
    break_seconds_live: 0,
    expected_seconds: 8 * 3600,
    opened_at: null,
    closed_at: null,
    last_heartbeat: null,
    has_offline: false,
    needs_review: false,
    schedule: {
      name: 'Jornada general de oficina',
      entry_from: '07:00',
      entry_until: '10:00',
      entry_expected: '09:00',
      exit_expected: '18:00',
      grace_minutes: 10,
      break_max_minutes: 60,
    },
    punches: [],
    ...overrides,
  };
}

function summary(overrides: Partial<MySummary> = {}): MySummary {
  return {
    server_time: '2026-08-24T15:00:00Z',
    time_zone: 'America/Mexico_City',
    from: '2026-07-26',
    to: '2026-08-24',
    days: 30,
    worked_seconds: 0,
    break_seconds: 0,
    expected_seconds: 0,
    days_scheduled: 0,
    days_worked: 0,
    days_complete: 0,
    late_days: 0,
    on_time_days: 0,
    absent_days: 0,
    punctuality_pct: null,
    average_entry: null,
    streak_days: 0,
    series: [],
    ...overrides,
  };
}

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

beforeEach(async () => {
  await clearPendingPunches();
  setOnline(true);
  mySummary.mockResolvedValue(summary());
});

// Every test sets up the spies it uses. Resetting between tests is what stops
// one test's queued answer from being read by the next.
afterEach(() => {
  vi.resetAllMocks();
});

describe('PunchScreen', () => {
  it('offers exactly the actions the database sent, and nothing else', async () => {
    myDay.mockResolvedValue(day({ state: 'working', next_actions: ['break_start', 'clock_out'] }));

    render(<PunchScreen onSignOut={() => undefined} />);

    expect(await screen.findByRole('button', { name: /Iniciar pausa/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Registrar salida/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Registrar entrada/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Terminar pausa/ })).not.toBeInTheDocument();
  });

  it('renders what it is told even when that contradicts the obvious rule', async () => {
    // A finished day offering an entry makes no sense, and that is the point:
    // if the client had its own copy of the state machine it would override
    // this. It must not -- the engine decides, and a projection that drifts is
    // caught by the SQL suite, not papered over here.
    myDay.mockResolvedValue(day({ state: 'finished', next_actions: ['clock_in'] }));

    render(<PunchScreen onSignOut={() => undefined} />);

    expect(await screen.findByRole('button', { name: /Registrar entrada/ })).toBeInTheDocument();
    expect(screen.getByText('Jornada terminada')).toBeInTheDocument();
  });

  it('shows nothing to press once the day is closed', async () => {
    myDay.mockResolvedValue(day({ state: 'finished', next_actions: [] }));

    render(<PunchScreen onSignOut={() => undefined} />);

    expect(await screen.findByText('Tu jornada de hoy ya está cerrada.')).toBeInTheDocument();
    for (const label of [/Registrar entrada/, /Iniciar pausa/, /Registrar salida/]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('repeats the refusal the engine wrote, word for word', async () => {
    myDay.mockResolvedValue(day({ state: 'working', next_actions: ['break_start', 'clock_out'] }));
    punch.mockRejectedValue(
      new RpcError('Ya registraste tu entrada hoy (estado actual: working)', '22023'),
    );

    render(<PunchScreen onSignOut={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Iniciar pausa/ }));

    // Not reworded, not replaced by a generic apology: the message was written
    // in Spanish by the engine to be read here.
    expect(
      await screen.findByText('Ya registraste tu entrada hoy (estado actual: working)'),
    ).toBeInTheDocument();
  });

  it('keeps a punch that could not be sent, and says so', async () => {
    myDay.mockResolvedValue(day());
    punch.mockRejectedValue(new NetworkUnavailableError());

    render(<PunchScreen onSignOut={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Registrar entrada/ }));

    expect(await screen.findByText(/El marcaje quedó guardado en este equipo/)).toBeInTheDocument();
    expect(await screen.findByText('1 marcaje esperando a enviarse.')).toBeInTheDocument();
    await waitFor(async () => {
      expect(await countPendingPunches()).toBe(1);
    });
  });

  it('warns that there is no connection without hiding the buttons', async () => {
    // Offline is exactly when somebody needs to clock in. The punch goes to the
    // queue; refusing to offer it would lose the record entirely.
    setOnline(false);
    myDay.mockRejectedValue(new NetworkUnavailableError());

    render(<PunchScreen onSignOut={() => undefined} />);

    expect(await screen.findByText(/Sin conexión\. Puedes marcar/)).toBeInTheDocument();
  });

  it('sends the punch the button stands for', async () => {
    myDay.mockResolvedValue(day({ state: 'on_break', next_actions: ['break_end', 'clock_out'] }));
    punch.mockResolvedValue({
      repeated: false,
      punch_id: 'p1',
      workday_id: 'w1',
      state: 'working',
      occurred_at: '2026-08-24T15:00:00Z',
      worked_seconds: 0,
      break_seconds: 0,
    });

    render(<PunchScreen onSignOut={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: /Terminar pausa/ }));

    await waitFor(() => {
      expect(punch).toHaveBeenCalledTimes(1);
    });
    const sent = punch.mock.calls[0]?.[0] as { kind: PunchKind; idempotencyKey: string };
    expect(sent.kind).toBe('break_end');
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows the running total the database sent, not the one it settled at', async () => {
    // The engine only closes an interval at a punch, so `worked_seconds` is
    // still zero four hours into a shift. Showing that figure is what made the
    // old screen read as broken. `worked_seconds_live` is the database's own
    // answer to the same question, and it is the one on screen.
    myDay.mockResolvedValue(
      day({
        state: 'working',
        next_actions: ['break_start', 'clock_out'],
        worked_seconds: 0,
        worked_seconds_live: 4 * 3600,
        counting: 'worked',
        counting_since: '2026-08-24T11:00:00Z',
      }),
    );

    render(<PunchScreen onSignOut={() => undefined} />);

    expect(await screen.findByText(/^4:00:0\d$/)).toBeInTheDocument();
  });

  it('greets the person by their first name, in the hour of their own zone', async () => {
    // 15:00 UTC is 09:00 in Mexico City, and the greeting follows the
    // employee's zone rather than whatever zone the machine is set to.
    myDay.mockResolvedValue(day());

    render(<PunchScreen onSignOut={() => undefined} name="Luis Eduardo Hernández Cruz" />);

    expect(await screen.findByText('Buenos días, Luis')).toBeInTheDocument();
  });

  it('says so when HR has revoked this machine', async () => {
    // The engine refuses the punch either way. Saying it up front is the
    // difference between a screen that explains itself and one that fails on
    // the button press with no context.
    myDay.mockResolvedValue(day());

    render(<PunchScreen onSignOut={() => undefined} deviceRevoked />);

    expect(await screen.findByText(/dio de baja este equipo/)).toBeInTheDocument();
  });
});
