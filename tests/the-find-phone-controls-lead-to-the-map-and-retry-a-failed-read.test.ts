// Rendered CONTROL checks for components/family/find-phone-view.tsx.
//
// The real view on hook slots against the in-memory database, and the real
// page (app/(app)/dashboard/family/find-phone/page.tsx) for who reaches it.
// The view writes nothing: its four controls are two links to the Family Map,
// one link out to a map of a member's last position, and the retry on a failed
// read.
import { existsSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const boundary = vi.hoisted(() => ({
  role: 'parent',
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ redirect: boundary.redirect }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ active: { role: boundary.role, familyId: '0f0f0f0f-0000-4000-8000-000000000001' } }),
}));

const { FindPhoneView } = await import('@/components/family/find-phone-view');
const { default: FindPhonePage } = await import('@/app/(app)/dashboard/family/find-phone/page');

const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const ADA = '0a0a0a0a-0000-4000-8000-000000000001';
const BEN = '0a0a0a0a-0000-4000-8000-000000000002';
const SCHOOL = '0b0b0b0b-0000-4000-8000-000000000001';
let db: ReturnType<typeof createInMemorySupabase>;
const screen = () => render(h.hooks, createElement(FindPhoneView));

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = [];
  boundary.role = 'parent';
  boundary.redirect.mockClear();
  Object.assign(h.app, {
    familyId: FAMILY,
    members: [
      { id: ADA, display_name: 'Ada', role: 'parent', is_active: true, color: null },
      { id: BEN, display_name: 'Ben', role: 'child', is_active: true, color: null },
    ],
  });
  db.seed('family_places', [{ id: SCHOOL, family_id: FAMILY, name: 'School' }]);
  db.seed('member_locations', [{
    id: '0c0c0c0c-0000-4000-8000-000000000001', family_id: FAMILY, member_id: BEN, place_id: SCHOOL,
    latitude: 51.5, longitude: -0.12, battery: 80, is_sharing: true, address: null,
    updated_at: '2026-01-05T10:00:00.000Z',
  }]);
});

describe('who reaches Find Phone', () => {
  // lib/auth/guest-scope.ts:25 withholds the page from a guest; page.tsx:14 applies it.
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'])('a %s is given the view', async (role) => {
    boundary.role = role;
    const page = await FindPhonePage() as ReactElement;
    expect(page.type).toBe(FindPhoneView);
    expect(boundary.redirect).not.toHaveBeenCalled();
  });

  it('a guest is sent to their own landing page and is given no view', async () => {
    boundary.role = 'guest';
    await expect(FindPhonePage()).rejects.toThrow('redirect:/dashboard/grandparent-portal');
    expect(existsSync('app/(app)/dashboard/grandparent-portal/page.tsx')).toBe(true);
  });
});

describe('the Find Phone controls', () => {
  it('CONTROL-6B86C1637A20 the header link is named Family Map and opens the locator', () => {
    const tree = screen();
    const link = byName(tree, 'Family Map', 'a');
    expect(link.props.href).toBe('/dashboard/locator');
    expect(existsSync(`app/(app)${link.props.href as string}/page.tsx`)).toBe(true);
  });

  it('CONTROL-21774567F5B4 the footer link is named Location settings and opens the locator', () => {
    const tree = screen();
    expect(has(tree, "Location updates come from each member's device via the Family Map. Manage sharing in")).toBe(true);
    const link = byName(tree, 'Location settings', 'a');
    expect(link.props.href).toBe('/dashboard/locator');
    expect(existsSync(`app/(app)${link.props.href as string}/page.tsx`)).toBe(true);
  });

  it('CONTROL-9FD269D7C826 Open in Maps is offered only for a member with a position, and points at it', () => {
    const tree = screen();
    // Ada has no location row, Ben has coordinates: one link, Ben's.
    expect(has(tree, 'Ada')).toBe(true);
    expect(has(tree, 'School')).toBe(true);
    const links = allByName(tree, 'Open in Maps', 'a');
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe('https://maps.google.com/?q=51.5,-0.12');
    expect(links[0].props.target).toBe('_blank');
    expect(links[0].props.rel).toBe('noreferrer');

    // Without coordinates the link is gone, for every member.
    db.table('member_locations')[0].latitude = null;
    h.rows = {};
    expect(allByName(screen(), 'Open in Maps')).toEqual([]);
  });

  it('CONTROL-A959EE9BB6EC a failed read says so, and Try again re-reads both tables and shows the members', async () => {
    h.rows = { member_locations: [], family_places: [] };
    h.readErrors = { member_locations: 'permission denied' };
    let tree = screen();
    expect(text(tree)).toContain('Could not load phone locations. Refresh and try again.');
    expect(has(tree, 'Ben')).toBe(false);
    expect(allByName(tree, 'Open in Maps')).toEqual([]);

    await click(byName(tree, 'Try again', 'button'));
    expect([...h.refreshes].sort()).toEqual(['family_places', 'member_locations']);

    tree = screen();
    expect(has(tree, 'Could not load phone locations.')).toBe(false);
    expect(has(tree, 'Ben')).toBe(true);
    expect(allByName(tree, 'Open in Maps', 'a')).toHaveLength(1);
  });
});
