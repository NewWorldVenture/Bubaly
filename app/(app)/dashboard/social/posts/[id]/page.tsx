import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getPost } from '@/lib/social/queries';
import { PlatformBadge, PlatformDot } from '@/components/social/platform';
import { RetryPublishButton } from '@/components/social/retry-button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { SocialPlatform } from '@/lib/social/capabilities';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Post · Social' };
export const dynamic = 'force-dynamic';

const TARGET_TONE: Record<string, 'neutral' | 'success' | 'danger' | 'warning' | 'accent'> = {
  pending: 'neutral', publishing: 'accent', published: 'success', failed: 'danger', skipped: 'warning', canceled: 'neutral',
};

export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const tr = await getTranslations();
  const { id } = await params;
  const ctx = await requireUserContext();
  const { post, variants, targets, results } = await getPost(ctx.active.familyId, id);
  if (!post) notFound();

  const awaitingConfirmation = post.status === 'publishing' || targets.some((t) => t.status === 'publishing');
  const canRetry = !awaitingConfirmation
    && ['draft', 'scheduled', 'failed', 'partially_published'].includes(post.status)
    && targets.some((t) => t.status === 'failed' || t.status === 'pending');

  return (
    <div className="space-y-4">
      <Link href="/dashboard/social/posts" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> {tr('dashboardSocialPosts.backToPosts')}
      </Link>

      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{post.title || 'Untitled post'}</h2>
          <Badge tone={post.status === 'published' ? 'success' : post.status === 'failed' ? 'danger' : 'neutral'}>
            {post.status.replace(/_/g, ' ')}
          </Badge>
        </div>
        <p className="whitespace-pre-wrap text-sm text-muted">{post.body}</p>
        {awaitingConfirmation && <p role="status" className="mt-2 text-sm text-warning">{tr('socialPost.awaitingConfirmation')}</p>}
        {post.link && <a href={post.link} className="mt-2 inline-flex items-center gap-1 text-sm text-brand-text underline" target="_blank" rel="noreferrer">{post.link} <ExternalLink className="h-3 w-3" /></a>}
        {post.scheduled_for && <p className="mt-2 text-xs text-muted">{tr('dashboardSocialPosts.scheduledFor')} {new Date(post.scheduled_for).toLocaleString()}</p>}
      </Card>

      {variants.length > 0 && (
        <Card>
          <h3 className="mb-3 text-sm font-semibold">{tr('dashboardSocialPosts.platformVariants')}</h3>
          <div className="space-y-3">
            {variants.map((v) => (
              <div key={v.id} className="rounded-xl border border-border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <PlatformBadge platform={v.platform as SocialPlatform} />
                  <span className="text-xs text-muted">{v.char_count} chars</span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-muted">{v.body}</p>
                {v.hashtags.length > 0 && <p className="mt-1 text-xs text-brand-text">{v.hashtags.map((h) => `#${h}`).join(' ')}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{tr('dashboardSocialPosts.publishTargets')}</h3>
          {canRetry && <RetryPublishButton postId={post.id} />}
        </div>
        {targets.length === 0 ? (
          <p className="text-sm text-muted">{tr('dashboardSocialPosts.noPublishTargetsAddConnectedAccounts')}</p>
        ) : (
          <div className="space-y-2">
            {targets.map((t) => (
              <div key={t.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <PlatformDot platform={t.platform as SocialPlatform} />
                <Badge tone={TARGET_TONE[t.status] ?? 'neutral'}>{t.status}</Badge>
                {t.permalink_url ? (
                  <a href={t.permalink_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-brand-text underline">{tr('posts.view')}{' '}<ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="ml-auto text-xs text-muted">{t.error ?? '—'}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {results.length > 0 && (
        <Card>
          <h3 className="mb-3 text-sm font-semibold">{tr('dashboardSocialPosts.publishHistory')}</h3>
          <div className="space-y-1.5 text-sm">
            {results.map((r) => (
              <div key={r.id} className="flex items-center gap-2 border-b border-border/50 pb-1.5">
                <PlatformDot platform={r.platform as SocialPlatform} />
                <Badge tone={TARGET_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                <span className="text-xs text-muted">{r.status === 'publishing'
                  ? (r.error_message || tr('socialPost.awaitingConfirmation'))
                  : r.error_code ? `${r.error_code}: ${r.error_message ?? ''}`
                  : r.error_message || r.permalink_url || (r.status === 'published' && r.provider_object_id ? 'confirmed' : '—')}</span>
                <span className="ml-auto text-xs text-muted">{new Date(r.attempted_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
