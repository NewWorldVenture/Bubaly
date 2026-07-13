import { describe, expect, it } from 'vitest';
import { isNextScreeningTurn } from '@/lib/guardian/screening-turn';

describe('guardian screening turn ordering', () => {
  it('accepts only the next bounded turn', () => {
    expect(isNextScreeningTurn(0, 1)).toBe(true);
    expect(isNextScreeningTurn(2, 3)).toBe(true);
    expect(isNextScreeningTurn(2, 2)).toBe(false);
    expect(isNextScreeningTurn(2, 4)).toBe(false);
    expect(isNextScreeningTurn(5, 6)).toBe(false);
    expect(isNextScreeningTurn(0, Number.NaN)).toBe(false);
  });
});
