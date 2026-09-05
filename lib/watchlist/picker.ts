// lib/watchlist/picker.ts — pure, deterministic "what do we watch tonight" engine.
//
// The differentiator: the pick is made for THIS audience — the youngest person
// on the couch sets the age ceiling, the time you actually have sets the
// runtime ceiling, and every vote the family cast counts. No title is ever
// invented; every pick is something the family already added.

import type { WatchKind, WatchService, WatchStatus, WatchVote } from '@/lib/database.types';
import { ageOn as memberAgeOn } from '@/lib/members/age';

export const WATCH_KINDS: { value: WatchKind; label: string; emoji: string }[] = [
  { value: 'movie', label: 'Movie', emoji: '🎬' },
  { value: 'show', label: 'Series', emoji: '📺' },
  { value: 'documentary', label: 'Documentary', emoji: '🌍' },
  { value: 'kids', label: 'Kids', emoji: '🧸' },
  { value: 'special', label: 'Special / event', emoji: '🎉' },
];

export const WATCH_SERVICES: { value: WatchService; label: string }[] = [
  { value: 'netflix', label: 'Netflix' }, { value: 'disney', label: 'Disney+' }, { value: 'prime', label: 'Prime Video' },
  { value: 'hulu', label: 'Hulu' }, { value: 'max', label: 'Max' }, { value: 'apple', label: 'Apple TV+' },
  { value: 'peacock', label: 'Peacock' }, { value: 'paramount', label: 'Paramount+' }, { value: 'youtube', label: 'YouTube' },
  { value: 'library', label: 'Library / owned' }, { value: 'theater', label: 'In theaters' }, { value: 'other', label: 'Other' },
];

export const WATCH_STATUSES: { value: WatchStatus; label: string }[] = [
  { value: 'want', label: 'Want to watch' }, { value: 'watching', label: 'Watching' }, { value: 'watched', label: 'Watched' }, { value: 'skipped', label: 'Skipped' },
];

/** Age ratings → the youngest age they are suitable for (US MPA + TV parental guidelines). */
export const AGE_RATINGS: { value: string; label: string; minAge: number }[] = [
  { value: 'G', label: 'G · General', minAge: 0 },
  { value: 'TV-Y', label: 'TV-Y · All children', minAge: 0 },
  { value: 'TV-G', label: 'TV-G · General', minAge: 0 },
  { value: 'TV-Y7', label: 'TV-Y7 · 7+', minAge: 7 },
  { value: 'PG', label: 'PG · Parental guidance', minAge: 8 },
  { value: 'TV-PG', label: 'TV-PG · Parental guidance', minAge: 8 },
  { value: 'PG-13', label: 'PG-13', minAge: 13 },
  { value: 'TV-14', label: 'TV-14', minAge: 14 },
  { value: 'R', label: 'R · Restricted', minAge: 17 },
  { value: 'TV-MA', label: 'TV-MA · Mature', minAge: 17 },
  { value: 'NR', label: 'Not rated', minAge: 0 },
];

export const VOTE_WEIGHT: Record<WatchVote, number> = { love: 3, up: 1, down: -2 };

export const kindMeta = (k: WatchKind) => WATCH_KINDS.find((x) => x.value === k) ?? WATCH_KINDS[0];
export const serviceLabel = (s: WatchService) => WATCH_SERVICES.find((x) => x.value === s)?.label ?? 'Other';
export const ratingMinAge = (rating: string | null | undefined) => AGE_RATINGS.find((r) => r.value === rating)?.minAge ?? 0;

export type TitleLike = {
  id: string; title: string; kind: WatchKind; min_age: number; runtime_min: number | null; service: WatchService;
  status: WatchStatus; priority: number; genres: string[]; created_at?: string;
};
export type VoteLike = { title_id: string; member_id: string; vote: WatchVote };
export type SessionLike = { title_id: string | null; title_name: string; watched_on: string; rating: number | null; member_ids: string[] };

/** Watchlist ages require an actual, non-future calendar birthday. */
export function ageOn(birthday: string | null | undefined, today: Date): number | null {
  if (typeof birthday !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthday) || Number.isNaN(today.getTime())) return null;
  const birthDate = new Date(`${birthday}T00:00:00`);
  const year = Number(birthday.slice(0, 4));
  const month = Number(birthday.slice(5, 7));
  const day = Number(birthday.slice(8, 10));
  if (year < 1 || Number.isNaN(birthDate.getTime()) || birthDate.getFullYear() !== year
    || birthDate.getMonth() + 1 !== month || birthDate.getDate() !== day || birthDate > today) return null;
  return memberAgeOn(birthday, today);
}

/** Preserve a slot for every selected person, including missing household members. */
export function watchlistAudienceAges(
  audienceIds: readonly string[],
  members: readonly { id: string; birthday?: string | null }[],
  today: Date,
): (number | null)[] {
  return audienceIds.map((id) => ageOn(members.find((member) => member.id === id)?.birthday, today));
}

export type AudienceEligibility = {
  eligible: boolean;
  youngest: number | null;
  unresolvedIds: string[];
  blocker: string | null;
};

/** A recommendation needs a valid whole-year age for every selected person. */
export function getAudienceEligibility(
  audienceIds: readonly string[],
  audienceAges: readonly (number | null | undefined)[],
): AudienceEligibility {
  const aligned = audienceIds.length === audienceAges.length;
  const unresolvedIds = audienceIds.filter((_, index) => {
    const age = audienceAges[index];
    return !aligned || typeof age !== 'number' || !Number.isInteger(age) || age < 0;
  });
  const eligible = audienceIds.length > 0 && aligned && unresolvedIds.length === 0;
  return {
    eligible,
    youngest: eligible ? Math.min(...audienceAges as number[]) : null,
    unresolvedIds,
    blocker: eligible ? null : audienceIds.length === 0
      ? 'Select who is watching before getting recommendations.'
      : 'Confirm ages for everyone watching before getting recommendations.',
  };
}

/** Sum of the audience's votes for a title (members not voting count 0). */
export function voteScore(titleId: string, votes: VoteLike[], audienceIds?: string[]): number {
  return votes
    .filter((v) => v.title_id === titleId && (!audienceIds || audienceIds.includes(v.member_id)))
    .reduce((sum, v) => sum + VOTE_WEIGHT[v.vote], 0);
}

export type PickContext = {
  /** Member ids on the couch tonight. */
  audienceIds: string[];
  /** One age per audienceIds entry, in the same order. Unknown ages must retain their slot. */
  audienceAges: (number | null | undefined)[];
  availableMinutes: number;
  service?: WatchService | 'any';
  kind?: WatchKind | 'any';
};

export type Pick<T extends TitleLike = TitleLike> = { title: T; score: number; reasons: string[]; blockers: string[] };

/** Rank the watchlist for tonight. Unsuitable titles are returned with `blockers` so the UI can explain. */
export function pickTonight<T extends TitleLike>(titles: T[], votes: VoteLike[], ctx: PickContext): { picks: Pick<T>[]; excluded: Pick<T>[]; audienceEligibility: AudienceEligibility } {
  const audienceEligibility = getAudienceEligibility(ctx.audienceIds, ctx.audienceAges);
  const { youngest } = audienceEligibility;
  const picks: Pick<T>[] = [];
  const excluded: Pick<T>[] = [];
  for (const t of titles) {
    if (t.status !== 'want' && t.status !== 'watching') continue;
    const reasons: string[] = [];
    const blockers: string[] = [];
    if (audienceEligibility.blocker) blockers.push(audienceEligibility.blocker);
    if (youngest !== null && t.min_age > youngest) blockers.push(`rated ${t.min_age}+, youngest tonight is ${youngest}`);
    if (t.runtime_min && t.runtime_min > ctx.availableMinutes) blockers.push(`${t.runtime_min} min, you have ${ctx.availableMinutes}`);
    if (ctx.service && ctx.service !== 'any' && t.service !== ctx.service) blockers.push(`on ${serviceLabel(t.service)}`);
    if (ctx.kind && ctx.kind !== 'any' && t.kind !== ctx.kind) blockers.push(kindMeta(t.kind).label);

    const audienceVotes = votes.filter((v) => v.title_id === t.id && ctx.audienceIds.includes(v.member_id));
    const score = voteScore(t.id, votes, ctx.audienceIds) * 10 + (4 - t.priority) * 8 + (t.status === 'watching' ? 6 : 0);
    const loves = audienceVotes.filter((v) => v.vote === 'love').length;
    const downs = audienceVotes.filter((v) => v.vote === 'down').length;
    if (loves) reasons.push(loves === 1 ? '1 loves it' : `${loves} love it`);
    if (audienceVotes.length && downs === 0) reasons.push('nobody voted it down');
    if (downs) reasons.push(`${downs} would rather not`);
    if (t.status === 'watching') reasons.push('already started');
    if (t.priority === 1) reasons.push('top priority');
    if (t.runtime_min && t.runtime_min <= ctx.availableMinutes) reasons.push(`${t.runtime_min} min fits`);
    if (youngest !== null && t.min_age <= youngest) reasons.push('fine for everyone');

    (blockers.length ? excluded : picks).push({ title: t, score, reasons, blockers });
  }
  picks.sort((a, b) => b.score - a.score || a.title.title.localeCompare(b.title.title));
  excluded.sort((a, b) => b.score - a.score);
  return { picks, excluded, audienceEligibility };
}

export type WatchlistSummary = {
  want: number;
  watching: number;
  watchedThisMonth: number;
  avgRating: number | null;
  topService: string | null;
  text: string;
};

export function watchlistSummary(titles: TitleLike[], sessions: SessionLike[], today: Date): WatchlistSummary {
  const want = titles.filter((t) => t.status === 'want').length;
  const watching = titles.filter((t) => t.status === 'watching').length;
  const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const thisMonth = sessions.filter((s) => s.watched_on.startsWith(monthKey));
  const rated = sessions.map((s) => s.rating).filter((r): r is number => typeof r === 'number');
  const avgRating = rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : null;
  const counts = new Map<string, number>();
  for (const t of titles) if (t.status === 'want') counts.set(t.service, (counts.get(t.service) ?? 0) + 1);
  const topService = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const text = want === 0 && watching === 0 ? 'Nothing queued — add a few titles' : `${want} to watch${watching ? ` · ${watching} in progress` : ''}`;
  return { want, watching, watchedThisMonth: thisMonth.length, avgRating, topService: topService ? serviceLabel(topService as WatchService) : null, text };
}

/** Available-time presets for the "tonight" picker. */
export const TIME_PRESETS = [30, 45, 60, 90, 120, 180] as const;
