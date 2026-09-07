import type { Metadata } from 'next';
import Link from 'next/link';
import { Film, Eye, EyeOff, FileText, Youtube } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { thumbnailUrl, formatDuration, isVideoProvider, type VideoProvider } from '@/lib/marketing/video';
import { saveVideoAction, toggleVideoPublishAction, deleteVideoAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'video.videoMarketing', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Video = Tables<'marketing_videos'>;
type Asset = Tables<'marketing_assets'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

const PROVIDER_LABEL: Record<VideoProvider, string> = { youtube: 'YouTube', vimeo: 'Vimeo', upload: 'Uploaded' };

export default async function VideoPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  const [videosResult, assetsResult] = await Promise.all([
    supabase.from('marketing_videos').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(300),
    supabase.from('marketing_assets').select('id, name').eq('kind', 'video').is('deleted_at', null).order('created_at', { ascending: false }).limit(200),
  ]);
  const readError = videosResult.error ?? assetsResult.error;
  if (readError) {
    console.error('[admin-marketing-video] video read failed', readError);
    return <AdminVideoReadError />;
  }
  const { data: videoData } = videosResult;
  const { data: assetData } = assetsResult;
  const videos = (videoData ?? []) as Video[];
  const videoAssets = (assetData ?? []) as Pick<Asset, 'id' | 'name'>[];
  const published = videos.filter((v) => v.status === 'published').length;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Catalog YouTube/Vimeo embeds or uploaded videos. Transcripts feed AEO/SEO; published videos can embed in content and landing pages.
      </p>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Film className="h-4 w-4 text-brand-text" /> {tr('adminMarketingVideo.addVideo')}</h2>
        <form action={saveVideoAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="title" required placeholder={tr('adminMarketingVideo.title')} className={`${inputCls} lg:col-span-2`} />
          <select name="status" defaultValue="draft" className={inputCls} aria-label={tr('adminMarketingVideo.status')}>
            <option value="draft">{tr('adminMarketingVideo.draft')}</option>
            <option value="published">{tr('adminMarketingVideo.published')}</option>
          </select>
          <input name="duration_seconds" type="number" min="0" placeholder={tr('adminMarketingVideo.durationSec')} className={inputCls} />
          <input name="url" placeholder={tr('adminMarketingVideo.youtubeVimeoUrl')} className={`${inputCls} lg:col-span-2`} />
          <input name="attribution" placeholder={tr('adminMarketingVideo.attributionIfRequired')} className={inputCls} />
          <select name="asset_id" defaultValue="" className={inputCls} aria-label={tr('adminMarketingVideo.orPickAnUploadedVideo')}>
            <option value="">{tr('adminMarketingVideo.orPickUploadedVideo')}</option>
            {videoAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input name="poster_url" placeholder={tr('adminMarketingVideo.posterImageUrlOptional')} className={inputCls} />
          <select name="license" defaultValue="embedded_source" className={inputCls} aria-label={tr('adminMarketingVideo.videoLicense')}>
            <option value="embedded_source">{tr('adminMarketingVideo.embeddedSourceTerms')}</option><option value="original">{tr('adminMarketingVideo.originalOwned')}</option><option value="cc0">{tr('adminMarketingVideo.cc0PublicDomain')}</option><option value="cc_by">{tr('adminMarketingVideo.creativeCommonsBy')}</option><option value="licensed">{tr('adminMarketingVideo.licensedWithProof')}</option>
          </select>
          <input name="tags" placeholder={tr('adminMarketingVideo.tagsCommaSeparated')} className={`${inputCls} lg:col-span-2`} />
          <textarea name="transcript" placeholder={tr('adminMarketingVideo.transcriptOptionalFeedsAeoSeo')} rows={2} className={`${inputCls} h-auto py-2 lg:col-span-2`} />
          <button type="submit" className={btnCls}>{tr('adminMarketingVideo.addVideo')}</button>
        </form>
        <p className="mt-3 text-xs text-muted">
          {videos.length} video{videos.length === 1 ? '' : 's'} · {published} {tr('adminMarketingVideo.publishedPasteAUrlOrPick')}
        </p>
      </Card>

      {videos.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{tr('adminMarketingVideo.noVideosYetAddYourFirst')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((v) => {
            const provider = isVideoProvider(v.provider) ? v.provider : 'upload';
            const thumb = v.poster_url ?? thumbnailUrl(provider, v.video_id);
            return (
              <div key={v.id} className="flex flex-col rounded-xl border border-border bg-surface/40 p-3">
                <div className="mb-2 flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-elevated">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt={v.title} className="h-full w-full object-cover" />
                  ) : (
                    <Film className="h-8 w-8 text-muted" />
                  )}
                </div>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium" title={v.title}>{v.title}</p>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${v.status === 'published' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-300'}`}>
                    {v.status === 'published' ? 'Live' : 'Draft'}
                  </span>
                </div>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  {provider === 'youtube' ? <Youtube className="h-3 w-3" /> : <Film className="h-3 w-3" />}
                  {PROVIDER_LABEL[provider]}
                  {v.duration_seconds ? ` · ${formatDuration(v.duration_seconds)}` : ''}
                  {v.transcript ? <span className="inline-flex items-center gap-0.5"> · <FileText className="h-3 w-3" /> transcript</span> : ''}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">{fmtDate(v.created_at)}</p>
                {v.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {v.tags.map((t) => <span key={t} className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-muted">{t}</span>)}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-3 text-xs">
                  <form action={toggleVideoPublishAction.bind(null, v.id, v.status !== 'published')}>
                    <button type="submit" className="inline-flex items-center gap-1 text-muted hover:text-fg">
                      {v.status === 'published' ? <><EyeOff className="h-3 w-3" />{' '}{tr('video.unpublish')}</> : <><Eye className="h-3 w-3" />{' '}{tr('video.publish')}</>}
                    </button>
                  </form>
                  <form action={deleteVideoAction.bind(null, v.id)}>
                    <button type="submit" className="text-muted hover:text-rose-400">{tr('video.delete')}</button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

async function AdminVideoReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('video.videoMarketing')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('video.catalogAndPublishVideoContent')}</p>
      </div>
      <ErrorState message={tr('video.couldNotLoadMarketingVideos')} />
      <Link href="/admin/marketing/video" className="text-sm font-medium text-brand-text underline">{tr('video.refreshVideos')}</Link>
    </div>
  );
}
