import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { sendReactEmail } from '@/lib/email';
import { WeeklyDigestEmail } from '@/lib/emails/weekly-digest';
import * as React from 'react';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { loadCompareLine } from '@/lib/network/compare-line-server';
import { renderCompareLine } from '@/lib/network/compare-line';

// Runs every Monday at 08:00 UTC via Vercel Cron.
// Sends each family a summary of the week ahead: events, due chores, meal count.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('weeklyDigest.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();

  const weekStart = new Date().toISOString();
  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: families, error: familiesError } = await supabase.from('families').select('id, name');
  if (familiesError) {
    console.error('Weekly digest family read error:', familiesError);
    return NextResponse.json({ error: t('weeklyDigest.weeklyDigestProcessingFailed') }, { status: 500 });
  }
  if (!families?.length) return NextResponse.json({ sent: 0 });

  const { data: authUsers, error: authUsersError } = await supabase.auth.admin.listUsers();
  if (authUsersError) {
    console.error('Weekly digest user read error:', authUsersError);
    return NextResponse.json({ error: t('weeklyDigest.weeklyDigestProcessingFailed') }, { status: 500 });
  }
  const emailByUserId = new Map(
    (authUsers?.users ?? []).map((u) => [u.id, u.email ?? null]),
  );

  let sent = 0;
  let failed = 0;
  for (const family of families) {
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
      continue;
    }

    if (!members?.length) continue;

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
      continue;
    }

    if (!adminMember?.user_id) continue;
    const adminEmail = emailByUserId.get(adminMember.user_id);
    if (!adminEmail) continue;

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
  }

  return NextResponse.json({ sent, failed }, { status: failed === 0 ? 200 : 502 });
}
