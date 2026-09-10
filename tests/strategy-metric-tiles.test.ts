import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { StrategyMetricTiles } from '@/components/admin/strategy-metric-tiles';
import type { StrategyMetrics } from '@/lib/metric/strategy-server';
import { decisionCompression } from '@/lib/reasoning/engine';

const locales = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const catalogue = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(resolve('lib/i18n/messages', locale + '.json'), 'utf8'));
let messages: Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, values: Record<string, unknown> = {}) => {
    if (!messages[key]) throw new Error('Missing translation: ' + key);
    return messages[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? '{' + name + '}'));
  },
}));
beforeEach(() => {
  vi.stubGlobal('React', React);
  messages = catalogue('en-US');
});
afterEach(() => { vi.unstubAllGlobals(); });
const metrics = (over: Partial<StrategyMetrics> = {}): StrategyMetrics => ({
  rework: { terminal: 1, firstTimeRight: 1, reworked: 0, firstTimeRightRate: 1, reworkRate: 0 },
  compression: null, compressionRead: 'ok',
  conversion: { families: 4, recordedPaidActivations: 1, rate: 0.25, medianDays: 6, priorOnly: 1, missingEvidence: 2, ambiguousStatus: 0 },
  referrals: null, ...over,
});
const render = async (value: StrategyMetrics) => renderToStaticMarkup(await StrategyMetricTiles({ metrics: value }));

describe('strategy metric evidence on the admin report', () => {
  it('shows zero decisions without a fabricated per-decision ratio or handling claim', async () => {
    const html = await render(metrics({ compression: decisionCompression({ rawSignals: 10, humanDecisions: 0 }) }));
    expect(html).toContain('No recorded decisions');
    expect(html).toContain('10 signals, 0 decisions');
    expect(html).not.toContain('10 per decision');
    expect(html).not.toContain('absorbing most of the load');
    expect(html).toContain('These counts do not prove that work was handled');
  });
  it('shows an actual recorded ratio without inferring signal-to-decision causation', async () => {
    const html = await render(metrics({ compression: decisionCompression({ rawSignals: 10, humanDecisions: 2 }) }));
    expect(html).toContain('5 per decision');
    expect(html).toContain('10 signals, 2 decisions');
    expect(html).not.toContain('absorbing most of the load');
    expect(html).toContain('each signal needed a decision');
  });
  it('states the observed measure, recording delay, reactivation and coverage limitations', async () => {
    const html = await render(metrics());
    expect(html).toContain('Recorded paid activations after first value');
    expect(html).toContain('1 of 4 families past first value; median 6 days to the first qualifying record');
    expect(html).toContain('1 with only earlier records; 2 without dated evidence');
    expect(html).toContain('Includes reactivations');
    expect(html).toContain('not first payment');
    expect(html).toContain('best-effort and may be incomplete');
    expect(html).toContain('neither first-ever conversion nor causation');
    expect(html).toContain('last seven days');
    expect(html).toContain('not a database snapshot');
    expect(html).not.toContain('days to decide');
  });
  it('shows a failed billing read as unavailable with a real retry link', async () => {
    const html = await render(metrics({ conversion: null }));
    expect(html).toContain(messages['strategyMetrics.paidActivationReadFailed']);
    expect(html).toContain('href="/admin/reports"');
    expect(html).toContain('Try again');
    expect(html).not.toContain('1 of 4 families');
    expect(html).not.toContain('0 with only earlier records');
  });
  it('distinguishes absent first-value data from missing payment-date evidence', async () => {
    const empty = await render(metrics({
      conversion: { families: 0, recordedPaidActivations: 0, rate: null, medianDays: null, priorOnly: 0, missingEvidence: 0, ambiguousStatus: 0 },
    }));
    expect(empty).toContain('No family has reached first value yet');
    const unknown = await render(metrics({
      conversion: { families: 1, recordedPaidActivations: 0, rate: 0, medianDays: null, priorOnly: 0, missingEvidence: 1, ambiguousStatus: 0 },
    }));
    expect(unknown).toContain('0 of 1 families past first value');
    expect(unknown).toContain('1 without dated evidence');
    expect(unknown).not.toContain('No family has reached first value yet');
  });
  it('keeps uncertain current status visibly separate from missing date evidence', async () => {
    const html = await render(metrics({
      conversion: { families: 1, recordedPaidActivations: 0, rate: 0, medianDays: null, priorOnly: 0, missingEvidence: 0, ambiguousStatus: 1 },
    }));
    expect(html).toContain('1 first-value families have conflicting subscription records');
    expect(html).toContain('their current paid status is unknown');
    expect(html).toContain('0 without dated evidence');
  });
  it.each(locales)('renders translated evidence and methodology in %s', async (locale) => {
    messages = catalogue(locale);
    const html = await render(metrics());
    expect(html).toContain(messages['strategyMetrics.recordedPaidActivationsAfterValue']);
    expect(html).not.toContain('strategyMetrics.');
    expect(html).not.toMatch(/\{(?:recorded|families|days|prior|missing)\}/);
    const english = catalogue('en-US');
    for (const key of [
      'liveReadMethodology', 'paidActivationEvidence', 'paidActivationMethodology', 'paidActivationReadFailed', 'paidActivationAmbiguousStatus',
      'noRecordedDecisions', 'compressionEvidenceMethodology',
      'recordedPaidActivationCount', 'recordedPaidActivationMedian', 'recordedPaidActivationsAfterValue',
    ]) {
      const full = 'strategyMetrics.' + key;
      expect(messages[full].match(/\{\w+\}/g)?.sort() ?? []).toEqual(english[full].match(/\{\w+\}/g)?.sort() ?? []);
      if (locale !== 'en-US') expect(messages[full]).not.toBe(english[full]);
    }
  });
});
