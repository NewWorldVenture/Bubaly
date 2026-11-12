// components/brand/logo.tsx, rendered: the one control in it is the home link.
//
// The real Logo and the real IntentLink are driven with
// tests/helpers/module-harness.tsx; only next/link and next/image are replaced,
// by plain host elements that keep every prop.
//
// The logo is drawn for everyone: signed-out visitors (app/(auth)/layout.tsx,
// components/marketing/site-header.tsx), every signed-in role
// (components/app/app-shell.tsx) and admins (components/admin/admin-shell.tsx).
// It takes no role and reads no plan, and it writes nothing, so there is no
// role to refuse.
import { existsSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allByName, nodes, render, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/image', async () => {
  const { createElement: h2 } = await import('react');
  return { default: ({ src, alt }: { src: string; alt: string }) => h2('img', { src, alt }) };
});

const { Logo } = await import('@/components/brand/logo');
type LogoProps = Parameters<typeof Logo>[0];

const draw = (props: LogoProps = {}): ReactNode => render(h.hooks, createElement(Logo, props));
function homeLink(tree: ReactNode): Node {
  const links = nodes(tree).filter((n) => n.type === 'a');
  expect(links).toHaveLength(1);
  return links[0];
}

beforeEach(() => resetHookSlots(h.hooks));

describe('the logo', () => {
  it('CONTROL-ED557B428D83 is one link named "Bubaly home" whose default target is the landing page', () => {
    const tree = draw();
    const link = homeLink(tree);
    // named: the label is the catalogue's English, and it finds the link.
    expect(link.props['aria-label']).toBe('Bubaly home');
    expect(allByName(tree, 'Bubaly home', 'a')).toEqual([link]);
    // The wordmark inside it carries its own alternative text.
    const images = nodes(link).filter((n) => n.type === 'img');
    expect(images.map((n) => n.props.alt)).toEqual(['Bubaly']);
    // effective: it goes to "/", which is app/(marketing)/page.tsx.
    expect(link.props.href).toBe('/');
    expect(existsSync('app/(marketing)/page.tsx')).toBe(true);
  });

  it('CONTROL-ED557B428D83 goes where the shell that draws it says: /home for a signed-in member', () => {
    // components/app/app-shell.tsx:383 and components/admin/admin-shell.tsx:77.
    const link = homeLink(draw({ href: '/home', markVariant: 'home' }));
    expect(link.props.href).toBe('/home');
    expect(existsSync('app/(app)/home/page.tsx')).toBe(true);
    expect(link.props['aria-label']).toBe('Bubaly home');
  });

  it('CONTROL-ED557B428D83 keeps its name when only the mark is drawn', () => {
    const link = homeLink(draw({ showText: false }));
    expect(link.props['aria-label']).toBe('Bubaly home');
    // The mark is decorative: the link's own label is the only name.
    const images = nodes(link).filter((n) => n.type === 'img');
    expect(images.map((n) => n.props.alt)).toEqual(['']);
  });

  it('CONTROL-ED557B428D83 prefetches its page on intent, not on sight', () => {
    const before = homeLink(draw());
    expect(before.props.prefetch).toBe(false);
    (before.props.onMouseEnter as (event: unknown) => void)({});
    // null is Next's "auto": the link now prefetches as any other would.
    expect(homeLink(draw()).props.prefetch).toBeNull();
  });

  it('CONTROL-ED557B428D83 is a plain document link on the sign-in pages', () => {
    // app/(auth)/layout.tsx:20 asks for a full document navigation.
    const link = homeLink(draw({ documentNavigation: true }));
    expect(link.props.href).toBe('/');
    expect(link.props['aria-label']).toBe('Bubaly home');
    expect('prefetch' in link.props).toBe(false);
  });
});
