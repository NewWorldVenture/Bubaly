import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { between, bodyOf } from './helpers/source-order';
import { ButtonLink } from '@/components/ui/button-link';

// A11Y-001: a Link with a Button as its child put a button inside a link.
// Interactive content inside <a> is invalid HTML, the keyboard met two tab
// stops for one action, and the button covered its own link: axe reported the
// 404 page's "Back to home" as a 9px target at 390 px. Those links are
// ButtonLink now, a link wearing Button's classes, so there is one control.

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** A link (Next's or a plain <a>) whose first child is a button, across line breaks. */
const WRAPPED = /<(Link|a)\b[^<>]*>\s*<(Button|button)\b/g;

// The one site left, on purpose: an auth surface, outside what this change
// touches. Listed by name so it is neither forgotten nor allowed to multiply;
// fixing it makes this entry stale, and the test then asks for it to go.
const LEFT = ['components/auth/join-invite.tsx'];

describe('a link is not wrapped around a button', () => {
  it('no link in the app or its components has a button as its child', () => {
    const found = new Set<string>();
    for (const file of [...sourceFiles('app'), ...sourceFiles('components')]) {
      if (WRAPPED.test(readFileSync(file, 'utf8'))) found.add(file);
      WRAPPED.lastIndex = 0;
    }
    expect([...found].sort()).toEqual(LEFT);
  });

  it('ButtonLink is one link, with no button inside it', () => {
    const html = renderToStaticMarkup(createElement(ButtonLink, { href: '/', variant: 'outline' }, 'Back to home'));
    expect(html).toMatch(/^<a [^>]*href="\/"[^>]*>Back to home<\/a>$/);
    expect(html).not.toContain('<button');
    expect(html).toContain('focus-ring');
  });

  it('ButtonLink looks exactly like Button: its copied classes equal Button’s', () => {
    const button = readFileSync('components/ui/button.tsx', 'utf8');
    const link = readFileSync('components/ui/button-link.tsx', 'utf8');
    for (const block of ['const VARIANTS', 'const SIZES']) {
      const strip = (src: string) => bodyOf(src, block, '};').replace(/\s+/g, ' ');
      expect(strip(link), block).toBe(strip(button));
    }
    const base = between(button, 'className={cn(', 'VARIANTS[variant]').match(/'([^']+)'/);
    expect(base, "Button's base classes").not.toBeNull();
    expect(link).toContain(`'${base![1]}'`);
  });
});
