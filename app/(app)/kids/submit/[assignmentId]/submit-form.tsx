'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, PartyPopper, Loader2, Send } from 'lucide-react';
import { submitProofAction } from '@/app/(app)/missions/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export function SubmitProofForm({ assignmentId, proofKind }: { assignmentId: string; proofKind: string }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [previews, setPreviews] = useState<string[]>([]);
  const router = useRouter();

  const needsMedia = proofKind !== 'none';
  const accept = proofKind === 'video' ? 'video/*' : 'image/*,video/*';

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setPreviews(files.filter((f) => f.type.startsWith('image/')).map((f) => URL.createObjectURL(f)));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    fd.set('assignment_id', assignmentId);
    start(async () => {
      const res = await submitProofAction(fd);
      if (res.ok) { setDone(true); setTimeout(() => router.push('/kids'), 2200); }
      else setError(res.error ?? t('submitForm.somethingWentWrongTryAgain'));
    });
  }

  if (done) {
    return (
      <div className="rounded-3xl border border-emerald-400/30 bg-emerald-400/10 p-8 text-center">
        <PartyPopper className="mx-auto h-12 w-12 text-emerald-400" />
        <p className="mt-3 text-xl font-black">{t('kidsSubmitSubmitForm.sent')}</p>
        <p className="text-sm text-muted">{t('kidsSubmitSubmitForm.greatWorkWeAposReChecking')}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {needsMedia && (
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">{t('kidsSubmitSubmitForm.yourProof')}</span>
          <div className="flex min-h-28 cursor-pointer items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-surface/40 p-4 text-muted hover:border-brand">
            <Camera className="h-6 w-6" />
            <span>{t('kidsSubmitSubmitForm.tapToTakeAPhoto')}{proofKind === 'video' || proofKind === 'before_after' ? ' or video' : ''}</span>
            <input type="file" name="media" accept={accept} capture="environment" multiple={proofKind === 'before_after'} onChange={onFiles} className="hidden" />
          </div>
        </label>
      )}

      {previews.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {previews.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={src} alt={t('submitForm.preview')} className="h-24 w-24 rounded-xl border border-border object-cover" />
          ))}
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-sm font-semibold">{t('kidsSubmitSubmitForm.addANoteOptional')}</span>
        <textarea name="note" rows={2} placeholder={t('kidsSubmitSubmitForm.anythingYouWantToTellYour')} className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
      </label>

      {error && <p className="rounded-lg bg-danger/10 p-2 text-sm text-danger">{error}</p>}

      <button disabled={pending} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-base font-bold text-brand-fg disabled:opacity-60">
        {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />} {pending ? 'Sending…' : 'Submit my work'}
      </button>
    </form>
  );
}
