import type { Metadata } from 'next';
import { ImageIcon, Film, Music, FileText } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getMediaLibrary } from '@/lib/social/queries';
import { createMediaAction } from '@/app/(app)/dashboard/social/actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Media Library · Social' };
export const dynamic = 'force-dynamic';

const KIND_ICON = { image: ImageIcon, video: Film, audio: Music, document: FileText, thumbnail: ImageIcon } as const;

export default async function MediaLibraryPage() {
  const ctx = await requireUserContext();
  const assets = await getMediaLibrary(ctx.active.familyId);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <h2 className="text-sm font-semibold">Assets</h2>
        {assets.length === 0 ? (
          <EmptyState icon={ImageIcon} title="No media yet" description="Add an asset by URL, or record a prompt/storyboard for AI generation. Generated media is only stored when a real generation provider returns a file." />
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
        <h3 className="mb-2 text-sm font-semibold">Add asset</h3>
        <form action={createMediaAction} className="space-y-2">
          <input name="title" placeholder="Title" className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <select name="kind" className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm">
            <option value="image">Image</option>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
            <option value="document">Document</option>
            <option value="thumbnail">Thumbnail</option>
          </select>
          <input name="url" placeholder="URL (leave blank for a prompt/storyboard asset)" className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <input name="alt_text" placeholder="Alt text (accessibility)" className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <input name="tags" placeholder="tags, comma, separated" className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-sm" />
          <button className="h-9 w-full rounded-lg bg-brand text-sm font-medium text-brand-fg">Add to library</button>
        </form>
        <p className="mt-2 text-[11px] text-muted">Aspect-ratio guidance per platform is shown in the studio preview when you select target platforms.</p>
      </Card>
    </div>
  );
}
