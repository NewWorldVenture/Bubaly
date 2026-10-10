'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, PartyPopper, Loader2, Send } from 'lucide-react';
import { submitProofAction } from '@/app/(app)/missions/actions';
import { useTranslations } from '@/components/i18n/locale-provider';
import { createClient } from '@/lib/supabase/client';
import {
  MAX_PROOF_BYTES, MAX_PROOF_FILES, PROOF_BUCKET, newProofObjectId, proofFileProblem, proofObjectPath,
} from '@/lib/chores/proof-media';

export function SubmitProofForm({ assignmentId, proofKind, familyId, memberId }: {
  assignmentId: string; proofKind: string; familyId: string; memberId: string;
}) {
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
    const form = new FormData(e.currentTarget);
    const files = form.getAll('media').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > MAX_PROOF_FILES) { setError(t('kidsSubmitSubmitForm.tooManyFiles', { count: MAX_PROOF_FILES })); return; }
    for (const file of files) {
      const problem = proofFileProblem(file);
      if (problem === 'type') { setError(t('kidsSubmitSubmitForm.thatFileCannotBeProof')); return; }
      if (problem === 'size') { setError(t('kidsSubmitSubmitForm.thatFileIsTooBig', { limit: MAX_PROOF_BYTES / (1024 * 1024) })); return; }
    }
    // The files go straight to Storage, into this child's own proof folder
    // (0376), and the action gets only their paths. A server action's body is
    // capped at 1 MB, so sending the files through it refused an ordinary phone
    // photo — and every video — before the action could run.
    const fd = new FormData();
    fd.set('assignment_id', assignmentId);
    const note = form.get('note');
    if (typeof note === 'string') fd.set('note', note);
    start(async () => {
      const storage = createClient().storage.from(PROOF_BUCKET);
      const uploaded: string[] = [];
      for (const file of files) {
        const path = proofObjectPath(familyId, memberId, newProofObjectId(), file.name);
        const { error: uploadError } = await storage.upload(path, file, { contentType: file.type, upsert: false })
          .catch((thrown: unknown) => ({ error: thrown }));
        if (uploadError) {
          // Nothing was submitted, so nothing will refer to what did upload.
          if (uploaded.length) await storage.remove(uploaded).catch(() => undefined);
          setError(t('actions.couldNotUploadProofMedia'));
          return;
        }
        uploaded.push(path);
        fd.append('media_path', path);
      }
      // Past this point the server owns the uploads: a refusal removes them
      // there, and a lost response may still have recorded the submission.
      const res = await submitProofAction(fd).catch(() => ({ ok: false, error: undefined }));
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
            <span>{t(proofKind === 'video' || proofKind === 'before_after' ? 'kidsSubmitSubmitForm.tapToTakeAPhotoOrVideo' : 'kidsSubmitSubmitForm.tapToTakeAPhoto')}</span>
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
