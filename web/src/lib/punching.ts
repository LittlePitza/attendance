import { api } from './api';
import { storedClockSkewMs } from './clock';
import { deviceId } from './device';
import { NetworkUnavailableError, RpcError } from './errors';
import { newId } from './ids';
import { enqueuePunch } from './queue';
import type { OfflinePunchEvent, PunchKind, PunchResult } from './types';

export type PunchOutcome =
  | { readonly status: 'recorded'; readonly result: PunchResult }
  | { readonly status: 'queued'; readonly event: OfflinePunchEvent }
  | { readonly status: 'refused'; readonly message: string };

/**
 * Takes one punch, online or not.
 *
 * The screen calls this and renders the outcome. It does not decide whether the
 * punch is legal -- the engine does that -- and it does not decide whether to
 * queue: that follows from whether the request reached the server at all.
 *
 * The idempotency key is minted once, before the attempt. If the request goes
 * out and the reply is lost, the retry carries the same key and the database
 * returns the original punch rather than making a second one.
 */
export async function recordPunch(kind: PunchKind): Promise<PunchOutcome> {
  const event: OfflinePunchEvent = {
    idempotency_key: newId(),
    kind,
    // The device's own reading, uncorrected on purpose. Subtracting the
    // measured drift here would produce a tidier timestamp and destroy the
    // evidence: the database stores the reading and the drift side by side so
    // that a clock which is minutes out is visible to HR instead of smoothed
    // away. The official time, when the punch is online, is the server's.
    occurred_at: new Date().toISOString(),
    client_reported_at: new Date().toISOString(),
    clock_skew_ms: storedClockSkewMs(),
    device_id: deviceId(),
  };

  try {
    const result = await api.punch({
      kind,
      idempotencyKey: event.idempotency_key,
      clientReportedAt: event.client_reported_at,
      clockSkewMs: event.clock_skew_ms,
      deviceId: event.device_id,
    });
    return { status: 'recorded', result };
  } catch (error) {
    if (error instanceof NetworkUnavailableError) {
      await enqueuePunch(event);
      return { status: 'queued', event };
    }

    if (error instanceof RpcError) {
      // Already written to be read on screen, in Spanish, by the engine.
      return { status: 'refused', message: error.message };
    }

    throw error;
  }
}
