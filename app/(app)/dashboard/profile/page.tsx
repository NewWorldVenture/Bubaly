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

  // The member identity is the primary content and safely falls back to the
  // already-loaded ctx member, so we don't fail the whole page closed. The
  // contribution STATS are a secondary enhancement that degrades to 0 on a read
  // failure — but a silently-swallowed error would make "0 points / 0 chores"
  // indistinguishable from a real read failure, so log each so it's diagnosable.
  if (doneQ.error) console.error('[dashboard/profile] chore-points read failed', { memberId, error: doneQ.error });
  if (upcomingQ.error) console.error('[dashboard/profile] upcoming-events read failed', { memberId, error: upcomingQ.error });
  if (milestonesQ.error) console.error('[dashboard/profile] milestones read failed', { memberId, error: milestonesQ.error });

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
