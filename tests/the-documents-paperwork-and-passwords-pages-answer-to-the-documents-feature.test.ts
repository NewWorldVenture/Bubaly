import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { FEATURE_CATALOG } from '@/lib/constants/feature-catalog';

// /dashboard/files/{cloud,shared,vault} open through
// `requireFeature('/dashboard/documents')`: a Documents feature the admin
// switched Off is a 404, a tier above the family's plan is the upgrade page,
// and a locked family (trial ended unpaid, account closed) is refused free
// features too (lib/server/feature-entitlement.ts).
//
// The File Manager (/dashboard/documents) is the Documents feature's own page,
// and the Paperwork Inbox and the Wi-Fi & Passwords vault are the same area
// (each steps up as `documents`). All three called `requireUserContext` only,
// so whatever the gate said, they opened: Documents "Off" still served the
// File Manager, and a closed account still read and uploaded there.
//
// Each page is driven for real. `requireFeature` refuses the way it does
// (by throwing its redirect), and the page must stop there.

const h = vi.hoisted(() => ({
  refused: null as string | null,
  features: [] as string[],
  steppedUp: [] as string[],
}));

const ctx = { user: { id: 'parent-user' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } } };

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ctx,
  requireFeature: async (key: string) => {
    h.features.push(key);
    if (h.refused === key) throw new Error(`NEXT_REDIRECT feature ${key}`);
    return ctx;
  },
}));
vi.mock('@/lib/auth/require-aal2', () => ({
  requireAal2: async (_ctx: unknown, _area: string, returnTo: string) => { h.steppedUp.push(returnTo); },
}));
vi.mock('@/lib/supabase/server', async () => {
  const { createInMemorySupabase } = await import('./helpers/in-memory-supabase');
  return { createServer: async () => createInMemorySupabase() };
});
vi.mock('@/components/modules/documents-module', () => ({ DocumentsModule: () => null }));
vi.mock('@/components/modules/passwords-module', () => ({ PasswordsModule: () => null }));
vi.mock('@/components/modules/paperwork-module', () => ({ PaperworkModule: () => null }));

const PAGES: [string, () => Promise<{ default: () => Promise<unknown> }>][] = [
  ['/dashboard/documents', () => import('@/app/(app)/dashboard/documents/page')],
  ['/dashboard/paperwork', () => import('@/app/(app)/dashboard/paperwork/page')],
  ['/dashboard/passwords', () => import('@/app/(app)/dashboard/passwords/page')],
];

beforeEach(() => {
  h.refused = null; h.features = []; h.steppedUp = [];
});

describe('the File Manager, the Paperwork Inbox and the passwords vault answer to the Documents feature', () => {
  it('gates on a key the catalog really has', () => {
    expect(FEATURE_CATALOG.some((feature) => feature.href === '/dashboard/documents')).toBe(true);
  });

  it.each(PAGES)('%s opens only when the Documents feature does', async (route, load) => {
    const { default: Page } = await load();
    h.refused = '/dashboard/documents';

    await expect(Page()).rejects.toThrow('NEXT_REDIRECT feature /dashboard/documents');
    // Refused at the door: the step-up is not asked for a page the family cannot open.
    expect(h.steppedUp).toEqual([]);
  });

  it.each(PAGES)('%s still opens for a family that has it, and still steps up', async (route, load) => {
    const { default: Page } = await load();

    const page = (await Page()) as ReactElement;
    expect(page).toBeTruthy();
    expect(h.features).toEqual(['/dashboard/documents']);
    expect(h.steppedUp).toEqual([route]);
  });
});
