import { describe, it, expect } from 'vitest';
import {
  LIFE_EVENT_TEMPLATES,
  getTemplate,
  addDays,
  buildPlanItems,
  type LifeEventItemCategory,
} from '@/lib/life-events/templates';

const VALID_CATEGORIES: LifeEventItemCategory[] = ['plan', 'buy', 'book', 'notify', 'document', 'health', 'home', 'celebrate'];

describe('template catalog integrity', () => {
  it('has the eleven expected life events with unique keys', () => {
    const keys = LIFE_EVENT_TEMPLATES.map((t) => t.key);
    // The original six, plus M25's holidays + emergency_prep and M34's camp,
    // aging_parent and renovation. `holidays` covers both the "holiday" the
    // outcome launcher runs and the "holidays" the checklist calls it.
    expect(keys).toEqual(expect.arrayContaining([
      'new_baby', 'moving', 'school_start', 'vacation', 'new_pet', 'new_job',
      'holidays', 'emergency_prep', 'camp', 'aging_parent', 'renovation',
    ]));
    expect(keys).toHaveLength(11);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every template a distinct icon key the module can resolve', () => {
    for (const t of LIFE_EVENT_TEMPLATES) {
      expect(t.icon, t.key).toMatch(/^[a-z-]+$/);
      expect(t.description.length, t.key).toBeGreaterThan(20);
    }
  });
  it('every template has items with valid categories and a title', () => {
    for (const t of LIFE_EVENT_TEMPLATES) {
      expect(t.items.length).toBeGreaterThanOrEqual(8);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.defaultLeadDays).toBeGreaterThan(0);
      for (const it of t.items) {
        expect(it.title.length).toBeGreaterThan(0);
        expect(VALID_CATEGORIES).toContain(it.category);
        expect(Number.isInteger(it.offsetDays)).toBe(true);
      }
    }
  });
});

describe('getTemplate', () => {
  it('returns a known template and undefined for unknown', () => {
    expect(getTemplate('vacation')?.title).toBe('Family Vacation');
    expect(getTemplate('nope')).toBeUndefined();
  });
});

describe('addDays (UTC)', () => {
  it('adds and subtracts days across month boundaries', () => {
    expect(addDays('2026-07-01', -1)).toBe('2026-06-30');
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-07-15', 0)).toBe('2026-07-15');
  });
  it('is stable regardless of a time component on the input', () => {
    expect(addDays('2026-07-15T23:59:00Z', -5)).toBe('2026-07-10');
  });
});

describe('buildPlanItems', () => {
  const vacation = getTemplate('vacation')!;

  it('materializes one dated item per template item', () => {
    const items = buildPlanItems(vacation, '2026-08-01');
    expect(items).toHaveLength(vacation.items.length);
  });

  it('computes due dates from the event date + offset', () => {
    const items = buildPlanItems(vacation, '2026-08-01');
    const bookTravel = items.find((i) => i.title.startsWith('Book travel'))!;
    expect(bookTravel.due_on).toBe(addDays('2026-08-01', -45)); // -45 offset
  });

  it('returns items in chronological order with sequential sort', () => {
    const items = buildPlanItems(vacation, '2026-08-01');
    for (let i = 1; i < items.length; i++) {
      expect(items[i].due_on >= items[i - 1].due_on).toBe(true);
      expect(items[i].sort).toBe(i);
    }
    expect(items[0].sort).toBe(0);
  });

  it('preserves notes (null when absent)', () => {
    const items = buildPlanItems(vacation, '2026-08-01');
    const packing = items.find((i) => i.title === 'Pack bags')!;
    expect(packing.note).toMatch(/packing list/i);
    const withoutNote = items.find((i) => i.note === null);
    expect(withoutNote).toBeDefined();
  });

  it('an after-event item (positive offset) lands after the event date', () => {
    const baby = getTemplate('new_baby')!;
    const items = buildPlanItems(baby, '2026-09-10');
    const announce = items.find((i) => i.title.startsWith('Send birth announcements'))!;
    expect(announce.due_on).toBe('2026-09-24'); // +14
  });
});
