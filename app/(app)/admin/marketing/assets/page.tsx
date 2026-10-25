import type { Metadata } from 'next';
import Link from 'next/link';
import { Image as ImageIcon, FileText, Film, Palette, UploadCloud } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import {
  ASSET_KINDS, assetsByKind, formatBytes, isImageMime, type AssetKind,
} from '@/lib/marketing/assets';
import { uploadAssetAction, updateAssetAction, deleteAssetAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('assets.assetLibrary'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

type Asset = Tables<'marketing_assets'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:brightness-95';

const KIND_ICON: Record<AssetKind, typeof ImageIcon> = {
  image: ImageIcon, video: Film, document: FileText, brand: Palette,
};
const KIND_LABEL: Record<AssetKind, string> = {
  image: 'Images', video: 'Video', document: 'Documents', brand: 'Brand',
};
const BUCKET = 'marketing-assets';
/** The newest assets the library lists. */
const LISTED = 300;
/** Assets the total size may page through before it says it is not shown (one round trip per 1,000). */
const SUM_ROW_CEILING = 10_000;

export default async function AssetsPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  // "N assets · size" and each kind's "(N)" were counted and summed from the
  // list, the newest 300, so past them each was the list's total presented as
  // the library's (coverage sweep round 9, class B). The counts are head:true
  // counts now, the size is summed over every asset, paged on the id (uploads
  // land while this reads) to a ceiling past which it says it is not shown,
  // and the library says when it lists part of the assets.
  const counted = () => supabase.from('marketing_assets').select('id', { count: 'exact', head: true }).is('deleted_at', null);
  const [[listResult, totalResult, bytesResult], kindResults] = await Promise.all([settleAll([
    supabase
      .from('marketing_assets')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(LISTED),
    counted(),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('marketing_assets').select('id, size_bytes').is('deleted_at', null);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING }),
  ]), settleAll(ASSET_KINDS.map((kind) => counted().eq('kind', kind)))]);
  const { data, error: listError } = listResult;
  const bytesCeiling = 'truncated' in bytesResult && bytesResult.truncated;
  const assetsError = listError ?? totalResult.error ?? (bytesCeiling ? null : bytesResult.error) ?? kindResults.find((r) => r.error)?.error;
  if (assetsError) {
    console.error('[admin-marketing-assets] asset read failed', assetsError);
    return <AdminAssetsReadError />;
  }
  const assets = (data ?? []) as Asset[];
  const totalAssets = totalResult.count ?? 0;
  const countByKind = new Map(ASSET_KINDS.map((kind, i) => [kind, kindResults[i]?.count ?? 0]));

  // Mint short-lived signed URLs for image previews (private bucket).
  const imagePaths = assets.filter((a) => isImageMime(a.mime_type)).map((a) => a.storage_path);
  const signed = new Map<string, string>();
  if (imagePaths.length) {
    const { data: urls, error: signedError } = await supabase.storage.from(BUCKET).createSignedUrls(imagePaths, 3600);
    if (signedError) {
      console.error('[admin-marketing-assets] asset preview read failed', signedError);
      return <AdminAssetsReadError />;
    }
    for (const u of urls ?? []) if (u.signedUrl && u.path) signed.set(u.path, u.signedUrl);
  }

  const grouped = assetsByKind(assets);
  const totalBytes = (bytesResult.data ?? []).reduce((sum, a) => sum + (a.size_bytes ?? 0), 0);

  return (
    <div className="space-y-5">
      <PartialReadBanner
        title={tr('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={bytesCeiling ? [tr('adminMarketingAssets.totalSize')] : []}
      />
      <p className="text-sm text-muted">
        {tr('adminMarketingAssets.centralLibraryForImagesVideoDocuments')}
      </p>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><UploadCloud className="h-4 w-4 text-brand-text" /> {tr('adminMarketingAssets.uploadAsset')}</h2>
        <form action={uploadAssetAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input type="file" name="file" required aria-label={tr('adminMarketingAssets.uploadAsset')} className={`${inputCls} py-1.5 file:mr-2 file:rounded file:border-0 file:bg-elevated file:px-2 file:py-1 file:text-xs lg:col-span-2`} />
          <select name="kind" defaultValue="" className={inputCls} aria-label={tr('adminMarketingAssets.assetKind')}>
            <option value="">{tr('adminMarketingAssets.autoDetectKind')}</option>
            {ASSET_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <input name="name" placeholder={tr('adminMarketingAssets.nameDefaultsToFilename')} className={inputCls} />
          <input name="alt_text" placeholder={tr('adminMarketingAssets.altTextForImages')} className={`${inputCls} lg:col-span-2`} />
          <input name="tags" placeholder={tr('adminMarketingAssets.tagsCommaSeparated')} className={inputCls} />
          <select name="license" defaultValue="original" className={inputCls} aria-label={tr('adminMarketingAssets.assetLicense')}>
            <option value="original">{tr('adminMarketingAssets.originalOwned')}</option><option value="cc0">{tr('adminMarketingAssets.cc0PublicDomain')}</option><option value="cc_by">{tr('adminMarketingAssets.creativeCommonsBy')}</option><option value="licensed">{tr('adminMarketingAssets.licensedWithProof')}</option>
          </select>
          <input name="source_url" placeholder={tr('adminMarketingAssets.sourceUrlIfApplicable')} className={inputCls} />
          <input name="attribution" placeholder={tr('adminMarketingAssets.attributionIfRequired')} className={inputCls} />
          <SubmitButton className={btnCls}>{tr('adminMarketingAssets.upload')}</SubmitButton>
        </form>
        <p className="mt-3 text-xs text-muted">
          {totalAssets.toLocaleString()} asset{totalAssets === 1 ? '' : 's'} · {bytesCeiling ? tr('strategyMetrics.unavailable') : formatBytes(totalBytes)} {tr('adminMarketingAssets.total50MbPerFile')}
        </p>
        {totalAssets > assets.length && (
          <p className="mt-1 text-xs text-muted">{tr('adminCeiling.listShowsTheNewest', { shown: assets.length.toLocaleString(), total: totalAssets.toLocaleString() })}</p>
        )}
      </Card>

      {assets.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{tr('adminMarketingAssets.noAssetsYetUploadYourFirst')}</p>
      ) : (
        ASSET_KINDS.filter((k) => grouped[k].length > 0).map((kind) => {
          const Icon = KIND_ICON[kind];
          return (
            <Card key={kind}>
              <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
                <Icon className="h-4 w-4 text-brand-text" /> {KIND_LABEL[kind]}
                <span className="text-xs font-normal text-muted">({(countByKind.get(kind) ?? grouped[kind].length).toLocaleString()})</span>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {grouped[kind].map((a) => {
                  const preview = signed.get(a.storage_path);
                  return (
                    <div key={a.id} className="flex flex-col rounded-xl border border-border bg-surface/40 p-3">
                      <div className="mb-2 flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-elevated">
                        {preview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={preview} alt={a.alt_text ?? a.name} className="h-full w-full object-contain" />
                        ) : (
                          <Icon className="h-8 w-8 text-muted" />
                        )}
                      </div>
                      <p className="truncate text-sm font-medium" title={a.name}>{a.name}</p>
                      <p className="mt-0.5 text-xs text-muted">{formatBytes(a.size_bytes)} · {fmtDate(a.created_at)}</p>
                      {a.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {a.tags.map((t) => <span key={t} className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-muted">{t}</span>)}
                        </div>
                      )}
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-muted hover:text-fg">{tr('assets.editDetails')}</summary>
                        <form action={updateAssetAction} className="mt-2 space-y-2">
                          <input type="hidden" name="id" value={a.id} />
                          <input name="name" defaultValue={a.name} placeholder={tr('assets.name')} className={inputCls} />
                          <input name="alt_text" defaultValue={a.alt_text ?? ''} placeholder={tr('assets.altText')} className={inputCls} />
                          <input name="tags" defaultValue={a.tags.join(', ')} placeholder={tr('assets.tags')} className={inputCls} />
                          <select aria-label={tr('fieldName.license')} name="license" defaultValue={a.license ?? 'original'} className={inputCls}><option value="original">{tr('assets.originalOwned')}</option><option value="cc0">{tr('assets.cc0PublicDomain')}</option><option value="cc_by">{tr('assets.creativeCommonsBy')}</option><option value="licensed">{tr('assets.licensedWithProof')}</option></select>
                          <input name="source_url" defaultValue={a.source_url ?? ''} placeholder={tr('assets.sourceUrl')} className={inputCls} />
                          <input name="attribution" defaultValue={a.attribution ?? ''} placeholder={tr('assets.attribution')} className={inputCls} />
                          <SubmitButton className={`${btnCls} w-full`}>{tr('assets.save')}</SubmitButton>
                        </form>
                      </details>
                      <form action={deleteAssetAction.bind(null, a.id, a.storage_path)} className="mt-2">
                        <SubmitButton className="text-xs text-muted hover:text-rose-400">{tr('assets.delete')}</SubmitButton>
                      </form>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}

async function AdminAssetsReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('assets.assetLibrary')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('assets.manageReusableImagesVideoDocuments')}</p>
      </div>
      <ErrorState message={tr('assets.couldNotLoadMarketingAssets')} />
      <Link href="/admin/marketing/assets" className="text-sm font-medium text-brand-text underline">{tr('assets.refreshAssets')}</Link>
    </div>
  );
}
