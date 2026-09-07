import type { Metadata } from 'next';
import { ImageIcon, Film, Music, FileText } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getMediaLibrary } from '@/lib/social/queries';
import { createMediaAction } from '@/app/(app)/dashboard/social/actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Media Library · Social' };
export const dynamic = 'force-dynamic';

const KIND_ICON = { image: ImageIcon, video: Film, audio: Music, document: FileText, thumbnail: ImageIcon } as const;

export default async function MediaLibraryPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const assets = await getMediaLibrary(ctx.active.familyId);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <h2 className="text-sm font-semibold">{t('dashboardSocialMediaLibrary.assets')}</h2>
        {assets.length === 0 ? (
          <EmptyState icon={ImageIcon} title={t('dashboardSocialMediaLibrary.noMediaYet')} description={t('mediaLibrary.addAnAssetByUrl')} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {assets.map((a) => {
              const Icon = KIND_ICON[a.kind] ?? FileText;
              return (
                <Card key={a.id} className="space-y-2">
                  <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-elevated">
                    {a.url && a.kind === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.url} alt={a.alt_text ?? a.title ?? ''} className="h-full w-full object-cover" />
                    ) : (
                      <Icon className="h-8 w-8 text-muted" />
                    )}
                  </div>
                  <p className="truncate text-xs font-medium">{a.title ?? 'Untitled'}</p>
                  <div className="flex items-center gap-1">
                    <Badge tone="neutral">{a.kind}</Badge>
                    <Badge tone={a.status === 'ready' ? 'success' : 'warning'}>{a.status}</Badge>
                  </div>
                  {a.tags.length > 0 && <p className="truncate text-[11px] text-muted">{a.tags.join(', ')}</p>}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Card>
        <h3 className="mb-2 text-sm font-semibold">{t('dashboardSocialMediaLibrary.addAsset')}</h3>
        <form action={createMediaAction} className="space-y-2">
          <input name="title" placeholder={t('dashboardSocialMediaLibrary.title')} className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <select name="kind" className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm">
            <option value="image">{t('dashboardSocialMediaLibrary.image')}</option>
            <option value="video">{t('dashboardSocialMediaLibrary.video')}</option>
            <option value="audio">{t('dashboardSocialMediaLibrary.audio')}</option>
            <option value="document">{t('dashboardSocialMediaLibrary.document')}</option>
            <option value="thumbnail">{t('dashboardSocialMediaLibrary.thumbnail')}</option>
          </select>
          <input name="url" placeholder={t('dashboardSocialMediaLibrary.urlLeaveBlankForAPrompt')} className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <input name="alt_text" placeholder={t('dashboardSocialMediaLibrary.altTextAccessibility')} className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <input name="tags" placeholder={t('dashboardSocialMediaLibrary.tagsCommaSeparated')} className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <button className="h-9 w-full rounded-lg bg-brand text-sm font-medium text-brand-fg">{t('dashboardSocialMediaLibrary.addToLibrary')}</button>
        </form>
        <p className="mt-2 text-[11px] text-muted">{t('dashboardSocialMediaLibrary.aspectRatioGuidancePerPlatformIs')}</p>
      </Card>
    </div>
  );
}
