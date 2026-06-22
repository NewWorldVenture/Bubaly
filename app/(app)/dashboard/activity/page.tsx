import type { Metadata } from 'next';
import { Activity as ActivityIcon, Megaphone, CalendarPlus, CheckCircle2, Image as ImageIcon, StickyNote, ShoppingCart } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Avatar } from '@/components/ui/avatar';
import { mergeActivity, relativeTime, type ActivityItem, type ActivityKind } from '@/lib/activity/feed';

export const metadata: Metadata = { title: 'Activity' };
export const dynamic = 'force-dynamic';

const KIND_ICON: Record<ActivityKind, typeof Megaphone> = {
  announcement: Megaphone, event: CalendarPlus, chore: CheckCircle2, photo: ImageIcon, note: StickyNote, grocery: ShoppingCart,
};
const KIND_TINT: Record<ActivityKind, string> = {
  announcement: 'text-violet-300 bg-violet-500/15',
  event: 'text-blue-300 bg-blue-500/15',
  chore: 'text-emerald-300 bg-emerald-500/15',
  photo: 'text-pink-300 bg-pink-500/15',
  note: 'text-amber-300 bg-amber-500/15',
  grocery: 'text-cyan-300 bg-cyan-500/15',
};

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

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const memberByUser = new Map((members ?? []).filter((m) => m.user_id).map((m) => [m.user_id as string, m]));

  // Resolve chore titles.
  const choreIds = [...new Set((chores ?? []).map((c) => c.chore_id))];
  const { data: choreRows } = choreIds.length
    ? await supabase.from('chores').select('id, title').in('id', choreIds)
    : { data: [] as { id: string; title: string }[] };
  const choreTitle = new Map((choreRows ?? []).map((c) => [c.id, c.title]));

  const sources: ActivityItem[][] = [
    (announcements ?? []).map((a) => ({ id: `a-${a.id}`, kind: 'announcement' as const, text: `posted “${a.title}”`, at: a.created_at, memberId: a.author_member_id })),
    (events ?? []).map((e) => ({ id: `e-${e.id}`, kind: 'event' as const, text: `added event “${e.title}”`, at: e.created_at, memberId: e.assignee_id })),
    (chores ?? []).map((c) => ({ id: `c-${c.id}`, kind: 'chore' as const, text: `completed “${choreTitle.get(c.chore_id) ?? 'a chore'}”`, at: c.approved_at as string, memberId: c.member_id })),
    (photos ?? []).map((p) => ({ id: `p-${p.id}`, kind: 'photo' as const, text: p.caption ? `added photo “${p.caption}”` : 'added a photo', at: p.created_at, userId: p.uploaded_by })),
    (notes ?? []).map((n) => ({ id: `n-${n.id}`, kind: 'note' as const, text: `added note${n.title ? ` “${n.title}”` : ''}`, at: n.created_at, userId: n.created_by })),
    (grocery ?? []).map((g) => ({ id: `g-${g.id}`, kind: 'grocery' as const, text: `added “${g.name}” to groceries`, at: g.created_at, userId: g.created_by })),
  ];

  const feed = mergeActivity(sources, 60);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <ActivityIcon className="h-5 w-5 text-brand" />
        <h1 className="text-lg font-bold">Family Activity</h1>
      </div>

      {feed.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-surface/40 py-16 text-center">
          <ActivityIcon className="h-10 w-10 text-muted/40" />
          <p className="mt-3 text-muted">No activity yet — it&apos;ll appear here as your family uses Bubaly.</p>
        </div>
      ) : (
        <ul className="space-y-1">
          {feed.map((item) => {
            const Icon = KIND_ICON[item.kind];
            const who = item.memberId ? memberById.get(item.memberId) : item.userId ? memberByUser.get(item.userId) : undefined;
            return (
              <li key={item.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-surface/40">
                <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${KIND_TINT[item.kind]}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className="font-semibold">{who?.display_name ?? 'Someone'}</span> {item.text}
                  </p>
                </div>
                {who && <Avatar name={who.display_name} color={who.color} size={24} />}
                <span className="shrink-0 text-xs text-muted">{relativeTime(item.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
