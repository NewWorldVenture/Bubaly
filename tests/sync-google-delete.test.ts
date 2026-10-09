import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteEvent, GoogleApiError } from '@/lib/sync/providers/google';

afterEach(() => vi.unstubAllGlobals());

function transport(status: number, body: unknown, raw = false) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://www.googleapis.com/calendar/v3/calendars/synthetic%2Fcalendar/events/synthetic%2Fevent');
    expect(init?.method).toBe('DELETE');
    return status === 204 ? new Response(null, { status })
      : new Response(raw ? String(body) : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Google event deletion acknowledgement', () => {
  it('keeps a normal 204 deletion successful', async () => {
    const fetch = transport(204, null);
    await expect(deleteEvent('synthetic-token', 'synthetic/calendar', 'synthetic/event')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts the documented 410 deleted receipt without a second request', async () => {
    const fetch = transport(410, { error: { code: 410, errors: [{ domain: 'global', reason: 'deleted' }] } });
    await expect(deleteEvent('synthetic-token', 'synthetic/calendar', 'synthetic/event')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['expired sync', 410, { error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } }, false],
    ['old modification window', 410, { error: { code: 410, errors: [{ reason: 'updatedMinTooLongAgo' }] } }, false],
    ['mixed reasons', 410, { error: { code: 410, errors: [{ reason: 'deleted' }, { reason: 'fullSyncRequired' }] } }, false],
    ['missing reasons', 410, { error: { code: 410, errors: [] } }, false],
    ['null reason record', 410, { error: { code: 410, errors: [null] } }, false],
    ['unconfirmed body code', 410, { error: { code: 403, errors: [{ reason: 'deleted' }] } }, false],
    ['malformed body', 410, '{truncated', true],
    ['null body', 410, null, false],
    ['missing resource', 404, { error: { code: 404, errors: [{ reason: 'notFound' }] } }, false],
    ['permission denied', 403, { error: { code: 403, errors: [{ reason: 'deleted' }] } }, false],
  ] as const)('retains %s as a provider failure', async (_name, status, body, raw) => {
    const fetch = transport(status, body, raw);
    await expect(deleteEvent('synthetic-token', 'synthetic/calendar', 'synthetic/event'))
      .rejects.toMatchObject({ name: 'GoogleApiError', status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves a network failure instead of confirming deletion', async () => {
    const error = new Error('Synthetic transport failure');
    vi.stubGlobal('fetch', vi.fn(async () => { throw error; }));
    await expect(deleteEvent('synthetic-token', 'synthetic/calendar', 'synthetic/event')).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(GoogleApiError);
  });
});
