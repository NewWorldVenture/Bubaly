import { describe, expect, it } from 'vitest';
import { buildCalendarRequest, calendarOwnerKey, eventDay, groupCalendarDays, parseCalendarReply } from '../mobile/src/lib/calendar-core';
const owner = { userId: 'user', familyId: 'family', memberId: 'member' };
const event = { eventId: 'master', occurrenceKey: '["master","2026-10-10"]', title: 'All day', starts_at: '2026-10-10T00:00:00Z', ends_at: null, all_day: true, location: null, category: 'family', startDate: '2026-10-10', endDate: '2026-10-11' };
const body = () => ({ userId: 'user', familyId: 'family', timezone: 'America/Los_Angeles', fromDay: '2026-10-10', toDay: '2026-10-13', count: 1, occurrences: [event] });
describe('portable mobile calendar contract', () => {
  it('binds both expected identities and never follows login redirects', () => {
    const { url, init } = buildCalendarRequest('https://example.invalid/', 'token', owner, '2026-10-10', 3);
    expect(url).toContain('/api/calendar/occurrences?'); expect(init.headers).toMatchObject({ Authorization: 'Bearer token', 'X-Bubaly-User-Id': 'user', 'X-Bubaly-Family-Id': 'family' }); expect(init.redirect).toBe('error');
  });
  it('keeps full count independent of the displayed prefix', () => { expect(parseCalendarReply({ ...body(), count: 101, occurrences: Array.from({ length: 100 }, (_, n) => ({ ...event, occurrenceKey: String(n) })) }, owner).count).toBe(101); });
  it('rejects a counted response missing its required display prefix', () => { expect(() => parseCalendarReply({ ...body(), occurrences: [] }, owner)).toThrow('incomplete'); });
  it.each(['America/Los_Angeles', 'Asia/Tokyo'])('groups DATE by civil day in %s', zone => { expect(eventDay(event, zone)).toBe('2026-10-10'); expect(groupCalendarDays([event], zone)[0].key).toBe('2026-10-10'); });
  it.each([{ userId: 'other' }, { familyId: 'other' }, { count: 0 }, { timezone: 'bad/zone' }, { occurrences: [event, event] }, { occurrences: [{ ...event, endDate: 'bad' }] }])('refuses malformed or wrong-owner response %j', patch => { expect(() => parseCalendarReply({ ...body(), ...patch }, owner)).toThrow(); });
  it('distinguishes a same-family new user and member changes', () => { expect(calendarOwnerKey(owner)).not.toBe(calendarOwnerKey({ ...owner, userId: 'other' })); expect(calendarOwnerKey(owner)).not.toBe(calendarOwnerKey({ ...owner, memberId: 'other' })); });
});
