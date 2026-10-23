import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { creditChildWallet } from '@/lib/wallet/server';
import { allowanceOccurrenceKey, rollForward } from '@/lib/wallet/allowance';
import { planLevel } from '@/lib/constants/plans';
import { walletTierForPlanLevel, walletFeatureEnabled } from '@/lib/wallet/tiers';
import { isMissingRelationError } from '@/lib/supabase/errors';
import type { Split } from '@/lib/wallet/ledger';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { readAll, readAllAsQuery } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { dayKeyInTz } from '@/lib/services/scope';

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
    // "Due today" is the FAMILY's today. `next_run_on` is written on the
    // family's day (wallet/actions.ts nextRunDate of dayKeyInTz), and "Run due
    // now" pays on it, but this run decided on the UTC day: at 07:00 UTC a
    // Pacific family is still on the evening before, so a rule due on its
    // Saturday was paid on Friday night and stamped last_run_on Saturday. The
    // read takes every rule due on the latest calendar day anywhere (UTC+14),
    // a superset, and each rule is then decided, claimed and stamped on its
    // own family's day. With one 07:00 UTC tick a rule west of UTC-7 is paid
    // late on its due day instead of early; paying at its local midnight
    // would take a later schedule, which is the owner's (vercel.json).
    const now = new Date();
    const latestDay = new Date(now.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);

    // `.limit(N)` is not a bound — PostgREST caps a response at db-max-rows
    // whatever the client asked for, so this quietly read 1,000. `max` is the
    // same ceiling, honoured by paging to it. See lib/supabase/read-all.ts.
    //
    // Rules of OPEN families only: a closed account (families.closed_at) is not
    // paid allowances, whatever its subscription row still says.
    const { rows: rules, error } = await readAll((from, to) => supabase
      .from('allowance_rules')
      .select('id, family_id, child_wallet_id, amount_cents, cadence, split, next_run_on, last_run_on, created_by, family:families!inner(closed_at, timezone)')
      .is('family.closed_at', null)
      .eq('is_active', true)
      .lte('next_run_on', latestDay)
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

    // Who wrote the rule. 0298 makes allowance_rules manager-only in the
    // database, which is the real boundary; this is the second lock on the
    // same door, because THIS is the code that turns a row into money. It runs
    // as the service role and bypasses RLS, so a rule written before 0298
    // reaches a database — or after any future policy drift — would still be
    // paid. A rule whose author is not an active manager of its family is not
    // paid, and says so in the response rather than being silently dropped.
    //
    // Read in chunks of families, each paged to its end. One `.in()` over every
    // due family built a URL of ~40 bytes per id, so past roughly 200 families
    // the request line outgrew the gateway and the whole run answered 500,
    // paying nobody; below that, past 1,000 manager rows the response stopped at
    // db-max-rows and the families whose managers did not come back had every
    // rule skipped as "unauthored" in a run reported ok. A read that fails, or
    // cannot be completed, fails the run instead: each chunk is paged to its
    // end (readAllAsQuery), and a chunk's error is the read's.
    const authorKeys = new Set<string>();
    if (families.length > 0) {
      type ManagerRow = { id: string; family_id: string; user_id: string | null; role: string; is_active: boolean };
      const { data: managers, error: managersError } = await readInChunks<ManagerRow, { message: string }>(
        families,
        (families) => readAllAsQuery<ManagerRow>((from, to) => supabase
          .from('family_members')
          .select('id, family_id, user_id, role, is_active')
          .in('family_id', families)
          .in('role', ['parent', 'adult'])
          .eq('is_active', true)
          .order('id')
          .range(from, to)),
      );
      if (managersError) throw managersError;
      for (const m of managers ?? []) {
        if (m.user_id) authorKeys.add(`${m.family_id}:${m.user_id}`);
      }
    }
    let skippedUnauthored = 0;
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
    let due = 0;
    for (const rule of rules ?? []) {
      // The family's own day: a rule not yet due there is not this run's.
      const family = rule.family as { timezone?: string | null } | null;
      const today = dayKeyInTz(now, family?.timezone || 'UTC');
      if ((rule.next_run_on ?? today) > today) continue;
      due++;

      // A rule with no author predates the column or was written by the service
      // role; those are the seed/migration path and stay payable. A rule that
      // names an author who is not an active manager of that family does not.
      if (rule.created_by && !authorKeys.has(`${rule.family_id}:${rule.created_by}`)) {
        console.warn('[wallet-allowance] skipped a rule whose author is not an active manager', { ruleId: rule.id });
        skippedUnauthored++;
        continue;
      }

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
      //
      // `is_active` is part of the claim for the same reason: the rules were
      // read as active, but a parent's pause that commits after that read does
      // not move `next_run_on`, and this run can reach a rule long after reading
      // it. A paused rule now matches nothing here and is not paid.
      const { data: claimed, error: scheduleError } = await supabase
        .from('allowance_rules')
        .update({ next_run_on: next, last_run_on: today })
        .eq('id', rule.id)
        .eq('family_id', rule.family_id)
        .eq('is_active', true)
        // The amount this run read is the amount it will credit. An amount-only
        // edit keeps the rule's date, so one that commits after the read would
        // otherwise be claimed and paid at the old figure. With this the claim
        // misses, the rule stays due, and the next run pays the new amount.
        // (No semicolons in this comment: the claim guard reads the statement
        // up to its first one.)
        .eq('amount_cents', rule.amount_cents)
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

      // Keyed per OCCURRENCE (lib/wallet/allowance.ts allowanceOccurrenceKey):
      // the rule and the day it is paid for, so the ledger can say whether THIS
      // payment landed, and a unique key can refuse paying it twice. The key
      // rides in `metadata.occurrence`; `related_id` is a uuid column and keeps
      // the rule's id — the `<rule>:<day>` text there was refused with 22P02,
      // and the claim above had already moved the schedule on: nobody was paid.
      // The day is the one being PAID (the `next_run_on` this run claimed), not
      // `today`: a run that catches up several missed periods pays the first
      // one it claimed, and a run-day key (this run's day was once UTC, while
      // "Run due now" counts in the family's zone) named one payment twice.
      const occurrence = allowanceOccurrenceKey(rule.id, rule.next_run_on ?? today);
      const res = await creditChildWallet(supabase, {
        familyId: rule.family_id,
        childWalletId: rule.child_wallet_id,
        amountCents: rule.amount_cents,
        type: 'allowance',
        description: 'Weekly allowance',
        createdBy: null,
        relatedType: 'allowance_rules',
        relatedId: rule.id,
        occurrence,
        splitOverride: rule.split as Partial<Split> | null,
      });
      if (!res.ok) {
        // The ledger already holds this occurrence: the mirrored 07:00 run, or
        // a retry after a lost answer, got there first. Paid, not failed, and
        // the claim stands — rolling it back is what paid an allowance twice.
        if (res.duplicate) {
          paid++;
          continue;
        }
        if (res.insertFailed) {
          // The insert answered an error, but the ledger may hold the credit
          // anyway (the server committed, the connection dropped). Rolling the
          // schedule back on that answer re-credited the child next run, and
          // nothing refused the second payment. Ask the ledger first, under the
          // occurrence key — the rule's uuid in related_id, the day in metadata.
          const { data: landed, error: landedError } = await supabase
            .from('wallet_transactions')
            .select('id')
            .eq('family_id', rule.family_id)
            .eq('related_type', 'allowance_rules')
            .eq('related_id', rule.id)
            .eq('metadata->>occurrence', occurrence)
            .limit(1);
          if (landedError) {
            // Unknown outcome, and no way to find out this run: the claim stays
            // in place, so the rule is NOT due again until its next date. Paid
            // or not, the child is not paid twice; a run that cannot tell says
            // so and leaves the ledger to a person.
            failed++;
            console.error('Allowance credit outcome unknown and the ledger could not be read; leaving the schedule advanced.', {
              ruleId: rule.id, familyId: rule.family_id, occurrence, error: landedError,
            });
            continue;
          }
          if (landed?.length) {
            paid++;
            console.error('Allowance credit answered an error after it landed; counted as paid.', {
              ruleId: rule.id, familyId: rule.family_id, occurrence, error: res.error,
            });
            continue;
          }
        }
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

    // Both sides of the merge: main's failed-count and 502 (one bad rule must
    // not end the platform's run, and the run must not report ok when it did),
    // plus this branch's skippedUnauthored (a rule whose author is not an
    // active manager is not paid, and says so rather than vanishing).
    const ok = failed === 0;
    return NextResponse.json(
      { ok, due, paid, skippedFree, skippedUnauthored, failed },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Allowance cron error:', err);
    return NextResponse.json({ error: t('walletAllowance.allowanceRunFailed') }, { status: 500 });
  }
}
