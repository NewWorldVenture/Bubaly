// X5 — decision compression: how many raw signals the engine absorbs per
// decision a person actually had to make.
import { describe, it, expect } from 'vitest';
import { decisionCompression } from '@/lib/reasoning/engine';
import enUS from '@/lib/i18n/messages/en-US.json';

describe('decisionCompression', () => {
  it('is null when there were no signals at all', () => {
    // A household with nothing to reason over has not demonstrated
    // compression, and "0:1" would be a claim about the product.
    expect(decisionCompression({ rawSignals: 0, humanDecisions: 0 })).toBeNull();
    expect(decisionCompression({ rawSignals: 0, humanDecisions: 4 })).toBeNull();
    expect(decisionCompression({ rawSignals: -3, humanDecisions: 1 })).toBeNull();
  });

  it('divides signals by decisions', () => {
    const c = decisionCompression({ rawSignals: 40, humanDecisions: 4 });
    expect(c?.ratio).toBe(10);
    expect(c?.rawSignals).toBe(40);
    expect(c?.humanDecisions).toBe(4);
  });

  it('handles a week where nothing had to be asked', () => {
    // Zero decisions with signals present is real and good, not a divide-by-zero.
    const c = decisionCompression({ rawSignals: 12, humanDecisions: 0 });
    expect(c?.ratio).toBe(12);
    expect(c?.level).toBe('high');
  });

  it('labels the three bands', () => {
    expect(decisionCompression({ rawSignals: 100, humanDecisions: 5 })?.level).toBe('high');
    expect(decisionCompression({ rawSignals: 10, humanDecisions: 3 })?.level).toBe('moderate');
    expect(decisionCompression({ rawSignals: 10, humanDecisions: 9 })?.level).toBe('low');
  });

  it('rounds the ratio to one decimal', () => {
    expect(decisionCompression({ rawSignals: 10, humanDecisions: 3 })?.ratio).toBe(3.3);
  });

  it('carries a catalogue key for every label it can produce', () => {
    const catalogue = enUS as Record<string, string>;
    for (const [signals, decisions] of [[100, 1], [10, 3], [10, 9]] as const) {
      const c = decisionCompression({ rawSignals: signals, humanDecisions: decisions });
      expect(c).not.toBeNull();
      expect(catalogue[c!.labelKey]).toBe(c!.label);
    }
  });

  it('truncates fractional inputs rather than inventing precision', () => {
    const c = decisionCompression({ rawSignals: 10.9, humanDecisions: 2.9 });
    expect(c?.rawSignals).toBe(10);
    expect(c?.humanDecisions).toBe(2);
  });
});
