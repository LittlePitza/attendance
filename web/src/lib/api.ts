import { NetworkUnavailableError, RpcError, isTransportFailure } from './errors';
import { supabase } from './supabase';
import type {
  HeartbeatResult,
  MyDay,
  OfflinePunchEvent,
  PunchKind,
  PunchResult,
  ServerTime,
  SyncResult,
} from './types';

/**
 * The only module that names a database function.
 *
 * Everything above this line works with typed values; everything below it is
 * PostgREST. Keeping the names in one place means a renamed function is one
 * edit, and means no component can quietly invent a call of its own.
 */
async function rpc<T>(name: string, args?: Readonly<Record<string, unknown>>): Promise<T> {
  // Asking while the browser already knows it is offline wastes a timeout the
  // employee has to wait through before the punch reaches the queue.
  if (!navigator.onLine) {
    throw new NetworkUnavailableError();
  }

  const { data, error } = await supabase.rpc(name, args);

  if (error !== null) {
    throw isTransportFailure(error)
      ? new NetworkUnavailableError(error.message)
      : new RpcError(error.message, error.code);
  }

  return data as T;
}

export interface OnlinePunchInput {
  readonly kind: PunchKind;
  readonly idempotencyKey: string;
  readonly clientReportedAt: string;
  readonly clockSkewMs: number;
  readonly deviceId: string;
}

export const api = {
  /** The punch screen, in one round trip. */
  myDay: (): Promise<MyDay> => rpc<MyDay>('my_day'),

  /** The official clock, used to measure how far this device has drifted. */
  serverTime: (): Promise<ServerTime> => rpc<ServerTime>('server_time'),

  /**
   * The timestamp that counts is the server's. What is sent here is stored
   * beside it as `client_reported_at`, for auditing only.
   */
  punch: (input: OnlinePunchInput): Promise<PunchResult> =>
    rpc<PunchResult>('punch', {
      p_kind: input.kind,
      p_idempotency_key: input.idempotencyKey,
      p_client_reported_at: input.clientReportedAt,
      p_clock_skew_ms: input.clockSkewMs,
      p_device_id: input.deviceId,
    }),

  /** Offline punches, replayed. The database sorts them; arrival order is not trusted. */
  syncPunches: (events: readonly OfflinePunchEvent[]): Promise<SyncResult> =>
    rpc<SyncResult>('sync_punches', { p_events: events }),

  /** Proof of life while a workday is open. Feeds the `no_connection` alert. */
  heartbeat: (): Promise<HeartbeatResult> => rpc<HeartbeatResult>('heartbeat'),
} as const;
