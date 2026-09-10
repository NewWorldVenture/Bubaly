'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Upload } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { CameraCapture } from '@/components/ui/camera-capture';
import { useApp } from '@/components/app/app-context';
import { CAPTURE_DOCUMENT_BYTES, uploadCapturedDocument, type DocumentCaptureResult } from '@/lib/capture/document-upload';

export function DocumentCapture({ photo = false, onSaved }: { photo?: boolean; onSaved?: () => void }) {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const [selection, setSelection] = useState<{ file: File; captureId: string; familyId: string; userId: string } | null>(null);
  const [sender, setSender] = useState('');
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DocumentCaptureResult | null>(null);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const ownSelection = selection?.familyId === familyId && selection.userId === userId ? selection : null;
  const ownResult = ownSelection ? result : null;
  useEffect(() => {
    generation.current++;
    setSelection(null); setResult(null); setSender(''); setBusy(false); setCamera(false);
    return () => { generation.current++; };
  }, [familyId, userId]);

  function choose(file: File | undefined) {
    if (!file) return;
    generation.current++;
    setBusy(false);
    setSelection({ file, captureId: crypto.randomUUID(), familyId, userId });
    setResult(file.size > CAPTURE_DOCUMENT_BYTES ? { ok: false, reason: 'too_large', retryable: false } : null);
  }
  async function save() {
    if (!ownSelection || busy) return;
    const current = ++generation.current;
    setBusy(true); setResult(null);
    const response = await uploadCapturedDocument({ ...ownSelection, sender, isCurrent: () => generation.current === current });
    if (generation.current !== current) return;
    setResult(response); setBusy(false);
    if (response.ok) onSaved?.();
  }
  const failed = ownResult && !ownResult.ok ? ownResult : null;
  return <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
    <h2 className="text-sm font-semibold">{t('documentCapture.title')}</h2>
    <p className="text-xs text-muted">{t('documentCapture.description')}</p>
    <input ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png,image/gif,image/webp,text/plain"
      capture={photo ? 'environment' : undefined} className="sr-only" aria-label={t('documentCapture.choose')}
      onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ''; }} />
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-semibold disabled:opacity-50">
        <Upload className="h-4 w-4" />{t('documentCapture.choose')}
      </button>
      <button type="button" disabled={busy} onClick={() => setCamera(true)} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-semibold disabled:opacity-50">
        <Camera className="h-4 w-4" />{t('cameraCapture.takeAPhoto')}
      </button>
    </div>
    {camera && <CameraCapture onClose={() => setCamera(false)} onCapture={(file) => { choose(file); setCamera(false); }} />}
    {ownSelection && <>
      <p className="break-all text-sm">{ownSelection.file.name}</p>
      {!ownResult?.ok && <>
        <label className="block text-xs text-muted">{t('paperwork.fromSchoolCoachClinicOptional')}
          <input value={sender} maxLength={200} disabled={busy || failed?.saved === true} onChange={(event) => setSender(event.target.value)} className="mt-1 block w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm" />
        </label>
        <button type="button" disabled={busy || !!(failed && !failed.retryable)} onClick={() => void save()}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? t('documentCapture.reading') : failed ? t('timeSaved.tryAgain') : t('documentCapture.save')}
        </button>
      </>}
    </>}
    {failed && <p role="alert" className="text-sm text-danger">{t(failed.saved ? 'documentCapture.savedRetry' : `documentCapture.${failed.reason}`)}</p>}
    {failed?.reason === 'step_up' && failed.stepUp && <a href={failed.stepUp} className="inline-block text-sm font-semibold underline">{t('stepUp.title')}</a>}
    {ownResult?.ok && <div role="status" className="space-y-2 text-sm">
      <p>{t('documentCapture.saved')}</p>
      {ownResult.data.partial && <p className="text-amber-700 dark:text-amber-300">{t('paperwork.partialExtractionWarning')}</p>}
      <a href={`/dashboard/paperwork#paperwork-${ownResult.data.id}`} className="inline-block font-semibold underline">{t('documentCapture.review')}</a>
    </div>}
  </section>;
}
