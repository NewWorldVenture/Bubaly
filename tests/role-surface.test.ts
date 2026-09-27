import { describe, it, expect } from 'vitest';
import { roleSurface, roleGreeting, focusHeadline, focusChipClasses } from '@/lib/ui/role-surface';
import { getMessages, translate } from '@/lib/i18n/messages';

const en = (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params);
const fr = (key: string, params?: Record<string, string | number>) => translate(getMessages('fr-FR'), key, params);

describe('roleSurface', () => {
  it('gives parents/adults the full, manageable surface', () => {
    expect(roleSurface('parent')).toMatchObject({ density: 'comfortable', canManage: true, focusMax: 6 });
    expect(roleSurface('adult').canManage).toBe(true);
  });
  it('kids get a playful, trimmed, non-management surface', () => {
    const s = roleSurface('child');
    expect(s).toMatchObject({ density: 'playful', tone: 'kid', canManage: false });
    expect(s.focusMax).toBeLessThan(roleSurface('parent').focusMax);
  });
  it('teens sit between: casual, cozy, no management', () => {
    expect(roleSurface('teen')).toMatchObject({ density: 'cozy', tone: 'casual', canManage: false });
  });
  it('guests cannot manage', () => {
    expect(roleSurface('guest').canManage).toBe(false);
  });
  it('falls back to adult for null/unknown', () => {
    expect(roleSurface(null)).toEqual(roleSurface('adult'));
    expect(roleSurface(undefined)).toEqual(roleSurface('adult'));
  });
});

describe('roleGreeting', () => {
  it('is formal for parents', () => {
    expect(roleGreeting('parent', 'Jordan', 'morning', en)).toBe('Good morning, Jordan');
    expect(roleGreeting('parent', 'Jordan', 'night', en)).toBe('Good night, Jordan');
  });
  it('is casual for adults/teens', () => {
    expect(roleGreeting('teen', 'Liam', 'morning', en)).toBe('Morning, Liam');
    expect(roleGreeting('adult', 'Sam', 'evening', en)).toBe('Evening, Sam');
  });
  it('is playful with emoji for kids', () => {
    expect(roleGreeting('child', 'Mia', 'morning', en)).toContain('Good morning, Mia');
    expect(roleGreeting('child', 'Mia', 'morning', en)).toContain('☀️');
  });
  it('speaks the family\'s language, name and emoji in its word order', () => {
    expect(roleGreeting('parent', 'Jordan', 'morning', fr)).toBe('Bonjour Jordan');
    expect(roleGreeting('adult', '', 'midday', fr)).toBe('Salut la famille');
    expect(focusHeadline('child', fr)).toBe('C’est parti');
  });
  it('handles a blank name', () => {
    expect(roleGreeting('adult', '   ', 'morning', en)).toBe('Morning, there');
  });
});

describe('focusHeadline', () => {
  it('varies by role tone', () => {
    expect(focusHeadline('parent', en)).toBe('Focus now');
    expect(focusHeadline('teen', en)).toBe('Your focus');
    expect(focusHeadline('child', en)).toBe("Let's go");
  });
});

describe('focusChipClasses', () => {
  it('gives kids bigger, more tappable chips than adults', () => {
    const kid = focusChipClasses('child');
    const adult = focusChipClasses('parent');
    expect(kid.chip).toContain('py-3');
    expect(kid.chip).toContain('text-base');
    expect(kid.icon).toBe('h-5 w-5');
    expect(adult.chip).toContain('py-2');
    expect(adult.chip).toContain('text-sm');
    expect(adult.icon).toBe('h-4 w-4');
  });
  it('sizes each density distinctly (playful > cozy > comfortable)', () => {
    const playful = focusChipClasses('child').chip;   // playful
    const cozy = focusChipClasses('teen').chip;        // cozy
    const comfortable = focusChipClasses('parent').chip; // comfortable
    expect(new Set([playful, cozy, comfortable]).size).toBe(3);
  });
  it('falls back to the comfortable chip for null/unknown roles', () => {
    expect(focusChipClasses(null)).toEqual(focusChipClasses('adult'));
  });
});
