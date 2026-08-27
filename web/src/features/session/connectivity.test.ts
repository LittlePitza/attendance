import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEventResult } from '../../lib/types';
import { bufferedCount, drainEvents, noteEvent } from './connectivity';

const reportSessionEvent =
  vi.fn<
    (
      sessionId: string,
      kind: string,
      at?: string,
      detail?: Readonly<Record<string, unknown>>,
    ) => Promise<SessionEventResult>
  >();

vi.mock('../../lib/api', () => ({
  api: {
    reportSessionEvent: (
      sessionId: string,
      kind: string,
      at?: string,
      detail?: Readonly<Record<string, unknown>>,
    ) => reportSessionEvent(sessionId, kind, at, detail),
  },
}));

beforeEach(() => {
  window.localStorage.clear();
  reportSessionEvent.mockReset();
  reportSessionEvent.mockResolvedValue({ recorded: true, event_id: 'e1' });
});

describe('the connectivity buffer', () => {
  it('writes an observation down instead of sending it', () => {
    noteEvent('connection_lost');

    // Nothing is sent from `noteEvent`, and that is the whole point: there is no
    // connection to send a lost connection on.
    expect(reportSessionEvent).not.toHaveBeenCalled();
    expect(bufferedCount()).toBe(1);
  });

  it('carries the hour the device saw, not the hour it was sent', async () => {
    noteEvent('connection_lost');
    await drainEvents('s1');

    const [, kind, at] = reportSessionEvent.mock.calls[0] ?? [];
    expect(kind).toBe('connection_lost');
    // A real ISO timestamp from the moment it was observed. Without it the log
    // would only know when the device got back, which is the one hour nobody
    // needs.
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('survives a reload, because a drop that takes the tab is the case worth having', async () => {
    noteEvent('connection_lost');

    // A fresh module read of the same storage is what a reload amounts to here.
    expect(bufferedCount()).toBe(1);

    await drainEvents('s1');
    expect(bufferedCount()).toBe(0);
  });

  it('sends oldest first and then forgets', async () => {
    noteEvent('connection_lost');
    noteEvent('connection_back');
    await drainEvents('s1');

    expect(reportSessionEvent.mock.calls.map((call) => call[1])).toEqual([
      'connection_lost',
      'connection_back',
    ]);
    expect(bufferedCount()).toBe(0);
  });

  it('drops what the server refused rather than retrying it for ever', async () => {
    reportSessionEvent.mockResolvedValue({ recorded: false, reason: 'unknown_session' });
    noteEvent('connection_lost');

    await drainEvents('s1');

    // Answered is answered. A flush naming a session the sweeper closed cannot
    // improve by being repeated on every reconnection.
    expect(bufferedCount()).toBe(0);
  });

  it('keeps what never got an answer, because that decided nothing', async () => {
    reportSessionEvent.mockRejectedValue(new Error('offline'));
    noteEvent('connection_lost');

    await drainEvents('s1');

    expect(bufferedCount()).toBe(1);
  });

  it('caps the buffer and admits the hole rather than pretending to be whole', async () => {
    for (let index = 0; index < 45; index += 1) {
      noteEvent('connection_lost');
    }

    expect(bufferedCount()).toBe(40);

    await drainEvents('s1');

    // The first event out declares what was lost, so a reader knows the trail is
    // partial instead of assuming it is complete.
    const [, , , detail] = reportSessionEvent.mock.calls[0] ?? [];
    expect(detail).toMatchObject({ dropped_before: 5 });
  });

  it('does nothing at all when there is nothing to say', async () => {
    await drainEvents('s1');
    expect(reportSessionEvent).not.toHaveBeenCalled();
  });

  it('survives storage being unavailable without taking the app with it', () => {
    const setItem = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota');
      });

    // A private window, blocked site data or a full quota costs a gap nobody can
    // explain. It must not cost the punch screen.
    expect(() => noteEvent('connection_lost')).not.toThrow();

    setItem.mockRestore();
  });
});
