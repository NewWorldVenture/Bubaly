'use client';

// Reveal a card's full number / expiry / CVC via Stripe.js Issuing Elements.
// The PAN renders inside Stripe-hosted iframes — it never passes through our
// servers, our database, or even this component's state (PCI stays with
// Stripe). Flow: prepare (ids + publishable key) → nonce → ephemeral key →
// retrieveIssuingCard → mount the display Elements.
import { useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { prepareCardRevealAction, createCardRevealAction } from '@/app/(app)/money/actions';

export function CardRevealModal({ cardId, childName, onClose }: {
  cardId: string; childName: string; onClose: () => void;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const numberRef = useRef<HTMLDivElement>(null);
  const expiryRef = useRef<HTMLDivElement>(null);
  const cvcRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const prep = await prepareCardRevealAction(cardId);
        if (!prep.ok || !prep.data) throw new Error(prep.ok ? 'Missing data' : prep.error);
        const { stripeCardId, publishableKey, stripeAccount } = prep.data;

        const { loadStripe } = await import('@stripe/stripe-js');
        const stripe = await loadStripe(publishableKey, { stripeAccount });
        if (!stripe) throw new Error('Stripe.js failed to load.');

        const nonceResult = await stripe.createEphemeralKeyNonce({ issuingCard: stripeCardId });
        if (!nonceResult.nonce) throw new Error('Could not start a secure session.');

        const keyRes = await createCardRevealAction({ cardId, nonce: nonceResult.nonce });
        if (!keyRes.ok || !keyRes.data) throw new Error(keyRes.ok ? 'Missing key' : keyRes.error);
        if (cancelled) return;

        // The Issuing display Elements authenticate directly with the ephemeral
        // key + nonce — the PAN renders inside Stripe-hosted iframes.
        const auth = { issuingCard: stripeCardId, ephemeralKeySecret: keyRes.data.ephemeralKeySecret, nonce: nonceResult.nonce };
        const elements = stripe.elements();
        const style = { base: { color: '#fff', fontSize: '16px', fontFamily: 'ui-monospace, monospace' } };
        elements.create('issuingCardNumberDisplay', { ...auth, style }).mount(numberRef.current!);
        elements.create('issuingCardExpiryDisplay', { ...auth, style }).mount(expiryRef.current!);
        elements.create('issuingCardCvcDisplay', { ...auth, style }).mount(cvcRef.current!);
        setState('ready');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not reveal the card.');
        setState('error');
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [cardId]);

  return (
    <Modal open title={`${childName}'s card details`} onClose={onClose}>
      <div className="space-y-4">
        {state === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 className="h-5 w-5 animate-spin" /> Opening a secure session…
          </div>
        )}
        {state === 'error' && (
          <div className="flex items-center gap-2 rounded-xl border border-danger/25 bg-danger/10 p-3 text-sm text-danger">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}
        <div className={state === 'ready' ? 'block' : 'hidden'}>
          <div className="rounded-2xl bg-gradient-to-br from-brand to-violet-700 p-5 text-white">
            <p className="text-[10px] uppercase tracking-widest text-white/60">Card number</p>
            <div ref={numberRef} className="mt-1 min-h-6" />
            <div className="mt-4 flex gap-8">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-white/60">Expires</p>
                <div ref={expiryRef} className="mt-1 min-h-5" />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-white/60">CVC</p>
                <div ref={cvcRef} className="mt-1 min-h-5" />
              </div>
            </div>
          </div>
          <p className="mt-3 flex items-start gap-2 text-xs text-muted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-text" />
            Shown via Stripe&apos;s secure display — the number never touches Bubaly&apos;s servers.
            This reveal is logged for the family.
          </p>
        </div>
      </div>
    </Modal>
  );
}
