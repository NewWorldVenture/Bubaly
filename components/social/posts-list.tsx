import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { formatDistanceToNow } from 'date-fns';
import { FileText } from 'lucide-react';
import type { Tables } from '@/lib/database.types';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';

const STATUS_TONE: Record<string, 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'accent'> = {
  draft: 'neutral',
  scheduled: 'warning',
  publishing: 'accent',
  published: 'success',
  partially_published: 'warning',
  failed: 'danger',
  canceled: 'neutral',
};

export async function PostsList({ posts, emptyLabel }: { posts: Tables<'social_posts'>[]; emptyLabel?: string }) {
  const t = await getTranslations();
  if (posts.length === 0) {
    return <EmptyState icon={FileText} title={emptyLabel ?? 'No posts yet'} description="Create content in the studio to see it here." />;
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-elevated text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">{t('postsList.post')}</th>
            <th className="px-3 py-2 font-medium">{t('postsList.kind')}</th>
            <th className="px-3 py-2 font-medium">{t('postsList.status')}</th>
            <th className="px-3 py-2 font-medium">{t('postsList.when')}</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((p) => (
            <tr key={p.id} className="border-t border-border hover:bg-elevated/50">
              <td className="px-3 py-2">
                <Link href={`/dashboard/social/posts/${p.id}`} className="font-medium hover:underline">
                  {p.title || p.body.slice(0, 60) || 'Untitled'}
                </Link>
              </td>
              <td className="px-3 py-2 capitalize text-muted">{p.kind}</td>
              <td className="px-3 py-2">
                <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status.replace(/_/g, ' ')}</Badge>
              </td>
              <td className="px-3 py-2 text-xs text-muted">
                {p.scheduled_for
                  ? `for ${new Date(p.scheduled_for).toLocaleString()}`
                  : `updated ${formatDistanceToNow(new Date(p.updated_at))} ago`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const POST_TABS = [
  { href: '/dashboard/social/posts', label: 'All' },
  { href: '/dashboard/social/scheduled', label: 'Scheduled' },
  { href: '/dashboard/social/published', label: 'Published' },
  { href: '/dashboard/social/failed', label: 'Failed' },
];

export function PostTabs({ active }: { active: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {POST_TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`rounded-lg px-3 py-1 text-sm font-medium ${active === t.href ? 'bg-elevated text-fg' : 'text-muted hover:text-fg'}`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
