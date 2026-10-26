import { readFileSync } from 'node:fs';
import { createClient as createSdkClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';
import { inScope, inWalletScope, ownMemberOnly, readWalletScope, readsEveryWallet } from '@/lib/wallet/own-wallets';
import type { SupabaseServer } from '@/lib/supabase/types';

// The held 0515, the owner's decision: a child's money is read by a parent or
// adult and by that child. Every wallet page reads a non-manager's own wallet,
// narrowed in the query before any limit, and says so; a sibling's wallet
// answers a child as one that is not there; the treasury and the family coach
// are a parent's or adult's.

const MIGRATION = 'supabase/reserved/0515_a_childs_money_is_read_by_managers_and_that_child.sql';
const PROBE = 'docs/audit/reserved/a-childs-money-is-read-by-managers-and-that-child-check.sql';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const read = (p: string) => readFileSync(p, 'utf8');

/** The real SDK against a synthetic PostgREST that records each request. */
function sdk(rows: Record<string, unknown[]>) {
  const calls: URL[] = [];
  const client = createSdkClient('https://synthetic-wallet.example.test', 'synthetic-not-a-live-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(url);
      return new Response(JSON.stringify(rows[url.pathname.replace('/rest/v1/', '')] ?? []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return { client: client as unknown as SupabaseServer, calls };
}
const ctx = (role: string) => ({ active: { familyId: 'synthetic-family', role, member: { id: 'synthetic-self' } } });

describe('who reads a child\'s money', () => {
  it('a parent and an adult read every wallet; anyone else their own', () => {
    for (const role of ['parent', 'adult']) expect(readsEveryWallet(role), role).toBe(true);
    for (const role of ['teen', 'child', 'caregiver', 'guest', null]) expect(readsEveryWallet(role), String(role)).toBe(false);
  });

  it('a manager\'s scope is every wallet, without a read', async () => {
    const { client, calls } = sdk({});
    expect(await readWalletScope(client, ctx('parent'))).toEqual({ scope: { all: true }, error: null });
    expect(calls).toHaveLength(0);
  });

  it('anyone else\'s scope is the wallets on their own member, read first', async () => {
    const { client, calls } = sdk({ child_wallets: [{ id: 'w-own' }] });
    expect(await readWalletScope(client, ctx('teen'))).toEqual({ scope: { all: false, ids: ['w-own'] }, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe('/rest/v1/child_wallets');
    expect(calls[0].searchParams.get('family_id')).toBe('eq.synthetic-family');
    expect(calls[0].searchParams.get('member_id')).toBe('eq.synthetic-self');
  });

  it('a wallet table is narrowed to the scope\'s wallets in the request, before its range', async () => {
    const { client, calls } = sdk({});
    const scope = { all: false as const, ids: ['w-own'] };
    await inWalletScope(client.from('wallet_transactions').select('id').eq('family_id', 'synthetic-family'), scope).order('id').range(0, 99);
    expect(calls[0].searchParams.get('child_wallet_id')).toBe('in.(w-own)');
    expect(calls[0].searchParams.get('offset')).toBe('0');
    await inWalletScope(client.from('wallet_transactions').select('id').eq('family_id', 'synthetic-family'), { all: true });
    expect(calls[1].searchParams.get('child_wallet_id')).toBeNull();
    await ownMemberOnly(client.from('child_wallets').select('id').eq('family_id', 'synthetic-family'), scope, 'synthetic-self');
    expect(calls[2].searchParams.get('member_id')).toBe('eq.synthetic-self');
  });

  it('a row on another wallet, or on none, is not in a child\'s scope', () => {
    const rows = [{ id: 'a', child_wallet_id: 'w-own' }, { id: 'b', child_wallet_id: 'w-sib' }, { id: 'c', child_wallet_id: null }];
    expect(inScope(rows, { all: false, ids: ['w-own'] }).map((r) => r.id)).toEqual(['a']);
    expect(inScope(rows, { all: true }).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('every wallet page reads a non-manager\'s own wallet, in the query', () => {
  it.each([
    ['app/(app)/wallet/activity/page.tsx', ["inWalletScope(supabase.from('wallet_transactions')"]],
    ['app/(app)/wallet/allowance/page.tsx', ["inWalletScope(supabase.from('allowance_rules')"]],
    ['app/(app)/wallet/gift/page.tsx', ["inWalletScope(supabase.from('gift_links')", "inWalletScope(supabase.from('pay_handles')"]],
    ['app/(app)/wallet/goals/page.tsx', ["inWalletScope(supabase.from('wallet_goals')", "inWalletScope(supabase.from('wallet_buckets')", "inWalletScope(supabase.from('wallet_transactions')"]],
    ['app/(app)/wallet/send/page.tsx', ["inWalletScope(supabase.from('wallet_buckets')", "inWalletScope(supabase.from('wallet_transactions')"]],
    ['app/(app)/wallet/settings/page.tsx', ["inWalletScope(supabase.from('wallet_rules')"]],
    ['app/(app)/wallet/cards/page.tsx', ["inWalletScope(supabase.from('stripe_issuing_cards')"]],
    ['app/(app)/wallet/invest/page.tsx', ["inWalletScope(supabase.from('invest_holdings')", "inWalletScope(supabase.from('wallet_buckets')", "inWalletScope(supabase.from('invest_orders')", "inWalletScope(supabase\n        .from('wallet_transactions')"]],
  ])('%s', (file, narrowed) => {
    const src = read(file);
    expect(src).toContain('await readWalletScope(supabase, ctx)');
    expect(src).toContain("ownMemberOnly(supabase.from('child_wallets')");
    for (const n of narrowed) expect(src, n).toContain(n);
    expect(src).toContain("childMoney.onlyYourOwnWallet");
    // The scope is read before the page's other reads.
    expect(at(src, 'await readWalletScope(supabase, ctx)')).toBeLessThan(at(src, "ownMemberOnly(supabase.from('child_wallets')"));
  });

  it('a sibling\'s wallet page answers a child as one that is not there, and lists no siblings', () => {
    const src = read('app/(app)/wallet/children/[childId]/page.tsx');
    expect(src).toContain('if (!cw || (!seesEveryWallet && cw.member_id !== ctx.active.member.id)) return <AppNotFound');
    expect(src).toContain(": Promise.resolve({ data: [] as { id: string; member_id: string; is_active: boolean }[], error: null }),");
  });

  it('the treasury, which totals every child, is a parent\'s or adult\'s, decided before it reads', () => {
    const src = read('app/(app)/wallet/treasury/page.tsx');
    expect(at(src, 'if (!readsEveryWallet(ctx.active.role)) {')).toBeLessThan(at(src, "supabase.from('child_wallets')"));
    expect(src).toContain("title={tr('householdMoney.keptByParents')}");
  });

  it('the coaches: the family one is a manager\'s, a child\'s answers only about their own wallet', () => {
    const family = read('app/api/ai/wallet/route.ts');
    expect(at(family, 'if (!readsEveryWallet(ctx.active.role)) {')).toBeLessThan(at(family, "supabase.from('child_wallets')"));
    expect(read('app/api/ai/wallet/child/[childId]/route.ts')).toContain('if (!cw || (!readsEveryWallet(ctx.active.role) && cw.member_id !== ctx.active.member.id)) {');
    const invest = read('app/api/ai/invest/route.ts');
    expect(invest).toContain("if (body.childWalletId && !readsEveryWallet(ctx.active.role)) {");
    expect(invest).toContain(".eq('id', body.childWalletId).eq('family_id', familyId).eq('member_id', ctx.active.member.id).maybeSingle();");
  });

  it('the hub reads a member\'s own cards, passes and rewards, and files what they add on them', () => {
    const hub = read('components/wallet/wallet-hub.tsx');
    for (const t of ['wallet_cards', 'wallet_passes', 'wallet_rewards']) {
      expect(hub, t).toContain(`const query = sb.from('${t}').select('*').eq('family_id', familyId).eq('is_active', true);`);
    }
    expect(hub.match(/query\.eq\('member_id', selfId!\)\)\.order\('sort_order'\)/g)).toHaveLength(3);
    const actions = read('app/(app)/wallet/hub-actions.ts');
    expect(actions).toContain('return isManager(ctx.active.role) ? null : ctx.active.member.id;');
    expect(actions.match(/family_id: ctx\.active\.familyId, member_id: ownerOfNew\(ctx\), name/g)).toHaveLength(3);
  });

  it('says so in the seven base locales', () => {
    for (const locale of LOCALES) {
      const m = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      expect(m['childMoney.onlyYourOwnWallet'], locale).toBeTruthy();
    }
  });
});

describe('the database half', () => {
  it('reads the sixteen tables by two rules through a helper pinned to the row\'s family, and keeps every write', () => {
    const sql = read(MIGRATION);
    for (const t of ['child_wallets', 'wallet_cards', 'wallet_passes', 'wallet_rewards', 'stripe_cardholders', 'stripe_issuing_cards',
      'stripe_authorizations', 'wallet_transactions', 'invest_holdings', 'invest_orders', 'pay_handles', 'wallet_buckets',
      'wallet_goals', 'wallet_rules', 'allowance_rules', 'gift_links']) {
      expect(sql, t).toContain(`('${t}', '`);
    }
    expect(sql).toContain('       and w.family_id = p_family_id\n       and public.is_self_member(w.member_id)');
    expect(sql).toContain('security definer\nset search_path = public, pg_temp');
    expect(sql).toContain("revoke all on function public.is_own_child_wallet_in_family(uuid, uuid) from anon;");
    expect(sql).toContain("raise exception '0515: public.% had % write policies and now has %'");
    const probe = read(PROBE);
    expect(probe).toContain("rule_wal  constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR is_own_child_wallet_in_family(child_wallet_id, family_id)))';");
    expect(probe).toContain('-- M1. The helper no longer pinned to the row\'s family.');
  });
});
