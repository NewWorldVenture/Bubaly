import { describe, it, expect } from 'vitest';
import {
  PROFILE_QUESTIONS, nextQuestion, isAnswered, profileCompleteness, normalizeAnswer,
} from '@/lib/marketing/progressive-profile';

describe('isAnswered', () => {
  it('treats empty/null/[] as unanswered', () => {
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('   ')).toBe(false);
    expect(isAnswered([])).toBe(false);
    expect(isAnswered('parent')).toBe(true);
    expect(isAnswered(['meals'])).toBe(true);
    expect(isAnswered(4)).toBe(true);
  });
});

describe('nextQuestion', () => {
  it('asks the first unanswered field in order', () => {
    expect(nextQuestion({})?.field).toBe('role');
    expect(nextQuestion({ role: 'parent' })?.field).toBe('top_priority');
    expect(nextQuestion({ role: 'parent', top_priority: 'meals' })?.field).toBe('household_size');
  });

  it('skips fields the visitor dismissed', () => {
    expect(nextQuestion({ role: 'parent' }, ['top_priority'])?.field).toBe('household_size');
  });

  it('returns null once everything is answered', () => {
    const full = { role: 'parent', top_priority: 'meals', household_size: 4, child_ages: 'teen', interests: ['money'] };
    expect(nextQuestion(full)).toBeNull();
  });

  it('returns null when remaining fields are all skipped', () => {
    expect(nextQuestion({}, PROFILE_QUESTIONS.map((q) => q.field))).toBeNull();
  });
});

describe('profileCompleteness', () => {
  it('is the answered share (skips do not count)', () => {
    expect(profileCompleteness({})).toBe(0);
    expect(profileCompleteness({ role: 'parent' })).toBe(0.2);
    const full = { role: 'parent', top_priority: 'meals', household_size: 4, child_ages: 'teen', interests: ['money'] };
    expect(profileCompleteness(full)).toBe(1);
  });
});

describe('normalizeAnswer', () => {
  it('validates choice values against the options', () => {
    expect(normalizeAnswer('role', 'parent')).toBe('parent');
    expect(normalizeAnswer('role', 'astronaut')).toBeNull();
  });

  it('coerces household_size to a number', () => {
    expect(normalizeAnswer('household_size', '4')).toBe(4);
  });

  it('filters multi answers to allowed, de-duped values', () => {
    expect(normalizeAnswer('interests', ['meals', 'meals', 'nope', 'money'])).toEqual(['meals', 'money']);
    expect(normalizeAnswer('interests', [])).toBeNull();
    expect(normalizeAnswer('interests', ['nope'])).toBeNull();
  });

  it('rejects unknown fields', () => {
    expect(normalizeAnswer('bogus' as never, 'x')).toBeNull();
  });
});
