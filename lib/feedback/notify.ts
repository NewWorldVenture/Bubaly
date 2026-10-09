import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/server/email';
import { superAdminEmails as envSuperAdminEmails } from '@/lib/constants/super-admins';
import { kindMeta } from '@/lib/feedback/board';
import {
  isGithubConfigured, createIssue, type GithubIssue,
} from '@/lib/integrations/github';
import { issueTitle, issueBody, githubLabels } from '@/lib/feedback/github-map';
import { wroteNoRows } from '@/lib/supabase/errors';
import { readAll } from '@/lib/supabase/read-all';

type Admin = ReturnType<typeof createServiceClient>;

type AdminNoteKind = 'feedback_new' | 'github_sync' | 'github_error' | 'info';

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://www.bubaly.com').replace(/\/$/, '');
}

/** The most `super_admins` rows a recipient read accepts; one more is a truncated read. */
const SUPER_ADMIN_READ_MAX = 1_000;

/**
 * `failure` is a classification, not a message: the raw cause is kept apart for
 * the server log only, so nothing a database said can reach a response body.
 */
export type SuperAdminRecipients =
  | { emails: string[]; failure: null }
  | { emails: null; failure: 'read_failed' | 'truncated'; cause: unknown };

/**
 * Every super-admin email — the code/env allowlist ∪ the super_admins table — or
 * an error when the table could not be read COMPLETELY.
 *
 * An empty table is not an error: the allowlist is then the whole, legitimate
 * list. A failed read, a thrown query and a read past the ceiling are errors,
 * because the allowlist alone would silently drop every admin who exists only in
 * the table. `{ data }` alone could not tell those apart: a PostgREST call
 * RESOLVES with `{ data: null, error }`, which read as "no rows".
 */
export async function readSuperAdminRecipients(admin: Admin): Promise<SuperAdminRecipients> {
  const set = new Set(envSuperAdminEmails());
  try {
    const { rows, error, truncated } = await readAll<{ email: string | null }>((from, to) => admin
      .from('super_admins').select('email').order('email').range(from, to), { max: SUPER_ADMIN_READ_MAX });
    if (error) return { emails: null, failure: truncated ? 'truncated' : 'read_failed', cause: error };
    for (const r of rows) if (r.email) set.add(r.email.toLowerCase());
  } catch (cause) {
    return { emails: null, failure: 'read_failed', cause };
  }
  return { emails: [...set], failure: null };
}

/**
 * Best-effort form for alerts (notifySuperAdmins): when the table cannot be read
 * it still reaches the allowlist rather than nobody, and says so in the log. A
 * caller that must not send to a partial list uses readSuperAdminRecipients.
 */
export async function allSuperAdminEmails(admin: Admin): Promise<string[]> {
  const read = await readSuperAdminRecipients(admin);
  if (read.failure === null) return read.emails;
  console.error('[feedback-notify] super_admins read failed; using the env allowlist only', read.failure, read.cause);
  return envSuperAdminEmails();
}

/**
 * Record a super-admin notification (the /admin feed) and email the super
 * admins. Best-effort: never throws, so it can't break the flow that triggered
 * it (a feedback submission, a bot sync). Email is skipped gracefully with no
 * RESEND key.
 */
export async function notifySuperAdmins(admin: Admin, input: {
  kind: AdminNoteKind; title: string; body?: string; url?: string;
  relatedType?: string; relatedId?: string; meta?: Record<string, unknown>;
  email?: boolean;
}): Promise<void> {
  try {
    // The result is read. A PostgREST call RESOLVES with { data, error } and
    // rejects only under .throwOnError(), so this catch could never fire for the
    // failure its own message names — it saw a client that could not be built,
    // and nothing else. Best-effort is right here; silent is not, because the
    // /admin feed is where a super admin finds out at all.
    const { error } = await admin.from('admin_notifications').insert({
      kind: input.kind, title: input.title, body: input.body ?? null, url: input.url ?? null,
      related_type: input.relatedType ?? null, related_id: input.relatedId ?? null,
      meta: (input.meta ?? {}) as never,
    });
    if (error) console.error('[feedback-notify] admin_notifications insert failed', error);
  } catch (e) {
    console.error('[feedback-notify] admin_notifications insert failed', e);
  }

  if (input.email === false) return;
  try {
    const emails = await allSuperAdminEmails(admin);
    if (emails.length === 0) return;
    const link = input.url ? `${appUrl()}${input.url.startsWith('http') ? '' : ''}${input.url}` : `${appUrl()}/admin/feedback`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:520px">
        <h2 style="margin:0 0 8px">${escapeHtml(input.title)}</h2>
        ${input.body ? `<p style="color:#444;line-height:1.5">${escapeHtml(input.body)}</p>` : ''}
        <p style="margin-top:16px"><a href="${link}" style="background:#7c5dff;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">Open the admin board</a></p>
      </div>`;
    await Promise.all(emails.map((to) => sendEmail({ to, subject: `[Bubaly] ${input.title}`, html }).catch(() => null)));
  } catch (e) {
    console.error('[feedback-notify] super-admin email failed', e);
  }
}

type IdeaForIssue = {
  id: string; title: string; kind?: string | null; category?: string | null;
  problem?: string | null; body?: string | null; impact?: string | null;
  vote_count?: number | null; author_name?: string | null;
};

/**
 * How long a claimed idea is left to the worker filing its issue before another
 * worker may file it instead. Far longer than one GitHub round trip, so a live
 * claim is never taken over; short enough that a worker that died holding one
 * delays the idea by one backfill pass, not for good.
 */
export const GITHUB_ISSUE_CLAIM_LEASE_MS = 10 * 60_000;

/**
 * Mirror a feedback idea into the GitHub tracker (the right list by label) and
 * store the issue link back on the row. No-op (returns skipped) when GitHub
 * isn't configured, so submissions never depend on it.
 *
 * Claimed before GitHub is called. Three paths file issues — the submit action,
 * the backfill cron (Vercel and the GitHub dispatcher both fire it) and the
 * admin's "Sync now" — and each used to read the idea as unsynced, open an
 * issue and only then write the number back. Two that overlapped both opened
 * one. The claim is a conditional stamp of `github_synced_at` on a row that
 * still has no issue and no live claim: Postgres lets one such UPDATE match,
 * and every other worker matches zero rows and leaves the idea to the winner
 * (`skipped`, not an error). `github_synced_at` is otherwise written only
 * alongside an issue number, so on an unlinked idea it means exactly "claimed
 * at". A create that throws gives the claim back at once; a worker that dies
 * holding it is overtaken after GITHUB_ISSUE_CLAIM_LEASE_MS.
 */
export async function syncIdeaToGithub(admin: Admin, idea: IdeaForIssue): Promise<{ ok: true; issue: GithubIssue } | { ok: false; skipped: boolean; error?: string }> {
  if (!isGithubConfigured()) return { ok: false, skipped: true };
  const claimedAt = new Date();
  const claimStamp = claimedAt.toISOString();
  const leaseExpired = new Date(claimedAt.getTime() - GITHUB_ISSUE_CLAIM_LEASE_MS).toISOString();
  const { data: claimed, error: claimError } = await admin.from('feedback_ideas')
    .update({ github_synced_at: claimStamp })
    .eq('id', idea.id)
    .is('github_issue_number', null)
    .or(`github_synced_at.is.null,github_synced_at.lt.${leaseExpired}`)
    .select('id');
  if (claimError) {
    console.error('[feedback-notify] GitHub issue claim failed', { ideaId: idea.id, error: claimError });
    return { ok: false, skipped: false, error: 'Could not claim the idea for GitHub.' };
  }
  // Already linked, claimed by a live worker, or deleted: nothing to file here.
  if (wroteNoRows(claimed)) return { ok: false, skipped: true };
  let issue: GithubIssue;
  try {
    issue = await createIssue({
      title: issueTitle(idea),
      body: issueBody(idea, `${appUrl()}/feedback`),
      labels: githubLabels(idea),
    });
  } catch (e) {
    console.error('[feedback-notify] GitHub issue create failed', e);
    // No issue exists, so give the claim back for the next pass to file it.
    // Conditional on our own stamp: a worker that took over an expired claim
    // owns the idea now. A release that fails only waits out the lease.
    const { error: releaseError } = await admin.from('feedback_ideas')
      .update({ github_synced_at: null })
      .eq('id', idea.id)
      .is('github_issue_number', null)
      .eq('github_synced_at', claimStamp);
    if (releaseError) console.error('[feedback-notify] GitHub issue claim release failed', { ideaId: idea.id, error: releaseError });
    return { ok: false, skipped: false, error: e instanceof Error ? e.message : 'GitHub error' };
  }
  try {
    // This one is not best-effort. The issue EXISTS at GitHub by here, and this
    // row is the only record that it does — so a discarded failure returns
    // { ok: true } for a sync that left no trace, and once the claim's lease
    // runs out the next run files a SECOND issue for the same idea. The claim is
    // deliberately NOT released on this path for that reason.
    // And zero rows is the same lost record: an idea deleted since the read
    // leaves the issue orphaned at GitHub, which someone has to close.
    // Audit C1-S9-69.
    const { data: linked, error } = await admin.from('feedback_ideas').update({
      github_issue_number: issue.number,
      github_issue_url: issue.html_url,
      github_state: issue.state,
      github_synced_at: new Date().toISOString(),
    }).eq('id', idea.id).select('id');
    if (error || wroteNoRows(linked)) {
      console.error('[feedback-notify] GitHub issue created but the link was not recorded', { ideaId: idea.id, issue: issue.number, error });
      return { ok: false, skipped: false, error: 'The GitHub issue was created but could not be recorded.' };
    }
    return { ok: true, issue };
  } catch (e) {
    console.error('[feedback-notify] GitHub issue created but the link write threw', { ideaId: idea.id, issue: issue.number, error: e });
    return { ok: false, skipped: false, error: 'The GitHub issue was created but could not be recorded.' };
  }
}

/** Fire the on-submit side effects (notify super admin + mirror to GitHub).
 *  Fully best-effort; the caller's insert has already succeeded. */
export async function onFeedbackSubmitted(admin: Admin, idea: IdeaForIssue): Promise<void> {
  const meta = kindMeta(idea.kind ?? 'idea');
  const gh = await syncIdeaToGithub(admin, idea);
  const linkNote = gh.ok
    ? ` Tracked at ${gh.issue.html_url}.`
    : gh.skipped ? '' : ' (GitHub sync failed — see logs.)';
  await notifySuperAdmins(admin, {
    kind: 'feedback_new',
    title: `New ${meta.noun}: ${idea.title}`,
    body: `A family just submitted a ${meta.noun} on the feedback board.${linkNote}`,
    url: '/admin/feedback',
    relatedType: 'feedback_idea',
    relatedId: idea.id,
    meta: { kind: idea.kind ?? 'idea', github: gh.ok ? gh.issue.number : null },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
