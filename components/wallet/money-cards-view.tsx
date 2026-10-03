'use client';

// Wallet → Cards. Frictionless card management for kids — virtual + physical.
// Three modes: (A) provider not configured → explicit unavailable state, (B) setup
// needed → guided 3-step onboarding wizard, (C) live → manage per-child cards
// with instant freeze, spend controls, and physical-card ordering.
import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  CreditCard, ShieldCheck, Snowflake, Sparkles, Loader2, SlidersHorizontal,
  CheckCircle2, Circle, ChevronRight, Plus, Package, Zap, Lock, Eye,
} from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { formatCents as formatCentsIn } from '@/lib/wallet/ledger';
import {
  SPEND_WINDOWS, BLOCKABLE_CATEGORIES, type SpendWindow,
} from '@/lib/wallet/card-controls';
import {
  startConnectOnboardingAction, issueCardAction, setCardFrozenAction, updateCardControlsAction,
} from '@/app/(app)/money/actions';
import { CardRevealModal } from '@/components/wallet/card-reveal-modal';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { currencyUnit } from '@/lib/marketplace/listings';
import { useApp } from '@/components/app/app-context';

export type CardChild = { id: string; name: string; color: string | null };
export type IssuedCard = {
  id: string; childWalletId: string; type: 'virtual' | 'physical';
  status: string; last4: string | null; brand: string | null; isFrozen: boolean;
  spendLimitCents: number | null; spendWindow: string; blockedCategories: string[];
};
type Caps = { connectOnboarding: boolean; issuing: boolean; physicalCards: boolean };

// Pending card operations, held outside any one mounted view. A view left and
// re-entered before its request answered used to start with no claims and the
// same stale props, so a second freeze or a second card order went out while
// the first was still in flight. Claims now live here under their owner: the
// signed-in actor and the active family the page was rendered for (useApp(),
// fixed for the life of a mount; another account or family remounts the app
// with its own identity). The same person returning to the same family sees the
// operation still pending; another account or family never does. Without that
// identity a mounted view keeps a private owner, the old per-view behaviour. A
// claim is released under the owner that made it, when its request settles,
// mounted or not. Audit JIMMY-SUPPORT-CARD-RETRY-20261001 (A).
const NO_PENDING: ReadonlySet<string> = new Set();
const pendingByOwner = new Map<string, ReadonlySet<string>>();
const pendingListeners = new Set<() => void>();
let privateOwners = 0;

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

function pendingFor(owner: string): ReadonlySet<string> {
  return pendingByOwner.get(owner) ?? NO_PENDING;
}

function setPending(owner: string, keys: ReadonlySet<string>) {
  if (keys.size > 0) pendingByOwner.set(owner, keys);
  else pendingByOwner.delete(owner);
  for (const listener of [...pendingListeners]) listener();
}

/** The signed-in actor and family that own a claim, or null when either is unknown. */
function pendingOwner(userId: string | null | undefined, familyId: string | null | undefined): string | null {
  return userId && familyId ? JSON.stringify([userId, familyId]) : null;
}

export function MoneyCardsView({
  capabilities, accountReady, onboardingStarted, justCompletedSetup,
  childWallets, cards, canManage,
}: {
  capabilities: Caps; accountReady: boolean; onboardingStarted: boolean;
  justCompletedSetup?: boolean;
  childWallets: CardChild[]; cards: IssuedCard[]; canManage: boolean;
}) {
  const t = useTranslations();
  const tr = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [privateOwner] = useState(() => `view:${++privateOwners}`);
  const { userId, familyId } = useApp();
  const owner = pendingOwner(userId, familyId) ?? privateOwner;
  const busy = useSyncExternalStore(subscribePending, () => pendingFor(owner), () => NO_PENDING);
  // Keys this mounted view claimed itself; its own handlers reconcile those.
  const claimedHere = useRef(new Set<string>());
  const seenPending = useRef<ReadonlySet<string>>(busy);
  const [expanded, setExpanded] = useState<{ cardId: string; instance: number } | null>(null);
  const [orderingCard, setOrderingCard] = useState<{ child: CardChild; instance: number } | null>(null);
  const controlsInstance = useRef(0);
  const orderInstance = useRef(0);
  const formsMounted = useRef(true);
  const [revealing, setRevealing] = useState<{ cardId: string; childName: string } | null>(null);
  const [issueType, setIssueType] = useState<'virtual' | 'physical'>('virtual');

  useEffect(() => {
    formsMounted.current = true;
    return () => { formsMounted.current = false; };
  }, []);

  // A claim this view inherited (left by a view that was unmounted while its
  // request ran) has settled. The unmounted form presents nothing, and the
  // props here predate the change, so re-read before the control is used again.
  useEffect(() => {
    const released = [...seenPending.current].filter((key) => !busy.has(key));
    seenPending.current = busy;
    const inherited = released.filter((key) => !claimedHere.current.has(key));
    for (const key of released) claimedHere.current.delete(key);
    if (inherited.length > 0) router.refresh();
  }, [busy, router]);

  function closeOrder() {
    orderInstance.current += 1;
    setOrderingCard(null);
  }

  // Show success banner briefly when returning from Stripe onboarding.
  const [showSetupSuccess, setShowSetupSuccess] = useState(justCompletedSetup && accountReady);
  useEffect(() => {
    if (showSetupSuccess) {
      const t = setTimeout(() => setShowSetupSuccess(false), 6000);
      return () => clearTimeout(t);
    }
  }, [showSetupSuccess]);

  const cardsByChild = new Map<string, IssuedCard[]>();
  for (const c of cards) {
    const list = cardsByChild.get(c.childWalletId) ?? [];
    list.push(c); cardsByChild.set(c.childWalletId, list);
  }

  const childrenWithoutCards = childWallets.filter((c) => !cardsByChild.has(c.id));

  // How many of this child's cards of this type this view shows, every status:
  // the count an order from here is made against. The server refuses an order
  // whose count its mirror has moved past (another tab or device ordered since
  // this view read), so a stale view cannot become a second card; it answers
  // "refresh to try again", and the view re-reads so the next order is made
  // against what now exists. Audit JIMMY-SUPPORT-CARD-RETRY-20261001.
  function shownCount(childWalletId: string, type: IssuedCard['type']) {
    return (cardsByChild.get(childWalletId) ?? []).filter((card) => card.type === type).length;
  }

  function claimPending(keys: string[]) {
    // Claim synchronously: a retained callback can run again before React has
    // committed disabled buttons. Independent operations keep their own keys.
    const claimedBy = owner;
    const held = pendingFor(claimedBy);
    if (keys.some((key) => held.has(key))) return null;
    for (const key of keys) claimedHere.current.add(key);
    setPending(claimedBy, new Set([...held, ...keys]));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = new Set(pendingFor(claimedBy));
      for (const key of keys) remaining.delete(key);
      setPending(claimedBy, remaining);
    };
  }

  async function startSetup() {
    const release = claimPending(['setup']);
    if (!release) return;
    try {
      const res = await startConnectOnboardingAction();
      if (!res.ok) return toastError(res.error);
      if (res.data?.url) window.location.href = res.data.url;
    } catch {
      toastError(t('globalError.somethingWentWrong'));
    } finally {
      release();
    }
  }

  async function issueVirtual(childWalletId: string) {
    const release = claimPending([`issue-${childWalletId}`]);
    if (!release) return;
    try {
      const res = await issueCardAction({
        childWalletId, type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization',
        expectedCount: shownCount(childWalletId, 'virtual'),
      });
      if (!res.ok) {
        toastError(res.error);
        if ('stale' in res && res.stale) router.refresh();
        return;
      }
      success(t('moneyCardsView.virtualCardCreated'));
      router.refresh();
    } catch {
      toastError(t('globalError.somethingWentWrong'));
    } finally {
      release();
    }
  }

  async function issueAllVirtual() {
    // Reserve every target, including children not yet reached by the loop,
    // so bulk and individual issuance cannot dispatch the same work together.
    const release = claimPending(['issue-all', ...childrenWithoutCards.map((child) => `issue-${child.id}`)]);
    if (!release) return;
    // Every result used to be discarded and the toast reported the number
    // ATTEMPTED as the number issued. What was thrown away includes Trust-Engine
    // denials and "Finish account setup first" — the product REFUSING, reported
    // to a parent as success, on a payment instrument — and a THROW part-way
    // left `setBusy(null)` unreached (the button stuck), skipped the remaining
    // children, and said nothing. The four other issueCardAction call sites in
    // this file check res.ok; this one did not. Report what actually happened:
    // every child is attempted, the count is the number issued, and the first
    // refusal's reason is what the parent reads. Audit C4-S4-04.
    const failures: string[] = [];
    let issued = 0;
    try {
      for (const child of childrenWithoutCards) {
        const res = await issueCardAction({
          childWalletId: child.id, type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization',
          expectedCount: shownCount(child.id, 'virtual'),
        });
        if (!res.ok) failures.push(res.error || t('globalError.somethingWentWrong'));
        else issued += 1;
      }
    } catch (err) {
      failures.push(err instanceof Error && err.message ? err.message : t('globalError.somethingWentWrong'));
    } finally {
      release();
    }
    if (issued > 0) {
      success(issued === 1
        ? tr('moneyCards.issuedOneVirtualCard')
        : tr('moneyCards.issuedVirtualCards', { count: issued }));
    }
    // Refresh either way: the list is the honest record of what now exists, and
    // a partial run must not leave the screen showing the pre-run state.
    router.refresh();
    // Surface the actual reason rather than a count — the reason is what tells
    // a parent what to do next, and it is the thing that was being discarded.
    if (failures.length > 0) toastError(failures[0]);
  }

  async function toggleFreeze(card: IssuedCard) {
    const release = claimPending([`freeze-${card.id}`]);
    if (!release) return;
    try {
      const res = await setCardFrozenAction({ cardId: card.id, frozen: !card.isFrozen });
      if (!res.ok) return toastError(res.error);
      success(card.isFrozen ? 'Card unfrozen' : 'Card frozen');
      router.refresh();
    } catch {
      toastError(t('globalError.somethingWentWrong'));
    } finally {
      release();
    }
  }

  // ── Mode A: card provider is not configured → explicit unavailable state ──
  if (!capabilities.connectOnboarding && !capabilities.issuing) {
    return (
      <div>
        <WalletSubnav />
        <PageHeader title={tr('moneyCards.cards')} description={t('moneyCardsView.spendingCardsAreNotEnabled')} />
        <div className="mt-4 rounded-2xl border border-border bg-surface/40 p-6">
          <EmptyState
            icon={CreditCard}
            title={tr('moneyCards.spendingCardsAreUnavailable')}
            description="Your Family Wallet tracks allowances, gifts, savings goals and chore rewards today. A parent can return here after the family card program has been configured."
          />
        </div>
      </div>
    );
  }

  // ── Mode B: available but not set up → guided 3-step wizard ──
  if (!accountReady) {
    return (
      <div>
        <WalletSubnav />
        <PageHeader title={tr('moneyCards.cards')} description={t('moneyCardsView.setUpSafeSpendingCards')} />

        {/* Progress steps */}
        <div className="mt-4 mb-6">
          <SetupSteps current={onboardingStarted ? 1 : 0} />
        </div>

        <div className="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 via-brand/5 to-transparent p-6">
          <div className="flex items-start gap-4">
            <div className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-2xl bg-brand/20">
              {onboardingStarted ? <Sparkles className="h-6 w-6 text-brand-text" /> : <CreditCard className="h-6 w-6 text-brand-text" />}
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-bold">
                {onboardingStarted ? 'Finish your account setup' : 'Give your kids a safe way to spend'}
              </h3>
              <p className="mt-1 text-sm text-muted">
                {onboardingStarted
                  ? "You've started setup. Complete the quick identity verification to unlock cards for your kids."
                  : 'Every purchase is checked against their Spend balance in real time — they can never overspend. A quick identity verification is required by law.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                {canManage ? (
                  <Button onClick={startSetup} loading={busy.has('setup')} size="lg">
                    {onboardingStarted ? 'Continue setup' : 'Get started — 5 mins'}
                  </Button>
                ) : (
                  <p className="rounded-xl border border-border bg-surface/40 px-4 py-2 text-sm text-muted">{tr('moneyCards.askAParentToSetThis')}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Feature preview */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { icon: ShieldCheck, label: 'Real-time spend gate', desc: 'Declines if balance is insufficient — instantly.' },
            { icon: Snowflake, label: 'Instant freeze', desc: 'Freeze any card from your phone in one tap.' },
            { icon: SlidersHorizontal, label: 'Per-card controls', desc: 'Set daily limits and block categories like gaming.' },
          ].map((f) => (
            <div key={f.label} className="rounded-2xl border border-border bg-surface/40 p-4">
              <f.icon className="mb-2 h-5 w-5 text-brand-text" />
              <p className="text-sm font-semibold">{f.label}</p>
              <p className="mt-0.5 text-xs text-muted">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Mode C: account ready → manage cards ──
  return (
    <div>
      <WalletSubnav />
      <PageHeader title={tr('moneyCards.cards')} description={t('moneyCardsView.kidSafeSpendingCardsEach')} />

      {/* Setup success banner */}
      {showSetupSuccess && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-emerald-400" />
          <p className="flex-1 text-sm font-medium text-emerald-300">{tr('moneyCards.accountVerifiedIssueVirtualCardsFor')}</p>
          <button type="button" onClick={() => setShowSetupSuccess(false)} className="text-muted hover:text-fg">✕</button>
        </div>
      )}

      {/* Bulk issue prompt if any children lack cards */}
      {canManage && childrenWithoutCards.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-brand/20 bg-brand/5 px-4 py-3">
          <div className="flex items-center gap-3">
            <Zap className="h-5 w-5 flex-shrink-0 text-brand-text" />
            <p className="text-sm font-medium">
              {childrenWithoutCards.length === 1
                ? t('moneyCards.childNoCard', { name: childrenWithoutCards[0].name })
                : t('moneyCards.childrenNoCards', { n: childrenWithoutCards.length })}
            </p>
          </div>
          <Button size="sm" onClick={issueAllVirtual} loading={busy.has('issue-all')}
            disabled={childrenWithoutCards.some((child) => busy.has(`issue-${child.id}`))}>
            {tr('moneyCards.issueAll')}
          </Button>
        </div>
      )}

      {childWallets.length === 0 ? (
        <EmptyState icon={CreditCard} title={tr('moneyCards.noChildWallets')} description={t('moneyCardsView.addChildMembersToIssue')} />
      ) : (
        <div className="space-y-4">
          {childWallets.map((child) => {
            const childCards = cardsByChild.get(child.id) ?? [];
            return (
              <div key={child.id} className="overflow-hidden rounded-2xl border border-border bg-surface/40">
                {/* Child header */}
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/50">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={child.name} color={child.color ?? undefined} size={36} className="rounded-full" />
                    <div>
                      <p className="text-sm font-semibold">{child.name}</p>
                      <p className="text-xs text-muted">{childCards.length} card{childCards.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button" onClick={() => issueVirtual(child.id)}
                        disabled={busy.has(`issue-${child.id}`)}
                        className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated disabled:opacity-60 transition"
                      >
                        {busy.has(`issue-${child.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                        Virtual
                      </button>
                      {capabilities.physicalCards && (
                        <button
                          type="button" onClick={() => { setOrderingCard({ child, instance: ++orderInstance.current }); setIssueType('physical'); }}
                          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated transition"
                        >
                          <Package className="h-3.5 w-3.5" />{' '}{t('moneyCardsView.physical')}</button>
                      )}
                    </div>
                  )}
                </div>

                {/* Cards list */}
                {childCards.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-muted">{t('moneyCardsView.noCardYetUseThe')}</div>
                ) : (
                  <div className="divide-y divide-border/30">
                    {childCards.map((card) => (
                      <CardRow
                        key={card.id} card={card} canManage={canManage}
                        busy={busy} expanded={expanded?.cardId ?? null}
                        controlsKey={expanded?.instance}
                        claimControls={() => claimPending([`controls-${card.id}`])}
                        controlsCurrent={() => formsMounted.current && controlsInstance.current === expanded?.instance}
                        onFreeze={() => toggleFreeze(card)}
                        onReveal={() => setRevealing({ cardId: card.id, childName: child.name })}
                        onToggleControls={() => {
                          const instance = ++controlsInstance.current;
                          setExpanded(expanded?.cardId === card.id ? null : { cardId: card.id, instance });
                        }}
                        onSaved={() => {
                          if (!formsMounted.current) return;
                          if (controlsInstance.current === expanded?.instance) {
                            controlsInstance.current += 1;
                            setExpanded(null);
                          }
                          // A dismissed form cannot cancel its dispatched write.
                          // Reconcile success without closing a newer editor.
                          router.refresh();
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Physical card order modal */}
      {orderingCard && (
        <PhysicalCardModal
          key={orderingCard.instance}
          child={orderingCard.child}
          expectedCount={shownCount(orderingCard.child.id, 'physical')}
          pending={busy.has(`physical-${orderingCard.child.id}`)}
          claim={() => claimPending([`physical-${orderingCard.child.id}`])}
          isCurrent={() => formsMounted.current && orderInstance.current === orderingCard.instance}
          onClose={closeOrder}
          onIssued={() => {
            if (!formsMounted.current) return;
            if (orderInstance.current === orderingCard.instance) closeOrder();
            router.refresh();
          }}
          onStale={() => {
            // The cards changed under this order. Close the dialog so the
            // parent sees the refreshed list, with the card that made it
            // stale, before deciding on another: left open, one more click
            // would order a second card against the new count.
            if (!formsMounted.current) return;
            if (orderInstance.current === orderingCard.instance) closeOrder();
            router.refresh();
          }}
        />
      )}

      {/* Secure PAN reveal (Stripe Issuing Elements) */}
      {revealing && (
        <CardRevealModal
          cardId={revealing.cardId}
          childName={revealing.childName}
          onClose={() => setRevealing(null)}
        />
      )}
    </div>
  );
}

// ─── Setup Steps ──────────────────────────────────────────────────────────────

function SetupSteps({ current }: { current: number }) {
  const steps = [
    { label: 'Verify identity', desc: 'Secure, 5-minute process' },
    { label: 'Issue cards', desc: 'One tap per child' },
    { label: 'Start spending', desc: 'Real-time balance checks' },
  ];
  return (
    <div className="flex items-start gap-0">
      {steps.map((s, i) => (
        <div key={s.label} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex w-full items-center">
            {i > 0 && <div className={cn('h-0.5 flex-1 transition-colors', i <= current ? 'bg-brand' : 'bg-border')} />}
            <div className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors',
              i < current ? 'border-brand bg-brand text-white' : i === current ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted')}>
              {i < current ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
            </div>
            {i < steps.length - 1 && <div className={cn('h-0.5 flex-1 transition-colors', i < current ? 'bg-brand' : 'bg-border')} />}
          </div>
          <p className="mt-1 text-center text-xs font-semibold">{s.label}</p>
          <p className="text-center text-[10px] text-muted">{s.desc}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Card Row ─────────────────────────────────────────────────────────────────

function CardRow({ card, canManage, busy, expanded, controlsKey, claimControls, controlsCurrent, onFreeze, onReveal, onToggleControls, onSaved }: {
  card: IssuedCard; canManage: boolean; busy: ReadonlySet<string>; expanded: string | null;
  controlsKey?: number; claimControls: () => (() => void) | null; controlsCurrent: () => boolean;
  onFreeze: () => void; onReveal: () => void; onToggleControls: () => void; onSaved: () => void;
}) {
  const locale = useLocale();
  // Money follows the reader; the currency stays the money's own.
  const formatCents = (cents: number, currency?: string) =>
    formatCentsIn(cents, currency, locale.code);
  const t = useTranslations();
  const tr = useTranslations();
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        {/* Card art */}
        <div className={cn(
          'flex h-10 w-16 flex-shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white',
          card.isFrozen ? 'bg-muted/50' : 'bg-gradient-to-br from-brand to-violet-600',
        )}>
          {card.last4 ? `••${card.last4}` : card.type === 'physical' ? 'PHYS' : 'VIRT'}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {card.brand ?? (card.type === 'physical' ? t('moneyCardsView.physical') : 'Virtual')} card
            {card.last4 && <span className="font-normal text-muted"> ···· {card.last4}</span>}
          </p>
          <p className="flex items-center gap-2 text-xs text-muted">
            {card.isFrozen
              ? <span className="flex items-center gap-1 text-sky-400"><Snowflake className="h-3 w-3" /> {tr('moneyCards.frozen')}</span>
              : <span className="flex items-center gap-1 text-emerald-400"><ShieldCheck className="h-3 w-3" /> {tr('moneyCards.active')}</span>}
            {card.spendLimitCents != null && <span>· {formatCents(card.spendLimitCents)} {windowShort(card.spendWindow)}</span>}
            {card.blockedCategories.length > 0 && <span>· {card.blockedCategories.length} blocked</span>}
            {card.type === 'physical' && <span className="flex items-center gap-0.5"><Package className="h-3 w-3" /> {tr('moneyCards.physical')}</span>}
          </p>
        </div>

        {canManage && (
          <div className="flex items-center gap-1">
            <button type="button" onClick={onReveal}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated transition">
              <Eye className="h-3.5 w-3.5" /> {tr('moneyCards.reveal')}
            </button>
            <button type="button" onClick={onToggleControls}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated transition">
              <SlidersHorizontal className="h-3.5 w-3.5" /> {tr('moneyCards.controls')}
            </button>
            <button type="button" onClick={onFreeze} disabled={busy.has(`freeze-${card.id}`)}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated disabled:opacity-60 transition">
              {busy.has(`freeze-${card.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Snowflake className="h-3.5 w-3.5" />}
              {card.isFrozen ? 'Unfreeze' : 'Freeze'}
            </button>
          </div>
        )}
      </div>
      {canManage && expanded === card.id && (
        <CardControlsEditor key={controlsKey} card={card} pending={busy.has(`controls-${card.id}`)}
          claim={claimControls} isCurrent={controlsCurrent} onSaved={onSaved} />
      )}
    </div>
  );
}

// ─── Physical Card Order Modal ────────────────────────────────────────────────

function PhysicalCardModal({ child, expectedCount, pending, claim, isCurrent, onClose, onIssued, onStale }: {
  child: CardChild; expectedCount: number; pending: boolean; claim: () => (() => void) | null; isCurrent: () => boolean;
  onClose: () => void; onIssued: () => void; onStale: () => void;
}) {
  const t = useTranslations();
  const tr = useTranslations();
  const unit = currencyUnit(useLocale().code);
  const { success, error: toastError } = useToast();
  const [limitDollars, setLimitDollars] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isCurrent()) return;
    const release = claim();
    if (!release) return;
    const spendLimitCents = limitDollars.trim() ? Math.round(parseFloat(limitDollars) * 100) : null;
    try {
      const res = await issueCardAction({
        childWalletId: child.id, type: 'physical',
        spendLimitCents: spendLimitCents && spendLimitCents > 0 ? spendLimitCents : null,
        spendWindow: 'daily', expectedCount,
      });
      if (!res.ok) {
        if (isCurrent()) toastError(res.error ?? 'Could not order card');
        if ('stale' in res && res.stale) onStale();
        return;
      }
      if (isCurrent()) success(t('wallet.physicalCardOrdered', { name: child.name }));
      onIssued();
    } catch {
      if (isCurrent()) toastError(t('globalError.somethingWentWrong'));
    } finally {
      release();
    }
  }

  return (
    <Modal open title={tr('moneyCards.orderPhysicalCardFor', { name: child.name })} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-brand/20 bg-brand/5 p-3">
          <Package className="h-5 w-5 flex-shrink-0 text-brand-text" />
          <div>
            <p className="text-sm font-semibold">{tr('moneyCards.physicalVisaDebitCard')}</p>
            <p className="text-xs text-muted">{tr('moneyCards.shippedIn57BusinessDays')}</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface/40 p-3">
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-text" />
            <div>
              <p className="text-sm font-semibold">{tr('moneyCards.realTimeBalanceGate')}</p>
              <p className="text-xs text-muted">{tr('moneyCards.everySwipeChecks')} {child.name}{tr('moneyCards.aposSSpendBucketDeclinesInstantly')}</p>
            </div>
          </div>
        </div>

        <Field label={tr('moneyCards.dailySpendLimitOptionalLeaveBlank')}>
          {(id) => (
            <div className="flex items-center gap-1.5">
              {unit.before && <span className="text-muted">{unit.symbol}</span>}
              <Input id={id} type="number" min="1" step="1" value={limitDollars}
                onChange={(e) => setLimitDollars(e.target.value)} placeholder={t('moneyCardsView.noLimit')} />
              {!unit.before && <span className="text-muted">{unit.symbol}</span>}
            </div>
          )}
        </Field>

        <p className="text-xs text-muted">
          {tr('moneyCards.thePhysicalCardWillBeRegistered')} {child.name}{tr('moneyCards.aposSCardholderProfileYouCan')}
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('moneyCards.cancel')}</Button>
          <Button type="submit" loading={pending}>
            <Package className="h-4 w-4" /> {tr('moneyCards.orderCard')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Card Controls Editor ─────────────────────────────────────────────────────

function CardControlsEditor({ card, pending, claim, isCurrent, onSaved }: {
  card: IssuedCard; pending: boolean; claim: () => (() => void) | null; isCurrent: () => boolean; onSaved: () => void;
}) {
  const t = useTranslations();
  const tr = useTranslations();
  const unit = currencyUnit(useLocale().code);
  const { success, error: toastError } = useToast();
  const [limitDollars, setLimitDollars] = useState(card.spendLimitCents != null ? String(card.spendLimitCents / 100) : '');
  const [windowVal, setWindowVal] = useState<SpendWindow>((card.spendWindow as SpendWindow) ?? 'per_authorization');
  const [blocked, setBlocked] = useState<string[]>(card.blockedCategories);

  function toggleCat(value: string) {
    setBlocked((b) => (b.includes(value) ? b.filter((x) => x !== value) : [...b, value]));
  }

  async function save() {
    if (!isCurrent()) return;
    const trimmed = limitDollars.trim();
    const spendLimitCents = trimmed === '' ? null : Math.round(Number(trimmed) * 100);
    if (spendLimitCents != null && (!Number.isFinite(spendLimitCents) || spendLimitCents <= 0)) {
      return toastError(t('moneyCardsView.enterAValidLimitOr'));
    }
    const release = claim();
    if (!release) return;
    try {
      const res = await updateCardControlsAction({ cardId: card.id, spendLimitCents, spendWindow: windowVal, blockedCategories: blocked });
      if (!res.ok) {
        if (isCurrent()) toastError(res.error ?? 'Could not save controls.');
        return;
      }
      if (isCurrent()) success(t('moneyCardsView.controlsSaved'));
      onSaved();
    } catch {
      if (isCurrent()) toastError(t('globalError.somethingWentWrong'));
    } finally {
      release();
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{tr('moneyCards.spendLimitBlankNoLimit')}</span>
          <div className="flex items-center gap-1">
            {unit.before && <span className="text-muted">{unit.symbol}</span>}
            <input
              type="number" min="0" step="1" inputMode="decimal" value={limitDollars}
              onChange={(e) => setLimitDollars(e.target.value)} placeholder={tr('moneyCards.noLimit')}
              className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm focus-ring"
            />
            {!unit.before && <span className="text-muted">{unit.symbol}</span>}
          </div>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{tr('moneyCards.resets')}</span>
          <select
            value={windowVal} onChange={(e) => setWindowVal(e.target.value as SpendWindow)}
            className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm focus-ring"
          >
            {SPEND_WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </label>
      </div>

      <div>
        <span className="mb-1.5 block text-xs font-medium text-muted">{tr('moneyCards.blockTheseCategories')}</span>
        <div className="flex flex-wrap gap-1.5">
          {BLOCKABLE_CATEGORIES.map((c) => {
            const on = blocked.includes(c.value);
            return (
              <button key={c.value} type="button" onClick={() => toggleCat(c.value)}
                className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition',
                  on ? 'border-danger/40 bg-danger/10 text-danger' : 'border-border text-muted hover:border-danger/30')}>
                {c.emoji} {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={save} loading={pending}>{tr('moneyCards.saveControls')}</Button>
      </div>
    </div>
  );
}

function windowShort(w: string): string {
  return SPEND_WINDOWS.find((x) => x.value === w)?.label.replace('Per ', '/ ').toLowerCase() ?? '';
}
