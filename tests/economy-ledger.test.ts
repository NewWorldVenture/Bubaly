import { describe, it, expect } from 'vitest';
import {
  signedAmount, balanceFrom, canAfford, normalizeTokenAmount, normalizeEmoji, formatTokens,
} from '@/lib/economy/ledger';

describe('signedAmount', () => {
  it('signs by direction and truncates', () => {
    expect(signedAmount({ direction: 'credit', amount: 5 })).toBe(5);
    expect(signedAmount({ direction: 'debit', amount: 3 })).toBe(-3);
    expect(signedAmount({ direction: 'credit', amount: 2.9 })).toBe(2);
  });
});

describe('balanceFrom', () => {
  it('sums credits minus debits', () => {
    expect(balanceFrom([
      { direction: 'credit', amount: 10 },
      { direction: 'debit', amount: 4 },
      { direction: 'credit', amount: 1 },
    ])).toBe(7);
  });
  it('is 0 for empty/nullish', () => {
    expect(balanceFrom([])).toBe(0);
    // @ts-expect-error testing nullish tolerance
    expect(balanceFrom(null)).toBe(0);
  });
});

describe('canAfford', () => {
  it('requires a positive cost within balance', () => {
    expect(canAfford(10, 10)).toBe(true);
    expect(canAfford(10, 11)).toBe(false);
    expect(canAfford(10, 0)).toBe(false);
    expect(canAfford(10, -5)).toBe(false);
  });
});

describe('normalizeTokenAmount', () => {
  it('accepts positive integers, truncates, rejects junk', () => {
    expect(normalizeTokenAmount('5')).toBe(5);
    expect(normalizeTokenAmount(5.9)).toBe(5);
    expect(normalizeTokenAmount(0)).toBeNull();
    expect(normalizeTokenAmount(-3)).toBeNull();
    expect(normalizeTokenAmount('abc')).toBeNull();
  });
});

describe('normalizeEmoji', () => {
  it('falls back when empty', () => {
    expect(normalizeEmoji('')).toBe('⭐');
    expect(normalizeEmoji('  ', '🎁')).toBe('🎁');
  });
  it('keeps a short icon', () => {
    expect(normalizeEmoji('⭐')).toBe('⭐');
  });
});

describe('formatTokens', () => {
  it('renders amount + emoji', () => {
    expect(formatTokens(12, '⭐')).toBe('12 ⭐');
    expect(formatTokens(3.7, '🪙')).toBe('3 🪙');
  });
});
