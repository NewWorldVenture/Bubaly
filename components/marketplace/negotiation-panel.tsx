'use client';

// "Make an Offer" — the Best Offer negotiation box on a listing detail page.
// Buyers open a thread and counter; sellers counter / accept / decline. Every
// move is realtime (a marketplace_negotiation_rounds change refreshes the
// server component, which re-shapes names + state). The atomic accept lives in
// the DB, so a race can't hand the same item to two buyers.
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Handshake, Loader2, Check, X, ArrowRight, CircleDollarSign } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  whoseTurn, availableActions, validateOfferAmount, suggestedOpeningCents,
  suggestedCounterCents, savingsPercent, statusLine, roundLine,
  type Party, type RoundKind,
} from '@/lib/marketplace/negotiation';
import { makeOfferAction, respondToOfferAction } from '@/app/(app)/marketplace/negotiations/actions';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export type ThreadRound = { id: string; actorRole: Party; kind: RoundKind; amountCents: number | null; message: string | null; createdAt: string };
export type Thread = {
  id: string; buyerName: string; status: string; currentAmountCents: number;
  lastActor: Party; agreedAmountCents: number | null; rounds: ThreadRound[];
};

export function NegotiationPanel({
  listingId, askCents, isOwner, canOffer, threads,
}: {
  listingId: string;
  askCents: number;
  isOwner: boolean;
  canOffer: boolean;       // listing is open and viewer isn't the owner
  threads: Thread[];       // owner: all threads; buyer: their own (0 or 1)
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();

  // Realtime: any round change on this listing re-runs the server component.
  useEffect(() => {
    const sb = createClient();
    const ch = sb.channel(`negotiation:${listingId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'marketplace_negotiation_rounds', filter: `listing_id=eq.${listingId}` }, () => router.refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'marketplace_negotiations', filter: `listing_id=eq.${listingId}` }, () => router.refresh())
      .subscribe();
    return () => { void sb.removeChannel(ch); };
  }, [listingId, router]);

  const myThread = !isOwner ? threads[0] : undefined;
  const showOpener = canOffer && !myThread;

  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-brand/[0.05] to-surface/40 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold">
        <Handshake className="h-4 w-4 text-brand-text" /> Make an Offer
        <span className="ml-auto text-[11px] font-normal text-muted">Asking {money(askCents)}</span>
      </div>

      {showOpener && <OfferOpener listingId={listingId} askCents={askCents} onDone={(m) => { success(m); router.refresh(); }} onError={toastError} />}

      {myThread && (
        <ThreadView thread={myThread} viewer="buyer" askCents={askCents} listingId={listingId}
          onDone={(m) => { success(m); router.refresh(); }} onError={toastError} />
      )}

      {isOwner && (
        threads.length === 0
          ? <p className="text-sm text-muted">No offers yet. When a buyer makes an offer, you can counter or accept it here.</p>
          : (
            <div className="space-y-3">
              {threads.map((t) => (
                <div key={t.id} className="rounded-xl border border-border bg-surface/50 p-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-sm font-semibold">{t.buyerName}</span>
                    <span className={cn('text-[11px] font-medium',
                      t.status === 'agreed' ? 'text-emerald-400' : t.status === 'open' ? 'text-brand-text' : 'text-muted')}>
                      {t.status === 'open' ? statusLine({ status: 'open', currentAmountCents: t.currentAmountCents, lastActor: t.lastActor }, 'seller') : statusLine({ status: t.status as never, currentAmountCents: t.currentAmountCents, lastActor: t.lastActor, agreedAmountCents: t.agreedAmountCents }, 'seller')}
                    </span>
                  </div>
                  <ThreadView thread={t} viewer="seller" askCents={askCents} listingId={listingId}
                    onDone={(m) => { success(m); router.refresh(); }} onError={toastError} />
                </div>
              ))}
            </div>
          )
      )}
    </div>
  );
}

/** The buyer's initial "make an offer" input. */
function OfferOpener({ listingId, askCents, onDone, onError }: {
  listingId: string; askCents: number; onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState(() => (suggestedOpeningCents(askCents) / 100).toString());
  const [msg, setMsg] = useState('');

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition hover:opacity-90">
        <CircleDollarSign className="h-4 w-4" /> Make an offer
      </button>
    );
  }

  function submit() {
    const cents = Math.round(parseFloat(amt) * 100);
    const bad = validateOfferAmount(cents, askCents);
    if (bad) { onError(bad); return; }
    start(async () => {
      const res = await makeOfferAction({ listingId, amountCents: cents, message: msg });
      if (!res.ok) { onError(res.error); return; }
      setOpen(false); setMsg('');
      onDone('Offer sent — you’ll hear back here.');
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)}
            className="h-11 w-full rounded-xl border border-border bg-bg pl-7 pr-3 text-sm outline-none focus:border-brand" />
        </div>
        <button onClick={submit} disabled={pending}
          className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-50">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Send
        </button>
      </div>
      <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Add a note (optional)"
        className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-xs outline-none focus:border-brand" />
      <p className="text-[11px] text-muted">Offers below the {money(askCents)} asking price. The seller can accept or counter.</p>
    </div>
  );
}

/** The shared thread timeline + action row, from `viewer`'s side. */
function ThreadView({ thread, viewer, askCents, listingId, onDone, onError }: {
  thread: Thread; viewer: Party; askCents: number; listingId: string; onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const [pending, start] = useTransition();
  const [countering, setCountering] = useState(false);
  const [amt, setAmt] = useState(() => (suggestedCounterCents(thread.currentAmountCents, askCents) / 100).toString());

  const neg = { status: thread.status as never, currentAmountCents: thread.currentAmountCents, lastActor: thread.lastActor, agreedAmountCents: thread.agreedAmountCents };
  const actions = availableActions(neg, viewer);
  const myTurn = whoseTurn(neg) === viewer;

  function respond(action: 'counter' | 'accept' | 'decline' | 'withdraw', amountCents?: number) {
    start(async () => {
      const res = await respondToOfferAction({ negotiationId: thread.id, action, amountCents, listingId: undefined });
      if (!res.ok) { onError(res.error); return; }
      setCountering(false);
      onDone(
        res.data?.status === 'agreed' ? `Deal! Agreed at ${money(thread.currentAmountCents)} — check your orders.`
        : action === 'withdraw' ? 'Offer withdrawn.'
        : action === 'decline' ? 'Offer declined.'
        : 'Counter sent.');
    });
  }

  function sendCounter() {
    const cents = Math.round(parseFloat(amt) * 100);
    if (viewer === 'buyer') {
      const bad = validateOfferAmount(cents, askCents);
      if (bad) { onError(bad); return; }
    } else if (!cents || cents <= 0) { onError('Enter a valid counter amount.'); return; }
    // Buyers counter through the offer RPC (it appends to the same thread);
    // sellers counter through the respond RPC.
    start(async () => {
      const res = viewer === 'buyer'
        ? await makeOfferAction({ listingId, amountCents: cents })
        : await respondToOfferAction({ negotiationId: thread.id, action: 'counter', amountCents: cents });
      if (!res.ok) { onError(res.error); return; }
      setCountering(false);
      onDone('Counter sent.');
    });
  }

  return (
    <div className="space-y-2">
      {/* Timeline */}
      <ul className="space-y-1 text-xs">
        {thread.rounds.map((r) => (
          <li key={r.id} className="flex items-baseline justify-between gap-2">
            <span className={cn(r.actorRole === viewer ? 'text-fg' : 'text-muted')}>
              {roundLine({ actorRole: r.actorRole, kind: r.kind, amountCents: r.amountCents, createdAt: r.createdAt })}
              {r.message ? <span className="text-muted"> — “{r.message}”</span> : null}
            </span>
          </li>
        ))}
      </ul>

      {thread.status === 'open' && actions.length > 0 && (
        <div className="space-y-2 pt-1">
          {!countering ? (
            <div className="flex flex-wrap gap-2">
              {actions.includes('accept') && (
                <button onClick={() => respond('accept')} disabled={pending}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-bold text-emerald-400 transition hover:bg-emerald-500/25 disabled:opacity-50">
                  {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Accept {money(thread.currentAmountCents)}
                </button>
              )}
              {actions.includes('counter') && (
                <button onClick={() => setCountering(true)} disabled={pending}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold transition hover:bg-elevated disabled:opacity-50">
                  <CircleDollarSign className="h-3 w-3" /> Counter
                </button>
              )}
              {actions.includes('decline') && (
                <button onClick={() => respond('decline')} disabled={pending}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-rose-400 disabled:opacity-50">
                  <X className="h-3 w-3" /> Decline
                </button>
              )}
              {actions.includes('withdraw') && (
                <button onClick={() => respond('withdraw')} disabled={pending}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition hover:text-rose-400 disabled:opacity-50">
                  <X className="h-3 w-3" /> Withdraw
                </button>
              )}
              {!myTurn && <span className="self-center text-[11px] text-muted">Waiting on the other side…</span>}
            </div>
          ) : (
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
                <input type="number" inputMode="decimal" min="0" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-bg pl-7 pr-3 text-sm outline-none focus:border-brand" />
              </div>
              <button onClick={sendCounter} disabled={pending}
                className="inline-flex h-9 items-center gap-1 rounded-lg bg-brand px-3 text-xs font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-50">
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />} Send
              </button>
              <button onClick={() => setCountering(false)} className="text-xs text-muted hover:text-fg">Cancel</button>
            </div>
          )}
        </div>
      )}

      {thread.status === 'agreed' && (
        <p className="text-xs font-semibold text-emerald-400">
          Agreed at {money(thread.agreedAmountCents ?? thread.currentAmountCents)}
          {savingsPercent(thread.agreedAmountCents ?? thread.currentAmountCents, askCents) > 0 && (
            <span className="text-muted"> · {savingsPercent(thread.agreedAmountCents ?? thread.currentAmountCents, askCents)}% off asking</span>
          )}
        </p>
      )}
    </div>
  );
}
