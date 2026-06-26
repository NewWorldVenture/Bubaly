import { describe, it, expect } from 'vitest';
import {
  buildGiftAssistPrompt, parseGiftSuggestions, MIN_GIFT_CENTS, MAX_GIFT_CENTS,
} from '@/lib/wallet/gift-ai';

describe('buildGiftAssistPrompt', () => {
  const base = { childName: 'Mia', occasion: 'birthday', relationship: 'Grandma', goalTitle: null, goalSavedCents: null, goalTargetCents: null };

  it('includes the child name, occasion, and relationship', () => {
    const { user } = buildGiftAssistPrompt(base);
    expect(user).toContain('Mia');
    expect(user).toContain('a birthday');
    expect(user).toContain('Grandma');
  });

  it('mentions the savings goal when present', () => {
    const { user } = buildGiftAssistPrompt({ ...base, goalTitle: 'New bike', goalSavedCents: 2500, goalTargetCents: 10000 });
    expect(user).toContain('New bike');
    expect(user).toContain('$25');
    expect(user).toContain('$100');
  });

  it('falls back gracefully with no goal / no relationship', () => {
    const { user } = buildGiftAssistPrompt({ ...base, relationship: null });
    expect(user).toContain('a loving relative');
    expect(user).toContain('no goal shared');
  });

  it('always asks for JSON-only output', () => {
    const { system } = buildGiftAssistPrompt(base);
    expect(system).toMatch(/JSON only/i);
  });
});

describe('parseGiftSuggestions', () => {
  it('parses messages and converts whole-dollar amounts to cents', () => {
    const raw = '{"messages":["Happy birthday Mia!","Love you!"],"amounts":[10,25,50]}';
    const out = parseGiftSuggestions(raw);
    expect(out.messages).toEqual(['Happy birthday Mia!', 'Love you!']);
    expect(out.amountsCents).toEqual([1000, 2500, 5000]);
  });

  it('tolerates surrounding prose / code fences', () => {
    const raw = 'Here you go:\n```json\n{"messages":["Hi"],"amounts":[20]}\n```';
    const out = parseGiftSuggestions(raw);
    expect(out.messages).toEqual(['Hi']);
    expect(out.amountsCents).toEqual([2000]);
  });

  it('drops amounts outside the safe range and dedupes', () => {
    const raw = '{"messages":["x"],"amounts":[1,25,25,99999]}'; // $1 too low, $99999 too high, dup $25
    const out = parseGiftSuggestions(raw);
    expect(out.amountsCents).toEqual([2500]);
    expect(MIN_GIFT_CENTS).toBe(500);
    expect(MAX_GIFT_CENTS).toBe(50000);
  });

  it('caps to 3 messages and skips overly long ones', () => {
    const long = 'a'.repeat(400);
    const raw = JSON.stringify({ messages: ['one', 'two', long, 'four'], amounts: [] });
    const out = parseGiftSuggestions(raw);
    expect(out.messages).toEqual(['one', 'two', 'four']);
  });

  it('returns empty on garbage / no JSON', () => {
    expect(parseGiftSuggestions('no json here')).toEqual({ messages: [], amountsCents: [] });
    expect(parseGiftSuggestions('')).toEqual({ messages: [], amountsCents: [] });
  });

  it('handles missing fields safely', () => {
    expect(parseGiftSuggestions('{"messages":["hi"]}')).toEqual({ messages: ['hi'], amountsCents: [] });
    expect(parseGiftSuggestions('{"amounts":[10]}')).toEqual({ messages: [], amountsCents: [1000] });
  });
});
