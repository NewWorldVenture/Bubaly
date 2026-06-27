import { describe, expect, it } from 'vitest';
import {
  PET_SPECIES, CARE_KINDS, speciesMeta, careKindMeta,
  dayDiff, petAgeLabel, careUrgency, upcomingCare, careSummary,
  recommendedCare, SPECIES_CARE_PLAN, type CareRecordLike,
} from '@/lib/pets/care';

const TODAY = new Date('2026-06-24T12:00:00');

function rec(p: Partial<CareRecordLike> & { id: string; pet_id: string }): CareRecordLike {
  return { kind: 'vet_visit', title: 'Checkup', record_date: '2026-01-01', next_due: null, ...p };
}

describe('catalogs', () => {
  it('has 8 species and 6 care kinds', () => {
    expect(PET_SPECIES).toHaveLength(8);
    expect(CARE_KINDS).toHaveLength(6);
    expect(speciesMeta('dog').emoji).toBe('🐕');
    expect(careKindMeta('vaccination').label).toBe('Vaccination');
    expect(speciesMeta('nope' as never).value).toBe('other');
  });
});

describe('dayDiff', () => {
  it('counts whole days ignoring time', () => {
    expect(dayDiff('2026-06-24', '2026-06-25')).toBe(1);
    expect(dayDiff('2026-06-24', '2026-06-14')).toBe(-10);
  });
});

describe('petAgeLabel', () => {
  it('formats years and months', () => {
    expect(petAgeLabel('2023-04-24', TODAY)).toBe('3 yr 2 mo');
    expect(petAgeLabel('2025-04-24', TODAY)).toBe('1 yr 2 mo');
    expect(petAgeLabel('2025-06-24', TODAY)).toBe('1 yr'); // exact year → no months
  });
  it('shows months under a year and days under a month', () => {
    expect(petAgeLabel('2025-10-24', TODAY)).toBe('8 mo');
    expect(petAgeLabel('2026-06-20', TODAY)).toBe('4 days');
  });
  it('returns null for missing or future birthdays', () => {
    expect(petAgeLabel(null, TODAY)).toBeNull();
    expect(petAgeLabel('2030-01-01', TODAY)).toBeNull();
  });
});

describe('careUrgency', () => {
  it('classifies overdue / due soon / upcoming / ok', () => {
    expect(careUrgency('2026-06-20', TODAY)).toBe('overdue');
    expect(careUrgency('2026-06-30', TODAY)).toBe('due_soon');
    expect(careUrgency('2026-08-30', TODAY)).toBe('upcoming');
    expect(careUrgency(null, TODAY)).toBe('ok');
  });
});

describe('upcomingCare', () => {
  it('returns dated records soonest-first with urgency', () => {
    const records = [
      rec({ id: 'a', pet_id: 'p1', next_due: '2026-08-01', title: 'Vaccine' }),
      rec({ id: 'b', pet_id: 'p1', next_due: '2026-06-20', title: 'Meds' }),
      rec({ id: 'c', pet_id: 'p1', next_due: null }),
    ];
    const up = upcomingCare(records, TODAY);
    expect(up.map((u) => u.id)).toEqual(['b', 'a']); // c dropped (no due), b before a
    expect(up[0].urgency).toBe('overdue');
  });
});

describe('careSummary', () => {
  it('counts overdue and due-soon', () => {
    const records = [
      rec({ id: 'a', pet_id: 'p1', next_due: '2026-06-10' }), // overdue
      rec({ id: 'b', pet_id: 'p1', next_due: '2026-06-28' }), // due soon
      rec({ id: 'c', pet_id: 'p1', next_due: '2026-12-01' }), // upcoming
    ];
    const s = careSummary(2, records, TODAY);
    expect(s.pets).toBe(2);
    expect(s.overdue).toBe(1);
    expect(s.dueSoon).toBe(1);
    expect(s.text).toBe('1 overdue · 1 due soon');
  });
  it('handles no pets and all-up-to-date', () => {
    expect(careSummary(0, [], TODAY).text).toBe('No pets yet');
    expect(careSummary(1, [], TODAY).text).toBe('All care up to date');
  });
});

describe('recommendedCare', () => {
  it('flags overdue real records', () => {
    const recs = [rec({ id: 'a', pet_id: 'p1', kind: 'vaccination', title: 'Rabies booster', next_due: '2026-06-01' })];
    const out = recommendedCare({ id: 'p1', species: 'dog' }, recs, TODAY);
    const overdue = out.find((o) => o.title === 'Rabies booster');
    expect(overdue?.urgency).toBe('overdue');
    expect(overdue?.reason).toMatch(/Overdue by \d+ day/);
  });
  it('suggests standard species care with nothing on file', () => {
    const out = recommendedCare({ id: 'p1', species: 'dog' }, [], TODAY);
    // Dog plan has 3 standard items; none on file → all recommended.
    expect(out).toHaveLength(SPECIES_CARE_PLAN.dog.length);
    expect(out.every((o) => o.reason.includes('nothing on file'))).toBe(true);
  });
  it('does not re-suggest a care kind the pet already tracks', () => {
    const recs = [rec({ id: 'a', pet_id: 'p1', kind: 'vet_visit', title: 'Annual wellness exam', next_due: '2027-01-01' })];
    const out = recommendedCare({ id: 'p1', species: 'dog' }, recs, TODAY);
    expect(out.find((o) => o.kind === 'vet_visit' && o.reason.includes('nothing on file'))).toBeUndefined();
  });
});
