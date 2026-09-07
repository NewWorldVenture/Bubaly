'use client';

// Idea-attachment upload for the feedback form. Pick or drop an image → uploads
// to the public `feedback-attachments` bucket at {userId}/{ts}-{rand}.{ext} → the
// returned public URL becomes the idea's image_url. Client-side validation keeps
// bad files off the bucket; Remove deletes the object we uploaded.
import { useRef, useState } from 'react';
import { ImagePlus, Loader2, X, UploadCloud } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  FEEDBACK_ATTACHMENTS_BUCKET, FEEDBACK_ATTACHMENT_MAX_BYTES,
  feedbackAttachmentPathFromUrl, removeFeedbackAttachmentPath,
} from '@/lib/storage/feedback-attachments';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export function FeedbackAttachmentUpload({
  value, onChange, userId,
}: {
  value: string;
  onChange: (url: string) => void;
  userId: string;
}) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [ownedPath, setOwnedPath] = useState<string | null>(null);

  async function handleFile(file: File) {
    if (!OK_TYPES.includes(file.type)) { toastError(t('feedbackAttachmentUpload.pleaseChooseAJpegPng')); return; }
    if (file.size > FEEDBACK_ATTACHMENT_MAX_BYTES) { toastError(t('feedbackAttachmentUpload.thatImageIsOver10')); return; }
    setUploading(true);
    try {
      const sb = createClient();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { data, error } = await sb.storage.from(FEEDBACK_ATTACHMENTS_BUCKET).upload(path, file, { upsert: false, cacheControl: '31536000' });
      if (error) { toastError(`Upload failed: ${error.message}`); return; }
      const previousPath = ownedPath ?? feedbackAttachmentPathFromUrl(value, process.env.NEXT_PUBLIC_SUPABASE_URL);
      if (previousPath && previousPath !== data.path) await removeFeedbackAttachmentPath(sb, previousPath);
      const { data: pub } = sb.storage.from(FEEDBACK_ATTACHMENTS_BUCKET).getPublicUrl(data.path);
      setOwnedPath(data.path);
      onChange(pub.publicUrl);
    } catch {
      toastError(t('feedbackAttachmentUpload.uploadFailedPleaseTryAgain'));
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    const path = ownedPath ?? feedbackAttachmentPathFromUrl(value, process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (path) await removeFeedbackAttachmentPath(createClient(), path);
    setOwnedPath(null);
    onChange('');
  }

  const has = value.trim().length > 0;

  if (has) {
    return (
      <div className="relative overflow-hidden rounded-xl border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={value.trim()} alt={t('feedbackFeedbackAttachmentUpload.ideaAttachment')} className="max-h-48 w-full object-cover" />
        <button
          type="button" onClick={() => void remove()}
          className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg bg-black/60 px-2 py-1 text-xs font-semibold text-white backdrop-blur transition hover:bg-black/80"
        >
          <X className="h-3.5 w-3.5" /> {t('feedbackFeedbackAttachmentUpload.remove')}
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
        disabled={uploading}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-muted transition disabled:opacity-60',
          dragging ? 'border-brand bg-brand/5 text-brand-text' : 'border-border bg-surface/40 hover:border-brand/40 hover:text-brand-text',
        )}
      >
        {uploading ? (
          <><Loader2 className="h-5 w-5 animate-spin" /> <span className="text-sm font-semibold">Uploading…</span></>
        ) : (
          <>
            {dragging ? <UploadCloud className="h-5 w-5" /> : <ImagePlus className="h-5 w-5" />}
            <span className="text-sm font-semibold">{t('feedbackFeedbackAttachmentUpload.dragAmpDropOr')} <span className="text-brand-text">browse</span></span>
            <span className="text-[11px]">{t('feedbackFeedbackAttachmentUpload.addAnImageOrFileUp')}</span>
          </>
        )}
      </button>
      <input
        ref={inputRef} type="file" accept={OK_TYPES.join(',')} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.currentTarget.value = ''; }}
      />
    </>
  );
}
