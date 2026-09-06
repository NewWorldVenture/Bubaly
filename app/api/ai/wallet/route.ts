import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, aiCoachLevel, AI_COACH_DAILY_LIMIT } from '@/lib/wallet/tiers';
import { balanceFromLedger, bucketBalances, weeksToGoal, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { buildWalletCoachPrompt, parseWalletCoach, type CoachChild, type CoachGoal } from '@/lib/wallet/coach';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

// POST /api/ai/wallet — the AI Family Financial Coach. Gated by wallet tier
// (Free has no coach; Basic limited; Plus unlimited). Computes balances + goal
// forecasts from the immutable ledger, then asks the configured AI provider.
export async function POST() {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();

    const tier = walletTierForPlanLevel(await effectivePlanLevel(await resolveFamilyPlanLevel(supabase, familyId)));
    if (aiCoachLevel(tier) === 'none') {
      return NextResponse.json({ error: 'The AI Money Coach is available on the Basic and Plus plans.' }, { status: 403 });
    }
    const limited = await enforceAIRateLimit(supabase, `ai-wallet:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many AI Money Coach requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    // Per-day metering: the limited (Basic) tier is capped at AI_COACH_DAILY_LIMIT
    // calls/day. We count today's `ai_coach_call` audit rows for this family.
    const dailyLimit = AI_COACH_DAILY_LIMIT[tier];
    if (Number.isFinite(dailyLimit)) {
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const { count: usedToday } = await supabase
        .from('wallet_audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .eq('action', 'ai_coach_call')
        .gte('created_at', startOfDay.toISOString());
      if ((usedToday ?? 0) >= dailyLimit) {
        return NextResponse.json(
          { error: `You've reached today's AI Money Coach limit (${dailyLimit}/day on your plan). Upgrade to Plus for unlimited coaching.` },
          { status: 429 },
        );
      }
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
    const coaching = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'wallet.coach', text: 'Money coaching for the family' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 600 });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const parsed = parseWalletCoach(completion.text || '');
        if (!parsed.headline && parsed.insights.length === 0) {
          obs.failed(new Error('The coaching reply had no headline or insights.'));
          return null;
        }
        return parsed;
      },
    );
    if (!coaching) {
      return NextResponse.json({ error: 'Could not generate coaching right now. Please try again.' }, { status: 502 });
    }

    // Record this call for per-day metering (only matters for the metered tier,
    // but logging always keeps the count honest if the plan changes mid-day).
    await supabase.from('wallet_audit_logs').insert({
      family_id: familyId, actor_user_id: ctx.user.id, action: 'ai_coach_call',
      entity_type: 'ai_wallet_coach', detail: 'AI Money Coach generated',
    });

    return NextResponse.json({ coaching, tier });
  } catch (err) {
    console.error('Wallet coach error:', err);
    return NextResponse.json({ error: 'Failed to generate coaching' }, { status: 500 });
  }
}
