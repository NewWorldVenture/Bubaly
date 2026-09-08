'use client';

// "Report a disruption" — the one place a family says "our flight is two hours
// late" and gets an itinerary that matches.
//
// The honesty rule this file exists to keep: Bubaly moves the family's OWN
// itinerary rows and nothing else. It has not called an airline, a hotel or a
// restaurant, so every third-party booking comes back under "still needs a
// person", and the panel says so in as many words. There is no "rebooked"
// state to render, because there is no row that could justify one.

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Plane } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingBlock } from '@/components/ui/states-client';
import {
  listDisruptableBookingsAction, reportDisruptionAction,
  type DisruptableBookings, type DisruptionActionResult,
} from '../actions';

const INPUT = 'w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring';

type Kind = 'flight' | 'lodging';
type Outcome = 'delayed' | 'cancelled';
type Success = Extract<DisruptionActionResult, { ok: true }>;

export function DisruptionForm({ vacationId }: { vacationId: string }) {
  const t = useTranslations();
  const [bookings, setBookings] = useState<DisruptableBookings | null>(null);
  const [loading, setLoading] = useState(true);
  const [choice, setChoice] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('delayed');
  const [delay, setDelay] = useState('60');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [result, setResult] = useState<Success | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listDisruptableBookingsAction(vacationId)
      .then(setBookings)
      .catch(() => setBookings({ ok: false, error: t('vacationDisruption.couldNotLoadBookings') }))
      .finally(() => setLoading(false));
  }, [vacationId, t]);

  useEffect(() => { load(); }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const [kind, bookingId] = choice.split(':') as [Kind, string];
    setBusy(true);
    setIssue(null);
    setResult(null);
    try {
      const res = await reportDisruptionAction({
        vacationId,
        kind: kind === 'lodging' ? 'lodging' : 'flight',
        bookingId: bookingId ?? '',
        outcome,
        delayMinutes: outcome === 'delayed' ? Number(delay) : 0,
      });
      if (res.ok) setResult(res);
      else setIssue(res.error);
    } catch {
      setIssue(t('vacationDisruption.couldNotReport'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingBlock />;
  if (!bookings || !bookings.ok) {
    return <ErrorState message={bookings?.error ?? t('vacationDisruption.couldNotLoadBookings')} onRetry={load} />;
  }

  const hasBookings = bookings.flights.length > 0 || bookings.lodging.length > 0;

  return (
    <section className="rounded-2xl border border-border bg-surface/40 p-5">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />
        <h2 className="font-semibold">{t('vacationDisruption.title')}</h2>
      </div>
      <p className="mt-1 text-sm text-muted">{t('vacationDisruption.intro')}</p>

      {!hasBookings ? (
        <p className="mt-4 text-sm text-muted">{t('vacationDisruption.noBookings')}</p>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">{t('vacationDisruption.whichBooking')}</span>
            <select className={INPUT} value={choice} onChange={(e) => setChoice(e.target.value)} required>
              <option value="">{t('vacationDisruption.selectABooking')}</option>
              {bookings.flights.length > 0 && (
                <optgroup label={t('vacationDisruption.flightsGroup')}>
                  {bookings.flights.map((f) => (
                    <option key={f.id} value={`flight:${f.id}`}>{f.detail ? `${f.label} · ${f.detail}` : f.label}</option>
                  ))}
                </optgroup>
              )}
              {bookings.lodging.length > 0 && (
                <optgroup label={t('vacationDisruption.lodgingGroup')}>
                  {bookings.lodging.map((l) => (
                    <option key={l.id} value={`lodging:${l.id}`}>{l.detail ? `${l.label} · ${l.detail}` : l.label}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-muted">{t('vacationDisruption.whatHappened')}</span>
              <select className={INPUT} value={outcome} onChange={(e) => setOutcome(e.target.value === 'cancelled' ? 'cancelled' : 'delayed')}>
                <option value="delayed">{t('vacationDisruption.delayed')}</option>
                <option value="cancelled">{t('vacationDisruption.cancelled')}</option>
              </select>
            </label>
            {outcome === 'delayed' && (
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-muted">{t('vacationDisruption.delayMinutes')}</span>
                <input className={INPUT} type="number" min={1} step={5} value={delay} onChange={(e) => setDelay(e.target.value)} />
              </label>
            )}
          </div>

          <Button type="submit" disabled={busy || !choice}>
            {busy ? t('vacationDisruption.working') : t('vacationDisruption.submit')}
          </Button>
        </form>
      )}

      {issue && <p className="mt-3 text-sm text-danger">{issue}</p>}
      {result && <DisruptionReceipt result={result} />}
    </section>
  );
}

function DisruptionReceipt({ result }: { result: Success }) {
  const t = useTranslations();
  const reasonLabel = (reason: string) => {
    if (reason === 'cancelled') return t('vacationDisruption.reasonCancelled');
    if (reason === 'missed_window') return t('vacationDisruption.reasonMissedWindow');
    return t('vacationDisruption.reasonUnreachable');
  };

  if (result.noChange) {
    return <p className="mt-4 rounded-xl border border-border bg-elevated/40 px-4 py-3 text-sm text-muted">{t('vacationDisruption.noChange')}</p>;
  }

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-border bg-elevated/40 px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold">{t('vacationDisruption.movedHeading')}</h3>
        {result.shifted.length === 0 ? (
          <p className="mt-1 text-sm text-muted">{t('vacationDisruption.nothingMoved')}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {result.shifted.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <Plane className="h-3 w-3 text-muted" aria-hidden />
                <span className="font-medium">{s.title}</span>
                <span className="text-muted">{s.fromStart ?? ''}</span>
                <ArrowRight className="h-3 w-3 text-muted" aria-hidden />
                <span className="text-muted">{s.toDay} {s.toStart ?? ''}</span>
                {s.rolledOvernight && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                    {t('vacationDisruption.rolledOvernight')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold">{t('vacationDisruption.rebookHeading')}</h3>
        {result.toRebook.length === 0 ? (
          <p className="mt-1 text-sm text-muted">{t('vacationDisruption.nothingToRebook')}</p>
        ) : (
          <>
            <ul className="mt-1 space-y-1 text-sm">
              {result.toRebook.map((r) => (
                <li key={`${r.kind}-${r.id}`} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.title}</span>
                  <span className="text-muted">{reasonLabel(r.reason)}</span>
                  {r.when && <span className="text-muted">{r.when}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-300">{t('vacationDisruption.notRebookedNotice')}</p>
          </>
        )}
      </div>

      <p className="text-xs text-muted">
        {result.recorded ? t('vacationDisruption.recorded') : t('vacationDisruption.notRecorded')}
        {' '}
        {result.notified ? t('vacationDisruption.familyNotified') : t('vacationDisruption.familyNotNotified')}
      </p>
    </div>
  );
}
