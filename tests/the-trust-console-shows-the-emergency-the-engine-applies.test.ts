// N10 — /dashboard/trust read emergency_sessions with `ended_at is null` alone:
// no expiry, no order. The engine stops elevating at `expires_at` (0260,
// lib/trust/server.ts), so four hours on the console still said "Emergency mode
// is active", hid the activation form, and asked a parent to End a session that
// had already stopped. With two open sessions the banner named `[0]`'s domains
// while the engine applied the union. End had no `ended_at is null` guard, so a
// second End rewrote who ended it and when, and logged a second
// 'emergency_ended'; Revoke the same for a delegation; and Activate inserted
// beside an open session.
//
// N17 — the trust ledger read kept only `{ data }`. A failed read rendered the
// Audit tab's "No activity yet", on the surface where a parent checks whether
// an emergency override was ever made, and nothing was logged.
//
// The real page and actions run against the in-memory database; the real
// TrustModule is driven on hook slots to open its tabs.
import { createElement, isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, nodes, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => ({
  ...(await (await import('./helpers/module-state')).createModuleState()),
  client: null as unknown,
  role: 'parent',
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => ({ PageHeader: (await import('./helpers/module-harness')).ui.PageHeader }));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtDate: (value: unknown) => String(value) }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.client, createServiceClient: () => h.client }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'p@example.test' }, memberships: [],
    active: { familyId: 'fam-trust', role: h.role, member: { id: 'member-1' }, family: { id: 'fam-trust', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => {} }));
vi.mock('@/lib/trust/activity', () => ({
  loadTrustActivity: async () => ({ ok: true, data: { calls: [], dials: [], reads: [] } }),
  loadApprovalBasedOn: async () => ({ ok: true, data: {} }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { default: TrustPage } = await import('@/app/(app)/dashboard/trust/page');
const { TrustModule } = await import('@/components/modules/trust-module');
const { activateEmergencyAction, endEmergencyAction, revokeDelegationAction } = await import('@/app/(app)/dashboard/trust/actions');

type DB = SupabaseClient<Database>;
type TrustData = Parameters<typeof TrustModule>[0]['data'];
const FAMILY = 'fam-trust';
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
let db: InMemorySupabase;
let auditFails = false;

/** The data the real page hands TrustModule. */
async function pageData(): Promise<TrustData> {
  const out = await TrustPage();
  expect(isValidElement(out) && (out as ReactElement).type === TrustModule, 'the page rendered its error state').toBe(true);
  return (out as ReactElement<{ data: TrustData }>).props.data;
}
const screen = (data: TrustData) => render(h.hooks, createElement(TrustModule, { data, canManage: true }));

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  auditFails = false;
  h.client = withFaults(db as unknown as DB, (table) => (table === 'trust_audit_logs' && auditFails ? { message: 'canceling statement due to statement timeout', code: '57014' } : null));
  h.role = 'parent';
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [{ id: 'member-1', family_id: FAMILY, user_id: 'user-1', display_name: 'Ada', role: 'parent', is_active: true, color: null, created_at: '2026-01-01T00:00:00Z' }]);
});

describe('N10 — the console shows the emergency the engine applies', () => {
  it('does not show a session past its expiry as active, and offers the activation form', async () => {
    db.seed('emergency_sessions', [{ id: 'expired', family_id: FAMILY, kind: 'medical', elevated_domains: ['medical'], activated_at: iso(-5 * HOUR), expires_at: iso(-HOUR), ended_at: null }]);
    const data = await pageData();
    expect(data.emergencies).toEqual([]);

    let tree = screen(data);
    expect(has(tree, 'Emergency Mode active —')).toBe(false);
    await click(byName(tree, 'Emergency'));
    tree = screen(data);
    expect(allByName(tree, /Activate Emergency Mode/)).toHaveLength(1);
    expect(allByName(tree, /End Emergency Mode/)).toEqual([]);
  });

  it('shows every open session, newest first, each with its own End', async () => {
    db.seed('emergency_sessions', [
      { id: 'older', family_id: FAMILY, kind: 'medical', elevated_domains: ['medical'], activated_at: iso(-2 * HOUR), expires_at: iso(2 * HOUR), ended_at: null },
      { id: 'newer', family_id: FAMILY, kind: 'severe_weather', elevated_domains: ['finances'], activated_at: iso(-HOUR), expires_at: iso(3 * HOUR), ended_at: null },
      { id: 'ended', family_id: FAMILY, kind: 'general', elevated_domains: ['calendar'], activated_at: iso(-HOUR), expires_at: iso(3 * HOUR), ended_at: iso(-30 * 60_000) },
    ]);
    const data = await pageData();
    expect(data.emergencies.map((e) => e.id)).toEqual(['newer', 'older']);

    const tree = screen(data);
    const banners = nodes(tree).filter((n) => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.includes('border-rose-500/40'));
    expect(banners).toHaveLength(2);
    expect(allByName(tree, 'End')).toHaveLength(2);
  });

  it('a second End neither rewrites the end nor logs it twice', async () => {
    db.seed('emergency_sessions', [{ id: 'emg', family_id: FAMILY, kind: 'medical', elevated_domains: ['medical'], activated_at: iso(-HOUR), expires_at: iso(3 * HOUR), ended_at: null, ended_by: null }]);
    expect(await endEmergencyAction({ id: 'emg' })).toEqual({ ok: true });
    const first = { ...db.table('emergency_sessions')[0] };

    expect((await endEmergencyAction({ id: 'emg' })).ok).toBe(false);
    expect(db.table('emergency_sessions')[0]).toMatchObject({ ended_at: first.ended_at, ended_by: first.ended_by });
    expect(db.table('trust_audit_logs').filter((r) => r.decision === 'emergency_ended')).toHaveLength(1);
  });

  it('a second Revoke does not rewrite when a delegation was revoked', async () => {
    db.seed('trust_delegations', [{ id: 'deleg', family_id: FAMILY, revoked_at: null }]);
    expect(await revokeDelegationAction({ id: 'deleg' })).toEqual({ ok: true });
    const revokedAt = db.table('trust_delegations')[0].revoked_at;
    expect((await revokeDelegationAction({ id: 'deleg' })).ok).toBe(false);
    expect(db.table('trust_delegations')[0].revoked_at).toBe(revokedAt);
  });

  it('does not start a second emergency beside an open one, and does once the first has expired', async () => {
    db.seed('emergency_sessions', [{ id: 'open', family_id: FAMILY, kind: 'medical', elevated_domains: ['medical'], activated_at: iso(-HOUR), expires_at: iso(3 * HOUR), ended_at: null }]);
    expect(await activateEmergencyAction({ kind: 'general', elevatedDomains: ['finances'] }))
      .toEqual({ ok: false, error: 'Emergency mode is already on. End it before starting another, or let it end on its own.' });
    expect(db.table('emergency_sessions')).toHaveLength(1);

    db.table('emergency_sessions')[0].expires_at = iso(-60_000);
    expect(await activateEmergencyAction({ kind: 'general', elevatedDomains: ['finances'] })).toEqual({ ok: true });
    expect(db.table('emergency_sessions')).toHaveLength(2);
  });
});

describe('N17 — a ledger that could not be read is not "No activity yet"', () => {
  it('the Audit tab says the record could not be loaded, and the failure is logged', async () => {
    auditFails = true;
    const data = await pageData();
    expect(data.auditError).toBe('The record of trust decisions could not be loaded. Refresh to try again.');
    expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0]))).toContain('[dashboard/trust] trust audit log read failed');

    let tree = screen(data);
    await click(byName(tree, 'Audit'));
    tree = screen(data);
    expect(has(tree, 'The record of trust decisions could not be loaded. Refresh to try again.')).toBe(true);
    expect(has(tree, 'No activity yet')).toBe(false);
  });

  it('an empty ledger that WAS read still says "No activity yet"', async () => {
    const data = await pageData();
    expect(data.auditError).toBeNull();
    let tree = screen(data);
    await click(byName(tree, 'Audit'));
    tree = screen(data);
    expect(has(tree, 'No activity yet')).toBe(true);
  });
});
