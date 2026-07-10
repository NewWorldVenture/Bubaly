import { describe, it, expect } from 'vitest';
import { validateResult } from '@/lib/guardian/scam-ai';
import type { ScamDetectionResult } from '@/lib/guardian/scam';

// AI-1: the scam classifier's structured output is strictly validated so a
// prompt-injected / malformed model response can never emit an arbitrary
// action, off-list scamType, or out-of-range confidence — it falls back to the
// deterministic pattern result instead.
const FALLBACK: ScamDetectionResult = {
  isScam: true, scamType: 'phishing', confidence: 55,
  signals: ['pattern: urgency'], recommendation: 'flag',
};

describe('validateResult (AI-1 output hardening)', () => {
  it('accepts a well-formed result', () => {
    const r = validateResult(
      { isScam: true, scamType: 'irs_scam', confidence: 92, signals: ['gift cards'], recommendation: 'block' },
      FALLBACK,
    );
    expect(r).toEqual({ isScam: true, scamType: 'irs_scam', confidence: 92, signals: ['gift cards'], recommendation: 'block' });
  });

  it('rejects an off-list recommendation (e.g. an injected action) → falls back', () => {
    const r = validateResult(
      { isScam: false, scamType: null, confidence: 0, signals: [], recommendation: 'transfer_all_funds' },
      FALLBACK,
    );
    expect(r.recommendation).toBe('flag'); // fallback, not the injected value
    expect(r.isScam).toBe(false); // the boolean itself is still honored
  });

  it('nulls an unknown scamType', () => {
    const r = validateResult({ isScam: true, scamType: 'make_me_admin', confidence: 70, recommendation: 'monitor' }, FALLBACK);
    expect(r.scamType).toBeNull();
  });

  it('clamps confidence into 0..100', () => {
    expect(validateResult({ isScam: true, confidence: 9999, recommendation: 'block' }, FALLBACK).confidence).toBe(100);
    expect(validateResult({ isScam: true, confidence: -5, recommendation: 'block' }, FALLBACK).confidence).toBe(0);
    expect(validateResult({ isScam: true, confidence: 'lots', recommendation: 'block' }, FALLBACK).confidence).toBe(0);
  });

  it('falls back entirely when isScam is missing or the shape is wrong', () => {
    expect(validateResult({ confidence: 80 }, FALLBACK)).toEqual(FALLBACK);
    expect(validateResult('not json', FALLBACK)).toEqual(FALLBACK);
    expect(validateResult(null, FALLBACK)).toEqual(FALLBACK);
  });

  it('drops non-string signals and caps the array', () => {
    const many = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const r = validateResult({ isScam: true, confidence: 50, signals: [...many, 42, null], recommendation: 'flag' }, FALLBACK);
    expect(r.signals.length).toBe(12);
    expect(r.signals.every((s) => typeof s === 'string')).toBe(true);
  });
});
