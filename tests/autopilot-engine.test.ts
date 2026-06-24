import { describe, it, expect } from 'vitest';
import {
  confidenceTier, AUTO_THRESHOLD, APPROVE_THRESHOLD, daysUntilBirthday,
  renewalSuggestions, appointmentSuggestions, choreSuggestions, birthdaySuggestions,
  grocerySuggestions, conflictSuggestions, buildSuggestions, successProbability, partitionByTier,
  type FamilySnapshot,
} from '@/lib/autopilot/engine';

const base = (over: Partial<FamilySnapshot> = {}): FamilySnapshot => ({
  today: '2026-06-24',
  renewals: [],
  appointments: [],
  overdueChores: [],
  birthdays: [],
  lingeringGroceries: [],
  events: [],
  ...over,
});

describe('confidenceTier', () => {
  it('maps to auto / approve / ask by threshold', () => {
    expect(confidenceTier(AUTO_THRESHOLD)).toBe('auto');
    expect(confidenceTier(95)).toBe('auto');
    expect(confidenceTier(APPROVE_THRESHOLD)).toBe('approve');
    expect(confidenceTier(80)).toBe('approve');
    expect(confidenceTier(69)).toBe('ask');
    expect(confidenceTier(0)).toBe('ask');
  });
});

describe('daysUntilBirthday', () => {
  it('counts to the next occurrence (this year)', () => {
    expect(daysUntilBirthday('2026-06-24', '1990-06-27')).toBe(3);
    expect(daysUntilBirthday('2026-06-24', '1990-06-24')).toBe(0);
  });
  it('rolls to next year when already passed', () => {
    expect(daysUntilBirthday('2026-06-24', '1990-06-20')).toBeGreaterThan(300);
  });
});

describe('renewalSuggestions', () => {
  it('flags renewals expiring within 30 days, scaling confidence by proximity', () => {
    const out = renewalSuggestions(base({ renewals: [
      { id: 'r1', label: 'Passport', expiresOn: '2026-06-29' }, // 5d → 95
      { id: 'r2', label: 'Insurance', expiresOn: '2026-07-06' }, // 12d → 82
      { id: 'r3', label: 'Registration', expiresOn: '2026-07-20' }, // 26d → 72
      { id: 'r4', label: 'Far', expiresOn: '2026-12-01' }, // out of window
    ] }));
    expect(out.map((o) => o.sourceId)).toEqual(['r1', 'r2', 'r3']);
    expect(out[0].confidence).toBe(95);
    expect(out[0].actionType).toBe('create_reminder');
    expect(out[0].dedupeKey).toBe('renewal:r1');
  });
});

describe('appointmentSuggestions', () => {
  it('only suggests for today/tomorrow appts without a reminder', () => {
    const out = appointmentSuggestions(base({ appointments: [
      { id: 'a1', title: 'Dentist', startsAt: '2026-06-24T15:00:00Z', memberId: 'm1', hasReminder: false },
      { id: 'a2', title: 'Has reminder', startsAt: '2026-06-24T16:00:00Z', memberId: null, hasReminder: true },
      { id: 'a3', title: 'Next week', startsAt: '2026-07-01T10:00:00Z', memberId: null, hasReminder: false },
    ] }));
    expect(out.map((o) => o.sourceId)).toEqual(['a1']);
    expect(out[0].urgency).toBe(3); // today
  });
});

describe('choreSuggestions', () => {
  it('emits a nudge per overdue chore', () => {
    const out = choreSuggestions(base({ overdueChores: [{ id: 'c1', title: 'Trash', dueAt: '2026-06-20', memberId: 'm2' }] }));
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(74);
    expect(confidenceTier(out[0].confidence)).toBe('approve');
  });
});

describe('birthdaySuggestions', () => {
  it('flags birthdays within 14 days with proximity urgency', () => {
    const out = birthdaySuggestions(base({ birthdays: [
      { memberId: 'm1', name: 'Mia', birthday: '2015-06-26' }, // 2d
      { memberId: 'm2', name: 'Leo', birthday: '2012-12-01' }, // far
    ] }));
    expect(out.map((o) => o.memberId)).toEqual(['m1']);
    expect(out[0].urgency).toBe(3);
  });
});

describe('grocerySuggestions', () => {
  it('flags items lingering 7+ days, auto-tier confidence', () => {
    const out = grocerySuggestions(base({ lingeringGroceries: [
      { id: 'g1', name: 'Milk', addedAt: '2026-06-10' }, // 14d
      { id: 'g2', name: 'Fresh', addedAt: '2026-06-22' }, // 2d → skip
    ] }));
    expect(out.map((o) => o.sourceId)).toEqual(['g1']);
    expect(confidenceTier(out[0].confidence)).toBe('auto');
  });
});

describe('conflictSuggestions', () => {
  it('flags overlapping same-day events, higher confidence when same member', () => {
    const out = conflictSuggestions(base({ events: [
      { id: 'e1', title: 'Soccer', startsAt: '2026-06-24T15:00:00Z', endsAt: '2026-06-24T16:30:00Z', memberId: 'm1' },
      { id: 'e2', title: 'Dentist', startsAt: '2026-06-24T16:00:00Z', endsAt: '2026-06-24T17:00:00Z', memberId: 'm1' },
    ] }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('conflict');
    expect(out[0].confidence).toBe(84); // same member
    expect(out[0].urgency).toBe(3);
    expect(out[0].dedupeKey).toBe('conflict:e1|e2');
  });
  it('does not flag non-overlapping or different-day events', () => {
    expect(conflictSuggestions(base({ events: [
      { id: 'e1', title: 'A', startsAt: '2026-06-24T09:00:00Z', endsAt: '2026-06-24T10:00:00Z', memberId: 'm1' },
      { id: 'e2', title: 'B', startsAt: '2026-06-24T11:00:00Z', endsAt: '2026-06-24T12:00:00Z', memberId: 'm1' },
    ] }))).toHaveLength(0);
  });
  it('treats a missing end time as a 1-hour block', () => {
    const out = conflictSuggestions(base({ events: [
      { id: 'e1', title: 'A', startsAt: '2026-06-24T09:00:00Z', endsAt: null, memberId: null },
      { id: 'e2', title: 'B', startsAt: '2026-06-24T09:30:00Z', endsAt: null, memberId: null },
    ] }));
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(68); // family-wide clash
  });
});

describe('buildSuggestions + helpers', () => {
  const snap = base({
    renewals: [{ id: 'r1', label: 'Passport', expiresOn: '2026-06-29' }],
    overdueChores: [{ id: 'c1', title: 'Trash', dueAt: '2026-06-20', memberId: 'm2' }],
    lingeringGroceries: [{ id: 'g1', name: 'Milk', addedAt: '2026-06-10' }],
  });
  it('aggregates and sorts by urgency then confidence', () => {
    const all = buildSuggestions(snap);
    expect(all.length).toBe(3);
    expect(all[0].urgency).toBeGreaterThanOrEqual(all[all.length - 1].urgency);
  });
  it('partitions by tier', () => {
    const p = partitionByTier(buildSuggestions(snap));
    expect(p.auto.some((d) => d.kind === 'groceries')).toBe(true);
    expect(p.auto.some((d) => d.kind === 'document')).toBe(true); // 95
    expect(p.approve.some((d) => d.kind === 'chore')).toBe(true);
  });
  it('successProbability drops with more/urgent risks and stays 0-100', () => {
    expect(successProbability([])).toBe(100);
    const p = successProbability(buildSuggestions(snap));
    expect(p).toBeLessThan(100);
    expect(p).toBeGreaterThanOrEqual(0);
  });
});
