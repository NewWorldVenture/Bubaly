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
import { readAll } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';

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
    // Platform-wide, so this stays the UTC day deliberately: the alternative is
    // resolving every rule's family zone to decide whether its day has arrived,
    // and the cost of not doing so is bounded at one day early for families west
    // of UTC. Recorded rather than left looking overlooked — a per-family run
    // date is the fix if allowance timing ever needs to be exact to the day.
    const today = new Date().toISOString().slice(0, 10);

    // `.limit(N)` is not a bound — PostgREST caps a response at db-max-rows
    // whatever the client asked for, so this quietly read 1,000. `max` is the
    // same ceiling, honoured by paging to it. See lib/supabase/read-all.ts.
    const { rows: rules, error } = await readAll((from, to) => supabase
      .from('allowance_rules')
      .select('id, family_id, child_wallet_id, amount_cents, cadence, split, next_run_on, last_run_on')
      .eq('is_active', true)
      .lte('next_run_on', today)
      .order('id')
      .range(from, to), { max: 2000 });
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
      // Batched for the same reason the read above pages. The rules read is
      // bounded at 2,000, so this `.in()` can carry more families than one
      // response may return — and a plan that does not come back is not read as
      // "unknown", it is read as free, which SKIPS the child's allowance and
      // reports the run clean. It also keeps the URL inside the gateway's
      // request-line limit, the other way an `.in()` of that size fails.
      const { data: subs, error: subscriptionsError } = await readInChunks<
        { family_id: string; plan: string | null; status: string }, { message: string }
      >(
        families,
        (chunk) => supabase
          .from('subscriptions')
          .select('family_id, plan, status')
          .in('family_id', chunk)
          .in('status', ['active', 'trialing']),
      );
      if (subscriptionsError) throw subscriptionsError;
      for (const s of subs) planByFamily.set(s.family_id, s.plan);
    }

    let paid = 0;
    let skippedFree = 0;
    let failed = 0;
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
      if (scheduleError) {
        // Same isolation as the credit failure below: one rule's claim error is
        // that rule's problem. Throwing here ended the platform's run for every
        // rule ordered after it, and a claim error that recurs (a constraint or
        // a poisoned row rather than a blip) would do so every night. Nothing
        // was written, so the rule stays due and retries on its own.
        failed++;
        console.error('Allowance schedule claim failed; leaving it retryable.', {
          ruleId: rule.id, familyId: rule.family_id, error: scheduleError,
        });
        continue;
      }
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
        // Rows deliberately not checked: on the service role zero rows means the
        // rule was deleted mid-run, and a deleted rule has no schedule to restore
        // and no run to skip. Audit C1-S9-63.
        const { error: rollbackError } = await supabase
          .from('allowance_rules')
          .update({ next_run_on: rule.next_run_on, last_run_on: rule.last_run_on })
          .eq('id', rule.id)
          .eq('family_id', rule.family_id);
        if (rollbackError) {
          console.error('Allowance schedule rollback error:', rollbackError);
        }
        // Degrade-but-log, as the other batch crons do: one family's rule must
        // not end the platform's run. This used to `throw`, which the outer
        // catch turned into a 500 — and because the rollback restores
        // `next_run_on`, the same rule was due again the next night and threw
        // at the same point. Rules ordered after it were never reached, so a
        // SINGLE unpayable rule stopped allowances for every family after it,
        // permanently, with nothing in the response naming the cause.
        //
        // Reaching this is not exotic. `creditChildWallet` resolves buckets by
        // (family_id, child_wallet_id), so it reports "not fully provisioned"
        // for any wallet missing a bucket — and for a rule whose
        // `child_wallet_id` belongs to ANOTHER family, which RLS permits
        // because the foreign key names `child_wallets(id)` alone and the
        // insert policy only checks the row's own `family_id`. 0311 closes that
        // second door; this one keeps the run alive whatever the reason.
        failed++;
        console.error('Allowance credit failed; leaving it retryable.', {
          ruleId: rule.id, familyId: rule.family_id, error: res.error,
        });
        continue;
      }
      paid++;
    }

    const ok = failed === 0;
    return NextResponse.json({ ok, due: (rules ?? []).length, paid, skippedFree, failed }, { status: ok ? 200 : 502 });
  } catch (err) {
    console.error('Allowance cron error:', err);
    return NextResponse.json({ error: t('walletAllowance.allowanceRunFailed') }, { status: 500 });
  }
}
