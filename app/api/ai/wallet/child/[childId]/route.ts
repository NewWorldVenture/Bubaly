import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, aiCoachLevel, AI_COACH_DAILY_LIMIT } from '@/lib/wallet/tiers';
import { balanceFromLedger, bucketBalances, weeksToGoal, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { buildChildCoachPrompt, parseWalletCoach } from '@/lib/wallet/coach';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';

// POST /api/ai/wallet/child/[childId] — child-specific AI Money Coach.
// Same tier gate + daily limit as the family-wide coach, but the prompt is
// scoped to a single child: their buckets, saving rate, and personal goals.
export async function POST(_req: Request, { params }: { params: Promise<{ childId: string }> }) {
  const tr = await getTranslations();
  try {
    const { childId } = await params;
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-wallet-child:${ctx.user.id}:${childId}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: tr('child.tooManyChildMoneyCoach') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    // Verify the child wallet belongs to this family (RLS also enforces this)
    const { data: cw } = await supabase
      .from('child_wallets')
      .select('id, member_id')
      .eq('id', childId)
      .eq('family_id', familyId)
      .eq('is_active', true)
      .maybeSingle();
    if (!cw) return NextResponse.json({ error: tr('child.childWalletNotFound') }, { status: 404 });

    // Tier gate
    const tier = walletTierForPlanLevel(await effectivePlanLevel(await resolveFamilyPlanLevel(supabase, familyId)));
    if (aiCoachLevel(tier) === 'none') {
      return NextResponse.json({ error: tr('child.theAiMoneyCoachIs') }, { status: 403 });
    }

    // Per-day metering (same counter as the family-wide coach)
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

    const [{ data: member }, { data: walletBuckets }, { data: txns }, { data: goals }] = await Promise.all([
      supabase.from('family_members').select('display_name').eq('id', cw.member_id).maybeSingle(),
      supabase.from('wallet_buckets').select('id, kind').eq('child_wallet_id', childId),
      supabase.from('wallet_transactions').select('bucket_id, status, direction, amount_cents, created_at').eq('child_wallet_id', childId).limit(2000),
      supabase.from('wallet_goals').select('title, saved_cents, target_cents').eq('child_wallet_id', childId).neq('status', 'cancelled').limit(20),
    ]);

    const bucketKindById = new Map((walletBuckets ?? []).map((b) => [b.id, b.kind as BucketKind]));
    const entries: LedgerEntry[] = (txns ?? []).map((t) => ({
      direction: t.direction, amount_cents: t.amount_cents, status: t.status,
      bucket_kind: t.bucket_id ? bucketKindById.get(t.bucket_id) ?? null : null,
    }));

    const totalCents = balanceFromLedger(entries);
    const bals = bucketBalances(entries);

    // Weekly save rate from last 8 weeks of credits going into Save bucket
    const since = Date.now() - 56 * 86400000;
    let recentSaveCents = 0;
    for (const t of txns ?? []) {
      if (t.direction === 'credit' && t.status === 'completed' && Date.parse(t.created_at) >= since) {
        const kind = t.bucket_id ? bucketKindById.get(t.bucket_id) : null;
        if (kind === 'save') recentSaveCents += t.amount_cents;
      }
    }
    const weeklyRate = Math.round(recentSaveCents / 8);

    const coachGoals = (goals ?? []).map((g) => ({
      childName: member?.display_name ?? 'Child',
      title: g.title,
      savedCents: g.saved_cents,
      targetCents: g.target_cents,
      weeksToGoal: weeksToGoal(g.saved_cents, g.target_cents, weeklyRate),
    }));

    const { system, user } = buildChildCoachPrompt({
      name: member?.display_name ?? 'Child',
      totalCents,
      buckets: { spend: bals.spend, save: bals.save, give: bals.give, invest: bals.invest },
      weeklyCreditCents: weeklyRate,
      goals: coachGoals,
    });

    // The child's name is not on the row — `childId` is already the subject of
    // the audit-log entry below, and the request ledger does not need to repeat
    // which kid is being coached about money.
    const coaching = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'wallet.coach.child', text: 'Money coaching for one child' },
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
      return NextResponse.json({ error: tr('child.couldNotGenerateCoachingRight') }, { status: 502 });
    }

    await supabase.from('wallet_audit_logs').insert({
      family_id: familyId, actor_user_id: ctx.user.id, action: 'ai_coach_call',
      entity_type: 'child_wallet', entity_id: childId,
      detail: `AI Money Coach — ${member?.display_name ?? 'Child'}`,
    });

    return NextResponse.json({ coaching, tier });
  } catch (err) {
    console.error('Child wallet coach error:', err);
    return NextResponse.json({ error: tr('child.failedToGenerateCoaching') }, { status: 500 });
  }
}
