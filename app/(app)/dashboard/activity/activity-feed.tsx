'use client';

import { useMemo, useState } from 'react';
import {
  Activity as ActivityIcon, Megaphone, CalendarPlus, CheckCircle2,
  Image as ImageIcon, StickyNote, ShoppingCart, Filter, Sparkles,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { relativeTime, type ActivityItem, type ActivityKind } from '@/lib/activity/feed';

type Member = { id: string; display_name: string; color: string | null };

const KIND_ICON: Record<ActivityKind, typeof Megaphone> = {
  announcement: Megaphone, event: CalendarPlus, chore: CheckCircle2,
  photo: ImageIcon, note: StickyNote, grocery: ShoppingCart,
};
const KIND_TINT: Record<ActivityKind, string> = {
  announcement: 'text-violet-300 bg-violet-500/15',
  event: 'text-blue-300 bg-blue-500/15',
  chore: 'text-emerald-300 bg-emerald-500/15',
  photo: 'text-pink-300 bg-pink-500/15',
  note: 'text-amber-300 bg-amber-500/15',
  grocery: 'text-cyan-300 bg-cyan-500/15',
};
const KIND_LABELS: Record<ActivityKind, string> = {
  announcement: 'Announcements', event: 'Events', chore: 'Chores',
  photo: 'Photos', note: 'Notes', grocery: 'Groceries',
};
const ALL_KINDS: ActivityKind[] = ['announcement', 'event', 'chore', 'photo', 'note', 'grocery'];

function summarizeFeed(feed: ActivityItem[], memberById: Map<string, Member>): string {
  if (feed.length === 0) return 'No recent activity.';
  const counts: Record<string, number> = {};
  const actors = new Set<string>();
  for (const item of feed) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    const who = item.memberId ? memberById.get(item.memberId)?.display_name : undefined;
    if (who) actors.add(who);
  }
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${KIND_LABELS[k as ActivityKind]?.toLowerCase() ?? k}`);
  const actorList = actors.size > 3
    ? [...actors].slice(0, 3).join(', ') + ` and ${actors.size - 3} more`
    : [...actors].join(', ');
  return `${feed.length} activities (${parts.join(', ')}) from ${actorList || 'your family'}.`;
}

export function ActivityFeed({
  feed,
  memberById,
  memberByUser,
  members,
}: {
  feed: ActivityItem[];
  memberById: Map<string, Member>;
  memberByUser: Map<string, Member>;
  members: Member[];
}) {
  const [filterKind, setFilterKind] = useState<ActivityKind | 'all'>('all');
  const [filterMember, setFilterMember] = useState<string>('all');
  const [showSummary, setShowSummary] = useState(false);

  const filtered = useMemo(() => {
    let items = feed;
    if (filterKind !== 'all') items = items.filter((i) => i.kind === filterKind);
    if (filterMember !== 'all') {
      items = items.filter((i) => {
        if (i.memberId) return i.memberId === filterMember;
        if (i.userId) return memberByUser.get(i.userId)?.id === filterMember;
        return false;
      });
    }
    return items;
  }, [feed, filterKind, filterMember, memberByUser]);

  const summary = useMemo(() => summarizeFeed(feed, memberById), [feed, memberById]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ActivityIcon className="h-5 w-5 text-brand" />
          <h1 className="text-lg font-bold">Family Activity</h1>
        </div>
        <button
          type="button"
          onClick={() => setShowSummary((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-fg transition"
        >
          <Sparkles className="h-3.5 w-3.5" /> Summary
        </button>
      </div>

      {showSummary && (
        <div className="rounded-xl border border-brand/20 bg-brand/5 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-brand">
            <Sparkles className="h-4 w-4" /> Activity Summary
          </div>
          <p className="mt-1 text-sm text-muted">{summary}</p>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-4 w-4 text-muted" />
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setFilterKind('all')}
            className={`rounded-full border px-2.5 py-1 text-xs transition ${
              filterKind === 'all' ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:text-fg'
            }`}
          >
            All
          </button>
          {ALL_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilterKind(filterKind === k ? 'all' : k)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
                  filterKind === k ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:text-fg'
                }`}
              >
                <Icon className="h-3 w-3" /> {KIND_LABELS[k]}
              </button>
            );
          })}
        </div>
        {members.length > 1 && (
          <select
            value={filterMember}
            onChange={(e) => setFilterMember(e.target.value)}
            className="ml-auto rounded-lg border border-border bg-surface px-2 py-1 text-xs text-fg"
          >
            <option value="all">All members</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.display_name}</option>
            ))}
          </select>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-surface/40 py-16 text-center">
          <ActivityIcon className="h-10 w-10 text-muted/40" />
          <p className="mt-3 text-muted">
            {feed.length === 0
              ? "No activity yet — it'll appear here as your family uses Bubaly."
              : 'No activity matches your filters.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-1">
          {filtered.map((item) => {
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
