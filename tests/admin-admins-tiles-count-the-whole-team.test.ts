import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// /admin/admins tallied Total admins, Super admins, Admins, Pending
// invitations, the role donut and each role's "N user(s)" from its list, an
// unbounded read PostgREST answers with at most 1,000 rows and no error, so
// past them each was the list's count presented as the team's (coverage sweep
// round 9, class B). They are head:true counts now, and the list says when it
// holds only part of the team. The REAL page, in-memory database with
// PostgREST's 1,000-row cap.
const CAP = 1000;
const pad = (i: number) => String(i).padStart(6, '0');

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
// Client controls that reach for the router and server actions; they carry no number read here.
vi.mock('@/components/admin/admin-row-actions', () => ({ AdminRowActions: () => null }));
vi.mock('@/components/admin/invite-admin-button', () => ({ InviteAdminButton: () => null }));
vi.mock('@/components/admin/status-donut', () => ({
  StatusDonut: ({ total }: { total: number }) => createElement('div', { 'data-donut-total': total }),
}));

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const readError = SOURCE_MESSAGES['admins.couldNotLoadAdministratorsFrom'];
const admin = (k: number, role: string, status: string): Row => ({
  id: `adm-${pad(k)}`, email: `admin-${pad(k)}@example.com`, full_name: `Admin ${k}`, admin_role: role, status,
  // Higher k joined later.
  joined_at: new Date(Date.UTC(2025, 0, 1) + k * 60_000).toISOString(), last_active_at: null, permissions: [],
});
/** 1,200 admins: the 200 who joined FIRST are pending super administrators, the rest active viewers. */
function seedPastTheList() {
  db.seed('admin_users', [
    ...Array.from({ length: 200 }, (_, k) => admin(k, 'super_administrator', 'pending')),
    ...Array.from({ length: 1000 }, (_, k) => admin(200 + k, 'viewer', 'active')),
  ]);
}

async function render(tab?: string): Promise<string> {
  const { default: Page } = await import('@/app/(app)/admin/admins/page');
  return renderServerPage(await Page({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
}
const tile = (html: string, label: string) => new RegExp(`<p class="text-2xl font-black leading-none">([^<]*)</p><p class="mt-1 text-sm font-semibold">${label}</p>`).exec(html)?.[1];
const note = (shown: number, total: number) => m('adminCeiling.listAndFiltersShowTheNewest', { shown: shown.toLocaleString(), total: total.toLocaleString() });
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/admins past the 1,000 its list holds', () => {
  it('the tiles, the donut and the Roles tab count the whole team, and the list says it is part of it', async () => {
    seedPastTheList();
    const html = await render();
    expect(html).not.toContain(readError);
    expect(tile(html, m('admins.totalAdmins'))).toBe('1,200');
    expect(tile(html, m('admins.superAdmins'))).toBe('200');
    expect(tile(html, m('admins.pendingInvitations'))).toBe('200');
    expect(html).toContain('data-donut-total="1200"');
    expect(textOf(html)).toContain(note(1000, 1200));
    expect(textOf(await render('roles'))).toContain('Super Administrator');
    expect(textOf(await render('roles'))).toContain('200 user(s)');
  });

  it.each([
    ['the total', (calls: FaultCall[]) => head(calls) && !calls.some((c) => c.method === 'eq')],
    ['one role\'s count, super administrators', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[1] === 'super_administrator')],
    ['the pending count', (calls: FaultCall[]) => head(calls) && calls.some((c) => c.method === 'eq' && c.args[0] === 'status')],
  ])('a count that FAILS (%s) is the read-error state, not a tally of the list', async (_, failing) => {
    seedPastTheList();
    let faulted = 0;
    h.db = withFaults(db, (table, calls) => {
      if (table !== 'admin_users' || !failing(calls)) return null;
      faulted += 1;
      return { message: 'admin_users unavailable' };
    });
    const html = await render();
    expect(faulted).toBe(1);
    expect(html).toContain(readError);
    expect(html).not.toContain(m('admins.totalAdmins'));
  });

  it('the control: a team that fits the list is counted the same, and says nothing about part of it', async () => {
    db.seed('admin_users', [admin(1, 'super_administrator', 'active'), admin(2, 'administrator', 'pending'), admin(3, 'viewer', 'active')]);
    const html = await render();
    expect(tile(html, m('admins.totalAdmins'))).toBe('3');
    expect(tile(html, m('admins.superAdmins'))).toBe('1');
    expect(tile(html, m('admins.admins'))).toBe('1');
    expect(tile(html, m('admins.pendingInvitations'))).toBe('1');
    expect(textOf(html)).not.toContain(note(3, 3).slice(0, 30));
  });
});
