import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { creditChildWallet } from '@/lib/wallet/server';
import { rollForward } from '@/lib/wallet/allowance';
import { planLevel } from '@/lib/constants/plans';
import { walletTierForPlanLevel, walletFeatureEnabled } from '@/lib/wallet/tiers';
import { isMissingRelationError } from '@/lib/supabase/errors';
import type { Split } from '@/lib/wallet/ledger';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Allowance automation — runs due `allowance_rules`, crediting each child's
// wallet (immutable ledger, allocated by split) and advancing next_run_on.
// Allowances are a Basic+ feature, so families on the Free plan are skipped.
// Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('walletAllowance.unauthorized') }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    const today = new Date().toISOString().slice(0, 10);

    const { data: rules, error } = await supabase
      .from('allowance_rules')
      .select('id, family_id, child_wallet_id, amount_cents, cadence, split, next_run_on, last_run_on')
      .eq('is_active', true)
      .lte('next_run_on', today)
      .limit(2000);
    // If the wallet migration hasn't reached this database yet, there's simply
    // nothing to run — report a clean no-op so the cron isn't flagged as failed.
    if (error && isMissingRelationError(error)) {
      return NextResponse.json({ ok: true, skipped: 'wallet_not_deployed' });
    }
    if (error) throw error;

    // Resolve each family's plan once to gate the Basic+ feature.
    const families = Array.from(new Set((rules ?? []).map((r) => r.family_id)));
    const planByFamily = new Map<string, string | null>();
    if (families.length > 0) {
      const { data: subs, error: subscriptionsError } = await supabase
        .from('subscriptions')
        .select('family_id, plan, status')
        .in('family_id', families)
        .in('status', ['active', 'trialing']);
      if (subscriptionsError) throw subscriptionsError;
      for (const s of subs ?? []) planByFamily.set(s.family_id, s.plan);
    }

    let paid = 0;
    let skippedFree = 0;
    for (const rule of rules ?? []) {
      const tier = walletTierForPlanLevel(planLevel(planByFamily.get(rule.family_id) ?? null));
      if (!walletFeatureEnabled(tier, 'allowances')) { skippedFree++; continue; }

      const { runs, next } = rollForward(rule.next_run_on ?? today, rule.cadence, today, 1);
      if (runs === 0) continue;

      // Atomically CLAIM the schedule before the ledger write. The
      // `.lte('next_run_on', today)` predicate is the exclusivity guard: if two
      // cron invocations overlap, both read the rule as due, but only ONE update
      // matches a row (the first flips next_run_on into the future) — the loser
      // matches 0 rows and skips, so an allowance can never be double-credited.
      // If crediting then fails, we restore the prior schedule below so the next
      // run retries without skipping pay.
      const { data: claimed, error: scheduleError } = await supabase
        .from('allowance_rules')
        .update({ next_run_on: next, last_run_on: today })
        .eq('id', rule.id)
        .eq('family_id', rule.family_id)
        .lte('next_run_on', today)
        .select('id')
        .maybeSingle();
      if (scheduleError) throw scheduleError;
      if (!claimed) continue; // another concurrent run already claimed this rule — do not double-pay

      const res = await creditChildWallet(supabase, {
        familyId: rule.family_id,
        childWalletId: rule.child_wallet_id,
        amountCents: rule.amount_cents,
        type: 'allowance',
        description: 'Weekly allowance',
        createdBy: null,
        relatedType: 'allowance_rules',
        relatedId: rule.id,
        splitOverride: rule.split as Partial<Split> | null,
      });
      if (!res.ok) {
        const { error: rollbackError } = await supabase
          .from('allowance_rules')
          .update({ next_run_on: rule.next_run_on, last_run_on: rule.last_run_on })
          .eq('id', rule.id)
          .eq('family_id', rule.family_id);
        if (rollbackError) {
          console.error('Allowance schedule rollback error:', rollbackError);
        }
        throw new Error(`Allowance credit failed: ${res.error}`);
      }
      paid++;
    }

    return NextResponse.json({ ok: true, due: (rules ?? []).length, paid, skippedFree });
  } catch (err) {
    console.error('Allowance cron error:', err);
    return NextResponse.json({ error: t('walletAllowance.allowanceRunFailed') }, { status: 500 });
  }
}
