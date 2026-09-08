import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareLine, renderCompareLine, type CompareLineInput } from '@/lib/network/compare-line';
import type { NetworkAggregate } from '@/lib/network/aggregate';
import { K_ANONYMITY_FLOOR } from '@/lib/network/insights';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) =>
  (MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));

const COHORT = 'kids:6–9|size:3–4';
const agg = (metric: string, value: string, cohortSize: number, count = cohortSize, cohortKey = COHORT, scope: NetworkAggregate['scope'] = 'benchmarks'): NetworkAggregate =>
  ({ scope, cohortKey, metric, value, count, cohortSize });

const consenting: CompareLineInput = {
  consent: { enabled: true, scopes: { benchmarks: true } },
  cohortKey: COHORT,
  metrics: { dinner_habit: 'often (4–5)', reminders_per_week: '4–7' },
};

describe('compareLine — when it must say nothing', () => {
  const aggregates = [agg('dinner_habit', 'often (4–5)', 80, 83)];

  it('without consent, or without the benchmarks scope', () => {
    expect(compareLine({ ...consenting, consent: { enabled: false, scopes: { benchmarks: true } } }, aggregates)).toBeNull();
    expect(compareLine({ ...consenting, consent: { enabled: true, scopes: { timing: true } } }, aggregates)).toBeNull();
    expect(compareLine({ ...consenting, consent: { enabled: true, scopes: { benchmarks: false } } }, aggregates)).toBeNull();
  });

  it('when the family has not contributed yet (no cohort row)', () => {
    expect(compareLine({ ...consenting, cohortKey: null }, aggregates)).toBeNull();
  });

  it('when the only aggregates are another cohort’s, another scope’s, or under the floor', () => {
    expect(compareLine(consenting, [agg('dinner_habit', 'often (4–5)', 80, 83, 'kids:none|size:1–2')])).toBeNull();
    expect(compareLine(consenting, [agg('dinner_habit', 'often (4–5)', 80, 83, COHORT, 'timing')])).toBeNull();
    expect(compareLine(consenting, [agg('dinner_habit', 'often (4–5)', K_ANONYMITY_FLOOR - 1)])).toBeNull();
    expect(compareLine(consenting, [])).toBeNull();
  });

  it('when the noised count collapsed to zero — never "about 0 families"', () => {
    expect(compareLine(consenting, [agg('dinner_habit', 'often (4–5)', 40, 0)])).toBeNull();
  });

  it('when the family’s metrics do not overlap any published metric', () => {
    expect(compareLine({ ...consenting, metrics: { weekly_spend_band: 'under 100' } }, aggregates)).toBeNull();
  });

  it('when the metric is not in the catalogue, because it could not be named to a person', () => {
    expect(compareLine({ ...consenting, metrics: { mystery: 'x' } }, [agg('mystery', 'x', 60)])).toBeNull();
  });
});

describe('compareLine — when it speaks', () => {
  it('reports the family’s own band when it is the cohort’s most common one, with the NOISED count', () => {
    const line = compareLine(consenting, [
      agg('dinner_habit', 'often (4–5)', 80, 83),
      agg('dinner_habit', 'rarely (0–1)', 25, 24),
    ]);
    expect(line).toMatchObject({ metric: 'dinner_habit', familyValue: 'often (4–5)', cohortValue: 'often (4–5)', matches: true, count: 83, cohortSize: 80 });
    expect(line?.labelKey).toBe('network.metricDinnerPlanning');
    const text = renderCompareLine(line, t)!;
    expect(text).toContain('83');          // the DP-noised count is what a person reads
    expect(text).not.toContain('80');      // the true cohort size never leaves the pipeline
    expect(text).toContain('dinner planning');
    expect(text).toContain('same as you');
  });

  it('says where the majority sits when the family differs, naming both bands', () => {
    const line = compareLine({ ...consenting, metrics: { dinner_habit: 'rarely (0–1)' } }, [
      agg('dinner_habit', 'often (4–5)', 80, 83),
      agg('dinner_habit', 'rarely (0–1)', 25, 24),
    ]);
    expect(line).toMatchObject({ familyValue: 'rarely (0–1)', cohortValue: 'often (4–5)', matches: false, count: 83 });
    const text = renderCompareLine(line, t)!;
    expect(text).toContain('“often (4–5)”');
    expect(text).toContain('“rarely (0–1)”');
    expect(text).toContain('83');
  });

  it('prefers a metric the family shares with the majority, then the best-supported cohort', () => {
    const line = compareLine(consenting, [
      agg('dinner_habit', 'sometimes (2–3)', 200, 201),  // bigger, but the family differs
      agg('reminders_per_week', '4–7', 60, 61),           // smaller, but the family matches
    ]);
    expect(line?.metric).toBe('reminders_per_week');
    expect(line?.matches).toBe(true);

    const onlyDiffering = compareLine({ ...consenting, metrics: { dinner_habit: 'rarely (0–1)', reminders_per_week: 'none' } }, [
      agg('dinner_habit', 'sometimes (2–3)', 200, 201),
      agg('reminders_per_week', '4–7', 60, 61),
    ]);
    expect(onlyDiffering?.metric).toBe('dinner_habit'); // neither matches → the better-supported one
  });

  it('returns exactly one line however many metrics qualify', () => {
    const line = compareLine(consenting, [
      agg('dinner_habit', 'often (4–5)', 80, 83),
      agg('reminders_per_week', '4–7', 70, 70),
    ]);
    expect(line).not.toBeNull();
    expect(renderCompareLine(null, t)).toBeNull();
  });
});

describe('the weekly digest carries the line, and only from persisted state', () => {
  const route = readFileSync('app/api/cron/weekly-digest/route.ts', 'utf8');
  const email = readFileSync('lib/emails/weekly-digest.tsx', 'utf8');
  const loader = readFileSync('lib/network/compare-line-server.ts', 'utf8');

  it('the cron adds one line through the server loader and the pure renderer', () => {
    expect(route).toContain("import { loadCompareLine } from '@/lib/network/compare-line-server'");
    expect(route).toContain("import { renderCompareLine } from '@/lib/network/compare-line'");
    expect(route).toContain('compareLine: renderCompareLine(await loadCompareLine(supabase, family.id), t)');
  });

  it('the loader reads consent, the family’s own contribution row and the cohort aggregates — nothing raw', () => {
    expect(loader).toContain("from('network_consent')");
    expect(loader).toContain("from('network_contributions')");
    expect(loader).toContain("from('network_aggregates')");
    expect(loader).not.toMatch(/from\('(family_members|chores|chore_assignments|transactions|reminders|bedtime_routines)'\)/);
  });

  it('a failed read logs and yields no line rather than a made-up one', () => {
    expect(loader).toContain("console.error(`[network] compare line consent read failed");
    expect(loader).toContain("console.error(`[network] compare line contribution read failed");
    expect(loader).toContain("console.error(`[network] compare line aggregate read failed");
    expect((loader.match(/return null;/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('the email renders the line only when present, with the aggregation notice', () => {
    expect(email).toContain('compareLine?: string | null');
    expect(email).toContain('{compareLine && (');
    expect(email).toContain('Aggregated from consenting families; no family is identifiable.');
  });

  it('both sentences live in the catalogue with their placeholders', () => {
    expect(MESSAGES['network.compareLineSame']).toContain('{count}');
    expect(MESSAGES['network.compareLineSame']).toContain('{label}');
    expect(MESSAGES['network.compareLineSame']).toContain('{value}');
    expect(MESSAGES['network.compareLineDiffers']).toContain('{familyValue}');
  });
});
