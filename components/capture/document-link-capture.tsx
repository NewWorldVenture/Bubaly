'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/components/app/app-context';
import { useTranslations } from '@/components/i18n/locale-provider';
import { canonicalDocumentUrl, importDocumentLink, type DocumentLinkResult } from '@/lib/capture/document-link';

type Props = { initialUrl?: string; messageId?: string; candidates?: string[]; expectedFamilyId: string; expectedUserId: string };
type Selection = { owner: string; url: string; captureId: string; result: DocumentLinkResult | null; busy: boolean };
export function DocumentLinkCapture({ initialUrl = '', messageId, candidates = [], expectedFamilyId, expectedUserId }: Props) {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const owner = JSON.stringify([familyId, userId]);
  const expectedOwner = JSON.stringify([expectedFamilyId, expectedUserId]);
  const [selection, setSelection] = useState<Selection>(() => ({ owner: expectedOwner, url: initialUrl, captureId: '', result: null, busy: false }));
  const current = useRef({ owner, captureId: selection.captureId });
  current.current = { owner, captureId: selection.captureId };
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const previousOwner = useRef(owner);
  const own = selection.owner === owner && owner === expectedOwner;
  useEffect(() => {
    mounted.current = true;
    if (previousOwner.current !== owner) {
      previousOwner.current = owner;
      setSelection({ owner, url: '', captureId: '', result: null, busy: false });
    }
    return () => { mounted.current = false; controller.current?.abort(); inFlight.current = false; };
  }, [owner]);
  const result = own ? selection.result : null;
  const locked = selection.busy || result?.ok || (result && !result.ok && result.saved);
  function choose(url: string) {
    if (!mounted.current || !own || current.current.owner !== owner || current.current.captureId !== selection.captureId) return;
    controller.current?.abort();
    inFlight.current = false;
    const captureId = crypto.randomUUID();
    current.current.captureId = captureId;
    setSelection({ owner, url, captureId, result: null, busy: false });
  }
  async function save() {
    if (!mounted.current || !own || inFlight.current || selection.busy || current.current.owner !== owner || current.current.captureId !== selection.captureId) return;
    inFlight.current = true;
    const captureId = selection.captureId || crypto.randomUUID();
    current.current.captureId = captureId;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setSelection((previous) => mounted.current && !abort.signal.aborted && previous.owner === owner && previous.captureId === selection.captureId
      && current.current.owner === owner && current.current.captureId === captureId ? { ...previous, captureId, busy: true } : previous);
    const response = await importDocumentLink({ url: selection.url, captureId, messageId, familyId, userId }, abort.signal);
    if (!mounted.current || abort.signal.aborted || current.current.owner !== owner || current.current.captureId !== captureId) return;
    inFlight.current = false;
    setSelection((previous) => mounted.current && !abort.signal.aborted && previous.owner === owner && previous.captureId === captureId && current.current.owner === owner && current.current.captureId === captureId
      ? { ...previous, result: response, busy: false } : previous);
  }
  if (!own) return <p role="alert">{t('documentLink.context_changed')}</p>;
  return <section className="space-y-4 rounded-2xl border border-border bg-surface/40 p-5">
    <h1 className="text-lg font-bold">{t('documentLink.title')}</h1>
    <p className="text-sm text-muted">{t('documentLink.description')}</p>
    <p className="text-xs text-muted">{t('documentLink.policy')}</p>
    {messageId ? <label className="block text-sm">{t('documentLink.choose')}
      <select className="mt-2 w-full rounded-xl border border-border bg-surface p-3" value={selection.url} disabled={!!locked} onChange={(event) => choose(event.target.value)}>
        <option value="">{t('documentLink.choose')}</option>
        {candidates.map((url) => <option key={url} value={url}>{url}</option>)}
      </select>
      {candidates.length === 0 && <span className="mt-2 block text-muted">{t('documentLink.no_links')}</span>}
    </label> : <label className="block text-sm">{t('documentLink.url')}
      <input className="mt-2 w-full rounded-xl border border-border bg-surface p-3" type="url" maxLength={2_000} value={selection.url} disabled={!!locked} onChange={(event) => choose(event.target.value)} />
    </label>}
    {result?.ok ? <div role="status" className="space-y-2">
      <p>{t('documentLink.saved')}</p>
      {result.data.partial && <p className="text-amber-600">{t('documentLink.partial')}</p>}
      <a className="text-brand-text underline" href={`/dashboard/paperwork#paperwork-${result.data.id}`}>{t('documentLink.review')}</a>
    </div> : <>
      {result && <div role="alert">
        <p>{t(result.saved && result.retryable ? 'documentLink.saved_retry' : `documentLink.${result.reason}`)}</p>
        {result.reason === 'step_up' && result.stepUp && <a className="text-brand-text underline" href={result.stepUp}>{t('documentLink.verify')}</a>}
      </div>}
      <button type="button" onClick={() => void save()} disabled={selection.busy || !canonicalDocumentUrl(selection.url) || (!!result && !result.ok && !result.retryable)}
        className="rounded-xl bg-brand px-4 py-2 font-semibold text-white disabled:opacity-50">
        {t(selection.busy ? 'documentLink.importing' : result?.retryable ? 'documentLink.retry' : 'documentLink.import')}
      </button>
    </>}
    {(result || selection.busy) && <button type="button" className="ml-3 text-sm underline" onClick={() => choose('')}>{t('documentLink.reset')}</button>}
  </section>;
}
