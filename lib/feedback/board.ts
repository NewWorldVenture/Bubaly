// Pure, side-effect-free engine for the Feedback / Idea Board (/feedback).
// Everything here is deterministic and unit-tested (tests/feedback-board.test.ts):
// label/colour lookups, the roadmap pipeline, and the ranking/toggle helpers the
// server page and client components share. No Supabase, no React — just data.

export type FeedbackStatus = 'under_review' | 'planned' | 'in_progress' | 'shipped' | 'declined';
export type FeedbackCategory =
  | 'calendar' | 'tasks' | 'meals' | 'chores' | 'finance'
  | 'communication' | 'marketplace' | 'ai_assistant' | 'kids' | 'health' | 'mobile' | 'other';
export type FeedbackImpact = 'nice_to_have' | 'helpful' | 'game_changer';
export type FeedbackAudience = 'me' | 'others' | 'everyone';
export type FeedbackKind = 'idea' | 'bug';

export type FeedbackSort = 'top' | 'new' | 'trending';

export type IdeaRow = {
  id: string;
  title: string;
  problem: string | null;
  body: string | null;
  category: string;
  impact: string;
  audience: string;
  kind?: string;
  status: string;
  admin_note: string | null;
  image_url: string | null;
  author_name: string;
  vote_count: number;
  comment_count: number;
  pinned: boolean;
  github_issue_number?: number | null;
  github_issue_url?: string | null;
  created_at: string;
};

// ── Kind (bug vs enhancement) ────────────────────────────────────────────────
export const KIND_META: Record<FeedbackKind, { label: string; emoji: string; noun: string; tone: string }> = {
  idea: { label: 'Idea',       emoji: '💡', noun: 'idea',       tone: 'bg-amber-500/15 text-amber-500 border-amber-500/25' },
  bug:  { label: 'Bug report', emoji: '🐛', noun: 'bug report', tone: 'bg-rose-500/15 text-rose-500 border-rose-500/25' },
};
export const KIND_ORDER = Object.keys(KIND_META) as FeedbackKind[];
export function isFeedbackKind(v: unknown): v is FeedbackKind {
  return typeof v === 'string' && v in KIND_META;
}
export function kindMeta(v: string): { label: string; emoji: string; noun: string; tone: string } {
  return isFeedbackKind(v) ? KIND_META[v] : KIND_META.idea;
}

// ── Status (the public roadmap pipeline) ─────────────────────────────────────
type Meta = { label: string; tone: string; dot: string; badge: string };

export const STATUS_META: Record<FeedbackStatus, Meta> = {
  under_review: { label: 'Under review', tone: 'amber',  dot: 'bg-amber-400',   badge: 'bg-amber-500/15 text-amber-500 border-amber-500/25' },
  planned:      { label: 'Planned',      tone: 'blue',   dot: 'bg-blue-400',    badge: 'bg-blue-500/15 text-blue-500 border-blue-500/25' },
  in_progress:  { label: 'In progress',  tone: 'purple', dot: 'bg-purple-400',  badge: 'bg-purple-500/15 text-purple-500 border-purple-500/25' },
  shipped:      { label: 'Shipped',      tone: 'green',  dot: 'bg-emerald-400', badge: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/25' },
  declined:     { label: 'Not planned',  tone: 'gray',   dot: 'bg-zinc-400',    badge: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25' },
};

/** Statuses shown in the "Status legend" rail (declined is intentionally omitted). */
export const LEGEND_STATUSES: FeedbackStatus[] = ['under_review', 'planned', 'in_progress', 'shipped'];

/** The order statuses appear when filtering the board. */
export const FILTERABLE_STATUSES: FeedbackStatus[] = ['under_review', 'planned', 'in_progress', 'shipped', 'declined'];

export function isFeedbackStatus(v: unknown): v is FeedbackStatus {
  return typeof v === 'string' && v in STATUS_META;
}

export function statusMeta(v: string): Meta {
  return isFeedbackStatus(v) ? STATUS_META[v] : STATUS_META.under_review;
}

// ── Categories ───────────────────────────────────────────────────────────────
export const CATEGORY_META: Record<FeedbackCategory, { label: string; emoji: string }> = {
  calendar:      { label: 'Calendar',      emoji: '📅' },
  tasks:         { label: 'Tasks & to-dos', emoji: '✅' },
  meals:         { label: 'Meals',         emoji: '🍽️' },
  chores:        { label: 'Chores',        emoji: '🧹' },
  finance:       { label: 'Money',         emoji: '💰' },
  communication: { label: 'Messages',      emoji: '💬' },
  marketplace:   { label: 'Marketplace',   emoji: '🛍️' },
  ai_assistant:  { label: 'AI Assistant',  emoji: '✨' },
  kids:          { label: 'Kids',          emoji: '🧒' },
  health:        { label: 'Health',        emoji: '❤️' },
  mobile:        { label: 'Mobile app',    emoji: '📱' },
  other:         { label: 'Something else', emoji: '💡' },
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_META) as FeedbackCategory[];

export function isFeedbackCategory(v: unknown): v is FeedbackCategory {
  return typeof v === 'string' && v in CATEGORY_META;
}

export function categoryMeta(v: string): { label: string; emoji: string } {
  return isFeedbackCategory(v) ? CATEGORY_META[v] : CATEGORY_META.other;
}

// ── Impact ───────────────────────────────────────────────────────────────────
export const IMPACT_META: Record<FeedbackImpact, { label: string; weight: number }> = {
  nice_to_have: { label: 'Nice to have', weight: 1 },
  helpful:      { label: 'Helpful',      weight: 2 },
  game_changer: { label: 'Game changer', weight: 3 },
};
export const IMPACT_ORDER = Object.keys(IMPACT_META) as FeedbackImpact[];
export function isFeedbackImpact(v: unknown): v is FeedbackImpact {
  return typeof v === 'string' && v in IMPACT_META;
}
export function impactMeta(v: string): { label: string; weight: number } {
  return isFeedbackImpact(v) ? IMPACT_META[v] : IMPACT_META.helpful;
}

// ── Audience ("For you or others?") ──────────────────────────────────────────
export const AUDIENCE_META: Record<FeedbackAudience, { label: string }> = {
  me:       { label: 'Me' },
  others:   { label: 'Others' },
  everyone: { label: 'Everyone' },
};
export const AUDIENCE_ORDER = Object.keys(AUDIENCE_META) as FeedbackAudience[];
export function isFeedbackAudience(v: unknown): v is FeedbackAudience {
  return typeof v === 'string' && v in AUDIENCE_META;
}

// ── Submission validation (shared by client + server action) ─────────────────
export const TITLE_MAX = 120;
export const TEXT_MAX = 2000;

export type IdeaDraft = {
  title: string;
  problem?: string;
  body?: string;
  category?: string;
  impact?: string;
  audience?: string;
  kind?: string;
  imageUrl?: string;
};

export type NormalizedIdea = {
  title: string;
  problem: string | null;
  body: string | null;
  category: FeedbackCategory;
  impact: FeedbackImpact;
  audience: FeedbackAudience;
  kind: FeedbackKind;
  imageUrl: string | null;
};

/** Validate + normalize a draft. Returns an error string, or the clean row.
 *  Title is the only required field ("All fields optional" applies to the rest). */
export function normalizeIdea(draft: IdeaDraft): { ok: false; error: string } | { ok: true; value: NormalizedIdea } {
  const title = (draft.title ?? '').trim();
  if (!title) return { ok: false, error: 'Give your idea a short title.' };
  if (title.length > TITLE_MAX) return { ok: false, error: `Keep the title under ${TITLE_MAX} characters.` };

  const problem = (draft.problem ?? '').trim();
  const body = (draft.body ?? '').trim();
  if (problem.length > TEXT_MAX || body.length > TEXT_MAX) {
    return { ok: false, error: 'That’s a lot of detail — please trim it down a little.' };
  }

  const image = (draft.imageUrl ?? '').trim();
  return {
    ok: true,
    value: {
      title,
      problem: problem || null,
      body: body || null,
      category: isFeedbackCategory(draft.category) ? draft.category : 'other',
      impact: isFeedbackImpact(draft.impact) ? draft.impact : 'helpful',
      audience: isFeedbackAudience(draft.audience) ? draft.audience : 'me',
      kind: isFeedbackKind(draft.kind) ? draft.kind : 'idea',
      imageUrl: image ? image : null,
    },
  };
}

// ── Ranking ──────────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;

/** Age of an idea in whole days at `now` (>= 0). */
export function ageInDays(createdAt: string, now: number = Date.now()): number {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** A gravity-decayed "trending" score (HN-style): recent votes outrank old ones. */
export function trendingScore(idea: Pick<IdeaRow, 'vote_count' | 'created_at'>, now: number = Date.now()): number {
  const hours = Math.max(0, (now - new Date(idea.created_at).getTime()) / 3_600_000);
  return (idea.vote_count + 1) / Math.pow(hours + 2, 1.5);
}

/** Sort a copy of the ideas by the chosen mode. Pinned always float to the top. */
export function sortIdeas<T extends IdeaRow>(ideas: readonly T[], sort: FeedbackSort, now: number = Date.now()): T[] {
  const arr = [...ideas];
  const byRecency = (a: T, b: T) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  arr.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sort === 'new') return byRecency(a, b);
    if (sort === 'trending') return trendingScore(b, now) - trendingScore(a, now) || byRecency(a, b);
    // 'top'
    return b.vote_count - a.vote_count || byRecency(a, b);
  });
  return arr;
}

/** Pure toggle: given the set of idea ids the user has voted for, flip one. */
export function toggleVote(votedIds: readonly string[], ideaId: string): { next: string[]; voted: boolean } {
  const set = new Set(votedIds);
  if (set.has(ideaId)) {
    set.delete(ideaId);
    return { next: [...set], voted: false };
  }
  set.add(ideaId);
  return { next: [...set], voted: true };
}

/** Roadmap tallies for the header ("N shipped · N in progress · …"). */
export function statusTally(ideas: readonly IdeaRow[]): Record<FeedbackStatus, number> {
  const base: Record<FeedbackStatus, number> = { under_review: 0, planned: 0, in_progress: 0, shipped: 0, declined: 0 };
  for (const i of ideas) if (isFeedbackStatus(i.status)) base[i.status] += 1;
  return base;
}

/** Count ideas vs bug reports; a missing/unknown kind counts as an idea. */
export function kindTally(ideas: readonly IdeaRow[]): Record<FeedbackKind, number> {
  const base: Record<FeedbackKind, number> = { idea: 0, bug: 0 };
  for (const i of ideas) base[isFeedbackKind(i.kind) ? i.kind : 'idea'] += 1;
  return base;
}
