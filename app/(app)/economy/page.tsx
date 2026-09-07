import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { balanceFrom } from '@/lib/economy/ledger';
import { ErrorState } from '@/components/ui/states';
import {
  EconomyView, type Currency, type Member, type Reward, type Redemption, type BalanceCell,
} from '@/components/economy/economy-view';

export const metadata: Metadata = { title: 'Family Economy' };
export const dynamic = 'force-dynamic';

export default async function EconomyPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [currenciesRes, membersRes, txnsRes, rewardsRes, redemptionsRes] = await Promise.all([
    supabase.from('family_currencies').select('id, name, emoji, unit_label, is_active').eq('family_id', familyId).eq('is_active', true).order('sort_order'),
    supabase.from('family_members').select('id, display_name, color, role').eq('family_id', familyId).eq('is_active', true),
    supabase.from('currency_transactions').select('currency_id, member_id, direction, amount').eq('family_id', familyId).limit(5000),
    supabase.from('economy_rewards').select('id, currency_id, title, emoji, cost, stock, is_active').eq('family_id', familyId).eq('is_active', true).order('sort_order'),
    supabase.from('economy_redemptions').select('id, currency_id, member_id, title, cost, status, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(100),
  ]);

  // Kids' coin balances derive from the immutable currency_transactions ledger.
  // A dropped error would compute every child's balance as 0 from an empty
  // ledger — a reassuring-but-wrong money picture (a kid's earned coins appear
  // to vanish, or a parent thinks a child can't afford a reward). Fail closed on
  // a real read error across the economy tables; a genuinely missing table
  // (unapplied migration) is still tolerated as empty.
  const economyError = [currenciesRes.error, membersRes.error, txnsRes.error, rewardsRes.error, redemptionsRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (economyError) {
    console.error('[economy] family economy read failed', economyError);
    return <ErrorState message={tr('economy.couldNotLoadYourFamily')} />;
  }

  const currencies = currenciesRes.data;
  const members = membersRes.data;
  const txns = txnsRes.data;
  const rewards = rewardsRes.data;
  const redemptions = redemptionsRes.data;

  const currencyList: Currency[] = (currencies ?? []).map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, unitLabel: c.unit_label }));
  const memberList: Member[] = (members ?? []).map((m) => ({ id: m.id, name: m.display_name, color: m.color, isManager: isManager(m.role) }));

  // Derive per-currency, per-member balances from the immutable ledger.
  const byKey = new Map<string, { direction: 'credit' | 'debit'; amount: number }[]>();
  for (const t of txns ?? []) {
    const key = `${t.currency_id}:${t.member_id}`;
    const arr = byKey.get(key) ?? [];
    arr.push({ direction: t.direction, amount: t.amount });
    byKey.set(key, arr);
  }
  const balances: BalanceCell[] = [];
  for (const c of currencyList) {
    for (const m of memberList) {
      if (m.isManager) continue; // balances are for kids
      balances.push({ currencyId: c.id, memberId: m.id, balance: balanceFrom(byKey.get(`${c.id}:${m.id}`) ?? []) });
    }
  }

  const rewardList: Reward[] = (rewards ?? []).map((r) => ({ id: r.id, currencyId: r.currency_id, title: r.title, emoji: r.emoji, cost: r.cost, stock: r.stock }));
  const nameByMember = new Map(memberList.map((m) => [m.id, m.name]));
  const redemptionList: Redemption[] = (redemptions ?? []).map((r) => ({
    id: r.id, currencyId: r.currency_id, memberId: r.member_id, memberName: nameByMember.get(r.member_id) ?? 'Child',
    title: r.title, cost: r.cost, status: r.status,
  }));

  return (
    <EconomyView
      currencies={currencyList}
      members={memberList}
      balances={balances}
      rewards={rewardList}
      redemptions={redemptionList}
      canManage={isManager(ctx.active.role)}
    />
  );
}
