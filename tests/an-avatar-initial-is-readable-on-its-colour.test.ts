import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { MEMBER_COLORS } from '@/lib/onboarding/draft';
import { contrastRatio, readableTextOn } from '@/lib/utils/readable-text';

// The signed-in phone crawl's most common axe failure after the shell's home
// link: the user menu's avatar drew white initials on the member's colour, and
// on #6366f1 (a colour members have) that is 4.46:1, under AA's 4.5:1.

describe('an avatar initial', () => {
  it('reads at AA on every colour the app hands a member, and on the one axe caught', () => {
    for (const color of [...MEMBER_COLORS, '#6366f1']) {
      const ratio = contrastRatio(readableTextOn(color), color);
      expect(ratio, color).not.toBeNull();
      expect(ratio!, color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps white where white already reads, and where the colour cannot be read', () => {
    expect(readableTextOn('#4338ca')).toBe('#ffffff');
    expect(readableTextOn('rgb(var(--brand))')).toBe('#ffffff');
    expect(readableTextOn(null)).toBe('#ffffff');
  });

  it('is drawn in that colour, not the fixed white', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Sam Parent', color: '#6366f1' }));
    expect(html).not.toContain('text-white');
    expect(html).toMatch(/color:\s*#000000/);
  });
});
