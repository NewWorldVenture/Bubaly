// Pure, unit-tested helpers for the Memories page. No Supabase / React imports
// here beyond the lucide icon *type* — everything is deterministic given its
// inputs so it can be tested in the node-only vitest environment, and the
// server component stays a thin data-fetch + render shell.

import type { ComponentType } from 'react';
import { Image as ImageIcon, Video, LayoutGrid, BookOpen } from 'lucide-react';

/** Album row as selected by the Memories page (subset of family_albums). */
export type AlbumRow = {
  id: string;
  name: string;
  cover_url: string | null;
  kind: string;
  is_shared: boolean;
  photo_count: number;
  created_at: string;
  created_by: string | null;
};

/** Photo/video row as selected by the Memories page (subset of family_photos). */
export type PhotoRow = {
  id: string;
  album_id: string | null;
  uploaded_by: string | null;
  url: string | null;
  thumbnail_url: string | null;
  caption: string | null;
  media_type: string;
  taken_at: string | null;
  created_at: string;
};

/** The bits of a family_members row the page needs for attribution. */
export type MemberLite = {
  id: string;
  user_id: string | null;
  display_name: string;
  color: string | null;
};

const DAY_MS = 86_400_000;
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Whole-day difference between two instants, using local midnight boundaries. */
function calendarDaysAgo(iso: string, now: Date): number {
  const then = new Date(iso);
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  return Math.round((a - b) / DAY_MS);
}

/**
 * Friendly, human date label for a timeline row: "Today", "Yesterday",
 * "Last Thursday" (2–6 days ago), else the full date. Future dates fall back
 * to the absolute date too. Kept simple and locale-stable for tests.
 */
export function relativeDay(iso: string, now: Date): string {
  const days = calendarDaysAgo(iso, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days >= 2 && days <= 6) return `Last ${WEEKDAY[new Date(iso).getDay()]}`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Compact "time ago" for share attributions: "just now", "5m ago", "2h ago",
 * "3d ago", else an absolute date once it's over a week old.
 */
export function relativeTime(iso: string, now: Date): string {
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export type TimelineRow = { album: AlbumRow; relative: string };

/**
 * Build the highlight timeline: newest first, each row carrying a friendly
 * relative-day label. Capped so the page renders a digestible strip rather
 * than an unbounded wall.
 */
export function buildTimeline(highlights: AlbumRow[], now: Date = new Date(), limit = 12): TimelineRow[] {
  return [...highlights]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, limit)
    .map((album) => ({ album, relative: relativeDay(album.created_at, now) }));
}

export type StatRow = {
  label: string;
  value: number;
  icon: ComponentType<{ className?: string }>;
  tint: string;
};

/** The four "This Year" stat tiles, in display order. */
export function memoryStats(counts: { photos: number; videos: number; albums: number; memories: number }): StatRow[] {
  return [
    { label: 'Photos', value: counts.photos, icon: ImageIcon, tint: 'bg-brand/10 text-brand-text' },
    { label: 'Videos', value: counts.videos, icon: Video, tint: 'bg-violet-500/10 text-violet-500' },
    { label: 'Albums', value: counts.albums, icon: LayoutGrid, tint: 'bg-amber-500/10 text-amber-500' },
    { label: 'Memories Added', value: counts.memories, icon: BookOpen, tint: 'bg-emerald-500/10 text-emerald-500' },
  ];
}

export type SharedRow = { userId: string; name: string; label: string; at: string };

/** Recency window for the "Shared With You" rail. */
const SHARE_WINDOW_DAYS = 21;

/**
 * "Shared With You": recent media uploaded by *other* family members, grouped
 * by uploader. Each row summarizes what they added ("3 photos", "a video",
 * "2 videos") and when the most recent one landed. Newest sharer first,
 * capped to keep the rail tidy.
 */
export function sharedWithYou(
  photos: PhotoRow[],
  members: MemberLite[],
  myUserId: string,
  now: Date,
  limit = 4,
): SharedRow[] {
  const nameByUser = new Map<string, string>();
  for (const m of members) if (m.user_id) nameByUser.set(m.user_id, m.display_name);

  const cutoff = now.getTime() - SHARE_WINDOW_DAYS * DAY_MS;
  const groups = new Map<string, { at: string; photos: number; videos: number }>();

  for (const p of photos) {
    const uploader = p.uploaded_by;
    if (!uploader || uploader === myUserId) continue;
    const when = p.created_at;
    if (new Date(when).getTime() < cutoff) continue;
    const g = groups.get(uploader) ?? { at: when, photos: 0, videos: 0 };
    if (p.media_type === 'video') g.videos += 1; else g.photos += 1;
    if (when > g.at) g.at = when;
    groups.set(uploader, g);
  }

  return [...groups.entries()]
    .map(([userId, g]) => ({
      userId,
      name: nameByUser.get(userId) ?? 'A family member',
      label: shareLabel(g.photos, g.videos),
      at: g.at,
    }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

function shareLabel(photos: number, videos: number): string {
  const parts: string[] = [];
  if (photos === 1) parts.push('a photo');
  else if (photos > 1) parts.push(`${photos} photos`);
  if (videos === 1) parts.push('a video');
  else if (videos > 1) parts.push(`${videos} videos`);
  return parts.length ? parts.join(' and ') : 'a memory';
}
