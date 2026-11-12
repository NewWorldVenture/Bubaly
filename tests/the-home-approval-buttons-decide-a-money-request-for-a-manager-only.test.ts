import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allByName, byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { parentApprovalToNeed } from '@/lib/home/needs-sources';

// Register B, CONTROL sweep group 3: components/dashboard/home-approval-actions.tsx.
//
// The two one-tap buttons on a pending money approval. They are mounted by the
// REAL "Needs your attention" list (components/concierge/needs-attention.tsx),
// which is how a person reaches them on Home, and their only boundary is the
// wallet's server action module, mocked here for the cases that click and
// loaded for real in the cases that ask who the server refuses.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const boundary = vi.hoisted(() => ({
  role: 'parent',
  spend: [] as unknown[],
  allowance: [] as unknown[],
  answer: { ok: true } as { ok: true } | { ok: false; error: string },
  refreshed: 0,
  serverReads: 0,
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => { boundary.refreshed += 1; }, push: () => {} }) }));
vi.mock('@/app/(app)/wallet/actions', () => ({
  decideSpendRequestAction: async (input: unknown) => { boundary.spend.push(input); return boundary.answer; },
  decideAllowanceRequestAction: async (input: unknown) => { boundary.allowance.push(input); return boundary.answer; },
}));
// The other rows of the list are not on screen in these cases; their action
// modules are server-only.
vi.mock('@/app/(app)/dashboard/approvals-actions', () => ({ decideApproval: async () => ({ ok: true }), editAndApproveApproval: async () => ({ ok: true }) }));
vi.mock('@/app/(app)/dashboard/needs-you/actions', () => ({}));
vi.mock('@/lib/family/actions', () => ({}));
// What the real wallet actions stand on, for the cases that call them.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: h.app.familyId, role: boundary.role, member: { id: 'member-1' }, family: { name: 'Fixture family', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => { boundary.serverReads += 1; throw new Error('the refusal must come before any read'); },
  createServiceClient: () => { boundary.serverReads += 1; throw new Error('the refusal must come before any read'); },
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { NeedsAttention } = await import('@/components/concierge/needs-attention');

const SPEND = '11111111-1111-4111-8111-111111111111';
const ALLOWANCE = '22222222-2222-4222-8222-222222222222';
const reader = { t: (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params), locale: 'en-US' };

/** The list as Home builds it for one pending money approval. */
function list(approvalId: string, kind: string, canDecide: boolean) {
  const item = parentApprovalToNeed({ id: approvalId, kind, amount_cents: 1250, created_at: '2026-10-13T09:00:00Z' }, reader as never);
  return createElement(NeedsAttention, {
    items: [item], more: 0, headline: '1 thing needs you', approvals: {}, moneyApprovalKinds: { [approvalId]: kind },
    recommendationBodies: {}, canDecide,
  });
}

const show = (approvalId: string, kind: string, canDecide = true): ReactNode => render(h.hooks, list(approvalId, kind, canDecide));

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  boundary.role = 'parent';
  boundary.spend = []; boundary.allowance = []; boundary.answer = { ok: true }; boundary.refreshed = 0; boundary.serverReads = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('components/dashboard/home-approval-actions.tsx — Approve and Decline on a pending money approval', () => {
  it('CONTROL-8289A2B2C348 Approve: a manager sees it by name on a card purchase, and one tap approves that request', async () => {
    const tree = show(SPEND, 'card_spend');
    expect(has(tree, 'Card purchase')).toBe(true);
    const approve = byName(tree, 'Approve', 'button');
    expect(approve.props['aria-label']).toBe('Approve');
    expect(approve.props.disabled).toBe(false);

    await click(approve);

    expect(boundary.spend).toEqual([{ approvalId: SPEND, decision: 'approved' }]);
    expect(boundary.allowance).toEqual([]);
    expect(h.toasts.success).toEqual(['Approved ✓']);
    expect(boundary.refreshed).toBe(1);
    // The buttons are gone: the request cannot be decided twice from here.
    const after = show(SPEND, 'card_spend');
    expect(allByName(after, 'Approve')).toHaveLength(0);
    expect(allByName(after, 'Decline')).toHaveLength(0);
    expect(has(after, 'Done')).toBe(true);
  });

  it('CONTROL-AC87CC524220 Decline: a manager sees it by name on an allowance request, and one tap declines through the allowance action', async () => {
    const tree = show(ALLOWANCE, 'allowance_request');
    const decline = byName(tree, 'Decline', 'button');
    expect(decline.props['aria-label']).toBe('Decline');

    await click(decline);

    expect(boundary.allowance).toEqual([{ approvalId: ALLOWANCE, decision: 'rejected' }]);
    expect(boundary.spend).toEqual([]);
    expect(h.toasts.success).toEqual(['Declined']);
    expect(boundary.refreshed).toBe(1);
    expect(has(show(ALLOWANCE, 'allowance_request'), 'Done')).toBe(true);
  });

  it('CONTROL-8289A2B2C348 CONTROL-AC87CC524220 a refusal from the server is said, and the buttons stay for another try', async () => {
    boundary.answer = { ok: false, error: 'This request was already decided.' };
    await click(byName(show(SPEND, 'card_spend'), 'Approve', 'button'));

    expect(h.toasts.error).toEqual(['This request was already decided.']);
    expect(h.toasts.success).toEqual([]);
    expect(boundary.refreshed).toBe(0);
    const after = show(SPEND, 'card_spend');
    expect(allByName(after, 'Approve', 'button')).toHaveLength(1);
    expect(allByName(after, 'Decline', 'button')).toHaveLength(1);
  });

  // components/concierge/needs-attention.tsx:139 mounts the buttons only when
  // `canDecide`, which Home and /dashboard/needs-you set to isManager(role)
  // (app/(app)/home/page.tsx:640, app/(app)/dashboard/needs-you/page.tsx:187).
  it('CONTROL-8289A2B2C348 CONTROL-AC87CC524220 someone who cannot decide reads the request and is offered neither button', () => {
    const tree = show(SPEND, 'card_spend', false);
    expect(has(tree, 'Card purchase')).toBe(true);
    expect(allByName(tree, 'Approve')).toHaveLength(0);
    expect(allByName(tree, 'Decline')).toHaveLength(0);
    expect(allByName(tree, /Review/, 'a')).toHaveLength(1);
  });

  // app/(app)/wallet/actions.ts:1119 (spend) and :1247 (allowance): the server
  // refuses a non-manager before it reads anything.
  it.each(['teen', 'child', 'caregiver', 'guest'])('CONTROL-8289A2B2C348 CONTROL-AC87CC524220 the wallet actions refuse a %s who calls them anyway', async (role) => {
    boundary.role = role;
    const real = await vi.importActual<typeof import('@/app/(app)/wallet/actions')>('@/app/(app)/wallet/actions');

    const spend = await real.decideSpendRequestAction({ approvalId: SPEND, decision: 'approved' });
    const allowance = await real.decideAllowanceRequestAction({ approvalId: ALLOWANCE, decision: 'rejected' });

    expect(spend).toEqual({ ok: false, error: 'Only a parent/guardian can decide spend requests.' });
    expect(allowance).toEqual({ ok: false, error: 'Only a parent/guardian can decide allowance requests.' });
    expect(boundary.serverReads).toBe(0);
  });
});
