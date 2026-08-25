import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkUnavailableError } from './errors';
import { clearPendingPunches, countPendingPunches, enqueuePunch, pendingPunches } from './queue';
import { MAX_EVENTS_PER_BATCH, flushPendingPunches } from './sync';
import type { OfflinePunchEvent, PunchKind, SyncResult } from './types';

const syncPunches = vi.fn<(events: readonly OfflinePunchEvent[]) => Promise<SyncResult>>();

vi.mock('./api', () => ({ api: { syncPunches: (events: readonly OfflinePunchEvent[]) => syncPunches(events) } }));

function event(index: number, kind: PunchKind = 'clock_in'): OfflinePunchEvent {
  return {
    idempotency_key: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    kind,
    occurred_at: new Date(Date.UTC(2026, 7, 24, 9, index)).toISOString(),
    client_reported_at: new Date(Date.UTC(2026, 7, 24, 9, index)).toISOString(),
    clock_skew_ms: 0,
    device_id: 'device-under-test',
  };
}

function allAccepted(events: readonly OfflinePunchEvent[]): SyncResult {
  return {
    accepted: events.length,
    rejected: 0,
    events: events.map((one) => ({ idempotency_key: one.idempotency_key, accepted: true })),
  };
}

beforeEach(async () => {
  await clearPendingPunches();
});

afterEach(() => {
  syncPunches.mockReset();
});

describe('flushPendingPunches', () => {
  it('does not call the server when there is nothing waiting', async () => {
    const summary = await flushPendingPunches();

    expect(summary).toEqual({ accepted: 0, rejected: [], interrupted: false });
    expect(syncPunches).not.toHaveBeenCalled();
  });

  it('sends what is queued, oldest first, and empties the queue', async () => {
    // Queued out of order on purpose: a phone sends what it queued, whenever it
    // queued it, and the order it is read back in should not depend on that.
    await enqueuePunch(event(3));
    await enqueuePunch(event(1));
    await enqueuePunch(event(2));

    syncPunches.mockImplementation((events) => Promise.resolve(allAccepted(events)));

    const summary = await flushPendingPunches();

    expect(summary.accepted).toBe(3);
    expect(summary.interrupted).toBe(false);
    expect(await countPendingPunches()).toBe(0);

    const sentTimes = (syncPunches.mock.calls[0]?.[0] ?? []).map((one) => one.occurred_at);
    expect(sentTimes).toEqual([...sentTimes].sort());
  });

  it('splits a long outage into batches the database will accept', async () => {
    // `public.sync_punches` refuses more than 200 events in one call, so a
    // client that never chunked would fail whole rather than drain.
    const queued = MAX_EVENTS_PER_BATCH + 5;
    for (let index = 0; index < queued; index += 1) {
      await enqueuePunch(event(index));
    }

    syncPunches.mockImplementation((events) => Promise.resolve(allAccepted(events)));

    const summary = await flushPendingPunches();

    expect(syncPunches).toHaveBeenCalledTimes(2);
    expect(syncPunches.mock.calls[0]?.[0]).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(syncPunches.mock.calls[1]?.[0]).toHaveLength(5);
    expect(summary.accepted).toBe(queued);
    expect(await countPendingPunches()).toBe(0);
  });

  it('drops a refused punch instead of retrying it forever, and reports it', async () => {
    await enqueuePunch(event(1, 'clock_in'));
    await enqueuePunch(event(2, 'clock_in'));

    syncPunches.mockImplementation((events) =>
      Promise.resolve({
        accepted: 1,
        rejected: 1,
        events: [
          { idempotency_key: events[0]?.idempotency_key ?? '', accepted: true },
          {
            idempotency_key: events[1]?.idempotency_key ?? '',
            accepted: false,
            error: 'Ya registraste tu entrada hoy (estado actual: working)',
            code: '22023',
          },
        ],
      }),
    );

    const summary = await flushPendingPunches();

    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toHaveLength(1);
    expect(summary.rejected[0]?.reason).toContain('Ya registraste tu entrada hoy');
    // The refusal is final: the database will refuse it again on every retry.
    expect(await countPendingPunches()).toBe(0);
  });

  it('keeps what it could not send when the connection drops partway', async () => {
    const queued = MAX_EVENTS_PER_BATCH + 5;
    for (let index = 0; index < queued; index += 1) {
      await enqueuePunch(event(index));
    }

    syncPunches
      .mockImplementationOnce((events) => Promise.resolve(allAccepted(events)))
      .mockImplementationOnce(() => Promise.reject(new NetworkUnavailableError()));

    const summary = await flushPendingPunches();

    expect(summary.interrupted).toBe(true);
    expect(summary.accepted).toBe(MAX_EVENTS_PER_BATCH);
    // Nothing is lost: what went through is gone, what did not is still here.
    expect(await countPendingPunches()).toBe(5);
  });

  it('lets a real failure surface instead of silently keeping the queue', async () => {
    await enqueuePunch(event(1));
    syncPunches.mockImplementation(() =>
      Promise.reject(new Error('Esta cuenta no esta ligada a un empleado activo')),
    );

    await expect(flushPendingPunches()).rejects.toThrow('Esta cuenta no esta ligada');
    expect(await countPendingPunches()).toBe(1);
  });

  it('cannot queue the same punch twice', async () => {
    // The key is minted when the punch is taken, so a double tap that reaches
    // the queue twice is the same row, not two.
    const one = event(1);
    await enqueuePunch(one);
    await enqueuePunch(one);

    expect(await countPendingPunches()).toBe(1);
    expect(await pendingPunches()).toHaveLength(1);
  });
});
