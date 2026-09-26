import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { listAllAuthUsers } from '@/lib/server/list-all-auth-users';
import { readAll } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { sendReactEmail } from '@/lib/email';
import { ChoreReminderEmail } from '@/lib/emails/chore-reminder';
import * as React from 'react';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

// Runs every Sunday at 18:00 UTC via Vercel Cron.
// Finds every family member who has open chore assignments due this week and emails them.
//
// Budgeted and bounded, for the same reason as weekly-digest: the send loop is
// serial and one email API call deep per recipient, `byMember` preserves the
// order the assignments came back in, and there is no cursor. A run killed
// mid-loop therefore serves the same prefix of members every week and never
// reaches the tail — the members in it simply stop getting reminders, and the
// 200 says everything went fine. A declared budget is a chosen limit rather
// than one inherited from the platform default.
export const runtime = 'nodejs';
export const maxDuration = 300;

// Below maxDuration with room to finish the sends already in flight.
const BUDGET_MS = 260_000;
// Concurrency against provider latency, not CPU.
const CONCURRENCY = 8;
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
  // Batched: the assignments read above is paged and unbounded, so this id list
  // is every family with an open chore. One `.in()` carrying a thousand uuids
  // builds a URL of roughly 40 KB — past the gateway's request-line limit the
  // read fails outright, and the branch below turns that into a 500 for the
  // whole run, so nobody gets a chore reminder rather than one family losing
  // its name from the copy.
  const familyIds = [...new Set((assignments ?? []).map((a) => a.family_id))];
  const { data: families, error: familiesError } = await readInChunks<{ id: string; name: string }, { message: string }>(
    familyIds,
    (chunk) => supabase.from('families').select('id, name').in('id', chunk),
  );
  if (familiesError) {
    console.error('Cron chore family read error:', familiesError);
    return NextResponse.json({ error: t('choreReminders.choreReminderProcessingFailed') }, { status: 500 });
  }
  const familyNameById = new Map(families.map((f) => [f.id, f.name]));

  // Patch family names back in
  for (const a of assignments ?? []) {
    const bucket = byMember.get(a.member_id);
    if (bucket && !bucket.familyName) bucket.familyName = familyNameById.get(a.family_id) ?? 'your family';
  }

  // Fetch emails
  const userIds = [...byMember.values()].map((v) => v.userId);
  // Every auth user, not GoTrue's default first 50 — `listUsers()` with no
  // arguments is ONE page. The filter below narrows to the members who have a
  // reminder due, but it can only narrow what was read: a member past the first
  // page has no email here and was skipped silently.
  const { users: allAuthUsers, error: authUsersError } = await listAllAuthUsers(supabase);
  if (authUsersError) {
    console.error('Cron chore user read error:', authUsersError);
    return NextResponse.json({ error: t('choreReminders.choreReminderProcessingFailed') }, { status: 500 });
  }
  const emailByUserId = new Map(
    allAuthUsers
      .filter((u) => userIds.includes(u.id))
      .map((u) => [u.id, u.email ?? null]),
  );

  let sent = 0;
  let failed = 0;
  // A member with no email on file is neither sent nor failed. Counting it is
  // the difference between "nobody was due" and "nobody could be reached" — and
  // it is not a failed run, because there is nothing here to retry.
  let skipped = 0;
  // Recipients this run never ATTEMPTED, because the budget ran out. That one
  // IS a failed run, so it decides the status below.
  let unserved = 0;
  const startedAt = Date.now();

  const remind = async ({ userId, memberName, familyName, chores }: MemberBucket) => {
    const email = emailByUserId.get(userId);
    if (!email) { skipped++; return; }
    const { ok } = await sendReactEmail({
      to: email,
      subject: `${chores.length} chore${chores.length !== 1 ? 's' : ''} coming up this week`,
      react: React.createElement(ChoreReminderEmail, { memberName, familyName, chores }),
    });
    if (ok) sent++;
    else failed++;
  };

  const recipients = [...byMember.values()];
  for (let i = 0; i < recipients.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > BUDGET_MS) {
      unserved = recipients.length - i;
      console.error(`[chore-reminders] budget reached with ${unserved} recipients unreminded`);
      break;
    }
    await Promise.all(recipients.slice(i, i + CONCURRENCY).map(remind));
  }

  // `unserved` counts recipients this run never attempted. A 200 here would
  // make an unreminded tail look like a clean run. A `skipped` member has no
  // address to reach and nothing to retry, so it is reported without making the
  // run a failure.
  const ok = failed === 0 && unserved === 0;
  return NextResponse.json(
    { sent, failed, skipped, ...(unserved > 0 ? { unserved } : {}) },
    { status: ok ? 200 : 502 },
  );
}
