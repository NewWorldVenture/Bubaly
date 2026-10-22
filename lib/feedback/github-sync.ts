import 'server-only';
import { createServiceClient } from '@/lib/supabase/server';
import {
  isGithubConfigured, listIssuesByLabels, type GithubIssue,
} from '@/lib/integrations/github';
import { GH_MARKER_LABEL, feedbackIdFromBody, statusFromIssue } from '@/lib/feedback/github-map';
import { syncIdeaToGithub } from '@/lib/feedback/notify';
import { readAll } from '@/lib/supabase/read-all';
import { wroteNoRows } from '@/lib/supabase/errors';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

type Admin = ReturnType<typeof createServiceClient>;

export type SyncChange = { ideaId: string; title: string; from: string; to: string; issue: number; url: string | null };
export type SyncResult = {
  configured: boolean;
  created: number;      // unsynced ideas pushed to GitHub as new issues
  reconciled: number;   // linked issues examined
  changes: SyncChange[]; // status transitions the bot applied
  errors: number;
  /** Unsynced ideas left for a later run because their family reached the day's issue cap. */
  held: number;
};

/** Unsynced ideas one run reads; the rest wait for the next. */
const BACKFILL_PER_RUN = 25;
/**
 * Issues the backfill opens for ONE family in a day. The submit action limits
 * a member to 20 ideas a day before it opens an issue (app/(app)/feedback/
 * actions.ts), but a row written straight to PostgREST never passes through
 * it, and this backfill picked up every unlinked row and opened an issue with
 * the bot token for each: a scripted insert loop still spent GitHub's
 * content-creation allowance, 25 issues a run. So the backfill holds a
 * family's ideas once it has opened this many for them in a day, on the same
 * two-layer limiter the action uses, keyed by family (by author when a row
 * has none, and one shared key for a row with neither). A held idea is not an
 * error: it stays unlinked and is picked up when the window has passed.
 */
const FAMILY_ISSUES_PER_DAY = 20;
const ISSUE_WINDOW_MS = 86_400_000;

/**
 * The feedback ↔ GitHub bot. One pass:
 *   1. BACKFILL — any idea without an issue (submitted while GitHub was down /
 *      unconfigured) is pushed to the tracker.
 *   2. RECONCILE — reads BOTH lists (all `bubaly-feedback` issues cover bugs +
 *      enhancements) and maps each back to its idea (by stored number, else the
 *      body marker), then reflects the issue's open/closed + workflow labels
 *      onto the idea's status (e.g. issue closed-completed → shipped).
 * Returns a summary the caller (cron / admin action) relays to the super admin.
 * Best-effort throughout — a GitHub hiccup degrades the run, never throws.
 */
export async function runGithubFeedbackSync(admin: Admin, opts?: { backfillLimit?: number; issueLimit?: number }): Promise<SyncResult> {
  if (!isGithubConfigured()) return { configured: false, created: 0, reconciled: 0, changes: [], errors: 0, held: 0 };

  let created = 0;
  let errors = 0;
  let held = 0;
  const changes: SyncChange[] = [];
  // The backfill's limiter is keyed by FAMILY, so it runs on the service
  // client: rate_limit_hit (0179) refuses a key that does not name the caller
  // on a session client, and the limiter then fails closed. Both callers hand
  // this run the service client already; the limiter takes its own so where
  // the key is evaluated is on the page (tests/a-signed-in-rate-limit-key-
  // names-the-caller.test.ts).
  const limiter = createServiceClient();

  // 1. Backfill unsynced ideas → issues, within the per-run and per-family caps.
  const { data: unsynced } = await admin
    .from('feedback_ideas')
    .select('id, title, kind, category, problem, body, impact, vote_count, author_name, family_id, author_id')
    .is('github_issue_number', null)
    .order('created_at', { ascending: true })
    .limit(opts?.backfillLimit ?? BACKFILL_PER_RUN);
  for (const idea of unsynced ?? []) {
    const subject = idea.family_id ? `family:${idea.family_id}` : idea.author_id ? `author:${idea.author_id}` : 'unattributed';
    const gate = await enforceRequestRateLimit(limiter, `feedback-github-backfill:${subject}`, { limit: FAMILY_ISSUES_PER_DAY, windowMs: ISSUE_WINDOW_MS });
    if (!gate.ok) { held++; continue; }
    const r = await syncIdeaToGithub(admin, idea);
    if (r.ok) created++;
    else if (!r.skipped) errors++;
  }

  // 2. Reconcile issue state back onto ideas.
  let issues: GithubIssue[] = [];
  try {
    issues = await listIssuesByLabels([GH_MARKER_LABEL], undefined, opts?.issueLimit ?? 100);
  } catch (e) {
    console.error('[github-sync] listIssues failed', e);
    return { configured: true, created, reconciled: 0, changes, errors: errors + 1, held };
  }

  // `.limit(3000)` never was 3,000 — PostgREST caps at db-max-rows — so past
  // 1,000 linked ideas the sync stopped seeing the rest and would have started
  // re-opening issues it believed unlinked.
  const { rows: linked, error: linkedError } = await readAll((from, to) => admin
    .from('feedback_ideas')
    .select('id, title, status, github_issue_number')
    .not('github_issue_number', 'is', null)
    .order('id')
    .range(from, to), { max: 3000 });
  // The comment above names the consequence, and dropping this error is what
  // let it happen: every row missing from `linked` is an idea the reconcile
  // loop below believes has no issue, so a truncated read does not produce a
  // smaller sync — it produces issues re-opened against ideas that already had
  // one. A read this loop writes from has to be whole or not used.
  if (linkedError) {
    console.error('[github-sync] linked-idea read failed', linkedError);
    return { configured: true, created, reconciled: 0, changes, errors: errors + 1, held };
  }
  const byNumber = new Map<number, { id: string; title: string; status: string; github_issue_number: number | null }>();
  const byId = new Map<string, { id: string; title: string; status: string; github_issue_number: number | null }>();
  for (const row of linked ?? []) {
    if (row.github_issue_number) byNumber.set(row.github_issue_number, row);
    byId.set(row.id, row);
  }

  let reconciled = 0;
  for (const issue of issues) {
    let idea = byNumber.get(issue.number);
    if (!idea) {
      const fid = feedbackIdFromBody(issue.body);
      if (fid) idea = byId.get(fid);
    }
    if (!idea) continue;

    const patch: Record<string, unknown> = { github_state: issue.state, github_synced_at: new Date().toISOString() };
    if (!idea.github_issue_number) { patch.github_issue_number = issue.number; patch.github_issue_url = issue.html_url; }

    const nextStatus = statusFromIssue({ state: issue.state, stateReason: issue.state_reason, labels: issue.labels });
    if (nextStatus && nextStatus !== idea.status) {
      patch.status = nextStatus;
      changes.push({ ideaId: idea.id, title: idea.title, from: idea.status, to: nextStatus, issue: issue.number, url: issue.html_url });
    }

    // `reconciled` is reported back, and it counted ideas that matched nothing
    // (deleted since the read). Counted only when one changed. Audit C1-S9-69.
    const { data: reconciledRow, error } = await admin.from('feedback_ideas').update(patch as never).eq('id', idea.id).select('id');
    if (error) errors++; else if (!wroteNoRows(reconciledRow)) reconciled++;
  }

  return { configured: true, created, reconciled, changes, errors, held };
}

/** A one-line human summary of a sync run for the relay. */
export function summarizeSync(r: SyncResult): string {
  if (!r.configured) return 'GitHub isn’t configured — set GITHUB_TOKEN + GITHUB_FEEDBACK_REPO to enable the tracker.';
  const parts: string[] = [];
  if (r.created) parts.push(`${r.created} new issue${r.created === 1 ? '' : 's'} opened`);
  if (r.changes.length) parts.push(`${r.changes.length} status update${r.changes.length === 1 ? '' : 's'} from GitHub`);
  if (r.errors) parts.push(`${r.errors} error${r.errors === 1 ? '' : 's'}`);
  if (r.held) parts.push(`${r.held} idea${r.held === 1 ? '' : 's'} held by the daily cap`);
  if (parts.length === 0) return `Nothing new — ${r.reconciled} issue${r.reconciled === 1 ? '' : 's'} in sync.`;
  return parts.join(' · ');
}
