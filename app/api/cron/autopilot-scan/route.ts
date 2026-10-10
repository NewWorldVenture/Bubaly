import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import type { LocaleCode } from '@/lib/i18n/locales';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createServiceClient } from '@/lib/supabase/server';
import { runAutopilotScan } from '@/lib/autopilot/scan';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { readAll } from '@/lib/supabase/read-all';
import { getFeatureTiersByHref, resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';

const AUTOPILOT_FEATURE_HREF = '/dashboard/autopilot';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * The pass stops STARTING families once this much of `maxDuration` is spent,
 * so it returns a summary instead of being killed mid-loop. Families it did not
 * reach are counted and named rather than silently dropped.
 */
const TIME_BUDGET_MS = 45_000;
/** Families scanned at once. Bounded: each scan is a burst of reads and writes. */
const FAMILY_CONCURRENCY = 4;
const DAY_MS = 86_400_000;

// The scan STORES suggestion titles, and the subscription ones carry money
// ("$15.99 charge: Netflix tomorrow"). This cron has no reader to word them for:
// a family's language lives only in the browsing member's cookie, with no column
// on any family, member or profile row to read here (I18N-001). So it is en-US,
// said out loud rather than inherited from a request that does not exist. What
// these stored words still reach is the push/email notification the scan sends
// (lib/autopilot/scan.ts, recipients 'family', with no per-recipient locale to
// use) — not the screens: the Autopilot module, the home dashboard and the Calm
// page word a subscription title again for their reader from the facts in its
// payload (autopilotTitleFor in lib/autopilot/engine.ts).
const SUGGESTION_LOCALE: LocaleCode = 'en-US';
const suggestionText = (key: string, params?: Record<string, string | number>) => translate(getMessages(SUGGESTION_LOCALE), key, params);

// Family Autopilot cron — the "invisible product". Runs the prediction engine
// on a schedule so predictions and reversible auto-actions happen WITHOUT
// anyone opening the app. Scheduled via Vercel Cron.
//
// For ENTITLED families only. It used to run for every family on the platform,
// which made a Plus feature do its full work for families that do not have it:
// the scan writes behavioural traits to `family_digital_twin_profiles`,
// auto-creates `reminders` and `grocery_items`, and pushes notifications. The
// page and the resolve action are both gated, so those families could not open
// Autopilot to see where any of it came from, or dismiss it.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('autopilotScan.unauthorized') }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    // `.limit(N)` is not a bound — PostgREST caps a response at db-max-rows
    // whatever the client asked for, so this quietly read 1,000. `max` is the
    // same ceiling, honoured by paging to it. See lib/supabase/read-all.ts.
    // `timezone` is selected alongside `id` because the scan needs each
    // family's own day, and this loop is already holding that family's row.
    // A cron over every family is NOT a reason to fall back to Greenwich —
    // it runs at 06:30 UTC, which is 23:30 the previous day in Los Angeles,
    // so a Greenwich "today" here is the wrong day for the whole US west
    // coast on every single run.
    const { rows: families, error } = await readAll((from, to) => supabase
      .from('families').select('id, timezone').order('id').range(from, to), { max: 5000 });
    if (error) throw error;

    // Read once for the whole pass rather than per family. An unreadable tier
    // map fails the pass (the catch below): the catalog default is not the
    // configured tier, so it cannot decide who Autopilot runs for.
    const tiers = await getFeatureTiersByHref(supabase, { onUnavailable: 'throw' });

    let scanned = 0;
    let autoExecuted = 0;
    let notified = 0;
    let policyCandidates = 0;
    let skipped = 0;
    let failures = 0;
    const started = Date.now();
    // The start point rotates by day. Ordered by id and cut off by the budget,
    // the same lowest-id families were served first every day and the ones
    // after the cut-off never at all.
    const all = families ?? [];
    const offset = all.length > 0 ? Math.floor(started / DAY_MS) % all.length : 0;
    const queue = [...all.slice(offset), ...all.slice(0, offset)];
    const unreached: string[] = [];
    let cursor = 0;
    const scanFamily = async (fam: { id: string; timezone: string | null }) => {
      try {
        // Inside the per-family try on purpose. `resolveFeatureEntitlement`
        // throws when the plan cannot be read, and an unreadable plan is not an
        // unentitled family — that counts as a failure for this family, never
        // as a silent skip.
        const entitlement = await resolveFeatureEntitlement(supabase, fam.id, AUTOPILOT_FEATURE_HREF, tiers);
        if (!entitlement.allowed) { skipped++; return; }

        const r = await runAutopilotScan(supabase, fam.id, null, fam.timezone || 'UTC', SUGGESTION_LOCALE, suggestionText);
        scanned += r.scanned;
        autoExecuted += r.autoExecuted;
        notified += r.notified;
        policyCandidates += r.policyCandidates;
      } catch (err) {
        failures++;
        console.error(`Autopilot cron failed for family ${fam.id}:`, err);
      }
    };
    const worker = async () => {
      while (cursor < queue.length) {
        const fam = queue[cursor++];
        if (Date.now() - started >= TIME_BUDGET_MS) { unreached.push(fam.id); continue; }
        await scanFamily(fam);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FAMILY_CONCURRENCY, queue.length) }, worker));
    if (unreached.length > 0) {
      console.error(`Autopilot cron ran out of time: ${unreached.length} families not scanned`, unreached.slice(0, 50));
    }

    // A family the pass never reached is a family it failed, not a success.
    const scanFailures = failures;
    failures += unreached.length;
    const ok = failures === 0;
    return NextResponse.json(
      {
        ok, families: all.length, entitled: all.length - unreached.length - skipped - scanFailures, skipped, scanned, autoExecuted, notified, policyCandidates, failures,
        unreached: unreached.length, unreachedFamilies: unreached.slice(0, 50),
      },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Autopilot cron error:', err);
    return NextResponse.json({ error: t('autopilotScan.autopilotCronFailed') }, { status: 500 });
  }
}
