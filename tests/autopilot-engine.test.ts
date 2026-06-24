import { describe, it, expect } from 'vitest';
import {
  confidenceTier, AUTO_THRESHOLD, APPROVE_THRESHOLD, daysUntilBirthday,
  renewalSuggestions, appointmentSuggestions, choreSuggestions, birthdaySuggestions,
  grocerySuggestions, conflictSuggestions, expenseSuggestions, burnoutSuggestions,
  medicationSuggestions, mealSuggestions, insuranceSuggestions, monthlyCents, buildSuggestions, applyMemberTraits, successProbability, partitionByTier,
  type FamilySnapshot,
} from '@/lib/autopilot/engine';
import type { MemberTraits } from '@/lib/autopilot/twin';

const base = (over: Partial<FamilySnapshot> = {}): FamilySnapshot => ({
  today: '2026-06-24',
  renewals: [],
  appointments: [],
  overdueChores: [],
  birthdays: [],
  lingeringGroceries: [],
  events: [],
  subscriptions: [],
  stressSignals: [],
  medications: [],
  favoriteMeals: [],
  plannedDinnerDays: [],
  insurance: [],
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

describe('monthlyCents', () => {
  it('normalizes cadences to a monthly figure', () => {
    expect(monthlyCents(1200, 'monthly')).toBe(1200);
    expect(monthlyCents(12000, 'yearly')).toBe(1000);
    expect(monthlyCents(3000, 'quarterly')).toBe(1000);
    expect(monthlyCents(300, 'weekly')).toBe(1300);
  });
});

describe('expenseSuggestions', () => {
  it('flags an upcoming charge within 7 days', () => {
    const out = expenseSuggestions(base({ subscriptions: [
      { id: 's1', name: 'Netflix', costCents: 1599, cadence: 'monthly', nextCharge: '2026-06-27', lastUsed: '2026-06-23', status: 'active' },
      { id: 's2', name: 'Far', costCents: 999, cadence: 'monthly', nextCharge: '2026-08-01', lastUsed: null, status: 'active' },
    ] }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('finance');
    expect(out[0].title).toContain('Netflix');
    expect(out[0].dedupeKey).toBe('sub-charge:s1:2026-06-27');
  });
  it('flags a stale (unused 60+ days) active subscription', () => {
    const out = expenseSuggestions(base({ subscriptions: [
      { id: 's3', name: 'Gym', costCents: 4000, cadence: 'monthly', nextCharge: null, lastUsed: '2026-01-01', status: 'active' },
    ] }));
    expect(out.some((o) => o.dedupeKey === 'sub-stale:s3')).toBe(true);
  });
  it('ignores canceled subscriptions', () => {
    expect(expenseSuggestions(base({ subscriptions: [
      { id: 's4', name: 'Old', costCents: 500, cadence: 'monthly', nextCharge: '2026-06-25', lastUsed: null, status: 'canceled' },
    ] }))).toHaveLength(0);
  });
});

describe('burnoutSuggestions', () => {
  it('surfaces a heads-up when recent stress weight exceeds threshold', () => {
    const out = burnoutSuggestions(base({ stressSignals: [
      { memberId: 'm1', weight: 3, occurredOn: '2026-06-22' },
      { memberId: 'm1', weight: 3, occurredOn: '2026-06-23' },
    ] }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('wellbeing');
    expect(out[0].memberId).toBe('m1'); // concentrated on one member
  });
  it('stays quiet below threshold or with stale signals', () => {
    expect(burnoutSuggestions(base({ stressSignals: [{ memberId: 'm1', weight: 1, occurredOn: '2026-06-23' }] }))).toHaveLength(0);
    expect(burnoutSuggestions(base({ stressSignals: [{ memberId: 'm1', weight: 9, occurredOn: '2026-05-01' }] }))).toHaveLength(0);
  });
});

describe('medicationSuggestions', () => {
  it('flags a refill within its reminder lead time, auto-tier when due <=2 days', () => {
    const out = medicationSuggestions(base({ medications: [
      { id: 'm1', name: 'Insulin', memberId: 'p1', refillOn: '2026-06-25', reminderDays: 7 }, // 1d → 92 auto
      { id: 'm2', name: 'Vitamin', memberId: null, refillOn: '2026-06-30', reminderDays: 7 }, // 6d → 80 approve
      { id: 'm3', name: 'Far', memberId: null, refillOn: '2026-08-01', reminderDays: 7 }, // out of window
    ] }));
    expect(out.map((o) => o.sourceId)).toEqual(['m1', 'm2']);
    expect(out[0].confidence).toBe(92);
    expect(confidenceTier(out[0].confidence)).toBe('auto');
    expect(out[0].actionType).toBe('create_reminder');
    expect(out[1].confidence).toBe(80);
  });
  it('flags a just-overdue refill but drops very stale ones', () => {
    expect(medicationSuggestions(base({ medications: [
      { id: 'm4', name: 'Recent', memberId: null, refillOn: '2026-06-22', reminderDays: 7 }, // 2d overdue → keep
    ] }))).toHaveLength(1);
    expect(medicationSuggestions(base({ medications: [
      { id: 'm5', name: 'Old', memberId: null, refillOn: '2026-06-01', reminderDays: 7 }, // 23d overdue → drop
    ] }))).toHaveLength(0);
  });
});

describe('applyMemberTraits (Digital Twin modulation)', () => {
  const forgetful: MemberTraits = { memberId: 'm2', choreCompletionRate: 0.3, reliabilityScore: 30, sampleSize: 10 };
  it('bends a chore draft for a forgetful member', () => {
    const drafts = choreSuggestions(base({ overdueChores: [{ id: 'c1', title: 'Trash', dueAt: '2026-06-20', memberId: 'm2' }] }));
    const adjusted = applyMemberTraits(drafts[0], new Map([['m2', forgetful]]));
    expect(adjusted.confidence).toBe(drafts[0].confidence + 8);
    expect(adjusted.urgency).toBe(3); // 2 + 1
  });
  it('passes through drafts without a member or matching traits', () => {
    const d = grocerySuggestions(base({ lingeringGroceries: [{ id: 'g1', name: 'Milk', addedAt: '2026-06-10' }] }))[0];
    expect(applyMemberTraits(d, new Map([['m2', forgetful]]))).toBe(d); // no memberId → unchanged ref
  });
  it('buildSuggestions applies the traits map', () => {
    const snap = base({ overdueChores: [{ id: 'c1', title: 'Trash', dueAt: '2026-06-20', memberId: 'm2' }] });
    const plain = buildSuggestions(snap);
    const twinned = buildSuggestions(snap, new Map([['m2', forgetful]]));
    expect(twinned[0].confidence).toBe(plain[0].confidence + 8);
  });
});

describe('mealSuggestions (Meal Agent / Family Memory)', () => {
  const favs = [{ name: 'Tacos', count: 9 }, { name: 'Pasta', count: 6 }, { name: 'Stir-fry', count: 4 }];
  it('suggests planning when most of the next 3 days lack a dinner', () => {
    const out = mealSuggestions(base({ favoriteMeals: favs, plannedDinnerDays: ['2026-06-24'] }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('meal');
    expect(out[0].detail).toContain('Tacos');
    expect((out[0].payload.favorites as string[])).toEqual(['Tacos', 'Pasta', 'Stir-fry']);
  });
  it('stays quiet when dinners are mostly planned', () => {
    expect(mealSuggestions(base({ favoriteMeals: favs, plannedDinnerDays: ['2026-06-24', '2026-06-25', '2026-06-26'] }))).toHaveLength(0);
  });
  it('stays quiet with no learned favorites (nothing to remember yet)', () => {
    expect(mealSuggestions(base({ favoriteMeals: [], plannedDinnerDays: [] }))).toHaveLength(0);
  });
});

describe('insuranceSuggestions', () => {
  it('flags policies renewing within 30 days, scaling confidence by proximity', () => {
    const out = insuranceSuggestions(base({ insurance: [
      { id: 'i1', label: 'auto insurance (Geico)', renewalOn: '2026-06-29' }, // 5d → 95
      { id: 'i2', label: 'home insurance (State)', renewalOn: '2026-07-20' }, // 26d → 72
      { id: 'i3', label: 'far', renewalOn: '2026-12-01' }, // out of window
    ] }));
    expect(out.map((o) => o.sourceId)).toEqual(['i1', 'i2']);
    expect(out[0].confidence).toBe(95);
    expect(out[0].kind).toBe('insurance');
    expect(out[0].dedupeKey).toBe('insurance:i1:2026-06-29');
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
