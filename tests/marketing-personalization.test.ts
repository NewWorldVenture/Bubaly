import { describe, expect, it } from 'vitest';
import {
  ruleMatches,
  matchSpecificity,
  resolveSlot,
  resolveVariant,
  type PersonalizationRule,
} from '@/lib/marketing/personalization';

describe('ruleMatches', () => {
  it('passes when unconstrained', () => {
    expect(ruleMatches({}, {})).toBe(true);
  });
  it('checks list constraints case-insensitively', () => {
    expect(ruleMatches({ source: ['Google'] }, { source: 'google' })).toBe(true);
    expect(ruleMatches({ source: ['google'] }, { source: 'bing' })).toBe(false);
    expect(ruleMatches({ source: ['google'] }, { source: null })).toBe(false);
  });
  it('checks returning, minSessions, segments, paths', () => {
    expect(ruleMatches({ returning: true }, { returning: true })).toBe(true);
    expect(ruleMatches({ returning: true }, { returning: false })).toBe(false);
    expect(ruleMatches({ minSessions: 3 }, { sessions: 5 })).toBe(true);
    expect(ruleMatches({ minSessions: 3 }, { sessions: 1 })).toBe(false);
    expect(ruleMatches({ segments: ['vip'] }, { segments: ['new', 'vip'] })).toBe(true);
    expect(ruleMatches({ segments: ['vip'] }, { segments: ['new'] })).toBe(false);
    expect(ruleMatches({ paths: ['/pricing'] }, { path: '/pricing/annual' })).toBe(true);
    expect(ruleMatches({ paths: ['/pricing'] }, { path: '/blog' })).toBe(false);
  });
  it('requires ALL constraints to hold', () => {
    expect(ruleMatches({ source: ['google'], returning: true }, { source: 'google', returning: false })).toBe(false);
  });
});

describe('matchSpecificity', () => {
  it('counts active constraints', () => {
    expect(matchSpecificity({})).toBe(0);
    expect(matchSpecificity({ source: ['g'], returning: true, minSessions: 2 })).toBe(3);
    expect(matchSpecificity({ source: [], minSessions: 0 })).toBe(0);
  });
});

const rules: PersonalizationRule[] = [
  { id: 'a', slot: 'home_hero', match: {}, variant: { headline: 'Default' }, priority: 0, status: 'active', created_at: '2026-01-01' },
  { id: 'b', slot: 'home_hero', match: { source: ['google'] }, variant: { headline: 'Hi Google' }, priority: 5, status: 'active', created_at: '2026-01-02' },
  { id: 'c', slot: 'home_hero', match: { source: ['google'], returning: true }, variant: { headline: 'WB Google' }, priority: 5, status: 'active', created_at: '2026-01-03' },
  { id: 'd', slot: 'home_hero', match: {}, variant: { headline: 'Paused' }, priority: 99, status: 'paused', created_at: '2026-01-04' },
];

describe('resolveSlot / resolveVariant', () => {
  it('ignores other slots and paused rules', () => {
    expect(resolveVariant(rules, 'pricing_cta', {})).toBeNull();
    expect(resolveVariant(rules, 'home_hero', {})?.headline).toBe('Default'); // d is paused
  });
  it('higher priority wins, then specificity', () => {
    // google + returning matches b and c (both priority 5) → c is more specific
    expect(resolveVariant(rules, 'home_hero', { source: 'google', returning: true })?.headline).toBe('WB Google');
    // google but not returning → only b matches (c needs returning)
    expect(resolveVariant(rules, 'home_hero', { source: 'google' })?.headline).toBe('Hi Google');
  });
  it('returns the rule from resolveSlot', () => {
    expect(resolveSlot(rules, 'home_hero', {})?.id).toBe('a');
  });
});
