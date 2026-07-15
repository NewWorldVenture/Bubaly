import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/server/email';
import { superAdminEmails as envSuperAdminEmails } from '@/lib/constants/super-admins';
import { kindMeta } from '@/lib/feedback/board';
import {
  isGithubConfigured, createIssue, type GithubIssue,
} from '@/lib/integrations/github';
import { issueTitle, issueBody, githubLabels } from '@/lib/feedback/github-map';

type Admin = ReturnType<typeof createServiceClient>;

type AdminNoteKind = 'feedback_new' | 'github_sync' | 'github_error' | 'info';

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://www.bubaly.com').replace(/\/$/, '');
}

/** Every super-admin email: the code/env allowlist ∪ the super_admins table. */
export async function allSuperAdminEmails(admin: Admin): Promise<string[]> {
  const set = new Set(envSuperAdminEmails());
  try {
    const { data } = await admin.from('super_admins').select('email');
    for (const r of data ?? []) if (r.email) set.add(r.email.toLowerCase());
  } catch { /* table may not exist yet — env allowlist still applies */ }
  return [...set];
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
    await admin.from('admin_notifications').insert({
      kind: input.kind, title: input.title, body: input.body ?? null, url: input.url ?? null,
      related_type: input.relatedType ?? null, related_id: input.relatedId ?? null,
      meta: (input.meta ?? {}) as never,
    });
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
 * Mirror a feedback idea into the GitHub tracker (the right list by label) and
 * store the issue link back on the row. No-op (returns skipped) when GitHub
 * isn't configured, so submissions never depend on it.
 */
export async function syncIdeaToGithub(admin: Admin, idea: IdeaForIssue): Promise<{ ok: true; issue: GithubIssue } | { ok: false; skipped: boolean; error?: string }> {
  if (!isGithubConfigured()) return { ok: false, skipped: true };
  try {
    const issue = await createIssue({
      title: issueTitle(idea),
      body: issueBody(idea, `${appUrl()}/feedback`),
      labels: githubLabels(idea),
    });
    await admin.from('feedback_ideas').update({
      github_issue_number: issue.number,
      github_issue_url: issue.html_url,
      github_state: issue.state,
      github_synced_at: new Date().toISOString(),
    }).eq('id', idea.id);
    return { ok: true, issue };
  } catch (e) {
    console.error('[feedback-notify] GitHub issue create failed', e);
    return { ok: false, skipped: false, error: e instanceof Error ? e.message : 'GitHub error' };
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
