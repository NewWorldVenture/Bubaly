import { describe, expect, it } from 'vitest';
import {
  buildConciergeDigest,
  dayOffset,
  dueLabelFor,
  digestToPromptLines,
  type ConciergeSnapshot,
} from '@/lib/concierge/digest';

const NOW = '2026-06-23T12:00:00.000Z'; // a Tuesday

describe('dayOffset', () => {
  it('computes calendar-day differences ignoring time of day', () => {
    expect(dayOffset('2026-06-23T23:00:00.000Z', NOW)).toBe(0);
    expect(dayOffset('2026-06-24', NOW)).toBe(1);
    expect(dayOffset('2026-06-22', NOW)).toBe(-1);
    expect(dayOffset('2026-06-30', NOW)).toBe(7);
  });
  it('returns null for invalid dates', () => {
    expect(dayOffset('not-a-date', NOW)).toBeNull();
  });
});

describe('dueLabelFor', () => {
  it('renders friendly relative labels', () => {
    expect(dueLabelFor(0)).toBe('today');
    expect(dueLabelFor(1)).toBe('tomorrow');
    expect(dueLabelFor(-1)).toBe('yesterday');
    expect(dueLabelFor(3)).toBe('in 3 days');
    expect(dueLabelFor(-4)).toBe('4 days ago');
  });
});

describe('buildConciergeDigest — bills', () => {
  it('classifies overdue / today / soon and skips paid + out-of-window', () => {
    const snap: ConciergeSnapshot = {
      now: NOW,
      bills: [
        { name: 'Electric', amount: 120.5, dueDate: '2026-06-20' },          // overdue
        { name: 'Water', amount: 40, dueDate: '2026-06-23' },                // today
        { name: 'Internet', amount: 70, dueDate: '2026-06-28' },             // soon (5d)
        { name: 'Mortgage', amount: 2000, dueDate: '2026-07-30' },           // out of window
        { name: 'Gas', amount: 55, dueDate: '2026-06-22', status: 'paid' },  // paid → skip
        { name: 'NoDate', amount: 10, dueDate: null },                       // no date → skip
      ],
    };
    const d = buildConciergeDigest(snap);
    const bills = d.items.filter(i => i.domain === 'bill');
    expect(bills.map(b => b.title)).toEqual(['Electric', 'Water', 'Internet']);
    expect(bills[0].urgency).toBe('overdue');
    expect(bills[0].detail).toBe('$120.50 due 3 days ago');
    expect(bills[1].urgency).toBe('today');
    expect(bills[2].urgency).toBe('soon');
    expect(bills[2].detail).toBe('$70.00 due in 5 days');
  });

  it('formats bills without an amount', () => {
    const d = buildConciergeDigest({ now: NOW, bills: [{ name: 'HOA', dueDate: '2026-06-24' }] });
    expect(d.items[0].detail).toBe('Due tomorrow');
  });
});

describe('buildConciergeDigest — medications', () => {
  it('always marks supplied meds as due today with member/time detail', () => {
    const d = buildConciergeDigest({
      now: NOW,
      medications: [
        { name: 'Amoxicillin', member: 'Mia', timeOfDay: '8:00 AM' },
        { name: 'Vitamin D' },
      ],
    });
    const meds = d.items.filter(i => i.domain === 'medication');
    expect(meds).toHaveLength(2);
    expect(meds[0].urgency).toBe('today');
    expect(meds[0].detail).toBe('Mia · 8:00 AM');
    expect(meds[1].detail).toBe('Scheduled today');
  });
});

describe('buildConciergeDigest — pantry & warranties', () => {
  it('flags expiring pantry items within 5 days and marks expired ones', () => {
    const d = buildConciergeDigest({
      now: NOW,
      pantry: [
        { name: 'Milk', expiresAt: '2026-06-24' },     // soon
        { name: 'Yogurt', expiresAt: '2026-06-21' },   // expired
        { name: 'Canned beans', expiresAt: '2027-01-01' }, // out of window
      ],
    });
    const pantry = d.items.filter(i => i.domain === 'pantry');
    expect(pantry.map(p => p.title)).toEqual(['Yogurt', 'Milk']); // overdue first
    expect(pantry[0].detail).toBe('Expired 2 days ago');
    expect(pantry[1].detail).toBe('Expires tomorrow');
  });

  it('flags warranties expiring within 30 days', () => {
    const d = buildConciergeDigest({
      now: NOW,
      warranties: [
        { name: 'LG Fridge', expiresOn: '2026-07-10' }, // soon (17d)
        { name: 'Old TV', expiresOn: '2025-01-01' },    // long expired → still overdue surfaced? offset<0 → overdue
        { name: 'Roof', expiresOn: '2030-01-01' },      // out of window
      ],
    });
    const w = d.items.filter(i => i.domain === 'warranty');
    expect(w.map(x => x.title)).toEqual(['Old TV warranty', 'LG Fridge warranty']);
    expect(w[1].detail).toBe('Expires in 17 days');
  });
});

describe('buildConciergeDigest — trips', () => {
  it('detects upcoming and in-progress trips', () => {
    const d = buildConciergeDigest({
      now: NOW,
      trips: [
        { title: 'Beach Week', startDate: '2026-06-30', endDate: '2026-07-05', destination: 'Maui' }, // soon
        { title: 'Grandma visit', startDate: '2026-06-22', endDate: '2026-06-25' }, // in progress
        { title: 'Ski Trip', startDate: '2026-12-01' }, // out of window
      ],
    });
    const trips = d.items.filter(i => i.domain === 'trip');
    expect(trips.map(t => t.title).sort()).toEqual(['Beach Week', 'Grandma visit']);
    const inProgress = trips.find(t => t.title === 'Grandma visit')!;
    expect(inProgress.urgency).toBe('today');
    expect(inProgress.dueLabel).toBe('in progress');
    const upcoming = trips.find(t => t.title === 'Beach Week')!;
    expect(upcoming.detail).toBe('Departs in 7 days · Maui');
  });
});

describe('buildConciergeDigest — ordering, counts, headline', () => {
  it('orders overdue → today → soon and counts/rolls up by domain', () => {
    const snap: ConciergeSnapshot = {
      now: NOW,
      bills: [{ name: 'Electric', amount: 100, dueDate: '2026-06-20' }], // overdue
      medications: [{ name: 'Insulin', member: 'Dad' }],                 // today
      maintenance: [{ title: 'HVAC filter', dueAt: '2026-06-27' }],      // soon
      pantry: [{ name: 'Milk', expiresAt: '2026-06-23' }],               // today
    };
    const d = buildConciergeDigest(snap);
    expect(d.items[0].urgency).toBe('overdue');
    expect(d.items[d.items.length - 1].urgency).toBe('soon');
    expect(d.counts).toEqual({ overdue: 1, today: 2, soon: 1, total: 4 });
    // medication ranks before pantry within the same "today" bucket
    const todayItems = d.items.filter(i => i.urgency === 'today').map(i => i.domain);
    expect(todayItems).toEqual(['medication', 'pantry']);
    expect(d.byDomain.reduce((s, x) => s + x.count, 0)).toBe(4);
    expect(d.headline).toBe('1 overdue, 2 due today, 1 coming up.');
  });

  it('produces an all-caught-up headline when empty', () => {
    const d = buildConciergeDigest({ now: NOW });
    expect(d.counts.total).toBe(0);
    expect(d.headline).toMatch(/all caught up/i);
    expect(digestToPromptLines(d)).toMatch(/Nothing outstanding/);
  });
});

describe('digestToPromptLines', () => {
  it('renders tagged lines for LLM grounding', () => {
    const d = buildConciergeDigest({
      now: NOW,
      bills: [{ name: 'Water', amount: 40, dueDate: '2026-06-23' }],
    });
    expect(digestToPromptLines(d)).toBe('- [TODAY] (bill) Water — $40.00 due today');
  });
});
