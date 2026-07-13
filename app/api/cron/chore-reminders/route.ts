import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { sendReactEmail } from '@/lib/email';
import { ChoreReminderEmail } from '@/lib/emails/chore-reminder';
import * as React from 'react';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

// Runs every Sunday at 18:00 UTC via Vercel Cron.
// Finds every family member who has open chore assignments due this week and emails them.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch open assignments due within the next 7 days
  const { data: assignments, error } = await supabase
    .from('chore_assignments')
    .select('id, member_id, due_at, family_id, chores(title, points), family_members!member_id(display_name, user_id)')
    .in('status', ['todo', 'in_progress'])
    .not('due_at', 'is', null)
    .lte('due_at', weekEnd);

  if (error) {
    console.error('Cron chore fetch error:', error);
    return NextResponse.json({ error: 'Chore reminder processing failed.' }, { status: 500 });
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
  const { data: families } = await supabase.from('families').select('id, name').in('id', familyIds);
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));

  // Patch family names back in
  for (const a of assignments ?? []) {
    const bucket = byMember.get(a.member_id);
    if (bucket && !bucket.familyName) bucket.familyName = familyNameById.get(a.family_id) ?? 'your family';
  }

  // Fetch emails
  const userIds = [...byMember.values()].map((v) => v.userId);
  const { data: authUsers } = await supabase.auth.admin.listUsers();
  const emailByUserId = new Map(
    (authUsers?.users ?? [])
      .filter((u) => userIds.includes(u.id))
      .map((u) => [u.id, u.email ?? null]),
  );

  let sent = 0;
  for (const [, { userId, memberName, familyName, chores }] of byMember) {
    const email = emailByUserId.get(userId);
    if (!email) continue;
    const { ok } = await sendReactEmail({
      to: email,
      subject: `${chores.length} chore${chores.length !== 1 ? 's' : ''} coming up this week`,
      react: React.createElement(ChoreReminderEmail, { memberName, familyName, chores }),
    });
    if (ok) sent++;
  }

  return NextResponse.json({ sent });
}
