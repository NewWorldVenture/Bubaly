// Informed-consent contribution preview (pure, unit-tested, DB-free).
//
// Before a family opts into the Intelligence Network, they should see EXACTLY what
// they'd contribute — and see that it's coarse enough to be anonymous. This turns a
// family's own signals into the same low-resolution buckets any future aggregation
// would use (age BANDS not birthdays, count BANDS not exact counts). It reads only
// the family's own data, is shown only to them, and nothing here is shared or
// stored — it's a transparency tool that makes consent meaningful.

export type ContributionInput = {
  /** Member birthdays (ISO date or null) — used only to derive coarse age bands. */
  memberBirthdays: (string | null)[];
  householdSize: number;
  /** Dinners planned in the coming week (0–7). */
  plannedDinnersPerWeek: number;
  /** Active activities (teams + classes). */
  activeActivities: number;
};

export type ContributionBucket = { label: string; value: string };

function ageBand(birthday: string, now: Date): string | null {
  const b = new Date(birthday);
  if (Number.isNaN(b.getTime())) return null;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  if (age < 0 || age > 120) return null;
  if (age <= 2) return '0–2';
  if (age <= 5) return '3–5';
  if (age <= 9) return '6–9';
  if (age <= 13) return '10–13';
  if (age <= 17) return '14–17';
  return 'adult';
}

function countBand(n: number): string {
  if (n <= 0) return 'none';
  if (n <= 2) return '1–2';
  if (n <= 4) return '3–4';
  return '5+';
}

function sizeBand(n: number): string {
  if (n <= 2) return '1–2';
  if (n <= 4) return '3–4';
  return '5+';
}

function dinnerBand(n: number): string {
  if (n <= 1) return 'rarely (0–1)';
  if (n <= 3) return 'sometimes (2–3)';
  if (n <= 5) return 'often (4–5)';
  return 'most nights (6–7)';
}

const CHILD_BAND_ORDER = ['0–2', '3–5', '6–9', '10–13', '14–17'];

/** Structured coarse features — the single source of truth for both the consent
 *  preview and the aggregation cohort key. All fields are bands, never raw values. */
export type ContributionFeatures = {
  childBands: string[];   // present child age bands, ordered (never counts)
  sizeBand: string;
  dinnerBand: string;
  activityBand: string;
};

export function contributionFeatures(input: ContributionInput, now: Date = new Date()): ContributionFeatures {
  const childBands = Array.from(new Set(
    input.memberBirthdays
      .filter((b): b is string => !!b)
      .map((b) => ageBand(b, now))
      .filter((band): band is string => band !== null && band !== 'adult'),
  )).sort((a, b) => CHILD_BAND_ORDER.indexOf(a) - CHILD_BAND_ORDER.indexOf(b));
  return {
    childBands,
    sizeBand: sizeBand(input.householdSize),
    dinnerBand: dinnerBand(input.plannedDinnersPerWeek),
    activityBand: countBand(input.activeActivities),
  };
}

/**
 * The coarse, anonymized buckets a family would contribute. Only child age bands
 * that are present are listed (never counts of individuals), and every numeric
 * signal is banded — nothing here can single out a household.
 */
export function computeContribution(input: ContributionInput, now: Date = new Date()): ContributionBucket[] {
  const f = contributionFeatures(input, now);
  const buckets: ContributionBucket[] = [];
  if (f.childBands.length) buckets.push({ label: 'Children in age bands', value: f.childBands.join(', ') });
  buckets.push({ label: 'Household size', value: f.sizeBand });
  buckets.push({ label: 'Dinner planning habit', value: f.dinnerBand });
  buckets.push({ label: 'Activities', value: f.activityBand });
  return buckets;
}
