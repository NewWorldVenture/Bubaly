import { describe, expect, it } from 'vitest';
import {
  analyzeBinder,
  buildBinderPrompt,
  parseBinderResponse,
  type BinderEntryLike,
} from '@/lib/home/binder-ai';

function entry(overrides: Partial<BinderEntryLike>): BinderEntryLike {
  return { category: 'other', label: 'Test', is_sensitive: false, ...overrides };
}

describe('analyzeBinder', () => {
  it('summarizes entries', () => {
    const r = analyzeBinder([
      entry({ category: 'wifi', label: 'Home Network' }),
      entry({ category: 'emergency', label: 'Fire dept', is_sensitive: false }),
      entry({ category: 'code', label: 'Garage code', is_sensitive: true }),
    ]);
    expect(r.totalEntries).toBe(3);
    expect(r.sensitiveCount).toBe(1);
    expect(r.summary).toContain('3 entries');
  });

  it('detects missing essential categories', () => {
    const r = analyzeBinder([entry({ category: 'wifi' })]);
    expect(r.missingCategories).toContain('emergency');
    expect(r.missingCategories).toContain('shutoff');
    expect(r.missingCategories).toContain('insurance');
    expect(r.missingCategories).not.toContain('wifi');
  });

  it('handles empty', () => {
    const r = analyzeBinder([]);
    expect(r.totalEntries).toBe(0);
    expect(r.summary).toContain('0 entries');
  });
});

describe('buildBinderPrompt', () => {
  it('builds prompt with entry info', () => {
    const { system, user } = buildBinderPrompt([entry({ category: 'wifi', label: 'Home Network' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Home Network');
    expect(user).toContain('wifi');
  });
});

describe('parseBinderResponse', () => {
  it('parses valid JSON', () => {
    const r = parseBinderResponse('{"suggestions":["add insurance"],"missingEntries":["vet info"],"organizationTip":"label clearly"}');
    expect(r.suggestions).toEqual(['add insurance']);
    expect(r.missingEntries).toEqual(['vet info']);
    expect(r.organizationTip).toBe('label clearly');
  });

  it('handles malformed input', () => {
    const r = parseBinderResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseBinderResponse('```json\n{"suggestions":["x"],"missingEntries":[],"organizationTip":"y"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
