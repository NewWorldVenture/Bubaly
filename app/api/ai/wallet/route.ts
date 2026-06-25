import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { planLevel } from '@/lib/constants/plans';
import { walletTierForPlanLevel, aiCoachLevel } from '@/lib/wallet/tiers';
import { balanceFromLedger, bucketBalances, weeksToGoal, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { buildWalletCoachPrompt, parseWalletCoach, type CoachChild, type CoachGoal } from '@/lib/wallet/coach';

// POST /api/ai/wallet — the AI Family Financial Coach. Gated by wallet tier
// (Free has no coach; Basic limited; Plus unlimited). Computes balances + goal
// forecasts from the immutable ledger, then asks the configured AI provider.
export async function POST() {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();

    const { data: sub } = await supabase
      .from('subscriptions').select('plan, status').eq('family_id', familyId)
      .in('status', ['active', 'trialing']).maybeSingle();
    const tier = walletTierForPlanLevel(planLevel(sub?.plan ?? null));
    if (aiCoachLevel(tier) === 'none') {
      return NextResponse.json({ error: 'The AI Money Coach is available on the Basic and Plus plans.' }, { status: 403 });
    }

    const [{ data: childWallets }, { data: buckets }, { data: txns }, { data: members }, { data: goals }] = await Promise.all([
      supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
      supabase.from('wallet_buckets').select('id, kind').eq('family_id', familyId),
      supabase.from('wallet_transactions').select('child_wallet_id, bucket_id, status, direction, amount_cents, created_at').eq('family_id', familyId).limit(3000),
      supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
      supabase.from('wallet_goals').select('child_wallet_id, title, saved_cents, target_cents').eq('family_id', familyId).eq('status', 'active').limit(50),
    ]);

    const bucketKindById = new Map((buckets ?? []).map((b) => [b.id, b.kind as BucketKind]));
    const nameByMember = new Map((members ?? []).map((m) => [m.id, m.display_name]));
    const memberByWallet = new Map((childWallets ?? []).map((c) => [c.id, c.member_id]));
    const nameByWallet = (wid: string | null) => (wid ? nameByMember.get(memberByWallet.get(wid) ?? '') ?? null : null);

    const entriesByChild = new Map<string, LedgerEntry[]>();
    // estimate a weekly contribution rate per child from the last ~8 weeks of credits
    const recentCreditByChild = new Map<string, number>();
    const since = Date.now() - 56 * 86400000;
    for (const t of txns ?? []) {
      if (!t.child_wallet_id) continue;
      const arr = entriesByChild.get(t.child_wallet_id) ?? [];
      arr.push({ direction: t.direction, amount_cents: t.amount_cents, status: t.status, bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null });
      entriesByChild.set(t.child_wallet_id, arr);
      if (t.direction === 'credit' && t.status === 'completed' && Date.parse(t.created_at) >= since) {
        recentCreditByChild.set(t.child_wallet_id, (recentCreditByChild.get(t.child_wallet_id) ?? 0) + t.amount_cents);
      }
    }

    const children: CoachChild[] = (childWallets ?? []).map((cw) => {
      const entries = entriesByChild.get(cw.id) ?? [];
      return { name: nameByMember.get(cw.member_id) ?? 'Child', totalCents: balanceFromLedger(entries), saveCents: bucketBalances(entries).save };
    });

    const coachGoals: CoachGoal[] = (goals ?? []).map((g) => {
      const weekly = Math.round((recentCreditByChild.get(g.child_wallet_id ?? '') ?? 0) / 8); // avg over 8 weeks
      return { childName: nameByWallet(g.child_wallet_id), title: g.title, savedCents: g.saved_cents, targetCents: g.target_cents, weeksToGoal: weeksToGoal(g.saved_cents, g.target_cents, weekly) };
    });

    const { system, user } = buildWalletCoachPrompt({ children, goals: coachGoals, familyName: ctx.active.family.name });
    const provider = await resolveProvider();
    const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 600 });
    const coaching = parseWalletCoach(completion.text || '');
    if (!coaching.headline && coaching.insights.length === 0) {
      return NextResponse.json({ error: 'Could not generate coaching right now. Please try again.' }, { status: 502 });
    }
    return NextResponse.json({ coaching, tier });
  } catch (err) {
    console.error('Wallet coach error:', err);
    return NextResponse.json({ error: 'Failed to generate coaching' }, { status: 500 });
  }
}
