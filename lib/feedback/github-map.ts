// Pure, side-effect-free mapping between a feedback idea and its GitHub issue.
// Unit-tested (tests/feedback-github-map.test.ts). No network, no env, no React.
//
// The GitHub "project tracker" is a repo's Issues split into TWO LISTS by label:
//   • bugs        → the `bug` label
//   • enhancements → the `enhancement` label
// Every Bubaly-created issue also carries a marker label + an HTML marker in the
// body carrying the feedback id, so the bot can map an issue back to its idea
// even if the stored issue number was lost. Status flows back from the issue's
// open/closed state + workflow labels.

import { isFeedbackKind, isFeedbackCategory, categoryMeta, type FeedbackKind, type FeedbackStatus } from '@/lib/feedback/board';

export const GH_BUG_LABEL = 'bug';
export const GH_ENHANCEMENT_LABEL = 'enhancement';
export const GH_MARKER_LABEL = 'bubaly-feedback';

type IdeaLike = {
  id: string;
  title: string;
  kind?: string | null;
  category?: string | null;
  problem?: string | null;
  body?: string | null;
  impact?: string | null;
  vote_count?: number | null;
  author_name?: string | null;
};

/** The two-list label for a kind: bug → `bug`, idea → `enhancement`. */
export function listLabelForKind(kind: string | null | undefined): string {
  return isFeedbackKind(kind ?? '') && kind === 'bug' ? GH_BUG_LABEL : GH_ENHANCEMENT_LABEL;
}

/** All labels a new issue should carry: its list label + marker + category. */
export function githubLabels(idea: Pick<IdeaLike, 'kind' | 'category'>): string[] {
  const labels = [listLabelForKind(idea.kind), GH_MARKER_LABEL];
  if (isFeedbackCategory(idea.category ?? '')) labels.push(`area:${idea.category}`);
  return labels;
}

/** The issue title: "[Bug] …" / "[Idea] …", bounded. */
export function issueTitle(idea: Pick<IdeaLike, 'title' | 'kind'>): string {
  const tag = idea.kind === 'bug' ? 'Bug' : 'Idea';
  const title = (idea.title ?? '').trim().slice(0, 240) || 'Untitled';
  return `[${tag}] ${title}`;
}

const MARKER_RE = /<!--\s*bubaly-feedback:([0-9a-f-]{36})\s*-->/i;

/** The machine marker embedded in an issue body (id round-trips even if the
 *  stored issue number is lost). */
export function feedbackMarker(id: string): string {
  return `<!-- bubaly-feedback:${id} -->`;
}

/** Recover the feedback id from an issue body, or null. */
export function feedbackIdFromBody(body: string | null | undefined): string | null {
  const m = (body ?? '').match(MARKER_RE);
  return m ? m[1] : null;
}

/** The full issue body (markdown) for a new submission. */
export function issueBody(idea: IdeaLike, boardUrl: string): string {
  const cat = categoryMeta(idea.category ?? 'other');
  const lines: string[] = [];
  if (idea.kind === 'bug') {
    lines.push('**Reported bug from the Bubaly feedback board.**', '');
    if (idea.problem) lines.push('**What’s wrong / steps to reproduce:**', idea.problem, '');
    if (idea.body) lines.push('**Details:**', idea.body, '');
  } else {
    lines.push('**Idea from the Bubaly feedback board.**', '');
    if (idea.problem) lines.push('**Problem it solves:**', idea.problem, '');
    if (idea.body) lines.push('**The idea:**', idea.body, '');
  }
  lines.push(
    '---',
    `- **Area:** ${cat.emoji} ${cat.label}`,
    `- **Impact:** ${idea.impact ?? 'helpful'}`,
    `- **Votes:** ${idea.vote_count ?? 0}`,
    `- **Submitted by:** ${idea.author_name ?? 'A Bubaly family'}`,
    `- **Board:** ${boardUrl}`,
    '',
    feedbackMarker(idea.id),
  );
  return lines.join('\n');
}

/**
 * Map a GitHub issue's state + labels back to a feedback status. Returns null
 * when nothing warrants a change (so the reconciler leaves the row alone).
 *   closed + completed / "shipped" label      → shipped
 *   closed + not-planned / "wontfix"/"declined"→ declined
 *   open + "in progress" label                 → in_progress
 *   open + "planned" label                     → planned
 */
export function statusFromIssue(input: {
  state: string;                       // 'open' | 'closed'
  stateReason?: string | null;         // 'completed' | 'not_planned' | 'reopened' | null
  labels: string[];
}): FeedbackStatus | null {
  const labels = input.labels.map((l) => l.toLowerCase());
  const has = (...names: string[]) => names.some((n) => labels.includes(n));

  if (input.state === 'closed') {
    if (input.stateReason === 'not_planned' || has('wontfix', "won't fix", 'declined', 'not planned')) return 'declined';
    return 'shipped'; // closed (completed) → shipped
  }
  // open
  if (has('in progress', 'in-progress', 'in_progress', 'wip')) return 'in_progress';
  if (has('planned', 'accepted', 'approved')) return 'planned';
  return null; // still open, no workflow label → leave as-is (under_review)
}

/** GitHub open/closed for a feedback status (used when we push status → issue). */
export function githubStateForStatus(status: string): 'open' | 'closed' {
  return status === 'shipped' || status === 'declined' ? 'closed' : 'open';
}

export type { FeedbackKind };
