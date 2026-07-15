import type { Metadata } from 'next';
import Link from 'next/link';
import { MessagesSquare, ExternalLink, Github } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import type { IdeaRow } from '@/lib/feedback/board';
import { githubRepoStatus } from '@/lib/integrations/github';
import { FeedbackAdmin, type AdminComment, type AdminNotification } from '@/components/admin/feedback-admin';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Admin · Feedback & Ideas', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminFeedbackPage() {
  const supabase = createServiceClient();

  const [ideasResult, commentsResult, notesResult, gh] = await Promise.all([
    supabase.from('feedback_ideas')
      .select('id, title, problem, body, category, impact, audience, kind, status, admin_note, image_url, author_name, vote_count, comment_count, pinned, github_issue_number, github_issue_url, created_at')
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1000),
    supabase.from('feedback_comments')
      .select('id, idea_id, author_name, is_team, body, created_at')
      .order('created_at', { ascending: true })
      .limit(3000),
    supabase.from('admin_notifications')
      .select('id, kind, title, body, url, is_read, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
    githubRepoStatus(),
  ]);

  const readError = ideasResult.error ?? commentsResult.error ?? notesResult.error;
  if (readError) {
    console.error('[admin-feedback] feedback read failed', readError);
    return <AdminFeedbackReadError />;
  }

  const { data: ideas } = ideasResult;
  const { data: comments } = commentsResult;
  const { data: notes } = notesResult;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15">
            <MessagesSquare className="h-6 w-6 text-brand-text" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Feedback &amp; Ideas</h1>
            <p className="mt-1 text-sm text-muted">
              Every idea and bug families submit at <code className="text-xs">/feedback</code> — received here,
              mirrored to the GitHub tracker (bugs + enhancements), and reconciled back by the bot. Act on any of
              it: move it through the roadmap, note it, pin it, reply as the team, or remove spam.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${gh.ok ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-500' : 'border-border text-muted'}`}>
            <Github className="h-3.5 w-3.5" /> {gh.ok ? `Tracker: ${gh.repo}` : 'GitHub not configured'}
          </span>
          <Link href="/feedback" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-muted transition hover:bg-elevated hover:text-fg">
            Public board <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <FeedbackAdmin
        ideas={(ideas ?? []) as IdeaRow[]}
        comments={(comments ?? []) as AdminComment[]}
        notifications={(notes ?? []) as AdminNotification[]}
        githubConfigured={gh.ok}
      />
    </div>
  );
}

function AdminFeedbackReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Feedback &amp; Ideas</h1>
        <p className="mt-1 text-sm text-muted">Ideas and bug reports from the public feedback board.</p>
      </div>
      <ErrorState message="Could not load feedback from Supabase. Refresh and try again." />
      <a href="/admin/feedback" className="text-sm font-medium text-brand-text underline">Refresh feedback</a>
    </div>
  );
}
