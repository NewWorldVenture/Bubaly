import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computeContribution, contributionFeatures, choresPerChildBand, bedtimeBand, bedtimeToMinutes,
  weeklySpendBand, remindersBand, typicalWeeklySpend, bandFamilyLabelKey, bandLabelKey,
  METRIC_BAND_FAMILY, type BandFamily, type ContributionInput,
} from '@/lib/network/contribution';
import {
  BENCHMARK_METRICS, aggregateContributions, aggregatesToInsights, describeCohort, filterMetricsByScopes,
  metricLabel, metricLabelKey,
} from '@/lib/network/aggregate';
import { benchmarkRows, benchmarksCsv } from '@/lib/network/benchmarks';
import { compareLine, renderCompareLine } from '@/lib/network/compare-line';
import { featuresToContribution } from '@/lib/network/aggregate-server';

const NOW = new Date('2026-09-07T12:00:00Z');
const base: ContributionInput = { memberBirthdays: [], householdSize: 3, plannedDinnersPerWeek: 3, activeActivities: 1 };
const get = (bs: ReturnType<typeof computeContribution>, label: string) => bs.find((b) => b.label === label)?.value;

describe('chores per child band', () => {
  it('is null without children — the metric is not applicable, not "0"', () => {
    expect(choresPerChildBand(4, 0)).toBeNull();
    expect(choresPerChildBand(0, -1)).toBeNull();
  });
  it('bands the rounded ratio, never the raw counts', () => {
    expect(choresPerChildBand(0, 2)).toBe('none');
    expect(choresPerChildBand(1, 2)).toBe('1–2');   // 0.5 → rounds to 1 (round half up)
    expect(choresPerChildBand(3, 2)).toBe('1–2');   // 1.5 → 2
    expect(choresPerChildBand(5, 2)).toBe('3–5');   // 2.5 → 3
    expect(choresPerChildBand(10, 2)).toBe('3–5');
    expect(choresPerChildBand(11, 2)).toBe('6+');   // 5.5 → 6
    expect(choresPerChildBand(40, 3)).toBe('6+');
  });
  it('treats a negative open count as zero', () => {
    expect(choresPerChildBand(-3, 2)).toBe('none');
  });
});

describe('bedtime band', () => {
  it('parses Postgres time values and rejects garbage', () => {
    expect(bedtimeToMinutes('21:00:00')).toBe(1260);
    expect(bedtimeToMinutes('7:30')).toBe(450);
    expect(bedtimeToMinutes('25:00')).toBeNull();
    expect(bedtimeToMinutes('nope')).toBeNull();
    expect(bedtimeToMinutes(null)).toBeNull();
  });
  it('is null without any routine', () => {
    expect(bedtimeBand([])).toBeNull();
    expect(bedtimeBand([Number.NaN, -5, 1440])).toBeNull();
  });
  it('bands the hour on the lower median so one outlier cannot move it', () => {
    expect(bedtimeBand([18 * 60 + 30])).toBe('before 7pm');
    expect(bedtimeBand([19 * 60])).toBe('7–8pm');
    expect(bedtimeBand([19 * 60 + 59])).toBe('7–8pm');
    expect(bedtimeBand([20 * 60])).toBe('8–9pm');
    expect(bedtimeBand([21 * 60 + 15])).toBe('9–10pm');
    expect(bedtimeBand([22 * 60])).toBe('after 10pm');
    // two children at 20:00 and 20:30, one teen at 23:30 → median 20:30
    expect(bedtimeBand([23 * 60 + 30, 20 * 60, 20 * 60 + 30])).toBe('8–9pm');
    // even count → lower median (20:00, 21:30) → 20:00
    expect(bedtimeBand([21 * 60 + 30, 20 * 60])).toBe('8–9pm');
  });
  it('reads a bedtime after midnight as late evening, never as "before 7pm"', () => {
    expect(bedtimeBand([30])).toBe('after 10pm'); // 00:30
  });
});

describe('weekly spend band', () => {
  it('is null when spend is not tracked', () => {
    expect(weeklySpendBand(null)).toBeNull();
    expect(weeklySpendBand(undefined)).toBeNull();
    expect(weeklySpendBand(Number.NaN)).toBeNull();
  });
  it('bands amounts on their boundaries', () => {
    expect(weeklySpendBand(0)).toBe('none');
    expect(weeklySpendBand(99.99)).toBe('under 100');
    expect(weeklySpendBand(100)).toBe('100–250');
    expect(weeklySpendBand(249.99)).toBe('100–250');
    expect(weeklySpendBand(250)).toBe('250–500');
    expect(weeklySpendBand(500)).toBe('500–1,000');
    expect(weeklySpendBand(999.99)).toBe('500–1,000');
    expect(weeklySpendBand(1000)).toBe('1,000+');
  });
  it('smooths a trailing window into a weekly figure and is null with no expenses', () => {
    expect(typicalWeeklySpend([], 28)).toBeNull();
    expect(typicalWeeklySpend([100, 100, 100, 100], 28)).toBe(100);
    expect(typicalWeeklySpend([-50, 50], 7)).toBe(100); // sign-insensitive: expenses may be stored negative
  });
});

describe('reminders band', () => {
  it('bands counts on their boundaries', () => {
    expect(remindersBand(0)).toBe('none');
    expect(remindersBand(-2)).toBe('none');
    expect(remindersBand(1)).toBe('1–3');
    expect(remindersBand(3)).toBe('1–3');
    expect(remindersBand(4)).toBe('4–7');
    expect(remindersBand(7)).toBe('4–7');
    expect(remindersBand(8)).toBe('8–14');
    expect(remindersBand(14)).toBe('8–14');
    expect(remindersBand(15)).toBe('15+');
  });
});

describe('contributionFeatures / computeContribution with the four new metrics', () => {
  it('defaults the new inputs to "not applicable" so existing callers still get valid features', () => {
    const f = contributionFeatures(base, NOW);
    expect(f.choresPerChildBand).toBeNull();
    expect(f.bedtimeBand).toBeNull();
    expect(f.weeklySpendBand).toBeNull();
    expect(f.remindersBand).toBeNull();
    expect(contributionFeatures({ ...base, remindersPerWeek: 0 }, NOW).remindersBand).toBe('none');
  });

  it('previews exactly the bands that would be contributed — and omits what would not', () => {
    const withKids = computeContribution({
      ...base, memberBirthdays: ['2018-05-01', '1985-01-01'], householdSize: 3,
      childCount: 1, openChoreAssignments: 4, childBedtimeMinutes: [20 * 60 + 15],
      typicalWeeklySpend: 320, remindersPerWeek: 9,
    }, NOW);
    expect(get(withKids, 'Chores per child')).toBe('3–5');
    expect(get(withKids, 'Typical bedtime')).toBe('8–9pm');
    expect(get(withKids, 'Weekly spend')).toBe('250–500');
    expect(get(withKids, 'Reminders per week')).toBe('8–14');
    // every bucket carries a catalogue key so the UI renders it translated
    for (const b of withKids) expect(b.labelKey).toMatch(/^network\.bucket/);

    const noKids = computeContribution({ ...base, typicalWeeklySpend: null, remindersPerWeek: 0 }, NOW);
    expect(get(noKids, 'Chores per child')).toBeUndefined();
    expect(get(noKids, 'Typical bedtime')).toBeUndefined();
    expect(get(noKids, 'Weekly spend')).toBeUndefined();
    expect(get(noKids, 'Reminders per week')).toBe('none');
  });

  it('never carries a raw value into a bucket', () => {
    const buckets = computeContribution({
      ...base, childCount: 2, openChoreAssignments: 7, childBedtimeMinutes: [1234], typicalWeeklySpend: 731.5, remindersPerWeek: 11,
    }, NOW);
    const values = buckets.map((b) => b.value).join(' | ');
    expect(values).not.toContain('7');   // raw chores
    expect(values).not.toContain('1234');
    expect(values).not.toContain('731');
    expect(values).not.toContain('11');
  });
});

describe('featuresToContribution — the metric row that leaves the household', () => {
  it('emits the four new metrics under their catalogue keys, omitting the inapplicable ones', () => {
    const c = featuresToContribution('fam', {
      ...base, childCount: 2, openChoreAssignments: 3, childBedtimeMinutes: [21 * 60], typicalWeeklySpend: 80, remindersPerWeek: 2,
    }, NOW);
    expect(c.metrics).toEqual({
      dinner_habit: 'sometimes (2–3)', activities: '1–2', reminders_per_week: '1–3',
      chores_per_child: '1–2', bedtime_band: '9–10pm', weekly_spend_band: 'under 100',
    });
    const bare = featuresToContribution('fam', base, NOW);
    expect(Object.keys(bare.metrics).sort()).toEqual(['activities', 'dinner_habit']);
    expect(Object.keys(featuresToContribution('fam', { ...base, remindersPerWeek: 0 }, NOW).metrics)).toContain('reminders_per_week');
  });

  it('every emitted metric is in the catalogue, scoped to benchmarks, and consent-filtered like the originals', () => {
    const c = featuresToContribution('fam', {
      ...base, childCount: 1, openChoreAssignments: 1, childBedtimeMinutes: [20 * 60], typicalWeeklySpend: 10, remindersPerWeek: 1,
    }, NOW);
    for (const metric of Object.keys(c.metrics)) {
      const entry = BENCHMARK_METRICS.find((m) => m.key === metric);
      expect(entry, metric).toBeDefined();
      expect(entry!.scope).toBe('benchmarks');
      expect(metricLabelKey(metric)).toMatch(/^network\.metric/);
      expect(metricLabel(metric).length).toBeGreaterThan(0);
    }
    expect(filterMetricsByScopes(c.metrics, { timing: true })).toEqual({});
    expect(filterMetricsByScopes(c.metrics, { benchmarks: true })).toEqual(c.metrics);
  });
});

describe('aggregation of the new metrics under k-anonymity', () => {
  const family = (id: string, spend: number, bedtime: number) => featuresToContribution(id, {
    memberBirthdays: ['2018-05-01', '1985-01-01'], householdSize: 3, plannedDinnersPerWeek: 4, activeActivities: 1,
    childCount: 1, openChoreAssignments: 2, childBedtimeMinutes: [bedtime], typicalWeeklySpend: spend, remindersPerWeek: 5,
  }, NOW);

  it('publishes a band only once ≥ K distinct families back it, per metric', () => {
    // 120 families: 105 spend "100–250", 15 spend "1,000+" → the rare band is suppressed.
    const contributions = [
      ...Array.from({ length: 105 }, (_, i) => family(`a-${i}`, 150, 20 * 60)),
      ...Array.from({ length: 15 }, (_, i) => family(`b-${i}`, 5000, 20 * 60)),
    ];
    const agg = aggregateContributions(contributions);
    const spend = agg.filter((a) => a.metric === 'weekly_spend_band');
    expect(spend.map((a) => a.value)).toEqual(['100–250']);
    expect(spend[0].cohortSize).toBe(105);
    // the bedtime band is shared by all 120 → published with the full cohort
    const bed = agg.find((a) => a.metric === 'bedtime_band');
    expect(bed?.value).toBe('8–9pm');
    expect(bed?.cohortSize).toBe(120);
    for (const metric of ['chores_per_child', 'reminders_per_week']) {
      expect(agg.some((a) => a.metric === metric && a.scope === 'benchmarks')).toBe(true);
    }
  });

  it('maps every published row without a cohort filter, keeping ids unique across cohorts', () => {
    const agg = aggregateContributions(Array.from({ length: 120 }, (_, i) => family(`f-${i}`, 150, 21 * 60)));
    const all = aggregatesToInsights(agg, null);
    expect(all.length).toBe(agg.length);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    expect(all[0].id).toContain('kids:6–9|size:3–4');
    // the cohort-filtered form is unchanged for a family's own view
    expect(aggregatesToInsights(agg, 'kids:none|size:1–2')).toEqual([]);
  });
});

describe('the two insight sentences a family reads are catalogue keys', () => {
  const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  const page = readFileSync('app/(app)/dashboard/intelligence/page.tsx', 'utf8');
  const cohort = 'kids:6\u20139|size:3\u20134';
  const agg = aggregateContributions(Array.from({ length: 120 }, (_, i) => featuresToContribution(`f-${i}`, {
    memberBirthdays: ['2018-05-01', '1985-01-01'], householdSize: 3, plannedDinnersPerWeek: 4, activeActivities: 1,
    childCount: 1, openChoreAssignments: 2, childBedtimeMinutes: [21 * 60], typicalWeeklySpend: 150, remindersPerWeek: 5,
  }, NOW)));

  it('renders through the translator when the page passes one, metric label included', () => {
    const t = (key: string, params: Record<string, string | number> = {}) =>
      `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})`;
    const dinner = aggregatesToInsights(agg, cohort, t).find((i) => i.id.startsWith('dinner_habit:'));
    expect(dinner?.title).toBe('network.insightTitle(metric=network.metricDinnerPlanning())');
    // the BAND is a catalogue key too, not the stored English band
    expect(dinner?.detail).toBe('network.insightDetail(count=120,value=network.bandDinnerOften())');
  });

  it('falls back to the English wording when no translator is given', () => {
    const dinner = aggregatesToInsights(agg, cohort).find((i) => i.id.startsWith('dinner_habit:'));
    expect(dinner?.title).toBe('Families like yours: dinner planning');
    expect(dinner?.detail).toBe('About 120 similar families report \u201coften (4\u20135)\u201d.');
  });

  it('the intelligence page hands the translator in, and both keys carry their placeholders', () => {
    expect(page).toContain('aggregatesToInsights(aggregates, myCohort, t)');
    expect(MESSAGES['network.insightTitle']).toBe('Families like yours: {metric}');
    expect(MESSAGES['network.insightDetail']).toBe('About {count} similar families report \u201c{value}\u201d.');
  });
});

describe('describeCohort', () => {
  it('parses the two coarse dimensions and refuses anything else', () => {
    expect(describeCohort('kids:6–9.10–13|size:3–4')).toEqual({ childBands: ['6–9', '10–13'], sizeBand: '3–4' });
    expect(describeCohort('kids:none|size:1–2')).toEqual({ childBands: [], sizeBand: '1–2' });
    expect(describeCohort('zip:94110|size:3–4')).toBeNull();
    expect(describeCohort('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The BAND a reader sees is a catalogue key too.
//
// The metric LABELS were given catalogue keys first, and the VALUES were not —
// so a German reader got "Etwa 84 Familien geben „most nights (6–7)“ an" on a
// public, indexed marketing page. These tests pin the other half: every band
// this code can emit resolves to a key, that key exists in all seven
// catalogues, and no render site interpolates the stored English band.
// ---------------------------------------------------------------------------
describe('every band a reader sees is a catalogue key, in every locale', () => {
  const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
  const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [
    l, JSON.parse(readFileSync(`lib/i18n/messages/${l}.json`, 'utf8')) as Record<string, string>,
  ])) as Record<(typeof LOCALES)[number], Record<string, string>>;
  const translator = (locale: (typeof LOCALES)[number]) =>
    (key: string, params: Record<string, string | number> = {}) =>
      (CATALOGUES[locale][key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));

  /** Every band string the pure banding functions can produce, swept, not listed. */
  const emitted = () => {
    const bands = { age: new Set<string>(), size: new Set<string>(), activities: new Set<string>(),
      dinner: new Set<string>(), chores: new Set<string>(), bedtime: new Set<string>(),
      spend: new Set<string>(), reminders: new Set<string>() };
    for (let n = 0; n <= 40; n++) {
      const f = contributionFeatures({ ...base, householdSize: n, plannedDinnersPerWeek: n, activeActivities: n,
        childCount: 2, openChoreAssignments: n, remindersPerWeek: n }, NOW);
      bands.size.add(f.sizeBand);
      bands.dinner.add(f.dinnerBand);
      bands.activities.add(f.activityBand);
      if (f.choresPerChildBand) bands.chores.add(f.choresPerChildBand);
      if (f.remindersBand) bands.reminders.add(f.remindersBand);
    }
    for (let minutes = 0; minutes < 1440; minutes += 5) {
      const b = bedtimeBand([minutes]);
      if (b) bands.bedtime.add(b);
    }
    for (const amount of [0, 1, 99.99, 100, 249, 250, 499, 500, 999, 1000, 25_000]) {
      const b = weeklySpendBand(amount);
      if (b) bands.spend.add(b);
    }
    // Age bands come out of birthdays, so sweep ages 0-30 against a fixed NOW.
    for (let age = 0; age <= 30; age++) {
      const year = NOW.getUTCFullYear() - age;
      const f = contributionFeatures({ ...base, memberBirthdays: [`${year}-01-01`] }, NOW);
      for (const b of f.childBands) bands.age.add(b);
    }
    bands.age.add('adult'); // filtered out of childBands, but describeCohort can still carry it
    return bands;
  };

  it('maps every band the banding functions can emit to a key that exists in all seven catalogues', () => {
    const bands = emitted();
    const unmapped: string[] = [];
    const missing: string[] = [];
    for (const [family, values] of Object.entries(bands)) {
      expect(values.size, family).toBeGreaterThan(0);
      for (const value of values) {
        const key = bandFamilyLabelKey(family as BandFamily, value);
        if (!key) { unmapped.push(`${family}:${value}`); continue; }
        for (const locale of LOCALES) if (!CATALOGUES[locale][key]) missing.push(`${key} [${locale}]`);
      }
    }
    expect(unmapped).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('gives every published metric a band family, so a published row always has a key', () => {
    for (const m of BENCHMARK_METRICS) expect(METRIC_BAND_FAMILY[m.key], m.key).toBeDefined();
    const agg = aggregateContributions(Array.from({ length: 120 }, (_, i) => featuresToContribution(`f-${i}`, {
      memberBirthdays: ['2018-05-01', '1985-01-01'], householdSize: 3, plannedDinnersPerWeek: 6, activeActivities: 3,
      childCount: 1, openChoreAssignments: 4, childBedtimeMinutes: [22 * 60 + 30], typicalWeeklySpend: 700, remindersPerWeek: 20,
    }, NOW)));
    expect(agg.length).toBeGreaterThan(0);
    for (const a of agg) {
      expect(bandLabelKey(a.metric, a.value), `${a.metric}=${a.value}`).not.toBeNull();
      expect(benchmarkRows([a])[0]?.valueKey, `${a.metric}=${a.value}`).not.toBeNull();
    }
  });

  it('renders no English band inside a German sentence — the failure this exists to stop', () => {
    const de = translator('de-DE');
    const agg = aggregateContributions(Array.from({ length: 120 }, (_, i) => featuresToContribution(`f-${i}`, {
      memberBirthdays: ['2018-05-01', '1985-01-01'], householdSize: 3, plannedDinnersPerWeek: 7, activeActivities: 1,
      childCount: 1, openChoreAssignments: 2, childBedtimeMinutes: [22 * 60 + 30], typicalWeeklySpend: 80, remindersPerWeek: 5,
    }, NOW)));
    const sentences = aggregatesToInsights(agg, null, de).map((i) => `${i.title} ${i.detail}`);
    expect(sentences.length).toBeGreaterThan(0);
    const ENGLISH_BANDS = ['most nights', 'rarely', 'sometimes (', 'often (', 'after 10pm', 'before 7pm', 'under 100', 'none'];
    for (const sentence of sentences) {
      for (const english of ENGLISH_BANDS) expect(sentence, sentence).not.toContain(english);
    }
    // and the German band actually arrived
    expect(sentences.join(' ')).toContain('fast jeden Abend (6–7)');
    expect(sentences.join(' ')).toContain('nach 22 Uhr');
    expect(sentences.join(' ')).toContain('unter 100');
  });

  it('translates both bands in the weekly digest line, not just the metric label', () => {
    const de = translator('de-DE');
    const cohort = 'kids:6–9|size:3–4';
    const aggregates = [
      { scope: 'benchmarks' as const, cohortKey: cohort, metric: 'dinner_habit', value: 'most nights (6–7)', count: 83, cohortSize: 80 },
    ];
    const line = compareLine({ consent: { enabled: true, scopes: { benchmarks: true } }, cohortKey: cohort,
      metrics: { dinner_habit: 'rarely (0–1)' } }, aggregates);
    const text = renderCompareLine(line, de)!;
    expect(text).toContain('fast jeden Abend (6–7)');
    expect(text).toContain('selten (0–1)');
    expect(text).not.toContain('most nights');
    expect(text).not.toContain('rarely');
  });

  it('shows the consent preview in the reader’s language, bands included', () => {
    const de = translator('de-DE');
    const buckets = computeContribution({
      ...base, memberBirthdays: ['2018-05-01', '1985-01-01'], householdSize: 3,
      childCount: 1, openChoreAssignments: 0, childBedtimeMinutes: [18 * 60], typicalWeeklySpend: 50, remindersPerWeek: 0,
    }, NOW);
    for (const b of buckets) {
      expect(b.valueBands.length, b.label).toBeGreaterThan(0);
      for (const v of b.valueBands) expect(v.labelKey, `${b.label}=${v.value}`).not.toBeNull();
    }
    const rendered = buckets.map((b) => b.valueBands.map((v) => de(v.labelKey!)).join(', '));
    expect(rendered).toContain('vor 19 Uhr');
    expect(rendered).toContain('unter 100');
    expect(rendered).toContain('keine');
    expect(rendered.join(' | ')).not.toContain('before 7pm');
    expect(rendered.join(' | ')).not.toContain('under 100');
  });

  it('no render site interpolates the stored English band', () => {
    const publicPage = readFileSync('app/(marketing)/resources/benchmarks/page.tsx', 'utf8');
    const adminPage = readFileSync('app/(app)/admin/benchmarks/page.tsx', 'utf8');
    const intelligenceModule = readFileSync('components/modules/intelligence-module.tsx', 'utf8');
    const aggregate = readFileSync('lib/network/aggregate.ts', 'utf8');
    const compare = readFileSync('lib/network/compare-line.ts', 'utf8');

    expect(publicPage).toContain('value: r.valueKey ? t(r.valueKey) : r.value');
    expect(publicPage).not.toContain('{ count: r.count, value: r.value }');
    expect(adminPage).toContain('{r.valueKey ? t(r.valueKey) : r.value}');
    expect(adminPage).not.toContain('font-medium">{r.value}<');
    expect(intelligenceModule).toContain('b.valueBands.map((v) => (v.labelKey ? t(v.labelKey) : v.value))');
    expect(aggregate).toContain("t('network.insightDetail', { count: a.count, value: bandLabel(a.metric, a.value, t) })");
    expect(compare).toContain('value: bandLabel(line.metric, line.cohortValue, t)');
    expect(compare).toContain('familyValue: bandLabel(line.metric, line.familyValue, t)');
  });

  it('keeps the English band as the PERSISTED value — no migration, only rendering changed', () => {
    const c = featuresToContribution('fam', {
      ...base, childCount: 1, openChoreAssignments: 0, childBedtimeMinutes: [18 * 60],
      typicalWeeklySpend: 50, remindersPerWeek: 0,
    }, NOW);
    // what leaves the household is still the English band the aggregation groups on
    expect(c.metrics.bedtime_band).toBe('before 7pm');
    expect(c.metrics.weekly_spend_band).toBe('under 100');
    expect(c.metrics.chores_per_child).toBe('none');
    // …and the CSV export, a machine artefact, keeps it too
    expect(benchmarksCsv([{ scope: 'benchmarks', cohortKey: 'kids:6–9|size:3–4', metric: 'bedtime_band',
      value: 'before 7pm', count: 42, cohortSize: 40 }], '2026-09-07T03:00:00.000Z')).toContain('before 7pm');
  });
});
