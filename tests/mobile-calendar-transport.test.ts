import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarOwner, CalendarReply } from '../mobile/src/lib/calendar-core';
const h = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn() }));
vi.mock('../mobile/src/lib/supabase', () => ({ supabase: { auth: { getSession: h.session } } }));
vi.mock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://example.invalid' } }));
// Load the real mobile transport at runtime without importing native global
// declarations into the separate web TS project. Mobile tsc checks its source.
const transportModule = '../mobile/src/lib/queries';
const { fetchUpcomingEvents } = await import(transportModule) as {
  fetchUpcomingEvents: (owner: CalendarOwner, days?: number, signal?: AbortSignal, now?: Date) => Promise<CalendarReply>;
};
const owner = { userId: 'user', familyId: 'family', memberId: 'member', timezone: 'America/Los_Angeles' };
beforeEach(() => { h.session.mockReset().mockResolvedValue({ data: { session: { user: { id: 'user' }, access_token: 'fresh-token' } }, error: null }); h.fetch.mockReset().mockResolvedValue(Response.json({ userId: 'user', familyId: 'family', timezone: owner.timezone, fromDay: '2026-10-09', toDay: '2026-10-12', count: 0, occurrences: [] })); vi.stubGlobal('fetch', h.fetch); });
afterEach(() => vi.unstubAllGlobals());
describe('actual mobile calendar transport', () => {
  it('reads the current session and requests family-local days rather than device dates', async () => {
    await fetchUpcomingEvents(owner, 3, undefined, new Date('2026-10-10T01:00:00Z'));
    expect(h.session).toHaveBeenCalledOnce(); const [url, init] = h.fetch.mock.calls[0];
    expect(url).toContain('fromDay=2026-10-09'); expect(init.headers).toMatchObject({ Authorization: 'Bearer fresh-token', 'X-Bubaly-User-Id': 'user', 'X-Bubaly-Family-Id': 'family' }); expect(init.redirect).toBe('error');
  });
  it('refuses a changed user before network execution', async () => { h.session.mockResolvedValue({ data: { session: { user: { id: 'other' } } }, error: null }); await expect(fetchUpcomingEvents(owner)).rejects.toThrow('changed'); expect(h.fetch).not.toHaveBeenCalled(); });
  it('rejects an owner-echo mismatch', async () => { h.fetch.mockResolvedValue(Response.json({ userId: 'other' })); await expect(fetchUpcomingEvents(owner)).rejects.toThrow(); });
  it('passes cancellation and rejects an already aborted request', async () => { const abort = new AbortController(); abort.abort(); await expect(fetchUpcomingEvents(owner, 3, abort.signal)).rejects.toThrow(); expect(h.fetch).not.toHaveBeenCalled(); });
});
