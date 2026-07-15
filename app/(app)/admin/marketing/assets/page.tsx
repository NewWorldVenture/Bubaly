import type { Metadata } from 'next';
import Link from 'next/link';
import { Image as ImageIcon, FileText, Film, Palette, UploadCloud } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import {
  ASSET_KINDS, assetsByKind, formatBytes, isImageMime, type AssetKind,
} from '@/lib/marketing/assets';
import { uploadAssetAction, updateAssetAction, deleteAssetAction } from './actions';

export const metadata: Metadata = { title: 'Asset Library', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Asset = Tables<'marketing_assets'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

const KIND_ICON: Record<AssetKind, typeof ImageIcon> = {
  image: ImageIcon, video: Film, document: FileText, brand: Palette,
};
const KIND_LABEL: Record<AssetKind, string> = {
  image: 'Images', video: 'Video', document: 'Documents', brand: 'Brand',
};
const BUCKET = 'marketing-assets';

export default async function AssetsPage() {
  const supabase = createServiceClient();
  const { data, error: assetsError } = await supabase
    .from('marketing_assets')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(300);
  if (assetsError) {
    console.error('[admin-marketing-assets] asset read failed', assetsError);
    return <AdminAssetsReadError />;
  }
  const assets = (data ?? []) as Asset[];

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
  const totalBytes = assets.reduce((sum, a) => sum + (a.size_bytes ?? 0), 0);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Central library for images, video, documents and brand files — reusable across Email, Social, Content and Landing Pages.
      </p>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><UploadCloud className="h-4 w-4 text-brand-text" /> Upload asset</h2>
        <form action={uploadAssetAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input type="file" name="file" required className={`${inputCls} py-1.5 file:mr-2 file:rounded file:border-0 file:bg-elevated file:px-2 file:py-1 file:text-xs lg:col-span-2`} />
          <select name="kind" defaultValue="" className={inputCls} aria-label="Asset kind">
            <option value="">Auto-detect kind</option>
            {ASSET_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <input name="name" placeholder="Name (defaults to filename)" className={inputCls} />
          <input name="alt_text" placeholder="Alt text (for images)" className={`${inputCls} lg:col-span-2`} />
          <input name="tags" placeholder="Tags, comma-separated" className={inputCls} />
          <button type="submit" className={btnCls}>Upload</button>
        </form>
        <p className="mt-3 text-xs text-muted">
          {assets.length} asset{assets.length === 1 ? '' : 's'} · {formatBytes(totalBytes)} total · 50 MB per file.
        </p>
      </Card>

      {assets.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No assets yet — upload your first above.</p>
      ) : (
        ASSET_KINDS.filter((k) => grouped[k].length > 0).map((kind) => {
          const Icon = KIND_ICON[kind];
          return (
            <Card key={kind}>
              <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
                <Icon className="h-4 w-4 text-brand-text" /> {KIND_LABEL[kind]}
                <span className="text-xs font-normal text-muted">({grouped[kind].length})</span>
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
                        <summary className="cursor-pointer text-muted hover:text-fg">Edit details</summary>
                        <form action={updateAssetAction} className="mt-2 space-y-2">
                          <input type="hidden" name="id" value={a.id} />
                          <input name="name" defaultValue={a.name} placeholder="Name" className={inputCls} />
                          <input name="alt_text" defaultValue={a.alt_text ?? ''} placeholder="Alt text" className={inputCls} />
                          <input name="tags" defaultValue={a.tags.join(', ')} placeholder="Tags" className={inputCls} />
                          <button type="submit" className={`${btnCls} w-full`}>Save</button>
                        </form>
                      </details>
                      <form action={deleteAssetAction.bind(null, a.id, a.storage_path)} className="mt-2">
                        <button type="submit" className="text-xs text-muted hover:text-rose-400">Delete</button>
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

function AdminAssetsReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Asset Library</h1>
        <p className="mt-1 text-sm text-muted">Manage reusable images, video, documents, and brand files.</p>
      </div>
      <ErrorState message="Could not load marketing assets from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/assets" className="text-sm font-medium text-brand-text underline">Refresh assets</Link>
    </div>
  );
}
