// lib/pets/care.ts — pure, deterministic pet-care engine.
//
// The AI-first differentiator for the Pet Manager is that it KNOWS what each
// species needs and surfaces the next thing due — overdue vaccinations, an
// upcoming annual checkup, a monthly flea treatment — grounded entirely in the
// family's own care records plus a standard per-species care plan. No data is
// fabricated; every recommendation restates a real record or a known cadence.

import type { PetSpecies, PetCareKind } from '@/lib/database.types';

export const PET_SPECIES: { value: PetSpecies; label: string; emoji: string }[] = [
  { value: 'dog', label: 'Dog', emoji: '🐕' },
  { value: 'cat', label: 'Cat', emoji: '🐈' },
  { value: 'bird', label: 'Bird', emoji: '🦜' },
  { value: 'fish', label: 'Fish', emoji: '🐠' },
  { value: 'reptile', label: 'Reptile', emoji: '🦎' },
  { value: 'small_mammal', label: 'Small mammal', emoji: '🐹' },
  { value: 'horse', label: 'Horse', emoji: '🐎' },
  { value: 'other', label: 'Other', emoji: '🐾' },
];

export const CARE_KINDS: { value: PetCareKind; label: string; emoji: string }[] = [
  { value: 'vaccination', label: 'Vaccination', emoji: '💉' },
  { value: 'vet_visit', label: 'Vet visit', emoji: '🩺' },
  { value: 'medication', label: 'Medication', emoji: '💊' },
  { value: 'grooming', label: 'Grooming', emoji: '✂️' },
  { value: 'weight', label: 'Weight', emoji: '⚖️' },
  { value: 'other', label: 'Other', emoji: '🐾' },
];

export function speciesMeta(s: PetSpecies) {
  return PET_SPECIES.find((x) => x.value === s) ?? PET_SPECIES[PET_SPECIES.length - 1];
}
export function careKindMeta(k: PetCareKind) {
  return CARE_KINDS.find((x) => x.value === k) ?? CARE_KINDS[CARE_KINDS.length - 1];
}

/** Midnight-local for a date-only string or a Date (strips any time component). */
function dateOnly(v: string | Date): Date {
  if (typeof v === 'string') return new Date(`${v.slice(0, 10)}T00:00:00`);
  return new Date(v.getFullYear(), v.getMonth(), v.getDate());
}

/** Whole-day difference (b - a) on date-only values, ignoring time + tz noise. */
export function dayDiff(a: string | Date, b: string | Date): number {
  return Math.round((dateOnly(b).getTime() - dateOnly(a).getTime()) / 86_400_000);
}

/** A friendly age label from a birthday, e.g. "3 yr 2 mo" or "8 mo" or "5 days". */
export function petAgeLabel(birthday: string | null | undefined, today: Date = new Date()): string | null {
  if (!birthday) return null;
  const b = new Date(`${birthday.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(b.getTime()) || b > today) return null;
  let months = (today.getFullYear() - b.getFullYear()) * 12 + (today.getMonth() - b.getMonth());
  if (today.getDate() < b.getDate()) months -= 1;
  if (months < 1) {
    const days = Math.max(0, dayDiff(b, today));
    return days <= 1 ? 'Newborn' : `${days} days`;
  }
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${months} mo`;
  return rem === 0 ? `${years} yr` : `${years} yr ${rem} mo`;
}

export type CareUrgency = 'overdue' | 'due_soon' | 'upcoming' | 'ok';

/** Classify a next-due date relative to today. due_soon = within 14 days. */
export function careUrgency(nextDue: string | null | undefined, today: Date = new Date(), soonDays = 14): CareUrgency {
  if (!nextDue) return 'ok';
  const d = dayDiff(today, nextDue);
  if (d < 0) return 'overdue';
  if (d <= soonDays) return 'due_soon';
  return 'upcoming';
}

export interface CareRecordLike {
  id: string;
  pet_id: string;
  kind: PetCareKind;
  title: string;
  record_date: string;
  next_due: string | null;
}

export interface UpcomingCareItem {
  id: string;
  petId: string;
  kind: PetCareKind;
  title: string;
  nextDue: string;
  urgency: CareUrgency;
  daysUntil: number;
}

/** All records that have a next-due date, soonest first, with urgency tags. */
export function upcomingCare(records: readonly CareRecordLike[], today: Date = new Date()): UpcomingCareItem[] {
  return records
    .filter((r) => r.next_due)
    .map((r) => ({
      id: r.id, petId: r.pet_id, kind: r.kind, title: r.title,
      nextDue: r.next_due as string,
      urgency: careUrgency(r.next_due, today),
      daysUntil: dayDiff(today, r.next_due as string),
    }))
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

export interface CareSummary {
  pets: number;
  overdue: number;
  dueSoon: number;
  text: string;
}

/** A short household pet-care summary. */
export function careSummary(petCount: number, records: readonly CareRecordLike[], today: Date = new Date()): CareSummary {
  const up = upcomingCare(records, today);
  const overdue = up.filter((u) => u.urgency === 'overdue').length;
  const dueSoon = up.filter((u) => u.urgency === 'due_soon').length;
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (dueSoon > 0) parts.push(`${dueSoon} due soon`);
  const text = petCount === 0
    ? 'No pets yet'
    : parts.length
      ? `${parts.join(' · ')}`
      : 'All care up to date';
  return { pets: petCount, overdue, dueSoon, text };
}

/**
 * Standard recurring care cadences per species (months). Drives recommendations
 * for care a pet has NO record of yet — the "knows what each pet needs" engine.
 */
export const SPECIES_CARE_PLAN: Record<PetSpecies, { kind: PetCareKind; title: string; everyMonths: number }[]> = {
  dog:          [{ kind: 'vet_visit', title: 'Annual wellness exam', everyMonths: 12 }, { kind: 'vaccination', title: 'Rabies booster', everyMonths: 12 }, { kind: 'medication', title: 'Flea & tick prevention', everyMonths: 1 }],
  cat:          [{ kind: 'vet_visit', title: 'Annual wellness exam', everyMonths: 12 }, { kind: 'vaccination', title: 'FVRCP booster', everyMonths: 12 }, { kind: 'medication', title: 'Flea prevention', everyMonths: 1 }],
  bird:         [{ kind: 'vet_visit', title: 'Avian wellness check', everyMonths: 12 }],
  fish:         [{ kind: 'other', title: 'Water quality check', everyMonths: 1 }],
  reptile:      [{ kind: 'vet_visit', title: 'Reptile wellness check', everyMonths: 12 }],
  small_mammal: [{ kind: 'vet_visit', title: 'Wellness check', everyMonths: 12 }],
  horse:        [{ kind: 'vet_visit', title: 'Annual wellness exam', everyMonths: 12 }, { kind: 'vaccination', title: 'Core vaccinations', everyMonths: 12 }, { kind: 'grooming', title: 'Farrier / hoof trim', everyMonths: 2 }],
  other:        [{ kind: 'vet_visit', title: 'Annual wellness check', everyMonths: 12 }],
};

export interface CareRecommendation {
  petId: string;
  kind: PetCareKind;
  title: string;
  reason: string;
  urgency: CareUrgency;
}

/**
 * Deterministic per-pet care recommendations. Combines (a) real records whose
 * next_due is overdue/soon, and (b) standard species care the pet has no record
 * of at all. Never invents specifics — (b) only ever says "no X on file yet".
 */
export function recommendedCare(
  pet: { id: string; species: PetSpecies },
  records: readonly CareRecordLike[],
  today: Date = new Date(),
): CareRecommendation[] {
  const mine = records.filter((r) => r.pet_id === pet.id);
  const out: CareRecommendation[] = [];

  // (a) Overdue / due-soon scheduled care from real records.
  for (const u of upcomingCare(mine, today)) {
    if (u.urgency === 'overdue' || u.urgency === 'due_soon') {
      out.push({
        petId: pet.id, kind: u.kind, title: u.title, urgency: u.urgency,
        reason: u.urgency === 'overdue'
          ? `Overdue by ${Math.abs(u.daysUntil)} day${Math.abs(u.daysUntil) === 1 ? '' : 's'}`
          : `Due in ${u.daysUntil} day${u.daysUntil === 1 ? '' : 's'}`,
      });
    }
  }

  // (b) Standard species care with no record on file.
  const haveKinds = new Set(mine.map((r) => `${r.kind}:${r.title.toLowerCase()}`));
  const haveKindOnly = new Set(mine.map((r) => r.kind));
  for (const plan of SPECIES_CARE_PLAN[pet.species] ?? []) {
    const exactlyTracked = haveKinds.has(`${plan.kind}:${plan.title.toLowerCase()}`);
    if (!exactlyTracked && !haveKindOnly.has(plan.kind)) {
      out.push({
        petId: pet.id, kind: plan.kind, title: plan.title, urgency: 'upcoming',
        reason: 'Recommended care — nothing on file yet',
      });
    }
  }
  return out;
}
