import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { settleAll, describeReadError } from '@/lib/supabase/settle';
import { requireUserContext, effectivePlanLevel } from '@/lib/supabase/auth';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext, dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { walletTierForPlanLevel, aiCoachLevel, AI_COACH_DAILY_LIMIT } from '@/lib/wallet/tiers';
import { balanceFromLedger, bucketBalances, weeksToGoal, type LedgerEntry, type BucketKind } from '@/lib/wallet/ledger';
import { buildChildCoachPrompt, parseWalletCoach } from '@/lib/wallet/coach';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { readAllAsQuery } from '@/lib/supabase/read-all';
import { logWalletAudit } from '@/lib/server/audit';
import { admitDailyAIUse } from '@/lib/server/ai-daily-admission';

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
    // No key: say so before any work, rather than let the provider's throw
    // reach the catch below as a generic failure.
    if (!(await isAIConfigured())) return NextResponse.json({ error: tr('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
    const limited = await enforceAIRateLimit(supabase, `ai-wallet-child:${ctx.user.id}:${childId}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: tr('child.tooManyChildMoneyCoach') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    // Every read below decides either whether this call is allowed or what a
    // child is told about their own money, so a failed read stops the call
    // (503) rather than standing in for "no wallet", "no calls today" or "a
    // balance of zero". Each of those used to be the silent default here.
    const unavailable = () => NextResponse.json({ error: tr('child.failedToGenerateCoaching') }, { status: 503 });

    // Verify the child wallet belongs to this family (RLS also enforces this)
    // A refused read left the binding null and took the same branch as a row
    // that genuinely is not there, so the caller was told their own child wallet
    // does not exist. "Not found" is a claim about their data; it has to come
    // from an answer, not from the absence of one. Fails closed either way —
    // this changes WHICH closed answer is given, not whether one is. C1-S9-38.
    const { data: cw, error: cwError } = await supabase
      .from('child_wallets')
      .select('id, member_id')
      .eq('id', childId)
      .eq('family_id', familyId)
      .eq('is_active', true)
      .maybeSingle();
    if (cwError) {
      console.error('[ai/wallet/child] wallet read failed', { familyId, error: describeReadError(cwError) });
      return NextResponse.json({ error: tr('child.walletDataIsTemporarilyUnavailable') }, { status: 503 });
    }
    if (!cw) return NextResponse.json({ error: tr('child.childWalletNotFound') }, { status: 404 });

    // Tier gate
    const tier = walletTierForPlanLevel(await effectivePlanLevel(await resolveFamilyPlanLevel(supabase, familyId)));
    if (aiCoachLevel(tier) === 'none') {
      return NextResponse.json({ error: tr('child.theAiMoneyCoachIs') }, { status: 403 });
    }

    // Per-day metering (same counter as the family-wide coach)
    const dailyLimit = AI_COACH_DAILY_LIMIT[tier];
    if (Number.isFinite(dailyLimit)) {
      // The family's midnight, not the host's. This bound is the daily AI
      // quota window: on a UTC host `setHours(0,0,0,0)` rolls over at 17:00 in
      // California and 11:00 in Sydney, so a household's allowance reset in the
      // middle of their afternoon and calls made after it were counted against
      // tomorrow. Same defect and same fix as the kitchen display
      // (app/(app)/display/page.tsx:122).
      const startOfDay = new Date(zonedDayBoundsMs(dayKeyInTz(new Date(), ctx.active.family.timezone || 'UTC'), ctx.active.family.timezone || 'UTC').start);
      const { count: usedToday, error: meterError } = await supabase
        .from('wallet_audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .eq('action', 'ai_coach_call')
        .gte('created_at', startOfDay.toISOString());
      // An unreadable meter is not "none used": that answer lifted the daily
      // limit, and every call behind it is a paid model call.
      if (meterError || usedToday === null) { console.error('[ai-wallet-child] usage meter read failed', meterError); return unavailable(); }
      if (usedToday >= dailyLimit) {
        return NextResponse.json(
          { error: tr('wallet.coachDailyLimitReached', { limit: dailyLimit }) },
          { status: 429 },
        );
      }
      // One request per observed count, shared with the family coach (same rows).
      const admitted = await admitDailyAIUse({ countedAction: 'ai_coach_call', familyId, usedToday });
      if (!admitted.ok) return NextResponse.json(
        { error: tr('child.tooManyChildMoneyCoach') },
        { status: 429, headers: { 'Retry-After': String(admitted.retryAfter) } },
      );
    }

    const [
      { data: member, error: memberError },
      { data: walletBuckets, error: bucketsError },
      { data: txns, error: txnsError },
      { data: goals, error: goalsError },
    ] = await settleAll([
      supabase.from('family_members').select('display_name').eq('id', cw.member_id).maybeSingle(),
      supabase.from('wallet_buckets').select('id, kind').eq('child_wallet_id', childId),
      // Money, so a quietly truncated read is a wrong balance, not a short
      // list. `.limit(2000)` never was 2,000 — PostgREST caps at db-max-rows.
      readAllAsQuery((from, to) => supabase.from('wallet_transactions').select('bucket_id, status, direction, amount_cents, created_at').eq('child_wallet_id', childId).order('id').range(from, to), { max: 2000 }),
      supabase.from('wallet_goals').select('title, saved_cents, target_cents').eq('child_wallet_id', childId).neq('status', 'cancelled').limit(20),
    ]);

    // Same defect as the family-level route: readAllAsQuery reports a truncated
    // or failed read as `data: null`, and destructuring only `data` turned that
    // into a $0.00 balance the model then wrote coaching prose about. This is a
    // child's money — refuse rather than invent a number. Audit C4-S4-02.
    if (txnsError) {
      console.error('[ai/wallet/child] transaction read failed or truncated', { childId, error: txnsError });
      return NextResponse.json({ error: tr('child.couldNotGenerateCoachingRight') }, { status: 502 });
    }
    // The other three reads are held to the same standard (see `unavailable`).
    if (memberError || bucketsError || goalsError) {
      console.error('[ai-wallet-child] ledger read failed', memberError ?? bucketsError ?? goalsError);
      return unavailable();
    }

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

    await logWalletAudit(supabase, {
      family_id: familyId, actor_user_id: ctx.user.id, action: 'ai_coach_call',
      entity_type: 'child_wallet', entity_id: childId,
      detail: `AI Money Coach — ${member?.display_name ?? 'Child'}`,
    }, 'child AI money coach call');

    return NextResponse.json({ coaching, tier });
  } catch (err) {
    console.error('Child wallet coach error:', err);
    return NextResponse.json({ error: tr('child.failedToGenerateCoaching') }, { status: 500 });
  }
}
