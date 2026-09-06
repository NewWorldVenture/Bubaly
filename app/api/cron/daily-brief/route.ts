import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { buildBrief } from '@/lib/briefing/build';
import { collectBriefSource } from '@/lib/briefing/collect';
import { loadBrief, markDelivered, saveBrief } from '@/lib/briefing/store';
import { getAISettings } from '@/lib/services/ai-settings';
import { notify } from '@/lib/services/notifications';
import { dayKeyInTz, hourInTz } from '@/lib/services/scope';
import type { ServiceScope } from '@/lib/services/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

// The Daily Brief's delivery half (§49).
//
// Until now the brief had exactly one composer — a POST handler a page calls
// when somebody opens it — so the brief existed only if a person went looking
// for it, `markDelivered` and `loadBrief` had zero callers, and
// `home_briefs.delivered_at` was written by nothing. A brief that arrives only
// when asked for is not a brief; it is a page.
//
// SENT ONCE: `markDelivered` is a compare-and-set on `delivered_at is null`, so
// two overlapping ticks, a retried invocation, and the Vercel cron racing the
// GitHub dispatcher all produce exactly one notification. The stamp is taken
// AFTER the notification, because the failure worth avoiding is a family being
// told twice and the failure this risks is a brief arriving on the next tick.
//
// COMPOSED DETERMINISTICALLY: `buildBrief` is pure and needs no model, so this
// costs no tokens and cannot invent anything. The model's version is what the
// page adds on top when a person opens it.
const TICK_BUDGET_MS = 100_000;
const MAX_FAMILIES_PER_TICK = 40;
/** The family-local hour the brief is delivered. */
const DELIVERY_HOUR = 7;

type DB = SupabaseClient<Database>;

function systemScope(db: DB, familyId: string, tz: string, now: Date): ServiceScope {
  return { db, familyId, userId: null, memberId: null, role: 'system', actorKind: 'system', tz, now };
}

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const deadline = startedAt + TICK_BUDGET_MS;
  const db = createServiceClient();
  const now = new Date();

  const { data: families, error } = await db
    .from('families')
    .select('id, timezone')
    .limit(MAX_FAMILIES_PER_TICK * 8);
  if (error) {
    console.error('[cron:daily-brief] could not read families', error);
    return NextResponse.json({ error: 'Could not read families' }, { status: 500 });
  }

  // Only families whose own clock says it is the delivery hour. The dispatcher
  // runs this often enough that every timezone gets its own 7am.
  const due = (families ?? [])
    .filter((f) => hourInTz(now, f.timezone ?? 'America/New_York') === DELIVERY_HOUR)
    .slice(0, MAX_FAMILIES_PER_TICK);

  let delivered = 0;
  let skipped = 0;
  const problems: string[] = [];

  for (const family of due) {
    if (Date.now() > deadline) break;
    const tz = family.timezone ?? 'America/New_York';
    const scope = systemScope(db, family.id, tz, now);

    // The family's own switch. A paused Bubaly does not send a morning brief.
    const settings = await getAISettings(scope);
    if (!settings.enabled) { skipped += 1; continue; }

    const asOfDate = dayKeyInTz(now, tz);
    const existing = await loadBrief(scope, { asOfDate, kind: 'daily' }, { db });
    if (existing.ok && existing.data?.deliveredAt) { skipped += 1; continue; }

    let briefId = existing.ok ? existing.data?.id ?? null : null;
    let headline = existing.ok ? existing.data?.brief.headline ?? null : null;

    if (!briefId) {
      // Nobody opened the page today, so compose it here — deterministically.
      const source = await collectBriefSource(db, { familyId: family.id, tz, now });
      const brief = buildBrief({ kind: 'daily', now, ...source }, tz);
      const saved = await saveBrief(scope, brief, { db });
      if (!saved.ok) { problems.push(family.id); continue; }
      briefId = saved.data.id;
      headline = brief.headline;
      // A family with genuinely nothing on is not worth waking up for.
      if (brief.isSparse) { skipped += 1; continue; }
    }

    const sent = await notify(scope, {
      recipients: 'managers',
      type: 'system',
      title: 'Your family brief is ready',
      body: headline,
      relatedType: 'home_brief',
      relatedId: briefId,
    });
    if (!sent.ok) { problems.push(family.id); continue; }

    // The stamp is what makes this once. Taken after the send: a lost stamp
    // costs a duplicate on the next tick; a stamp taken first costs the brief.
    const stamped = await markDelivered(scope, briefId, { db });
    if (!stamped.ok) { problems.push(family.id); continue; }
    if (stamped.data) delivered += 1; else skipped += 1;
  }

  return NextResponse.json({
    ok: problems.length === 0,
    considered: due.length,
    delivered,
    skipped,
    problems: problems.length,
    ms: Date.now() - startedAt,
  });
}
