import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { mergeActivity, type ActivityItem } from '@/lib/activity/feed';
import { ActivityFeed } from './activity-feed';

export const metadata: Metadata = { title: 'Activity' };
export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [
    { data: members },
    { data: announcements },
    { data: events },
    { data: chores },
    { data: photos },
    { data: notes },
    { data: grocery },
  ] = await Promise.all([
    supabase.from('family_members').select('id, user_id, display_name, color').eq('family_id', familyId),
    supabase.from('family_announcements').select('id, title, created_at, author_member_id').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('calendar_events').select('id, title, created_at, assignee_id').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('chore_assignments').select('id, chore_id, member_id, approved_at').eq('family_id', familyId).not('approved_at', 'is', null).order('approved_at', { ascending: false }).limit(20),
    supabase.from('family_photos').select('id, caption, created_at, uploaded_by').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('notes').select('id, title, created_at, created_by').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
    supabase.from('grocery_items').select('id, name, created_at, created_by').eq('family_id', familyId).order('created_at', { ascending: false }).limit(20),
  ]);

  const memberList = (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name, color: m.color }));
  const memberById = Object.fromEntries(memberList.map((m) => [m.id, m]));
  const memberByUser = Object.fromEntries(
    (members ?? []).filter((m) => m.user_id).map((m) => [m.user_id as string, { id: m.id, display_name: m.display_name, color: m.color }]),
  );

  const choreIds = [...new Set((chores ?? []).map((c) => c.chore_id))];
  const { data: choreRows } = choreIds.length
    ? await supabase.from('chores').select('id, title').in('id', choreIds)
    : { data: [] as { id: string; title: string }[] };
  const choreTitle = new Map((choreRows ?? []).map((c) => [c.id, c.title]));

  const sources: ActivityItem[][] = [
    (announcements ?? []).map((a) => ({ id: `a-${a.id}`, kind: 'announcement' as const, text: `posted "${a.title}"`, at: a.created_at, memberId: a.author_member_id })),
    (events ?? []).map((e) => ({ id: `e-${e.id}`, kind: 'event' as const, text: `added event "${e.title}"`, at: e.created_at, memberId: e.assignee_id })),
    (chores ?? []).map((c) => ({ id: `c-${c.id}`, kind: 'chore' as const, text: `completed "${choreTitle.get(c.chore_id) ?? 'a chore'}"`, at: c.approved_at as string, memberId: c.member_id })),
    (photos ?? []).map((p) => ({ id: `p-${p.id}`, kind: 'photo' as const, text: p.caption ? `added photo "${p.caption}"` : 'added a photo', at: p.created_at, userId: p.uploaded_by })),
    (notes ?? []).map((n) => ({ id: `n-${n.id}`, kind: 'note' as const, text: `added note${n.title ? ` "${n.title}"` : ''}`, at: n.created_at, userId: n.created_by })),
    (grocery ?? []).map((g) => ({ id: `g-${g.id}`, kind: 'grocery' as const, text: `added "${g.name}" to groceries`, at: g.created_at, userId: g.created_by })),
  ];

  const feed = mergeActivity(sources, 60);

  return (
    <ActivityFeed
      feed={feed}
      memberById={new Map(Object.entries(memberById))}
      memberByUser={new Map(Object.entries(memberByUser))}
      members={memberList}
    />
  );
}
