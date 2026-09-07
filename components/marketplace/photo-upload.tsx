'use client';

// Real listing photo upload (backlog #10 "listing photo uploads"). Pick or drop
// an image → it uploads to the public `marketplace-photos` bucket at
// {userId}/{ts}-{rand}.{ext} → the returned public URL becomes the listing's
// photo_url. Pasting an https URL still works for power users. Client-side
// validation (image mime + ≤10 MB) keeps bad files off the bucket; a Remove
// deletes the object we uploaded so abandoned drafts don't leak storage.
import { useRef, useState } from 'react';
import { ImagePlus, Loader2, X, Link2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  MARKETPLACE_PHOTOS_BUCKET,
  removeMarketplacePhotoPath,
  marketplacePhotoPathFromUrl,
} from '@/lib/storage/marketplace-photos';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const MAX_BYTES = 10 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export function PhotoUpload({
  value, onChange, userId, className, onOwnedPathChange,
}: {
  value: string;
  onChange: (url: string) => void;
  userId: string;
  className?: string;
  onOwnedPathChange?: (path: string | null) => void;
}) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // The storage path of an object WE uploaded (so Remove can delete it). Pasted
  // URLs have no owned path — Remove just clears the field for those.
  const [ownedPath, setOwnedPath] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);

  async function handleFile(file: File) {
    if (!OK_TYPES.includes(file.type)) { toastError(t('photoUpload.pleaseChooseAJpegPng')); return; }
    if (file.size > MAX_BYTES) { toastError(t('photoUpload.thatImageIsOver10')); return; }
    setUploading(true);
    try {
      const sb = createClient();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const unique = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const path = `${userId}/${unique}.${ext}`;
      const { data, error } = await sb.storage.from(MARKETPLACE_PHOTOS_BUCKET).upload(path, file, { upsert: false, cacheControl: '31536000' });
      if (error) { toastError(t('photoUpload.uploadFailedPleaseTryAgain')); return; }
      // Delete a previously-uploaded object we're replacing.
      const previousPath = ownedPath ?? marketplacePhotoPathFromUrl(value, process.env.NEXT_PUBLIC_SUPABASE_URL);
      if (previousPath && previousPath !== data.path) {
        const { error: removeError } = await removeMarketplacePhotoPath(sb, previousPath);
        if (removeError) toastError(t('photoUpload.thePreviousPhotoCouldNot'));
      }
      const { data: pub } = sb.storage.from(MARKETPLACE_PHOTOS_BUCKET).getPublicUrl(data.path);
      setOwnedPath(data.path);
      onOwnedPathChange?.(data.path);
      onChange(pub.publicUrl);
    } catch {
      toastError(t('photoUpload.uploadFailedPleaseTryAgain'));
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    const path = ownedPath ?? marketplacePhotoPathFromUrl(value, process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (path) {
      const { error } = await removeMarketplacePhotoPath(createClient(), path);
      if (error) { toastError(t('photoUpload.thePhotoCouldNotBe')); return; }
    }
    setOwnedPath(null);
    onOwnedPathChange?.(null);
    onChange('');
  }

  const has = value.trim().length > 0;

  return (
    <div className={cn('space-y-2', className)}>
      {has ? (
        <div className="relative overflow-hidden rounded-xl border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value.trim()} alt={t('photoUpload.listingPhoto')} className="h-44 w-full object-cover" referrerPolicy="no-referrer" />
          <button
            type="button" onClick={() => void remove()}
            className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg bg-black/60 px-2 py-1 text-xs font-semibold text-white backdrop-blur transition hover:bg-black/80"
          >
            <X className="h-3.5 w-3.5" /> {t('photoUpload.remove')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex h-44 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-surface/40 text-muted transition hover:border-brand/40 hover:text-brand-text disabled:opacity-60"
        >
          {uploading ? (
            <><Loader2 className="h-6 w-6 animate-spin" /> <span className="text-sm font-semibold">Uploading…</span></>
          ) : (
            <>
              <ImagePlus className="h-6 w-6" />
              <span className="text-sm font-semibold">{t('photoUpload.addAPhoto')}</span>
              <span className="text-xs">{t('photoUpload.jpegPngWebpUpTo10')}</span>
            </>
          )}
        </button>
      )}

      <input
        ref={inputRef} type="file" accept={OK_TYPES.join(',')} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.currentTarget.value = ''; }}
      />

      {!has && (
        showPaste ? (
          <input
            type="url" autoFocus placeholder={t('photoUpload.orPasteAnImageUrlHttps')}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none ring-brand/50 focus:ring-2"
          />
        ) : (
          <button type="button" onClick={() => setShowPaste(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-muted transition hover:text-brand-text">
            <Link2 className="h-3 w-3" /> {t('photoUpload.orPasteALink')}
          </button>
        )
      )}
    </div>
  );
}
