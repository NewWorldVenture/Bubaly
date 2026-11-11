// `renewals.expires_at` (0033_renewals.sql) and a paperwork `due_on` are DATE
// columns: a day on the family's wall. They were counted as
// floor((UTC midnight of that day - now) / day), so from UTC midnight of the
// due day on — 5pm the afternoon BEFORE in Los Angeles — a renewal due today
// read "expired", one due tomorrow read "due today", a paperwork action due
// today read "Overdue", and the 3-day urgent threshold arrived a day early.
// Days are now counted between day keys: the DATE and the family's today
// (LIBRARY-140D5295F3B0).
import { describe, expect, it } from 'vitest';
import { renewalToNeed, paperworkActionsToNeeds, type NeedsReader } from '@/lib/home/needs-sources';
import { buildHomeNeeds, type HomeNeedsInput } from '@/lib/home/needs-build';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';

const EN: NeedsReader = { locale: 'en-US', t: (key, params) => translate(SOURCE_MESSAGES, key, params) };

// 5:30pm on 2026-06-28 in Los Angeles — already 00:30 on the 29th at Greenwich.
const LA_EVENING = new Date('2026-06-29T00:30:00.000Z');
const LA_TODAY = '2026-06-28';
// 8am on 2026-06-29 in Tokyo — still 23:00 on the 28th at Greenwich.
const TOKYO_MORNING = new Date('2026-06-28T23:00:00.000Z');
const TOKYO_TODAY = '2026-06-29';

const renewal = (expires_at: string) => ({ id: 'r1', title: 'Car registration', expires_at, reminder_days: 30, status: 'active' });
const slip = (due_on: string) => ({
  id: 'pw-1', title: 'Field trip slip', status: 'needs_action', urgency: 'soon', due_on,
  created_at: '2026-06-20T08:00:00Z',
  actions: [{ kind: 'sign', label: 'Sign and return', due_on: null, amount: null, materialized_id: null }],
});

describe("a renewal or paperwork due today is due today on the family's day", () => {
  it('reads a renewal against the family day key, whatever the instant', () => {
    expect(renewalToNeed(renewal('2026-06-28'), LA_TODAY)!.title).toBe('Renew Car registration — due today');
    expect(renewalToNeed(renewal('2026-06-29'), LA_TODAY)!.title).toBe('Renew Car registration — due in 1d');
    expect(renewalToNeed(renewal('2026-06-27'), LA_TODAY)!.title).toBe('Renew Car registration — expired');
    expect(renewalToNeed(renewal('2026-06-29'), TOKYO_TODAY)!.title).toBe('Renew Car registration — due today');
    expect(renewalToNeed(renewal('2026-06-28'), TOKYO_TODAY)!.title).toBe('Renew Car registration — expired');
  });

  it('turns a renewal urgent three days out, not four', () => {
    expect(renewalToNeed(renewal('2026-07-01'), LA_TODAY)).toMatchObject({ urgency: 'urgent', title: 'Renew Car registration — due in 3d' });
    expect(renewalToNeed(renewal('2026-07-02'), LA_TODAY)).toMatchObject({ urgency: 'normal', title: 'Renew Car registration — due in 4d' });
  });

  it('opens the reminder window on the day it says, not a day early', () => {
    const r = { ...renewal('2026-07-13'), reminder_days: 14 };
    expect(renewalToNeed(r, LA_TODAY)).toBeNull(); // 15 days out
    expect(renewalToNeed(r, '2026-06-29')!.title).toBe('Renew Car registration — due in 14d');
  });

  it('a DATE due today is never "expired" during its own day, even with only an instant', () => {
    // Noon UTC on the due day: floor(-12h / day) was -1, "expired".
    expect(renewalToNeed(renewal('2026-06-28'), new Date('2026-06-28T12:00:00Z'))!.title).toBe('Renew Car registration — due today');
    expect(paperworkActionsToNeeds(slip('2026-06-28'), new Date('2026-06-28T12:00:00Z'), EN)[0].title).toBe('Sign and return — Field trip slip · due today');
  });

  it('reads a paperwork action against the family day key', () => {
    expect(paperworkActionsToNeeds(slip('2026-06-28'), LA_TODAY, EN)[0]).toMatchObject({ urgency: 'urgent', title: 'Sign and return — Field trip slip · due today' });
    expect(paperworkActionsToNeeds(slip('2026-06-29'), LA_TODAY, EN)[0].title).toBe('Sign and return — Field trip slip · due in 1d');
    expect(paperworkActionsToNeeds(slip('2026-06-27'), LA_TODAY, EN)[0].title).toBe('Sign and return — Field trip slip · overdue');
    expect(paperworkActionsToNeeds(slip('2026-07-01'), LA_TODAY, EN)[0].urgency).toBe('urgent');
    expect(paperworkActionsToNeeds(slip('2026-07-02'), LA_TODAY, EN)[0].urgency).toBe('normal');
    expect(paperworkActionsToNeeds(slip('2026-06-29'), TOKYO_TODAY, EN)[0].title).toBe('Sign and return — Field trip slip · due today');
  });

  const base: Omit<HomeNeedsInput, 'now' | 'todayKey'> = {
    approvals: [], renewals: [renewal('2026-06-28'), { ...renewal('2026-06-29'), id: 'r2', title: 'Passport' }],
    documents: [], conflicts: [], pendingApprovals: 0, overdueMeds: false, overdueReminders: 0,
    dueTodayReminders: 0, pendingChores: 0, lowGrocery: false, openTodos: 0, reader: EN,
    paperwork: [slip('2026-06-28')],
  };

  it("the assembled list hands renewals and paperwork the family's today", () => {
    const titles = (now: Date, todayKey: string) => buildHomeNeeds({ ...base, now, todayKey }).map((n) => n.title);
    expect(titles(LA_EVENING, LA_TODAY)).toEqual([
      'Sign and return — Field trip slip · due today',
      'Renew Car registration — due today',
      'Renew Passport — due in 1d',
    ]);
    expect(titles(TOKYO_MORNING, TOKYO_TODAY)).toEqual([
      'Sign and return — Field trip slip · overdue',
      'Renew Car registration — expired',
      'Renew Passport — due today',
    ]);
  });
});
