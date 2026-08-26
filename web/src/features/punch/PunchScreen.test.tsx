import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkUnavailableError, RpcError } from '../../lib/errors';
import { clearPendingPunches, countPendingPunches } from '../../lib/queue';
import type { MyDay, PunchKind } from '../../lib/types';
import { PunchScreen } from './PunchScreen';

const myDay = vi.fn<() => Promise<MyDay>>();
const punch = vi.fn();

/**
 * The network is the only thing faked. The hooks, the offline queue and the
 * punch action all run for real, so what is under test is the composition an
 * employee actually uses.
 *
 * The heartbeat and the clock check are plain functions rather than spies, and
 * that is load-bearing rather than tidiness. Nothing asserts on either, so a
 * spy bought nothing -- and `restoreMocks` wipes a spy's implementation between
 * tests, which made these return `undefined` to a `.catch()` if the effect that
 * calls them flushed across that boundary. It passed locally and failed on CI,
 * which is the worst way for a test to be wrong. A function that always returns
 * a promise cannot be caught mid-restore.
 */
vi.mock('../../lib/api', () => ({
  api: {
    myDay: () => myDay(),
    punch: (input: unknown) => punch(input),
    heartbeat: () => Promise.resolve({}),
    serverTime: () =>
      Promise.resolve({ utc: '2026-08-24T15:00:00Z', epoch_ms: 1_787_670_000_000 }),
    syncPunches: () => Promise.resolve({ accepted: 0, rejected: 0, events: [] }),
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

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

beforeEach(async () => {
  await clearPendingPunches();
  setOnline(true);
});

// Only `myDay` and `punch` are spies now, and every test sets up the ones it
// uses. Resetting between tests is what stops one test's queued answer from
// being read by the next.
afterEach(() => {
  vi.resetAllMocks();
});

describe('PunchScreen', () => {
  it('offers exactly the actions the database sent, and nothing else', async () => {
    myDay.mockResolvedValue(day({ state: 'working', next_actions: ['break_start', 'clock_out'] }));

    render(<PunchScreen onSignOut={() => undefined} />);

    expect(await screen.findByRole('button', { name: 'Iniciar pausa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Registrar salida' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Registrar entrada' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Terminar pausa' })).not.toBeInTheDocument();
  });

  it('renders what it is told even when that contradicts the obvious rule', async () => {
    // A finished day offering an entry makes no sense, and that is the point:
    // if the client had its own copy of the state machine it would override
    // this. It must not -- the engine decides, and a projection that drifts is
    // caught by the SQL suite, not papered over here.
    myDay.mockResolvedValue(day({ state: 'finished', next_actions: ['clock_in'] }));

    render(<PunchScreen onSignOut={() => undefined} />);

    expect(await screen.findByRole('button', { name: 'Registrar entrada' })).toBeInTheDocument();
    expect(screen.getByText('Jornada terminada')).toBeInTheDocument();
  });

  it('shows nothing to press once the day is closed', async () => {
    myDay.mockResolvedValue(day({ state: 'finished', next_actions: [] }));

    render(<PunchScreen onSignOut={() => undefined} />);

    expect(await screen.findByText('Tu jornada de hoy ya está cerrada.')).toBeInTheDocument();
    for (const label of ['Registrar entrada', 'Iniciar pausa', 'Registrar salida']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('repeats the refusal the engine wrote, word for word', async () => {
    myDay.mockResolvedValue(day({ state: 'working', next_actions: ['break_start', 'clock_out'] }));
    punch.mockRejectedValue(
      new RpcError('Ya registraste tu entrada hoy (estado actual: working)', '22023'),
    );

    render(<PunchScreen onSignOut={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Iniciar pausa' }));

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
    await userEvent.click(await screen.findByRole('button', { name: 'Registrar entrada' }));

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
    await userEvent.click(await screen.findByRole('button', { name: 'Terminar pausa' }));

    await waitFor(() => {
      expect(punch).toHaveBeenCalledTimes(1);
    });
    const sent = punch.mock.calls[0]?.[0] as { kind: PunchKind; idempotencyKey: string };
    expect(sent.kind).toBe('break_end');
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
