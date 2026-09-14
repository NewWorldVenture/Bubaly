import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
import { sendReactEmail } from '@/lib/email';
import { ChoreReminderEmail } from '@/lib/emails/chore-reminder';
import * as React from 'react';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { readAllAuthUsers } from '@/lib/supabase/read-all-auth-users';

export const runtime = 'nodejs';
// A chosen budget rather than the platform default. The loop is one family (or
// one member) at a time with a network send in it, and a run killed mid-loop
// always walks the same ordered prefix, so the tail of the customer base would
// never be reached — silently, since nothing records where a run stopped.
export const maxDuration = 300;

// Runs every Sunday at 18:00 UTC via Vercel Cron.
// Finds every family member who has open chore assignments due this week and emails them.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('choreReminders.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();

  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch open assignments due within the next 7 days
  // Every one, not the first thousand: an unbounded select stops at PostgREST's
  // row ceiling and reports nothing, so the reminders past it would simply never
  // be sent. See lib/supabase/read-all.ts.
  type AssignmentRow = {
    id: string; member_id: string; due_at: string | null; family_id: string;
    chores: { title: string; points: number } | { title: string; points: number }[] | null;
    family_members: { display_name: string; user_id: string | null } | { display_name: string; user_id: string | null }[] | null;
  };
  // The embedded relations are adapted here rather than typed through readAll:
  // lib/database.types.ts is hand-authored and declares no relationships, so
  // supabase-js types an embed as SelectQueryError. The runtime shape is what
  // the loop below already handles with its Array.isArray guards.
  const { rows: assignments, error } = await readAll<AssignmentRow>(async (from, to) => {
    const page = await supabase
      .from('chore_assignments')
      .select('id, member_id, due_at, family_id, chores(title, points), family_members!member_id(display_name, user_id)')
      .in('status', ['todo', 'in_progress'])
      .not('due_at', 'is', null)
      .lte('due_at', weekEnd)
      .order('id')
      .range(from, to);
    return { data: (page.data ?? []) as unknown as AssignmentRow[], error: page.error };
  });

  if (error) {
    console.error('Cron chore fetch error:', error);
    return NextResponse.json({ error: t('choreReminders.choreReminderProcessingFailed') }, { status: 500 });
  }

  // Group by member_id
  type MemberBucket = {
    userId: string;
    memberName: string;
    familyName: string;
    chores: { title: string; points: number; dueAt: string | null }[];
  };
  const byMember = new Map<string, MemberBucket>();

  for (const a of assignments ?? []) {
    const member = Array.isArray(a.family_members) ? a.family_members[0] : a.family_members;
    const chore = Array.isArray(a.chores) ? a.chores[0] : a.chores;
    if (!member?.user_id || !chore) continue;

    if (!byMember.has(a.member_id)) {
      // Fetch family name separately since chore_assignments doesn't join families
      byMember.set(a.member_id, {
        userId: member.user_id,
        memberName: member.display_name,
        familyName: '',
        chores: [],
      });
    }
    byMember.get(a.member_id)!.chores.push({
      title: chore.title,
      points: chore.points,
      dueAt: a.due_at,
    });
  }

  if (byMember.size === 0) {
    return NextResponse.json({ sent: 0, message: 'No pending assignments' });
  }

  // Fetch family names
  const familyIds = [...new Set((assignments ?? []).map((a) => a.family_id))];
  const { data: families, error: familiesError } = await supabase.from('families').select('id, name').in('id', familyIds);
  if (familiesError) {
    console.error('Cron chore family read error:', familiesError);
    return NextResponse.json({ error: t('choreReminders.choreReminderProcessingFailed') }, { status: 500 });
  }
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));

  // Patch family names back in
  for (const a of assignments ?? []) {
    const bucket = byMember.get(a.member_id);
    if (bucket && !bucket.familyName) bucket.familyName = familyNameById.get(a.family_id) ?? 'your family';
  }

  // Fetch emails
  const userIds = [...byMember.values()].map((v) => v.userId);
  // Every auth user, not the first fifty — see lib/supabase/read-all-auth-users.
  const { users: authUsers, error: authUsersError } = await readAllAuthUsers((params) =>
    supabase.auth.admin.listUsers(params),
  );
  if (authUsersError) {
    console.error('Cron chore user read error:', authUsersError);
    return NextResponse.json({ error: t('choreReminders.choreReminderProcessingFailed') }, { status: 500 });
  }
  const emailByUserId = new Map(
    authUsers
      .filter((u) => userIds.includes(u.id))
      .map((u) => [u.id, u.email ?? null]),
  );

  let sent = 0;
  let failed = 0;
  // A member with no email on file is neither sent nor failed. Counting it is
  // the difference between "nobody was due" and "nobody could be reached".
  let skipped = 0;
  for (const [, { userId, memberName, familyName, chores }] of byMember) {
    const email = emailByUserId.get(userId);
    if (!email) { skipped++; continue; }
    const { ok } = await sendReactEmail({
      to: email,
      subject: `${chores.length} chore${chores.length !== 1 ? 's' : ''} coming up this week`,
      react: React.createElement(ChoreReminderEmail, { memberName, familyName, chores }),
    });
    if (ok) sent++;
    else failed++;
  }

  return NextResponse.json({ sent, failed, skipped }, { status: failed === 0 ? 200 : 502 });
}
