import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ProfileModule, type ProfileStats } from '@/components/modules/profile-module';

export const metadata: Metadata = { title: 'Profile' };
export const dynamic = 'force-dynamic';

/** Personal identity surface: who you are here + what you've contributed. */
export default async function ProfilePage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const memberId = ctx.active.member.id;
  const familyId = ctx.active.familyId;

  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const weekAhead = new Date(Date.now() + 7 * 86400_000).toISOString();
  const nowIso = new Date().toISOString();

  const [{ data: member }, doneQ, upcomingQ, milestonesQ] = await Promise.all([
    supabase.from('family_members').select('*').eq('id', memberId).maybeSingle(),
    supabase.from('chore_assignments')
      .select('points_awarded, approved_at')
      .eq('family_id', familyId).eq('member_id', memberId)
      .not('approved_at', 'is', null).gte('approved_at', monthAgo).limit(500),
    supabase.from('calendar_events')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('assignee_id', memberId)
      .gte('starts_at', nowIso).lt('starts_at', weekAhead),
    supabase.from('independence_milestones')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('member_id', memberId).eq('status', 'achieved'),
  ]);

  const done = doneQ.data ?? [];
  const stats: ProfileStats = {
    points30d: done.reduce((s, r) => s + (r.points_awarded ?? 0), 0),
    choresDone30d: done.length,
    upcoming7d: upcomingQ.count ?? 0,
    milestones: milestonesQ.count ?? 0,
  };

  return (
    <ProfileModule
      member={member ?? ctx.active.member}
      userId={ctx.user.id}
      userEmail={ctx.user.email ?? ''}
      stats={stats}
    />
  );
}
