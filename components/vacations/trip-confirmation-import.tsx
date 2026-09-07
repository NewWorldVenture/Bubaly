'use client';

import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/components/app/app-context';
import { Button } from '@/components/ui/button';
import {
  canImportConfirmation, confirmationContextKey, confirmationFieldsSchema, confirmationResultSchema,
  confirmationSourceSchema, sameConfirmationValue, suggestConfirmationFields,
  type ConfirmationFields, type ConfirmationImportContext, type ConfirmationPreview,
  type ConfirmationResult, type ConfirmationSource, type ConfirmationSuggestions,
} from '@/lib/vacations/confirmation-import';
import { useTranslations } from '@/components/i18n/locale-provider';

type Draft = {
  name: string; kind: string; location: string; reservedAt: string;
  partySize: string; confirmationCode: string; booked: boolean;
};
const EMPTY: Draft = { name: '', kind: 'reservation', location: '', reservedAt: '', partySize: '', confirmationCode: '', booked: false };
type Receipt = Extract<ConfirmationResult, { applied: true }>;
const INPUT = 'w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring';
const DEFAULT_TITLE = 'Travel confirmation';

function failureMessage(status: number): string {
  if (status === 401) return 'Sign in again before importing a confirmation.';
  if (status === 403) return 'Your current membership cannot import confirmations.';
  if (status === 404) return 'This trip is unavailable in the current household.';
  if (status === 409) return 'The trip changed, needs date/timezone setup, or this source was already imported. Request a fresh preview after reviewing the trip.';
  if (status === 400) return 'Some confirmation fields need correction.';
  return 'Confirmation import is temporarily unavailable.';
}

function boundPreview(preview: ConfirmationPreview, context: ConfirmationImportContext, source: ConfirmationSource, fields: ConfirmationFields): boolean {
  return preview.familyId === context.familyId && preview.memberId === context.memberId
    && preview.vacationId === context.vacationId && preview.trip.id === context.vacationId
    && preview.source.title === source.title && preview.source.text === source.text
    && sameConfirmationValue(preview.fields, fields);
}

export function TripConfirmationImport({ vacationId }: { vacationId: string }) {
  const { familyId, userId, selfMember } = useApp();
  const context: ConfirmationImportContext = {
    familyId, userId, memberId: selfMember?.id ?? null, role: selfMember?.role ?? null,
    active: selfMember?.is_active === true, vacationId,
  };
  if (!canImportConfirmation(context)) return null;
  return <ConfirmationImportWorkspace key={confirmationContextKey(context)} context={context} />;
}

export function ConfirmationImportWorkspace({ context }: { context: ConfirmationImportContext }) {
  const t = useTranslations();
  const [sourceTitle, setSourceTitle] = useState(DEFAULT_TITLE);
  const [sourceText, setSourceText] = useState('');
  const [draft, setDraft] = useState<Draft>({ ...EMPTY });
  const [suggestions, setSuggestions] = useState<ConfirmationSuggestions>({ fields: {}, evidence: [], warnings: [] });
  const [review, setReview] = useState<ConfirmationPreview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef<string | null>(null);
  const mountedKey = useRef(confirmationContextKey(context));
  const key = confirmationContextKey(context);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      controller.current?.abort();
    };
  }, []);

  if (!canImportConfirmation(context) || mountedKey.current !== key) return null;

  function clearReview(): boolean {
    if (busyRef.current) return false;
    generation.current += 1;
    controller.current?.abort();
    requestId.current = null;
    setReview(null);
    setReceipt(null);
    setAcknowledged(false);
    setIssue(null);
    setUncertain(false);
    return true;
  }

  function updateField(field: keyof Draft, value: string | boolean) {
    if (!clearReview()) return;
    setDraft((previous) => ({ ...previous, [field]: value }));
  }

  function suggestFields() {
    if (!clearReview()) return;
    const source = confirmationSourceSchema.safeParse({ title: sourceTitle.trim(), text: sourceText });
    if (!source.success) { setIssue(source.error.issues[0]?.message ?? 'Check the confirmation source.'); return; }
    const next = suggestConfirmationFields(source.data.text);
    setSuggestions(next);
    setDraft({
      ...EMPTY, ...next.fields,
      location: next.fields.location ?? '',
      partySize: next.fields.partySize == null ? '' : String(next.fields.partySize),
      confirmationCode: next.fields.confirmationCode ?? '',
      booked: false,
    });
  }

  async function runRequest(action: 'preview' | 'apply') {
    if (busyRef.current) return;
    if (action === 'apply' && (!review || !acknowledged || !requestId.current)) return;

    const sourceInput = action === 'apply' && review
      ? { title: review.source.title, text: review.source.text }
      : { title: sourceTitle.trim(), text: sourceText };
    const fieldsInput = action === 'apply' && review ? review.fields : {
      name: draft.name.trim(), kind: draft.kind.trim(), location: draft.location.trim() || null,
      reservedAt: draft.reservedAt.trim(),
      partySize: draft.partySize.trim() === '' ? null : /^\d+$/.test(draft.partySize.trim()) ? Number(draft.partySize) : Number.NaN,
      confirmationCode: draft.confirmationCode.trim() || null, booked: draft.booked,
    };
    const parsedSource = confirmationSourceSchema.safeParse(sourceInput);
    const parsedFields = confirmationFieldsSchema.safeParse(fieldsInput);
    if (!parsedSource.success || !parsedFields.success) {
      setIssue(!parsedSource.success ? parsedSource.error.issues[0]?.message ?? 'Check the source.' : !parsedFields.success ? parsedFields.error.issues[0]?.message ?? 'Check every field.' : 'Check every field.');
      return;
    }

    const approved = review;
    const savedRequestId = requestId.current;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    const token = ++generation.current;
    const current = () => alive.current && generation.current === token && mountedKey.current === key && !abort.signal.aborted;
    busyRef.current = true;
    setBusy(true);
    setIssue(null);

    try {
      const response = await fetch('/api/vacations/confirmation-import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', cache: 'no-store',
        signal: abort.signal,
        body: JSON.stringify({
          action, familyId: context.familyId, memberId: context.memberId, vacationId: context.vacationId,
          source: parsedSource.data, fields: parsedFields.data,
          ...(action === 'apply' ? { expected: approved, requestId: savedRequestId } : {}),
        }),
      });
      if (!current()) return;
      if (!response.ok) {
        if (action === 'apply' && [400, 401, 403, 404, 409].includes(response.status)) {
          setReview(null); requestId.current = null; setAcknowledged(false); setUncertain(false);
        } else if (action === 'apply') setUncertain(true);
        setIssue(failureMessage(response.status) + (action === 'apply' && response.status >= 500 ? ' A save cannot be confirmed; retry this same review to retrieve its receipt.' : ''));
        return;
      }
      const body: unknown = await response.json();
      if (!current()) return;
      const parsed = confirmationResultSchema.safeParse(body);
      if (!parsed.success || !boundPreview(parsed.data.preview, context, parsedSource.data, parsedFields.data)) {
        throw new Error('Invalid confirmation result.');
      }
      const result = parsed.data;
      if (action === 'preview') {
        if (result.applied) throw new Error('A preview cannot be a write.');
        const nextRequestId = crypto.randomUUID();
        requestId.current = nextRequestId;
        setReview(result.preview);
        setReceipt(null);
        setAcknowledged(false);
        setUncertain(false);
      } else {
        if (!result.applied || result.requestId !== savedRequestId || !sameConfirmationValue(result.preview, approved)) {
          throw new Error('The receipt does not match this review.');
        }
        setReceipt(result);
        setReview(null);
        requestId.current = null;
        setAcknowledged(false);
        setUncertain(false);
      }
    } catch {
      if (!current()) return;
      if (action === 'apply') {
        setUncertain(true);
        setIssue('The save result could not be confirmed. Retry this same review to retrieve its receipt; do not start a duplicate import.');
      } else {
        setReview(null); requestId.current = null; setAcknowledged(false);
        setIssue('A trustworthy preview could not be loaded. Nothing is reported as saved.');
      }
    } finally {
      if (current()) {
        controller.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function startAnother() {
    if (!clearReview()) return;
    setSourceTitle(DEFAULT_TITLE);
    setSourceText('');
    setDraft({ ...EMPTY });
    setSuggestions({ fields: {}, evidence: [], warnings: [] });
  }

  const id = 'confirmation-' + context.vacationId + '-';
  if (receipt) return (
    <section className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4" aria-label={t('tripImport.confirmationImportReceipt')}>
      <h3 className="font-semibold">{t('tripImport.reservationAndItineraryEntrySaved')}</h3>
      <p className="text-sm text-muted">{t('tripImport.theseAreHouseholdRecordsOfThe')}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-muted">{t('tripImport.reservation')}</dt><dd>{receipt.preview.fields.name}</dd></div>
        <div><dt className="text-muted">{t('tripImport.tripLocalTime')}</dt><dd>{receipt.preview.itinerary.date} {receipt.preview.itinerary.startTime} ({receipt.preview.trip.timezone})</dd></div>
        <div><dt className="text-muted">{t('tripImport.requestReceipt')}</dt><dd className="break-all font-mono text-xs">{receipt.requestId}</dd></div>
        <div><dt className="text-muted">{t('tripImport.savedAt')}</dt><dd className="break-all">{receipt.appliedAt}</dd></div>
        <div><dt className="text-muted">{t('tripImport.reservationRecord')}</dt><dd className="break-all font-mono text-xs">{receipt.reservationId}</dd></div>
        <div><dt className="text-muted">{t('tripImport.itineraryRecord')}</dt><dd className="break-all font-mono text-xs">{receipt.itineraryItemId}</dd></div>
      </dl>
      <details className="rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-sm">{t('tripImport.retainedOriginalSource')} {receipt.preview.source.title}</summary>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{receipt.preview.source.text}</pre>
        <p className="mt-2 break-all font-mono text-xs text-muted">SHA-256: {receipt.preview.source.sha256}</p>
      </details>
      <Button type="button" size="sm" variant="secondary" onClick={startAnother}>{t('tripImport.startAnotherImport')}</Button>
    </section>
  );

  return (
    <details className="rounded-2xl border border-border bg-surface/40 p-4">
      <summary className="cursor-pointer font-semibold">{t('tripImport.importATravelConfirmation')}</summary>
      <p className="mt-3 text-sm text-muted">{t('tripImport.pasteAConfirmationCorrectThe')}</p>
      <form className="mt-4 space-y-4" onSubmit={async (event) => { event.preventDefault(); await runRequest('preview'); }}>
        <fieldset disabled={busy} className="space-y-4">
          <div>
            <label htmlFor={id + 'sourceTitle'} className="mb-1 block text-sm font-medium">{t('tripImport.sourceTitle')}</label>
            <input id={id + 'sourceTitle'} name="sourceTitle" value={sourceTitle} maxLength={160} className={INPUT}
              onChange={(event) => { if (clearReview()) setSourceTitle(event.target.value); }} />
          </div>
          <div>
            <label htmlFor={id + 'sourceText'} className="mb-1 block text-sm font-medium">{t('tripImport.originalConfirmationText')}</label>
            <textarea id={id + 'sourceText'} name="sourceText" value={sourceText} rows={6} maxLength={65536} className={INPUT}
              onChange={(event) => {
                if (!clearReview()) return;
                setSourceText(event.target.value); setDraft({ ...EMPTY });
                setSuggestions({ fields: {}, evidence: [], warnings: [] });
              }} />
            <p className="mt-1 text-xs text-muted">{t('tripImport.plainTextOnlyUpTo32')}</p>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={suggestFields}>{t('tripImport.suggestFieldsFromThisText')}</Button>
          {suggestions.warnings.map((warning) => <p key={warning} className="text-sm text-muted">{warning}</p>)}
          {suggestions.evidence.length > 0 && (
            <details className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-sm">{t('tripImport.suggestedFieldEvidence')}</summary>
              {suggestions.evidence.map((entry) => <p key={entry.field} className="mt-2 whitespace-pre-wrap break-words text-xs"><strong>{entry.field}, line {entry.line}:</strong> {entry.text}</p>)}
            </details>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label htmlFor={id + 'name'} className="mb-1 block text-sm font-medium">{t('tripImport.reservationName')}</label><input id={id + 'name'} name="name" value={draft.name} maxLength={200} required className={INPUT} onChange={(event) => updateField('name', event.target.value)} /></div>
            <div><label htmlFor={id + 'kind'} className="mb-1 block text-sm font-medium">{t('tripImport.reservationType')}</label><input id={id + 'kind'} name="kind" value={draft.kind} maxLength={40} required className={INPUT} onChange={(event) => updateField('kind', event.target.value)} /></div>
            <div><label htmlFor={id + 'location'} className="mb-1 block text-sm font-medium">{t('tripImport.locationIfKnown')}</label><input id={id + 'location'} name="location" value={draft.location} maxLength={500} className={INPUT} onChange={(event) => updateField('location', event.target.value)} /></div>
            <div><label htmlFor={id + 'reservedAt'} className="mb-1 block text-sm font-medium">{t('tripImport.dateAndTimeWithUtcOffset')}</label><input id={id + 'reservedAt'} name="reservedAt" value={draft.reservedAt} required placeholder="2026-09-20T18:30:00-04:00" className={INPUT} onChange={(event) => updateField('reservedAt', event.target.value)} /><p className="mt-1 text-xs text-muted">{t('tripImport.includeSecondsAndTheOffsetStated')}</p></div>
            <div><label htmlFor={id + 'partySize'} className="mb-1 block text-sm font-medium">{t('tripImport.partySizeIfKnown')}</label><input id={id + 'partySize'} name="partySize" type="number" min={1} max={1000} step={1} value={draft.partySize} className={INPUT} onChange={(event) => updateField('partySize', event.target.value)} /></div>
            <div><label htmlFor={id + 'confirmationCode'} className="mb-1 block text-sm font-medium">{t('tripImport.confirmationCodeIfKnown')}</label><input id={id + 'confirmationCode'} name="confirmationCode" value={draft.confirmationCode} maxLength={120} className={INPUT} onChange={(event) => updateField('confirmationCode', event.target.value)} /></div>
          </div>
          <label className="flex items-start gap-2 text-sm"><input name="booked" type="checkbox" checked={draft.booked} onChange={(event) => updateField('booked', event.target.checked)} />{t('tripImport.iConfirmThisReservationIsAlready')}</label>
          <Button type="submit" size="sm" variant="secondary" loading={busy}>{t('tripImport.previewImport')}</Button>
        </fieldset>
      </form>
      {issue && <p role="alert" className="mt-3 text-sm">{issue}</p>}
      {review && (
        <section aria-label={t('tripImport.reviewConfirmationImport')} className="mt-4 space-y-3 rounded-xl border border-brand/30 bg-elevated/40 p-4">
          <h3 className="font-semibold">{t('tripImport.reviewBeforeSaving')}</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">{t('tripImport.trip')}</dt><dd>{review.trip.title}</dd></div>
            <div><dt className="text-muted">{t('tripImport.reservation')}</dt><dd>{review.fields.name} ({review.fields.kind})</dd></div>
            <div><dt className="text-muted">{t('tripImport.confirmedInputTime')}</dt><dd className="break-all">{review.fields.reservedAt}</dd></div>
            <div><dt className="text-muted">{t('tripImport.itineraryTime')}</dt><dd>{review.itinerary.date} {review.itinerary.startTime} ({review.trip.timezone})</dd></div>
            <div><dt className="text-muted">{t('tripImport.location')}</dt><dd>{review.fields.location ?? 'Not supplied'}</dd></div>
            <div><dt className="text-muted">{t('tripImport.partySize')}</dt><dd>{review.fields.partySize ?? 'Not supplied'}</dd></div>
            <div><dt className="text-muted">{t('tripImport.confirmationCode')}</dt><dd className="break-all">{review.fields.confirmationCode ?? 'Not supplied'}</dd></div>
            <div><dt className="text-muted">{t('tripImport.bookingStatus')}</dt><dd>{review.fields.booked ? 'Confirmed by you, not verified with provider' : 'Not confirmed'}</dd></div>
          </dl>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm">{t('tripImport.originalSourceRetainedUnchanged')}</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{review.source.text}</pre>
            <p className="mt-2 break-all font-mono text-xs text-muted">SHA-256: {review.source.sha256}</p>
          </details>
          <p className="text-xs text-muted">{t('tripImport.savesOneReservationAndOne')}</p>
          <label className="flex items-start gap-2 text-sm"><input name="acknowledged" type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => { if (!busyRef.current) setAcknowledged(event.target.checked); }} />{t('tripImport.iCheckedTheSourceTimeZone')}</label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" loading={busy} disabled={!acknowledged || busy} onClick={() => runRequest('apply')}>{uncertain ? 'Retry saving this review' : 'Save reservation and itinerary entry'}</Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={clearReview}>{t('tripImport.discardReview')}</Button>
          </div>
        </section>
      )}
    </details>
  );
}

