import type { Metadata } from 'next';
import { formatDistanceToNow } from 'date-fns';
import { Inbox as InboxIcon, ExternalLink } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getInbox, getAccounts } from '@/lib/social/queries';
import { resolveCommentAction } from '@/app/(app)/dashboard/social/actions';
import { PROVIDERS, PLATFORMS, type SocialPlatform } from '@/lib/social/capabilities';
import { PlatformDot } from '@/components/social/platform';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Inbox · Social' };
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const [{ comments, messages }, accounts] = await Promise.all([
    getInbox(familyId),
    getAccounts(familyId),
  ]);
  const connected = new Set(accounts.filter((a) => a.status === 'connected').map((a) => a.platform));
  const noInboxPlatforms = PLATFORMS.filter((p) => !PROVIDERS[p].inbox.supported);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <h2 className="text-sm font-semibold">Comments &amp; mentions</h2>
          {comments.length === 0 ? (
            <EmptyState
              icon={InboxIcon}
              title="Inbox is empty"
              description="Comments, mentions, and replies from connected accounts appear here once their APIs are credentialed. Nothing is fabricated."
            />
          ) : (
            comments.map((c) => (
              <Card key={c.id}>
                <div className="mb-1 flex items-center gap-2">
                  <PlatformDot platform={c.platform as SocialPlatform} />
                  <span className="text-sm font-medium">{c.author_name ?? c.author_handle ?? 'Someone'}</span>
                  <span className="text-xs capitalize text-muted">· {c.kind}</span>
                  {c.posted_at && <span className="text-xs text-muted">· {formatDistanceToNow(new Date(c.posted_at))} ago</span>}
                  <Badge tone={c.status === 'open' ? 'warning' : 'neutral'} className="ml-auto">{c.status}</Badge>
                </div>
                <p className="text-sm text-muted">{c.body}</p>
                <div className="mt-2 flex items-center gap-3">
                  {c.permalink_url && <a href={c.permalink_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-text underline">Open original <ExternalLink className="h-3 w-3" /></a>}
                  {c.status === 'open' && (
                    <form action={resolveCommentAction.bind(null, c.id)}>
                      <button className="text-xs font-medium text-muted hover:text-fg underline">Mark resolved</button>
                    </form>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Messages</h2>
          {messages.length === 0 ? (
            <Card><p className="text-xs text-muted">No direct messages synced.</p></Card>
          ) : (
            messages.map((m) => (
              <Card key={m.id}>
                <div className="mb-1 flex items-center gap-2">
                  <PlatformDot platform={m.platform as SocialPlatform} />
                  <span className="text-sm font-medium">{m.author_name ?? m.author_handle ?? 'Someone'}</span>
                </div>
                <p className="text-sm text-muted">{m.body}</p>
              </Card>
            ))
          )}

          <Card>
            <h3 className="mb-1 text-xs font-semibold">No inbox API</h3>
            <p className="text-xs text-muted">
              These platforms have no third-party comment/DM management API, so they are honestly excluded from the inbox:
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {noInboxPlatforms.map((p) => <span key={p} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]"><PlatformDot platform={p} /> {PROVIDERS[p].label}</span>)}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
