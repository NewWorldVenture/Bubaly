'use client';

// Pickup & hand-off coordinator, rendered per order on the Orders page. Walks
// the exchange through propose → confirm (→ family calendar + code) → complete
// (enter the code in person). Both the buyer and seller members drive it from
// their side; the safety copy nudges toward public meetup spots.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, CalendarCheck, ShieldCheck, Loader2, Check, KeyRound, Clock } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  SAFE_SPOTS, suggestedMeetTimes, meetSummary, statusLabel, isSafePublicSpot,
  canConfirm, canCancel, canComplete, type HandoffStatus, type HandoffRole, type LocationKind,
} from '@/lib/marketplace/handoff';
import {
  proposeHandoffAction, confirmHandoffAction, cancelHandoffAction, completeHandoffAction,
} from '@/app/(app)/marketplace/handoff/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type HandoffData = {
  status: HandoffStatus; proposerRole: HandoffRole; meetAt: string | null;
  locationLabel: string | null; locationKind: LocationKind; confirmCode: string | null;
  notes: string | null; hasCalendar: boolean;
} | null;

export function HandoffPanel({ orderId, viewerRole, handoff }: {
  orderId: string; viewerRole: HandoffRole; handoff: HandoffData;
}) {
  const tr = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);

  const active = handoff && handoff.status !== 'cancelled';
  const other = viewerRole === 'buyer' ? 'the seller' : 'the buyer';

  function propose(form: { meetAtIso: string | null; locationLabel: string; locationKind: LocationKind; notes: string }) {
    start(async () => {
      const res = await proposeHandoffAction({ orderId, ...form });
      if (!res.ok) { toastError(res.error); return; }
      setEditing(false); success('Pickup proposed — waiting for confirmation.'); router.refresh();
    });
  }
  function confirm() {
    start(async () => {
      const res = await confirmHandoffAction(orderId);
      if (!res.ok) { toastError(res.error); return; }
      success('Confirmed! Added to your calendar.'); router.refresh();
    });
  }
  function cancel() {
    start(async () => {
      const res = await cancelHandoffAction(orderId);
      if (!res.ok) { toastError(res.error); return; }
      success('Pickup cancelled.'); router.refresh();
    });
  }

  // Empty / cancelled → offer to arrange, or show the compose form.
  if (!active || editing) {
    if (!editing) {
      return (
        <button onClick={() => setEditing(true)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand/10 px-2.5 py-1.5 text-xs font-semibold text-brand-text transition hover:bg-brand/20">
          <MapPin className="h-3.5 w-3.5" /> {tr('handoff.arrangePickup')}
        </button>
      );
    }
    return <ProposeForm pending={pending} onSubmit={propose} onCancel={() => setEditing(false)} />;
  }

  const h = handoff!;
  const safe = isSafePublicSpot(h.locationKind);

  return (
    <div className="mt-2 rounded-xl border border-border bg-surface/60 p-3">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-brand-text" />
        <span className="text-xs font-bold">{statusLabel(h.status)}</span>
        {h.status === 'completed' && <Check className="h-3.5 w-3.5 text-emerald-500" />}
      </div>
      <p className="mt-1 text-sm">{meetSummary(h.meetAt, h.locationLabel)}</p>
      {safe && h.status !== 'completed' && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-3 w-3" /> {tr('handoff.publicMonitoredSpotTheSafeWay')}
        </p>
      )}
      {h.notes && <p className="mt-1 text-xs text-muted">“{h.notes}”</p>}

      {/* Proposed → the other party confirms; the proposer waits. */}
      {h.status === 'proposed' && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {canConfirm(h.status, viewerRole, h.proposerRole) ? (
            <button onClick={confirm} disabled={pending}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-600 transition hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400">
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} {tr('handoff.confirmPickup')}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted"><Clock className="h-3 w-3" /> {tr('handoff.waitingFor')} {other} {tr('handoff.toConfirm')}</span>
          )}
          <button onClick={() => setEditing(true)} disabled={pending} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold transition hover:bg-elevated disabled:opacity-50">{tr('handoff.reschedule')}</button>
          {canCancel(h.status) && <button onClick={cancel} disabled={pending} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-rose-400 disabled:opacity-50">{tr('handoff.cancel')}</button>}
        </div>
      )}

      {/* Confirmed → show the code + complete-in-person input. */}
      {h.status === 'confirmed' && (
        <div className="mt-2.5 space-y-2">
          {h.hasCalendar && <p className="flex items-center gap-1 text-[11px] text-muted"><CalendarCheck className="h-3 w-3" /> {tr('handoff.addedToYourFamilyCalendar')}</p>}
          {h.confirmCode && (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-brand/40 bg-brand/5 px-3 py-2">
              <KeyRound className="h-4 w-4 text-brand-text" />
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">{tr('handoff.handOffCode')}</p>
                <p className="font-mono text-lg font-black tracking-widest">{h.confirmCode}</p>
              </div>
              <span className="ml-auto max-w-[9rem] text-[10px] text-muted">{tr('handoff.shareThisWhenYouMeetTo')}</span>
            </div>
          )}
          {canComplete(h.status) && <CompleteForm orderId={orderId} onDone={() => { success('Handed off — order complete! 🎉'); router.refresh(); }} onError={toastError} />}
          {canCancel(h.status) && <button onClick={cancel} disabled={pending} className="text-[11px] text-muted transition hover:text-rose-400">{tr('handoff.cancelPickup')}</button>}
        </div>
      )}
    </div>
  );
}

function ProposeForm({ pending, onSubmit, onCancel }: {
  pending: boolean;
  onSubmit: (f: { meetAtIso: string | null; locationLabel: string; locationKind: LocationKind; notes: string }) => void;
  onCancel: () => void;
}) {
  const tr = useTranslations();
  const times = suggestedMeetTimes();
  const [when, setWhen] = useState<string>(times[0]?.iso ?? '');
  const [customWhen, setCustomWhen] = useState('');
  const [spot, setSpot] = useState(SAFE_SPOTS[0].label);
  const [spotKind, setSpotKind] = useState<LocationKind>(SAFE_SPOTS[0].kind);
  const [customSpot, setCustomSpot] = useState('');
  const [notes, setNotes] = useState('');

  function submit() {
    const label = customSpot.trim() || spot;
    const kind: LocationKind = customSpot.trim() ? 'other' : spotKind;
    const iso = customWhen ? new Date(customWhen).toISOString() : (when || null);
    onSubmit({ meetAtIso: iso, locationLabel: label, locationKind: kind, notes });
  }

  return (
    <div className="mt-2 space-y-2.5 rounded-xl border border-border bg-surface/60 p-3">
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{tr('handoff.when')}</p>
        <div className="flex flex-wrap gap-1.5">
          {times.map((t) => (
            <button key={t.iso} onClick={() => { setWhen(t.iso); setCustomWhen(''); }}
              className={cn('rounded-lg border px-2.5 py-1 text-xs transition',
                when === t.iso && !customWhen ? 'border-brand bg-brand/10 font-semibold text-brand-text' : 'border-border hover:bg-elevated')}>
              {t.label}
            </button>
          ))}
        </div>
        <input type="datetime-local" value={customWhen} onChange={(e) => setCustomWhen(e.target.value)}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-bg px-3 text-xs outline-none focus:border-brand" />
      </div>
      <div>
        <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <ShieldCheck className="h-3 w-3 text-emerald-500" /> {tr('handoff.safeMeetupSpot')}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {SAFE_SPOTS.map((s) => (
            <button key={s.label} onClick={() => { setSpot(s.label); setSpotKind(s.kind); setCustomSpot(''); }}
              title={s.hint}
              className={cn('rounded-lg border px-2.5 py-1 text-xs transition',
                spot === s.label && !customSpot ? 'border-brand bg-brand/10 font-semibold text-brand-text' : 'border-border hover:bg-elevated')}>
              {s.label}
            </button>
          ))}
        </div>
        <input value={customSpot} onChange={(e) => setCustomSpot(e.target.value)} placeholder={tr('handoff.orTypeASpecificPlace')}
          className="mt-1.5 h-9 w-full rounded-lg border border-border bg-bg px-3 text-xs outline-none focus:border-brand" />
      </div>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={tr('handoff.noteOptionalEGIllBe')}
        className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-xs outline-none focus:border-brand" />
      <div className="flex gap-2">
        <button onClick={submit} disabled={pending}
          className="inline-flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-50">
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <MapPin className="h-3 w-3" />} {tr('handoff.proposePickup')}
        </button>
        <button onClick={onCancel} className="text-xs text-muted hover:text-fg">{tr('handoff.cancel')}</button>
      </div>
    </div>
  );
}

function CompleteForm({ orderId, onDone, onError }: { orderId: string; onDone: () => void; onError: (m: string) => void }) {
  const tr = useTranslations();
  const [code, setCode] = useState('');
  const [pending, start] = useTransition();
  function submit() {
    if (!code.trim()) { onError('Enter the hand-off code.'); return; }
    start(async () => {
      const res = await completeHandoffAction({ orderId, code });
      if (!res.ok) { onError(res.error); return; }
      onDone();
    });
  }
  return (
    <div className="flex gap-2">
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={tr('handoff.enterCodeToComplete')}
        className="h-9 flex-1 rounded-lg border border-border bg-bg px-3 font-mono text-sm uppercase tracking-widest outline-none focus:border-brand" />
      <button onClick={submit} disabled={pending}
        className="inline-flex h-9 items-center gap-1 rounded-lg bg-emerald-500/15 px-3 text-xs font-bold text-emerald-600 transition hover:bg-emerald-500/25 disabled:opacity-50 dark:text-emerald-400">
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} {tr('handoff.complete')}
      </button>
    </div>
  );
}
