import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

const FAMILY = 'aaaaaaaa-0000-4000-8000-000000000001';
const FOREIGN = 'bbbbbbbb-0000-4000-8000-000000000001';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const h = vi.hoisted(() => ({
  db: null as SupabaseClient<Database> | null, role: 'parent', fail: false, contextCalls: 0,
  settings: { allow_child_customization: false, lock_to_family_default: false },
  calls: [] as { table: string; body: Record<string, unknown>; query: string }[],
  layouts: [] as Record<string, unknown>[], revalidated: [] as string[],
}));
// Authenticated context, tier and Next cache are inert boundaries. Actual
// exported actions, SDK query/response handling and the child layout gate run.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    h.contextCalls++;
    return { user: { id: USER }, active: { familyId: FAMILY, role: h.role } };
  },
  effectivePlanLevel: async (level: string) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 'plus' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => h.revalidated.push(path) }));
import { saveDashboardSettingsAction, saveDashboardLayoutAction } from '@/app/(app)/dashboard/customize-actions';

function db() {
  return createClient<Database>('https://dashboard-settings-fixture.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://dashboard-settings-fixture.invalid' || !url.pathname.startsWith('/rest/v1/')) {
        throw new Error('Unexpected fixture transport');
      }
      const table = url.pathname.split('/').at(-1)!, method = init?.method ?? 'GET', query = url.searchParams;
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status, headers: { 'content-type': 'application/json' },
      });
      if (method === 'GET') {
        if (table !== 'family_dashboard_settings' || query.get('family_id') !== `eq.${FAMILY}`
          || query.get('select') !== 'allow_child_customization,lock_to_family_default') throw new Error('Missing read scope');
        return json([h.settings]);
      }
      if (method !== 'POST') throw new Error('Unexpected mutation');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      h.calls.push({ table, body, query: url.search });
      if (body.family_id !== FAMILY) throw new Error('Foreign family write');
      if (table === 'family_dashboard_settings') {
        if (query.get('on_conflict') !== 'family_id' || body.updated_by !== USER
          || typeof body.allow_child_customization !== 'boolean' || typeof body.lock_to_family_default !== 'boolean'
          || Object.keys(body).sort().join(',') !== 'allow_child_customization,family_id,lock_to_family_default,updated_by') {
          throw new Error('Unexpected settings write');
        }
        if (h.fail) return json({ code: '42501', message: 'Synthetic policy refusal' }, 403);
        h.settings = { allow_child_customization: body.allow_child_customization, lock_to_family_default: body.lock_to_family_default };
      } else if (table === 'dashboard_layouts') h.layouts.push(body);
      else if (table !== 'dashboard_layout_events') throw new Error('Unexpected mutation table');
      // A normal return=minimal 204 is a valid upsert response. The shared
      // synthetic store lets the actual child action read the saved value.
      return new Response(null, { status: 204 });
    } },
  });
}

beforeEach(() => {
  h.role = 'parent'; h.fail = false; h.contextCalls = 0;
  h.settings = { allow_child_customization: false, lock_to_family_default: false };
  h.calls = []; h.layouts = []; h.revalidated = []; h.db = db();
});
afterEach(() => vi.restoreAllMocks());

describe('family dashboard settings through the actual actions and SDK', () => {
  for (const role of ['parent', 'adult']) {
    it.each([[false, false], [true, false], [false, true], [true, true]])(
      `persists the valid boolean choice %s/%s for ${role}`, async (allow, lock) => {
        h.role = role;
        expect(await saveDashboardSettingsAction({ allowChildCustomization: allow, lockToFamilyDefault: lock })).toEqual({ ok: true });
        expect(h.settings).toEqual({ allow_child_customization: allow, lock_to_family_default: lock });
        expect(h.calls.map(call => call.table)).toEqual(['family_dashboard_settings', 'dashboard_layout_events']);
        expect(h.revalidated).toEqual(['/dashboard']);
      },
    );
  }
  it.each(['child', 'teen', 'grandparent', 'caregiver'])('refuses the non-manager %s before writes or input validation', async role => {
    h.role = role;
    expect(await saveDashboardSettingsAction(null as never)).toEqual({ ok: false, error: 'customizeActions.onlyAParentGuardianCan2' });
    expect(h.contextCalls).toBe(1); expect(h.calls).toEqual([]); expect(h.revalidated).toEqual([]);
  });
  it('ignores caller-supplied family/member/user targets and writes the authenticated family', async () => {
    await saveDashboardSettingsAction({ allowChildCustomization: false, lockToFamilyDefault: true,
      familyId: FOREIGN, memberId: 'foreign-member', userId: 'foreign-user' } as never);
    expect(h.calls[0].body).toEqual({ family_id: FAMILY, allow_child_customization: false, lock_to_family_default: true, updated_by: USER });
  });
  it('an explicit Data API refusal does not report saved or revalidate', async () => {
    h.fail = true;
    expect((await saveDashboardSettingsAction({ allowChildCustomization: true, lockToFamilyDefault: false })).ok).toBe(false);
    expect(h.revalidated).toEqual([]); expect(h.settings.allow_child_customization).toBe(false);
  });
  it('a valid false save is enforced by the actual child layout action', async () => {
    await saveDashboardSettingsAction({ allowChildCustomization: false, lockToFamilyDefault: false }); h.role = 'child';
    expect((await saveDashboardLayoutAction({ featureKeys: ['meals'] })).ok).toBe(false); expect(h.layouts).toEqual([]);
  });
  it('string false cannot replace the saved false choice or grant child customization', async () => {
    expect((await saveDashboardSettingsAction({ allowChildCustomization: 'false', lockToFamilyDefault: false } as never)).ok).toBe(false);
    expect(h.settings.allow_child_customization).toBe(false); expect(h.calls).toEqual([]); h.role = 'child';
    expect((await saveDashboardLayoutAction({ featureKeys: ['meals'] })).ok).toBe(false); expect(h.layouts).toEqual([]);
  });
  it.each([
    null, undefined, [], [false, false], 'false', 0, false, {},
    { allowChildCustomization: false }, { lockToFamilyDefault: false },
    { allowChildCustomization: 'false', lockToFamilyDefault: false },
    { allowChildCustomization: false, lockToFamilyDefault: 'false' },
    { allowChildCustomization: {}, lockToFamilyDefault: false },
    { allowChildCustomization: false, lockToFamilyDefault: null },
    { allowChildCustomization: false, lockToFamilyDefault: [] },
    { allowChildCustomization: 0, lockToFamilyDefault: false },
  ].map(input => [input]))('refuses malformed runtime choice %j after the context gate without writing', async input => {
    expect(await saveDashboardSettingsAction(input as never)).toEqual({ ok: false, error: 'errors.thatChangeWasNotSaved' });
    expect(h.contextCalls).toBe(1); expect(h.calls).toEqual([]); expect(h.revalidated).toEqual([]);
    expect(h.settings).toEqual({ allow_child_customization: false, lock_to_family_default: false });
  });
});
