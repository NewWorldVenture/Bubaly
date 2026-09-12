import type { Metadata } from 'next';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Newspaper, ExternalLink, Heart, MessageCircle, Repeat2, Plug } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getFeed, getAccounts } from '@/lib/social/queries';
import { PLATFORMS, PROVIDERS, isPlatform, type SocialPlatform } from '@/lib/social/capabilities';
import { PlatformBadge } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';
import { safeSocialLink } from '@/lib/social/links';

export const metadata: Metadata = { title: 'Feed · Social' };
export const dynamic = 'force-dynamic';

type SP = { platform?: string; media?: string; q?: string };

export default async function FeedPage({ searchParams }: { searchParams: Promise<SP> }) {
  const t = await getTranslations();
  const sp = await searchParams;
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const platform = isPlatform(sp.platform) ? sp.platform : undefined;

  const [items, accounts] = await Promise.all([
    getFeed(familyId, { platform, mediaType: sp.media, search: sp.q }),
    getAccounts(familyId),
  ]);

  const connected = accounts.filter((a) => a.status === 'connected');
  const qs = (next: Partial<SP>) => {
    const merged = { ...sp, ...next };
    const params = new URLSearchParams();
    Object.entries(merged).forEach(([k, v]) => { if (v) params.set(k, String(v)); });
    const s = params.toString();
    return `/dashboard/social/feed${s ? `?${s}` : ''}`;
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={qs({ platform: undefined })} className={`rounded-lg px-2.5 py-1 text-xs font-medium ${!platform ? 'bg-brand text-brand-fg' : 'border border-border text-muted'}`}>{t('dashboardSocialFeed.allPlatforms')}</Link>
          {PLATFORMS.map((p) => (
            <Link key={p} href={qs({ platform: p })} className={`rounded-lg px-2.5 py-1 text-xs font-medium ${platform === p ? 'bg-brand text-brand-fg' : 'border border-border text-muted'}`}>
              {PROVIDERS[p].label}
            </Link>
          ))}
        </div>
        <form className="mt-3 flex gap-2" action="/dashboard/social/feed">
          {platform && <input type="hidden" name="platform" value={platform} />}
          <input name="q" defaultValue={sp.q ?? ''} placeholder={t('dashboardSocialFeed.searchTheFeed')} className="flex-1 rounded-lg border border-border bg-elevated px-3 py-1.5 text-sm" />
          <button className="rounded-lg bg-elevated px-3 py-1.5 text-sm font-medium">{t('dashboardSocialFeed.search')}</button>
        </form>
      </Card>

      {items.length === 0 ? (
        <EmptyState
          icon={connected.length === 0 ? Plug : Newspaper}
          title={connected.length === 0 ? 'No connected accounts' : 'No feed items yet'}
          description={
            connected.length === 0
              ? 'Connect an account to pull a unified feed. Live feed access requires each platform’s API credentials; until then the feed stays honestly empty rather than showing fabricated posts.'
              : 'Connected accounts have no synced posts yet. Background sync writes real items here once provider credentials are configured.'
          }
          action={
            connected.length === 0 ? (
              <Link href="/dashboard/social/accounts/connect" className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg">
                <Plug className="h-4 w-4" /> {t('dashboardSocialFeed.connectAnAccount')}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const meta = (item.metadata ?? {}) as Record<string, unknown>;
            const url = safeSocialLink(item.permalink_url) ?? safeSocialLink(meta.profile_url);
            const metrics = (item.metrics ?? {}) as Record<string, number>;
            const inner = (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <PlatformBadge platform={item.platform as SocialPlatform} />
                  <span className="text-sm font-medium">{item.author_name ?? item.author_handle ?? 'Unknown'}</span>
                  {item.posted_at && <span className="text-xs text-muted">· {formatDistanceToNow(new Date(item.posted_at))} ago</span>}
                  {url && <ExternalLink className="ml-auto h-3.5 w-3.5 text-muted" />}
                </div>
                {item.body && <p className="whitespace-pre-wrap text-sm">{item.body}</p>}
                <div className="mt-2 flex gap-4 text-xs text-muted">
                  {metrics.likes != null && <span className="inline-flex items-center gap-1"><Heart className="h-3 w-3" /> {metrics.likes}</span>}
                  {metrics.comments != null && <span className="inline-flex items-center gap-1"><MessageCircle className="h-3 w-3" /> {metrics.comments}</span>}
                  {metrics.shares != null && <span className="inline-flex items-center gap-1"><Repeat2 className="h-3 w-3" /> {metrics.shares}</span>}
                </div>
              </>
            );
            return (
              <Card key={item.id}>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="block">{inner}</a>
                ) : (
                  <div>{inner}</div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
