import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { sendReactEmail } from '@/lib/email';
import { WeeklyDigestEmail } from '@/lib/emails/weekly-digest';
import * as React from 'react';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

// Runs every Monday at 08:00 UTC via Vercel Cron.
// Sends each family a summary of the week ahead: events, due chores, meal count.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  const weekStart = new Date().toISOString();
  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: families, error: familiesError } = await supabase.from('families').select('id, name');
  if (familiesError) {
    console.error('Weekly digest family read error:', familiesError);
    return NextResponse.json({ error: 'Weekly digest processing failed.' }, { status: 500 });
  }
  if (!families?.length) return NextResponse.json({ sent: 0 });

  const { data: authUsers, error: authUsersError } = await supabase.auth.admin.listUsers();
  if (authUsersError) {
    console.error('Weekly digest user read error:', authUsersError);
    return NextResponse.json({ error: 'Weekly digest processing failed.' }, { status: 500 });
  }
  const emailByUserId = new Map(
    (authUsers?.users ?? []).map((u) => [u.id, u.email ?? null]),
  );

  let sent = 0;
  let failed = 0;
  for (const family of families) {
    const [{ data: events, error: eventsError }, { data: chores, error: choresError }, { data: meals, error: mealsError }, { data: members, error: membersError }] = await Promise.all([
      supabase.from('calendar_events').select('title, starts_at').eq('family_id', family.id)
        .gte('starts_at', weekStart).lte('starts_at', weekEnd).order('starts_at').limit(10),
      supabase.from('chores').select('title, points, assignee_id').eq('family_id', family.id)
        .in('status', ['todo', 'in_progress']).not('assignee_id', 'is', null),
      supabase.from('meal_plans').select('id').eq('family_id', family.id)
        .gte('planned_for', weekStart.slice(0, 10)).lte('planned_for', weekEnd.slice(0, 10)),
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
        openChores: chores?.length ?? 0,
        mealsPlanned: meals?.length ?? 0,
        memberCount: members?.length ?? 0,
      }),
    });
    if (ok) sent++;
    else failed++;
  }

  return NextResponse.json({ sent, failed }, { status: failed === 0 ? 200 : 502 });
}
