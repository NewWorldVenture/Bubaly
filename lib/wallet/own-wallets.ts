import { isManager } from '@/lib/constants/roles';
import type { SupabaseServer } from '@/lib/supabase/types';

/**
 * Who reads a child's money (the held 0515, the owner's decision "managers and
 * that child"): a parent or adult reads every child wallet and everything
 * hanging off one (buckets, ledger, goals, rules, allowance, gift links, pay
 * handles, cards, investments); anyone else reads only their own wallet's, and
 * the wallet-hub cards, passes and rewards that are theirs.
 *
 * The same rule holds before and after 0515 is released; before it, the
 * database returns more rows, and the screens show the same ones.
 */
export function readsEveryWallet(role: string | null | undefined): boolean {
  return isManager(role);
}

/** The wallets a page may read: every one in the family, or the viewer's own. */
export type WalletScope = { all: true } | { all: false; ids: string[] };

/**
 * Resolves a viewer's wallet scope: a manager reads every wallet; anyone else
 * reads the child wallets that are theirs, read first so every query after it
 * can be narrowed to them before any limit.
 */
export async function readWalletScope(
  supabase: SupabaseServer,
  ctx: { active: { familyId: string; role: string; member: { id: string } } },
): Promise<{ scope: WalletScope; error: { message: string } | null }> {
  if (readsEveryWallet(ctx.active.role)) return { scope: { all: true }, error: null };
  const { data, error } = await supabase.from('child_wallets').select('id')
    .eq('family_id', ctx.active.familyId).eq('member_id', ctx.active.member.id);
  return { scope: { all: false, ids: (data ?? []).map((w) => w.id) }, error };
}

/** Narrows a query of a wallet-keyed table to the scope's wallets. */
export function inWalletScope<Q>(query: Q, scope: WalletScope, column = 'child_wallet_id'): Q {
  return scope.all ? query : (query as unknown as { in(c: string, v: string[]): Q }).in(column, scope.ids);
}

/** Narrows a query of child_wallets (or a member-keyed table) to the viewer's own member. */
export function ownMemberOnly<Q>(query: Q, scope: WalletScope, selfMemberId: string): Q {
  return scope.all ? query : (query as unknown as { eq(c: string, v: string): Q }).eq('member_id', selfMemberId);
}

/** The rows a viewer reads of a wallet-keyed table: all, or their wallets'. */
export function inScope<T extends { child_wallet_id: string | null }>(rows: readonly T[], scope: WalletScope): T[] {
  return scope.all ? [...rows] : rows.filter((r) => r.child_wallet_id != null && scope.ids.includes(r.child_wallet_id));
}
