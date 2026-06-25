import { describe, it, expect } from 'vitest';
import { analyzeWallet, buildWalletPrompt, parseWalletResponse } from '../lib/wallet/wallet-ai';

const buckets = [
  { member_id: 'm1', bucket: 'save', balance_cents: 5000, target_cents: 10000 },
  { member_id: 'm1', bucket: 'spend', balance_cents: 3000, target_cents: null },
  { member_id: 'm1', bucket: 'give', balance_cents: 1000, target_cents: null },
  { member_id: 'm1', bucket: 'invest', balance_cents: 1000, target_cents: null },
];
const txns = [
  { member_id: 'm1', bucket: 'save', amount_cents: 500, kind: 'deposit', created_at: new Date().toISOString() },
];
const rules = [
  { bucket: 'save', pct: 50 },
  { bucket: 'spend', pct: 30 },
  { bucket: 'give', pct: 10 },
  { bucket: 'invest', pct: 10 },
];

describe('analyzeWallet', () => {
  it('produces analysis with total and breakdown', () => {
    const a = analyzeWallet(buckets, txns, 'm1');
    expect(a.totalBalance).toBe('$100.00');
    expect(a.bucketBreakdown).toHaveLength(4);
    expect(a.topBucket).toBe('Save');
    expect(a.goalsOnTrack).toBe(1);
  });
});

describe('buildWalletPrompt', () => {
  it('builds system + user prompt', () => {
    const analysis = analyzeWallet(buckets, txns, 'm1');
    const { system, user } = buildWalletPrompt(analysis, rules, 'Emma');
    expect(system).toContain('financial coach');
    expect(user).toContain('Emma');
    expect(user).toContain('$100.00');
  });
});

describe('parseWalletResponse', () => {
  it('parses valid JSON response', () => {
    const raw = '{"advice":"Great job saving!","suggestions":["Keep it up","Try investing"]}';
    const r = parseWalletResponse(raw);
    expect(r.advice).toBe('Great job saving!');
    expect(r.suggestions).toHaveLength(2);
  });

  it('handles wrapped JSON', () => {
    const raw = 'Here is your analysis:\n```json\n{"advice":"Good","suggestions":["A"]}\n```';
    const r = parseWalletResponse(raw);
    expect(r.advice).toBe('Good');
  });

  it('falls back to raw text on invalid JSON', () => {
    const r = parseWalletResponse('Just some plain text advice');
    expect(r.advice).toBe('Just some plain text advice');
    expect(r.suggestions).toEqual([]);
  });
});
