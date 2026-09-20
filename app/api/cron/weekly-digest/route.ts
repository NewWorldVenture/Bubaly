import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { listAllAuthUsers } from '@/lib/server/list-all-auth-users';
import { readAll } from '@/lib/supabase/read-all';
import { settleAll } from '@/lib/supabase/settle';
import { sendReactEmail } from '@/lib/email';
import { WeeklyDigestEmail } from '@/lib/emails/weekly-digest';
import * as React from 'react';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { loadCompareLine } from '@/lib/network/compare-line-server';
import { renderCompareLine } from '@/lib/network/compare-line';

// Runs every Monday at 08:00 UTC via Vercel Cron.
// Sends each family a summary of the week ahead: events, due chores, meal count.
//
// Budgeted and bounded, because an unbounded serial loop over every family is
// not merely slow here — it is silently unfair. The loop walks `families` in the
// same `order('id')` every week and keeps no cursor, so when the run is killed
// mid-loop the SAME prefix is served every time and the tail is never served at
// all: a stable, invisible partition of the customer base, and the families in
// it simply never receive a digest.
//
// Two changes follow from that. A declared budget, matching provider-sync,
// library-feeds and marketing, so the limit is chosen rather than inherited from
// the platform default. And bounded concurrency, because each family costs two
// to four sequential round trips plus an email API call, which serially is what
// makes the run outgrow any budget at all.
//
// If the budget is reached anyway, the run reports what it did NOT reach and
// answers 502 rather than 200 — the tail being unserved is exactly the thing
// that must not look like a clean run.
export const runtime = 'nodejs';
export const maxDuration = 300;

// Below maxDuration with room to finish the families already in flight and to
// write the response.
const BUDGET_MS = 260_000;
// Each family is mostly waiting on Supabase and the email provider, so this is
// concurrency against latency, not CPU.
const CONCURRENCY = 8;
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('weeklyDigest.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();

  const weekStart = new Date().toISOString();
  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Every household, not the first thousand. An unbounded select is capped at
  // PostgREST's db-max-rows and says nothing, so families past that ceiling
  // would silently never receive a digest.
  const { rows: families, error: familiesError } = await readAll<{ id: string; name: string }>(
    (from, to) => supabase.from('families').select('id, name').order('id').range(from, to),
  );
  if (familiesError) {
    console.error('Weekly digest family read error:', familiesError);
    return NextResponse.json({ error: t('weeklyDigest.weeklyDigestProcessingFailed') }, { status: 500 });
  }
  if (!families?.length) return NextResponse.json({ sent: 0, failed: 0, skipped: 0 });

  // Every auth user, not GoTrue's default first 50. `listUsers()` with no
  // arguments is ONE page, and `families` above is read with readAll — so a
  // truncated recipient map silently drops the digest for every family whose
  // admin sits past that page, without counting a failure.
  const { users: allAuthUsers, error: authUsersError } = await listAllAuthUsers(supabase);
  if (authUsersError) {
    console.error('Weekly digest user read error:', authUsersError);
    return NextResponse.json({ error: t('weeklyDigest.weeklyDigestProcessingFailed') }, { status: 500 });
  }
  const emailByUserId = new Map(
    allAuthUsers.map((u) => [u.id, u.email ?? null]),
  );

  let sent = 0;
  let failed = 0;
  // A family nobody could be emailed for is neither a send nor a send failure,
  // and reporting it as neither is how this route answered 200 while most of
  // the customer base got nothing. It is NOT a failed run, though — there is
  // nothing to retry — so it is reported without turning the status into 502.
  let skipped = 0;
  // Families this run never ATTEMPTED, because the budget ran out. That one is
  // a failed run: the tail being unserved is precisely what must not look
  // clean, so it decides the status below.
  let unserved = 0;
  const startedAt = Date.now();

  const digestFor = async (family: (typeof families)[number]) => {
    // An open chore is an ASSIGNMENT that is still todo/in_progress. `chores` is
    // the definition table — it carries neither `status` nor `assignee_id`, so
    // reading those from it errors and skipped every family's digest. Counts,
    // not rows: only the totals are rendered.
    const [{ data: events, error: eventsError }, { count: openChores, error: choresError }, { count: mealsPlanned, error: mealsError }, { data: members, error: membersError }] = await settleAll([
      supabase.from('calendar_events').select('title, starts_at').eq('family_id', family.id)
        .gte('starts_at', weekStart).lte('starts_at', weekEnd).order('starts_at').limit(10),
      supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id).in('status', ['todo', 'in_progress']),
      supabase.from('meal_plans').select('id', { count: 'exact', head: true })
        .eq('family_id', family.id)
        .gte('plan_date', weekStart.slice(0, 10)).lte('plan_date', weekEnd.slice(0, 10)),
      supabase.from('family_members').select('user_id, display_name').eq('family_id', family.id).eq('is_active', true),
    ]);

    const familyDataError = eventsError ?? choresError ?? mealsError ?? membersError;
    if (familyDataError) {
      console.error(`[weekly-digest] Family data read failed for ${family.id}:`, familyDataError);
      failed++;
      return;
    }

    if (!members?.length) { skipped++; return; }

    const { data: adminMember, error: adminMemberError } = await supabase
      .from('family_members')
      .select('user_id, display_name')
      .eq('family_id', family.id)
      .eq('is_active', true)
      .in('role', ['parent', 'adult'])
      .limit(1)
      .maybeSingle();

    if (adminMemberError) {
      console.error(`[weekly-digest] Admin member read failed for ${family.id}:`, adminMemberError);
      failed++;
      return;
    }

    if (!adminMember?.user_id) { skipped++; return; }
    const adminEmail = emailByUserId.get(adminMember.user_id);
    if (!adminEmail) { skipped++; return; }

    const { ok } = await sendReactEmail({
      to: adminEmail,
      subject: `${family.name} — your week ahead`,
      react: React.createElement(WeeklyDigestEmail, {
        familyName: family.name,
        adminName: adminMember.display_name,
        events: (events ?? []).map((e) => ({ title: e.title, date: e.starts_at.slice(0, 10) })),
        openChores: openChores ?? 0,
        mealsPlanned: mealsPlanned ?? 0,
        memberCount: members?.length ?? 0,
        // One "families like yours" line, only for families opted into benchmarks
        // and only from the k-anonymized rows the nightly aggregation persisted.
        compareLine: renderCompareLine(await loadCompareLine(supabase, family.id), t),
      }),
    });
    if (ok) sent++;
    else failed++;
  };

  for (let i = 0; i < families.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > BUDGET_MS) {
      unserved = families.length - i;
      console.error(`[weekly-digest] budget reached with ${unserved} families unserved`);
      break;
    }
    await Promise.all(families.slice(i, i + CONCURRENCY).map(digestFor));
  }

  // `unserved` counts families this run never attempted. Reporting 200 here
  // would make an unserved tail indistinguishable from a complete run. A
  // `skipped` family has no recipient to reach and nothing to retry, so it is
  // reported but does not make the run a failure.
  const ok = failed === 0 && unserved === 0;
  return NextResponse.json(
    { sent, failed, skipped, ...(unserved > 0 ? { unserved } : {}) },
    { status: ok ? 200 : 502 },
  );
}
