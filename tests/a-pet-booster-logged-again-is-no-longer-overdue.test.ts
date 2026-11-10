// A pet's booster stays "overdue" after the family logs the new one.
//
// The care form's "Next due" field powers the Pets page's reminders. Every
// helper read `next_due` from EVERY care record the pet has ever had, so last
// year's "Rabies booster" (next due 2026-03-01) stayed in the list after this
// year's booster was logged (next due 2027-03-02). Care status kept saying
// "1 overdue", the pet's card said "Overdue", Upcoming care listed it and Care
// needs said "Overdue by N days", for good. The only way out was deleting the
// vaccination history.
//
// The latest record of a series (same pet, kind and title) is the one whose
// next-due date counts; the older ones are history.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';
import {
  upcomingCare, careSummary, recommendedCare, supersededCareIds, type CareRecordLike,
} from '@/lib/pets/care';

const TODAY = new Date('2026-06-24T12:00:00');

function rec(p: Partial<CareRecordLike> & { id: string }): CareRecordLike {
  return { pet_id: 'dog', kind: 'vaccination', title: 'Rabies booster', record_date: '2025-03-01', next_due: null, ...p };
}

const lastYear = rec({ id: 'old', record_date: '2025-03-01', next_due: '2026-03-01' });
const thisYear = rec({ id: 'new', record_date: '2026-03-02', next_due: '2027-03-02' });

describe('a booster logged again replaces the one it renews', () => {
  it('lists only the new booster in upcoming care', () => {
    const up = upcomingCare([lastYear, thisYear], TODAY);
    expect(up.map((u) => u.id)).toEqual(['new']);
    expect(up[0].urgency).toBe('upcoming');
  });

  it('does not count the renewed booster as overdue in Care status', () => {
    const s = careSummary(1, [thisYear, lastYear], TODAY);
    expect(s.overdue).toBe(0);
    expect(s.text).toBe('All care up to date');
  });

  it('does not put the renewed booster in Care needs', () => {
    const out = recommendedCare({ id: 'dog', species: 'dog' }, [lastYear, thisYear], TODAY);
    expect(out.find((o) => o.urgency === 'overdue')).toBeUndefined();
  });

  it('matches the title whatever its case and spacing', () => {
    const renewed = rec({ id: 'new', title: '  rabies   BOOSTER ', record_date: '2026-03-02', next_due: '2027-03-02' });
    expect(upcomingCare([lastYear, renewed], TODAY).map((u) => u.id)).toEqual(['new']);
  });

  it('answers a booster logged with no next date, too', () => {
    const renewed = rec({ id: 'new', record_date: '2026-03-02', next_due: null });
    expect(upcomingCare([lastYear, renewed], TODAY)).toEqual([]);
    expect(careSummary(1, [lastYear, renewed], TODAY).overdue).toBe(0);
  });

  it('names the replaced record so the history list can stop colouring it overdue', () => {
    expect([...supersededCareIds([lastYear, thisYear])]).toEqual(['old']);
  });
});

describe('what is not a renewal stays due', () => {
  it('keeps an overdue booster nobody has logged again', () => {
    const up = upcomingCare([lastYear], TODAY);
    expect(up.map((u) => u.id)).toEqual(['old']);
    expect(up[0].urgency).toBe('overdue');
  });

  it('keeps a different vaccination of the same pet', () => {
    const dhpp = rec({ id: 'dhpp', title: 'DHPP', record_date: '2025-05-01', next_due: '2026-05-01' });
    expect(upcomingCare([dhpp, thisYear], TODAY).map((u) => u.id)).toEqual(['dhpp', 'new']);
    expect(careSummary(1, [dhpp, thisYear], TODAY).overdue).toBe(1);
  });

  it('keeps the same title under a different kind', () => {
    const visit = rec({ id: 'visit', kind: 'vet_visit', record_date: '2025-03-01', next_due: '2026-03-01' });
    expect(upcomingCare([visit, thisYear], TODAY).map((u) => u.id)).toEqual(['visit', 'new']);
  });

  it("keeps another pet's booster", () => {
    const cat = rec({ id: 'cat', pet_id: 'cat', record_date: '2025-03-01', next_due: '2026-03-01' });
    expect(upcomingCare([cat, thisYear], TODAY).map((u) => u.id)).toEqual(['cat', 'new']);
    expect(supersededCareIds([cat, thisYear]).size).toBe(0);
  });

  it('keeps the later of two records logged on the same day', () => {
    const early = rec({ id: 'z', record_date: '2026-03-02', next_due: '2026-04-02' });
    const later = rec({ id: 'b', record_date: '2026-03-02', next_due: '2027-03-02' });
    expect(upcomingCare([early, later], TODAY).map((u) => u.id)).toEqual(['b']);
    expect(upcomingCare([later, early], TODAY).map((u) => u.id)).toEqual(['b']);
  });
});

describe("the pet's care history", () => {
  const src = readFileSync('components/modules/pets-module.tsx', 'utf8');
  const detail = src.slice(at(src, 'function PetDetail('));

  it('does not colour a replaced record overdue', () => {
    expect(detail).toContain('const replaced = supersededCareIds(records);');
    expect(detail).toContain("const u = replaced.has(r.id) ? 'ok' : careUrgency(r.next_due, familyToday);");
  });
});
