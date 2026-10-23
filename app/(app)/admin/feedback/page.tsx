import type { Metadata } from 'next';
import Link from 'next/link';
import { MessagesSquare, ExternalLink, Github } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settle, settleAll } from '@/lib/supabase/settle';
import { FILTERABLE_STATUSES, type FeedbackStatus, type IdeaRow } from '@/lib/feedback/board';
import type { FeedbackBoardCounts } from '@/lib/feedback/admin';
import { githubRepoStatus } from '@/lib/integrations/github';
import { FeedbackAdmin, type AdminComment, type AdminNotification } from '@/components/admin/feedback-admin';
import { ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { getTranslations } from '@/lib/i18n/server';
import { readAllAsQuery, readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { signFeedbackAttachments } from '@/lib/storage/feedback-attachment-signing';

export const metadata: Metadata = { title: 'Admin · Feedback & Ideas', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** Comments the threads' paged read may go through before it is reported as a prefix. */
const COMMENT_CEILING = 3000;
/** Ideas the Total votes tile may page through before it says it is not shown (one round trip per 1,000). */
const VOTE_ROW_CEILING = 25_000;

export default async function AdminFeedbackPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();

  // The tiles (Needs review, Active, Shipped, Total ideas, Total votes) and the
  // status chips were tallied from the listed ideas, which are the newest 1,000
  // at most, so past 1,000 ideas they were the listed ideas' totals with
  // nothing to say so (review R7B-FEEDBACK-IDEAS-LIMIT-FEEDS-SUMMED-TILES). The
  // board is counted now: head:true counts of every idea and of each status,
  // and every idea's votes added up, paged on the id so a vote cast between
  // two pages cannot add an idea twice. Past VOTE_ROW_CEILING ideas Total
  // votes alone says it is not shown. The list itself is as it was.
  //
  // The relay's "N new" badge counted the unread among the newest 50
  // notifications it lists, while Mark all read marks every unread one (review
  // R8B-FEEDBACK-RELAY-UNREAD-BADGE-CAPPED). It is a head:true count of every
  // unread notification now, as /admin counts it.
  const [ideasResult, commentsResult, notesResult, gh, totalResult, votesResult, statusCountResults, unreadResult] = await Promise.all([
    settle(supabase.from('feedback_ideas')
      .select('id, title, problem, body, category, impact, audience, kind, status, admin_note, image_url, author_name, vote_count, comment_count, pinned, github_issue_number, github_issue_url, created_at')
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1000)),
    // `.limit(3000)` was never 3,000 — PostgREST caps at db-max-rows — and
    // `created_at` alone is not a total order, so pages could also overlap.
    settle(readAllAsQuery((from, to) => supabase.from('feedback_comments')
      .select('id, idea_id, author_name, is_team, body, created_at')
      .order('created_at', { ascending: true })
      .order('id')
      .range(from, to), { max: COMMENT_CEILING })),
    settle(supabase.from('admin_notifications')
      .select('id, kind, title, body, url, is_read, created_at')
      .order('created_at', { ascending: false })
      .limit(50)),
    githubRepoStatus(),
    settle(supabase.from('feedback_ideas').select('id', { count: 'exact', head: true })),
    settle(readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('feedback_ideas').select('id, vote_count');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: VOTE_ROW_CEILING })),
    settleAll(FILTERABLE_STATUSES.map((status) =>
      supabase.from('feedback_ideas').select('id', { count: 'exact', head: true }).eq('status', status))),
    settle(supabase.from('admin_notifications').select('id', { count: 'exact', head: true }).eq('is_read', false)),
  ]);

  // The comment rows only fill the threads. Past the ceiling they are a prefix,
  // so the threads say they are not shown, and the ideas, every moderation form
  // and the relay, which need none of them, stay: reaching it used to be the
  // read-error state for the whole console (review
  // R6-FEEDBACK-COMMENT-CEILING-TAKES-THE-IDEAS). A comment read that FAILS is
  // still the read-error state.
  const threadsCeiling = 'truncated' in commentsResult && commentsResult.truncated;
  if (threadsCeiling) console.warn('[admin-feedback] the comment read reached its ceiling; the threads are not shown');
  const votesCeiling = 'truncated' in votesResult && votesResult.truncated;
  if (votesCeiling) console.warn('[admin-feedback] the vote read reached its ceiling; Total votes is not shown');
  const readError = ideasResult.error ?? (threadsCeiling ? null : commentsResult.error) ?? notesResult.error
    ?? totalResult.error ?? (votesCeiling ? null : votesResult.error) ?? statusCountResults.find((r) => r.error)?.error
    ?? unreadResult.error;
  if (readError) {
    console.error('[admin-feedback] feedback read failed', readError);
    return <AdminFeedbackReadError />;
  }

  const counts: FeedbackBoardCounts = {
    total: totalResult.count ?? 0,
    byStatus: Object.fromEntries(FILTERABLE_STATUSES.map((status, i) => [status, statusCountResults[i]?.count ?? 0])) as Record<FeedbackStatus, number>,
    totalVotes: votesCeiling ? null : (votesResult.data ?? []).reduce((n, i) => n + (i.vote_count || 0), 0),
  };

  // `feedback-attachments` is private as of 0450, so the stored value — a bare
  // path on new rows, an old public URL on rows written before it — is not
  // something an <img src> can load. This is the only surface that draws these
  // screenshots, so it is the only place that has to sign them.
  const ideas = await signFeedbackAttachments(supabase, ideasResult.data ?? []);
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
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminFeedback.feedbackAmpIdeas')}</h1>
            <p className="mt-1 text-sm text-muted">
              {t('adminFeedback.everyIdeaAndBugFamiliesSubmit')} <code className="text-xs">/feedback</code> — received here,
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
            {t('adminFeedback.publicBoard')} <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: VOTE_ROW_CEILING.toLocaleString() })}
        failures={votesCeiling ? [t('feedbackAdmin.totalVotes')] : []}
      />

      <FeedbackAdmin
        ideas={(ideas ?? []) as IdeaRow[]}
        counts={counts}
        comments={threadsCeiling ? null : (comments ?? []) as AdminComment[]}
        notifications={(notes ?? []) as AdminNotification[]}
        unreadCount={unreadResult.count ?? 0}
        githubConfigured={gh.ok}
      />
    </div>
  );
}

async function AdminFeedbackReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Feedback &amp; Ideas</h1>
        <p className="mt-1 text-sm text-muted">{t('feedback.ideasAndBugReportsFrom')}</p>
      </div>
      <ErrorState message={t('feedback.couldNotLoadFeedbackFrom')} />
      <a href="/admin/feedback" className="text-sm font-medium text-brand-text underline">{t('feedback.refreshFeedback')}</a>
    </div>
  );
}
