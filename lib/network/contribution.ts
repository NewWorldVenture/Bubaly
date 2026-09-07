// Informed-consent contribution preview (pure, unit-tested, DB-free).
//
// Before a family opts into the Intelligence Network, they should see EXACTLY what
// they'd contribute — and see that it's coarse enough to be anonymous. This turns a
// family's own signals into the same low-resolution buckets any future aggregation
// would use (age BANDS not birthdays, count BANDS not exact counts). It reads only
// the family's own data, is shown only to them, and nothing here is shared or
// stored — it's a transparency tool that makes consent meaningful.
//
// Every band here is the single source of truth for BOTH the consent preview and
// the nightly aggregation (aggregate-server.ts), so what a family is shown is,
// by construction, what leaves the household row — never a raw value.

export type ContributionInput = {
  /** Member birthdays (ISO date or null) — used only to derive coarse age bands. */
  memberBirthdays: (string | null)[];
  householdSize: number;
  /** Dinners planned in the coming week (0–7). */
  plannedDinnersPerWeek: number;
  /** Active activities (teams + classes). */
  activeActivities: number;
  /** Active members with a child/teen role — the denominator for chores per child. */
  childCount?: number;
  /** Open chore assignments (todo / in progress / submitted) held by children. */
  openChoreAssignments?: number;
  /** Children's target bedtimes from active bedtime routines, as minutes after midnight. */
  childBedtimeMinutes?: number[];
  /**
   * Typical weekly household spend in the family's own currency (major units), or
   * null when the family records no expenses at all — a family that does not use
   * the finance module contributes nothing for this metric rather than "0".
   */
  typicalWeeklySpend?: number | null;
  /** Reminders due in the coming 7 days; omit when not measured, and nothing is contributed for it. */
  remindersPerWeek?: number;
};

/** One band as a reader must see it: the stored English band plus its catalogue key. */
export type BandValue = { value: string; labelKey: string | null };

export type ContributionBucket = {
  label: string;
  labelKey: string;
  /** The stored English band(s), joined — the persisted value, never the rendered one. */
  value: string;
  /** The same bands, each with the catalogue key that renders it in the reader's language. */
  valueBands: BandValue[];
};

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

/**
 * Chores per child, banded. Null when the household has no children — "chores
 * per child" means nothing there, so the metric is simply not contributed.
 */
export function choresPerChildBand(openAssignments: number, childCount: number): string | null {
  if (!Number.isFinite(childCount) || childCount <= 0) return null;
  const perChild = Math.round(Math.max(0, openAssignments) / childCount);
  if (perChild <= 0) return 'none';
  if (perChild <= 2) return '1–2';
  if (perChild <= 5) return '3–5';
  return '6+';
}

/** 'HH:MM' or 'HH:MM:SS' (Postgres `time`) → minutes after midnight, or null when unparseable. */
export function bedtimeToMinutes(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Typical children's bedtime, banded to the hour. Uses the lower median of the
 * routines so one outlier cannot move the band; bedtimes after midnight (up to
 * 05:00) count as late-evening, never as "before 7pm". Null without routines.
 */
export function bedtimeBand(minutesList: number[]): string | null {
  const valid = minutesList
    .filter((m) => Number.isFinite(m) && m >= 0 && m < 1440)
    .map((m) => (m < 5 * 60 ? m + 1440 : m))
    .sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const median = valid[Math.floor((valid.length - 1) / 2)];
  if (median < 19 * 60) return 'before 7pm';
  if (median < 20 * 60) return '7–8pm';
  if (median < 21 * 60) return '8–9pm';
  if (median < 22 * 60) return '9–10pm';
  return 'after 10pm';
}

/** Weekly spend in the family's own currency, banded; null when spend is not tracked. */
export function weeklySpendBand(weekly: number | null | undefined): string | null {
  if (weekly === null || weekly === undefined || !Number.isFinite(weekly)) return null;
  if (weekly <= 0) return 'none';
  if (weekly < 100) return 'under 100';
  if (weekly < 250) return '100–250';
  if (weekly < 500) return '250–500';
  if (weekly < 1000) return '500–1,000';
  return '1,000+';
}

/** Reminders in a week, banded. */
export function remindersBand(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return 'none';
  if (n <= 3) return '1–3';
  if (n <= 7) return '4–7';
  if (n <= 14) return '8–14';
  return '15+';
}

/**
 * A smoothed "typical weekly spend" from expense amounts recorded over a trailing
 * window, or null when nothing was recorded — so a family that does not track
 * money contributes no spend band at all.
 */
export function typicalWeeklySpend(expenseAmounts: number[], windowDays: number): number | null {
  const amounts = expenseAmounts.filter((a) => Number.isFinite(a));
  if (amounts.length === 0) return null;
  const total = amounts.reduce((sum, a) => sum + Math.abs(a), 0);
  const weeks = Math.max(1, windowDays / 7);
  return total / weeks;
}


// ---------------------------------------------------------------------------
// THE BAND CATALOGUE
//
// Every band string this file can emit, with the catalogue key that renders it
// in the reader's language.
//
// The English band is the PERSISTED value: it is what sits in
// `network_contributions.metrics` and `network_aggregates.value`, and what the
// nightly aggregation groups on. It must never change, and nothing here changes
// it. What a READER sees is a different thing entirely, and it has to be
// translated — the public /resources/benchmarks page, the admin report, the
// consent preview and the weekly digest all interpolate a band into an already
// translated sentence, and „Etwa 84 Familien geben ‚most nights (6–7)‘ an“ is
// exactly the failure this catalogue exists to stop.
// ---------------------------------------------------------------------------

/** The families of bands this file emits. A metric's values come from exactly one. */
export type BandFamily = 'age' | 'size' | 'activities' | 'dinner' | 'chores' | 'bedtime' | 'spend' | 'reminders';

/** How the translator is called wherever a band is rendered. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

const NUMERIC = {
  none: 'network.bandNone',
  '0–2': 'network.band0to2',
  '1–2': 'network.band1to2',
  '1–3': 'network.band1to3',
  '3–4': 'network.band3to4',
  '3–5': 'network.band3to5',
  '4–7': 'network.band4to7',
  '5+': 'network.band5Plus',
  '6–9': 'network.band6to9',
  '6+': 'network.band6Plus',
  '8–14': 'network.band8to14',
  '10–13': 'network.band10to13',
  '14–17': 'network.band14to17',
  '15+': 'network.band15Plus',
} as const;

/**
 * value → catalogue key, per band family. Exhaustive by construction: every band
 * function above returns one of these strings and nothing else, and
 * tests/network-benchmark-bands.test.ts sweeps the whole input space to prove it.
 */
export const BAND_LABEL_KEYS: Record<BandFamily, Record<string, string>> = {
  age: {
    '0–2': NUMERIC['0–2'], '3–5': NUMERIC['3–5'], '6–9': NUMERIC['6–9'],
    '10–13': NUMERIC['10–13'], '14–17': NUMERIC['14–17'], adult: 'network.bandAdult',
  },
  size: { '1–2': NUMERIC['1–2'], '3–4': NUMERIC['3–4'], '5+': NUMERIC['5+'] },
  activities: { none: NUMERIC.none, '1–2': NUMERIC['1–2'], '3–4': NUMERIC['3–4'], '5+': NUMERIC['5+'] },
  dinner: {
    'rarely (0–1)': 'network.bandDinnerRarely',
    'sometimes (2–3)': 'network.bandDinnerSometimes',
    'often (4–5)': 'network.bandDinnerOften',
    'most nights (6–7)': 'network.bandDinnerMostNights',
  },
  chores: { none: NUMERIC.none, '1–2': NUMERIC['1–2'], '3–5': NUMERIC['3–5'], '6+': NUMERIC['6+'] },
  bedtime: {
    'before 7pm': 'network.bandBedtimeBefore7pm',
    '7–8pm': 'network.bandBedtime7to8pm',
    '8–9pm': 'network.bandBedtime8to9pm',
    '9–10pm': 'network.bandBedtime9to10pm',
    'after 10pm': 'network.bandBedtimeAfter10pm',
  },
  spend: {
    none: NUMERIC.none,
    'under 100': 'network.bandSpendUnder100',
    '100–250': 'network.bandSpend100to250',
    '250–500': 'network.bandSpend250to500',
    '500–1,000': 'network.bandSpend500to1000',
    '1,000+': 'network.bandSpend1000Plus',
  },
  reminders: {
    none: NUMERIC.none, '1–3': NUMERIC['1–3'], '4–7': NUMERIC['4–7'],
    '8–14': NUMERIC['8–14'], '15+': NUMERIC['15+'],
  },
};

/** Which family a PUBLISHED metric's values come from. Keys match BENCHMARK_METRICS. */
export const METRIC_BAND_FAMILY: Record<string, BandFamily> = {
  dinner_habit: 'dinner',
  activities: 'activities',
  chores_per_child: 'chores',
  bedtime_band: 'bedtime',
  weekly_spend_band: 'spend',
  reminders_per_week: 'reminders',
};

/** Catalogue key for one band of a known family, or null for a value we did not emit. */
export function bandFamilyLabelKey(family: BandFamily, value: string): string | null {
  return BAND_LABEL_KEYS[family][value] ?? null;
}

/** Catalogue key for a published metric's band, or null for a metric/value the catalogue does not know. */
export function bandLabelKey(metric: string, value: string): string | null {
  const family = METRIC_BAND_FAMILY[metric];
  return family ? bandFamilyLabelKey(family, value) : null;
}

/**
 * The band a reader sees. Falls back to the stored English only when this
 * catalogue does not know the value — a row written by an older aggregation, or
 * a metric added since. That is deliberate: an unknown band is still shown (the
 * number behind it is real), it simply cannot be translated, and the band test
 * pins that nothing this code EMITS can land in that branch.
 */
export function bandLabel(metric: string, value: string, t?: Translate): string {
  const key = bandLabelKey(metric, value);
  return key && t ? t(key) : value;
}

/** The same, for the age and household-size bands that describe a cohort. */
export function bandFamilyLabel(family: BandFamily, value: string, t?: Translate): string {
  const key = bandFamilyLabelKey(family, value);
  return key && t ? t(key) : value;
}

/** A list of bands from one family, described so a render site can translate each. */
function bandValues(family: BandFamily, values: string[]): BandValue[] {
  return values.map((value) => ({ value, labelKey: bandFamilyLabelKey(family, value) }));
}

const CHILD_BAND_ORDER = ['0–2', '3–5', '6–9', '10–13', '14–17'];

/** Structured coarse features — the single source of truth for both the consent
 *  preview and the aggregation cohort key. All fields are bands, never raw values.
 *  A null band means "not applicable / not tracked" and is not contributed. */
export type ContributionFeatures = {
  childBands: string[];   // present child age bands, ordered (never counts)
  sizeBand: string;
  dinnerBand: string;
  activityBand: string;
  choresPerChildBand: string | null;
  bedtimeBand: string | null;
  weeklySpendBand: string | null;
  remindersBand: string | null;
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
    choresPerChildBand: choresPerChildBand(input.openChoreAssignments ?? 0, input.childCount ?? 0),
    bedtimeBand: bedtimeBand(input.childBedtimeMinutes ?? []),
    weeklySpendBand: weeklySpendBand(input.typicalWeeklySpend ?? null),
    remindersBand: input.remindersPerWeek === undefined ? null : remindersBand(input.remindersPerWeek),
  };
}

/**
 * The coarse, anonymized buckets a family would contribute. Only child age bands
 * that are present are listed (never counts of individuals), and every numeric
 * signal is banded — nothing here can single out a household. A metric that does
 * not apply to the household (no children, no tracked spend) is omitted rather
 * than shown as a value, because it is not contributed either.
 */
export function computeContribution(input: ContributionInput, now: Date = new Date()): ContributionBucket[] {
  const f = contributionFeatures(input, now);
  const buckets: ContributionBucket[] = [];
  const push = (label: string, labelKey: string, family: BandFamily, values: string[]) =>
    buckets.push({ label, labelKey, value: values.join(', '), valueBands: bandValues(family, values) });
  if (f.childBands.length) push('Children in age bands', 'network.bucketChildrenInAgeBands', 'age', f.childBands);
  push('Household size', 'network.bucketHouseholdSize', 'size', [f.sizeBand]);
  push('Dinner planning habit', 'network.bucketDinnerPlanningHabit', 'dinner', [f.dinnerBand]);
  push('Activities', 'network.bucketActivities', 'activities', [f.activityBand]);
  if (f.choresPerChildBand !== null) push('Chores per child', 'network.bucketChoresPerChild', 'chores', [f.choresPerChildBand]);
  if (f.bedtimeBand !== null) push('Typical bedtime', 'network.bucketTypicalBedtime', 'bedtime', [f.bedtimeBand]);
  if (f.weeklySpendBand !== null) push('Weekly spend', 'network.bucketWeeklySpend', 'spend', [f.weeklySpendBand]);
  if (f.remindersBand !== null) push('Reminders per week', 'network.bucketRemindersPerWeek', 'reminders', [f.remindersBand]);
  return buckets;
}
