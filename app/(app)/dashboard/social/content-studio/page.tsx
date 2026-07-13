import type { Metadata } from 'next';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { PenSquare, Sparkles, Wand2 } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getPosts } from '@/lib/social/queries';
import { AI_KIND_LABELS, type AiGenerationKind } from '@/lib/social/ai-kinds';
import { PostsList } from '@/components/social/posts-list';
import { Card } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Content Studio · Social' };
export const dynamic = 'force-dynamic';

export default async function ContentStudioPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [drafts, { data: generations }, { data: templates }] = await Promise.all([
    getPosts(familyId, ['draft']),
    supabase.from('social_ai_generations').select('id, kind, prompt, model, status, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(8),
    supabase.from('social_content_templates').select('id, name, kind').eq('family_id', familyId).is('deleted_at', null).limit(8),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Content Studio</h2>
          <p className="text-xs text-muted">Draft once, generate with AI, tailor per platform, and publish everywhere.</p>
        </div>
        <Link href="/dashboard/social/content-studio/new" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
          <PenSquare className="h-4 w-4" /> New post
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Your drafts</h3>
            <PostsList posts={drafts} emptyLabel="No drafts yet" />
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> Recent AI generations</h3>
            {(generations ?? []).length === 0 ? (
              <p className="text-xs text-muted">AI generation history will appear here. Open a new post to generate captions, hashtags, scripts, and more.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {(generations ?? []).map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2 border-b border-border/50 pb-1.5">
                    <span className="truncate">{AI_KIND_LABELS[g.kind as AiGenerationKind] ?? g.kind}</span>
                    <span className="shrink-0 text-xs text-muted">{formatDistanceToNow(new Date(g.created_at))} ago</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Wand2 className="h-4 w-4 text-accent" /> Templates</h3>
            {(templates ?? []).length === 0 ? (
              <p className="text-xs text-muted">No saved templates yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {(templates ?? []).map((t) => (
                  <li key={t.id} className="flex items-center justify-between">
                    <span>{t.name}</span>
                    <span className="text-xs capitalize text-muted">{t.kind}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
