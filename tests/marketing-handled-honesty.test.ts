import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDLED_SAMPLE, SAMPLE_NOW, SAMPLE_WEEK, sampleBriefNumbers } from '@/lib/marketing/handled-sample';
import { HANDLED_PUBLIC_MIN, formatHandled, handledNote, meetsHandledFloor } from '@/lib/marketing/format';
import { buildFirstBrief } from '@/lib/onboarding/first-brief';

// The "Bubaly Handled" band mixes three kinds of evidence — real aggregates,
// an illustrative sample, and a live demo — and this file keeps them apart.
// Source-level, in the style of tests/header-safe-area.test.ts: the rules are
// about what the shipped files SAY, and a grep is the honest way to pin that.
const ledger = readFileSync('components/marketing/handled-ledger.tsx', 'utf8');
const sample = readFileSync('lib/marketing/handled-sample.ts', 'utf8');
const stats = readFileSync('lib/marketing/stats.ts', 'utf8');
const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), en[key] ?? key);

describe('illustrative elements are badged', () => {
  it('the ledger renders the sample badge in every sample card header', () => {
    expect(ledger).toContain('handledProof.sampleBadge');
    // Two cards — the brief and the ledger — each carry the badge.
    expect(ledger.match(/handledProof\.sampleBadge/g)?.length).toBeGreaterThanOrEqual(2);
    expect(ledger).toContain('handledProof.sampleNote');
    expect(en['handledProof.sampleBadge']).toBe('Illustrative sample');
  });
});

describe('the sample brief uses the composer for numbers and the catalogue for words', () => {
  it("never renders buildFirstBrief's own English sentence", () => {
    expect(ledger).not.toContain('brief.headline');
    expect(ledger).not.toContain('.headline');
    expect(sample).not.toContain('brief.headline');
    expect(sample).not.toContain('.headline');
    expect(ledger).toContain("t('handledProof.sampleBriefHeadline'");
  });

  it('computes three things today, one clash and a positive estimate from the sample week', () => {
    const numbers = sampleBriefNumbers();
    expect(numbers.today).toBe(3);
    expect(numbers.clashes).toBe(1);
    expect(numbers.minutes).toBeGreaterThan(0);
    expect(numbers.handled).toBe(HANDLED_SAMPLE.filter((r) => r.state === 'done').length);
    // The same composer the onboarding value step runs, with the same inputs.
    const brief = buildFirstBrief(SAMPLE_WEEK, new Date(SAMPLE_NOW));
    expect(brief.todayCount).toBe(numbers.today);
    expect(brief.conflicts).toHaveLength(numbers.clashes);
    expect(brief.timeSavedMinutes).toBe(numbers.minutes);
  });

  it('keeps the headline placeholders the composer fills', () => {
    for (const placeholder of ['{today}', '{clashes}', '{handled}']) {
      expect(en['handledProof.sampleBriefHeadline']).toContain(placeholder);
    }
  });
});

describe('the sample ledger shows honest states', () => {
  it('has five rows: three done, one waiting for a parent, one partly done', () => {
    expect(HANDLED_SAMPLE).toHaveLength(5);
    expect(HANDLED_SAMPLE.filter((r) => r.state === 'done')).toHaveLength(3);
    expect(HANDLED_SAMPLE.filter((r) => r.state === 'awaiting_ok').length).toBeGreaterThanOrEqual(1);
    expect(HANDLED_SAMPLE.filter((r) => r.state === 'partial').length).toBeGreaterThanOrEqual(1);
  });

  it('every row copies through the catalogue', () => {
    for (const row of HANDLED_SAMPLE) {
      expect(en[row.titleKey], row.titleKey).toBeTruthy();
      expect(en[row.detailKey], row.detailKey).toBeTruthy();
    }
  });

  it('a partial row is labelled partly done and steps are shown as done of total', () => {
    const partial = HANDLED_SAMPLE.find((r) => r.state === 'partial')!;
    expect(partial.steps).toBeTruthy();
    expect(partial.steps!.done).toBeLessThan(partial.steps!.total);
    expect(ledger).toContain("t('completedByBubaly.partlyDone')");
    expect(ledger).toContain('handledProof.stepsComplete');
    expect(ledger).toContain('handledProof.waitingForYourOk');
    for (const icon of ['CheckCircle2', 'Clock', 'AlertTriangle']) expect(ledger).toContain(icon);
  });

  it('the sample claims only actions the product performs, never a payment or a third-party confirmation', () => {
    const copy = HANDLED_SAMPLE.map((r) => `${en[r.titleKey]} ${en[r.detailKey]}`).join('\n');
    // The only "paid" in the sample is the fee that was flagged and NOT paid.
    expect(copy).toMatch(/not paid/);
    expect(copy.replace(/not paid/g, '')).not.toMatch(/\bpaid\b/i);
    expect(copy).not.toMatch(/\b(purchased|bought|ordered|cancelled the)\b/i);
    expect(copy).toMatch(/hasn't confirmed/);
  });
});

describe('real aggregates come from the RPC and hide below the threshold', () => {
  it('stats.ts reads public_handled_stats() and never the runs table', () => {
    expect(stats).toContain(".rpc('public_handled_stats')");
    expect(stats).not.toContain(".from('family_automation_runs')");
    expect(stats).toContain(".rpc('public_stats')");
  });

  it('handledNote is empty below HANDLED_PUBLIC_MIN', () => {
    expect(HANDLED_PUBLIC_MIN).toBe(25);
    expect(handledNote(t, 0)).toBe('');
    expect(handledNote(t, HANDLED_PUBLIC_MIN - 1)).toBe('');
    expect(handledNote(t, 24)).toBe('');
    expect(handledNote(t, HANDLED_PUBLIC_MIN)).not.toBe('');
    expect(meetsHandledFloor(24)).toBe(false);
    expect(meetsHandledFloor(25)).toBe(true);
  });

  it('handledNote never carries English of its own — the words are the catalogue key', () => {
    expect(handledNote(t, 25)).toBe(t('handledProof.aggregateNote', { count: '25' }));
    const format = readFileSync('lib/marketing/format.ts', 'utf8');
    expect(format).not.toContain('things finished by Bubaly');
  });

  it('formatHandled rounds like formatFamilies', () => {
    expect(formatHandled(999)).toBe('999');
    expect(formatHandled(12345)).toBe('12,000+');
  });

  it('the ledger renders each aggregate line only behind its formatter', () => {
    expect(ledger).toContain('handledNote(t, stats.handledCompleted)');
    expect(ledger).toContain('meetsHandledFloor(stats.handled30d)');
    expect(ledger).toContain('meetsHandledFloor(stats.tasksCompleted)');
    expect(ledger).toContain('stats.families > 0');
    expect(ledger).toContain('familiesNote(t, stats.families)');
    expect(ledger).toContain('aggregates.length > 0');
    // No aggregate sentence is typed in the component: every line is a
    // formatter result or a catalogue key with the formatted count.
    expect(ledger).not.toMatch(/\d+ things finished/);
    expect(ledger).not.toContain('registered families');
  });

  it('links the live demo and the Trust Center', () => {
    expect(ledger).toContain('href="/pricing#demo"');
    expect(ledger).toContain('href="/security#ai-trust"');
    expect(ledger).toContain('id="handled"');
  });
});
