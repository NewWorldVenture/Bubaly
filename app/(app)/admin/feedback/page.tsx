import type { Metadata } from 'next';
import Link from 'next/link';
import { MessagesSquare, ExternalLink } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import type { IdeaRow } from '@/lib/feedback/board';
import { FeedbackAdmin, type AdminComment } from '@/components/admin/feedback-admin';

export const metadata: Metadata = { title: 'Admin · Feedback & Ideas', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminFeedbackPage() {
  const supabase = createServiceClient();

  const [{ data: ideas }, { data: comments }] = await Promise.all([
    supabase.from('feedback_ideas')
      .select('id, title, problem, body, category, impact, audience, status, admin_note, image_url, author_name, vote_count, comment_count, pinned, created_at')
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1000),
    supabase.from('feedback_comments')
      .select('id, idea_id, author_name, is_team, body, created_at')
      .order('created_at', { ascending: true })
      .limit(3000),
  ]);

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
              Every idea families submit at <code className="text-xs">/feedback</code> — receive it here and act on it:
              move it through the roadmap, add a public note, pin it, reply as the team, or remove spam. Changes
              are live on the public board instantly.
            </p>
          </div>
        </div>
        <Link href="/feedback" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-muted transition hover:bg-elevated hover:text-fg">
          View public board <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      <FeedbackAdmin ideas={(ideas ?? []) as IdeaRow[]} comments={(comments ?? []) as AdminComment[]} />
    </div>
  );
}
