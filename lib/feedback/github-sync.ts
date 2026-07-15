import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import {
  isGithubConfigured, listIssuesByLabels, type GithubIssue,
} from '@/lib/integrations/github';
import { GH_MARKER_LABEL, feedbackIdFromBody, statusFromIssue } from '@/lib/feedback/github-map';
import { syncIdeaToGithub } from '@/lib/feedback/notify';

type Admin = ReturnType<typeof createServiceClient>;

export type SyncChange = { ideaId: string; title: string; from: string; to: string; issue: number; url: string | null };
export type SyncResult = {
  configured: boolean;
  created: number;      // unsynced ideas pushed to GitHub as new issues
  reconciled: number;   // linked issues examined
  changes: SyncChange[]; // status transitions the bot applied
  errors: number;
};

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
  if (!isGithubConfigured()) return { configured: false, created: 0, reconciled: 0, changes: [], errors: 0 };

  let created = 0;
  let errors = 0;
  const changes: SyncChange[] = [];

  // 1. Backfill unsynced ideas → issues.
  const { data: unsynced } = await admin
    .from('feedback_ideas')
    .select('id, title, kind, category, problem, body, impact, vote_count, author_name')
    .is('github_issue_number', null)
    .order('created_at', { ascending: true })
    .limit(opts?.backfillLimit ?? 25);
  for (const idea of unsynced ?? []) {
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
    return { configured: true, created, reconciled: 0, changes, errors: errors + 1 };
  }

  const { data: linked } = await admin
    .from('feedback_ideas')
    .select('id, title, status, github_issue_number')
    .not('github_issue_number', 'is', null)
    .limit(3000);
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

    const { error } = await admin.from('feedback_ideas').update(patch as never).eq('id', idea.id);
    if (error) errors++; else reconciled++;
  }

  return { configured: true, created, reconciled, changes, errors };
}

/** A one-line human summary of a sync run for the relay. */
export function summarizeSync(r: SyncResult): string {
  if (!r.configured) return 'GitHub isn’t configured — set GITHUB_TOKEN + GITHUB_FEEDBACK_REPO to enable the tracker.';
  const parts: string[] = [];
  if (r.created) parts.push(`${r.created} new issue${r.created === 1 ? '' : 's'} opened`);
  if (r.changes.length) parts.push(`${r.changes.length} status update${r.changes.length === 1 ? '' : 's'} from GitHub`);
  if (r.errors) parts.push(`${r.errors} error${r.errors === 1 ? '' : 's'}`);
  if (parts.length === 0) return `Nothing new — ${r.reconciled} issue${r.reconciled === 1 ? '' : 's'} in sync.`;
  return parts.join(' · ');
}
