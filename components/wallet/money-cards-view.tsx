'use client';

// Wallet → Cards. Frictionless card management for kids — virtual + physical.
// Three modes: (A) provider not configured → explicit unavailable state, (B) setup
// needed → guided 3-step onboarding wizard, (C) live → manage per-child cards
// with instant freeze, spend controls, and physical-card ordering.
import { useState, useEffect } from 'react';
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
import { formatCents } from '@/lib/wallet/ledger';
import {
  SPEND_WINDOWS, BLOCKABLE_CATEGORIES, type SpendWindow,
} from '@/lib/wallet/card-controls';
import {
  startConnectOnboardingAction, issueCardAction, setCardFrozenAction, updateCardControlsAction,
} from '@/app/(app)/money/actions';
import { CardRevealModal } from '@/components/wallet/card-reveal-modal';
import { useTranslations } from '@/components/i18n/locale-provider';

export type CardChild = { id: string; name: string; color: string | null };
export type IssuedCard = {
  id: string; childWalletId: string; type: 'virtual' | 'physical';
  status: string; last4: string | null; brand: string | null; isFrozen: boolean;
  spendLimitCents: number | null; spendWindow: string; blockedCategories: string[];
};
type Caps = { connectOnboarding: boolean; issuing: boolean; physicalCards: boolean };

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
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [orderingCard, setOrderingCard] = useState<CardChild | null>(null);
  const [revealing, setRevealing] = useState<{ cardId: string; childName: string } | null>(null);
  const [issueType, setIssueType] = useState<'virtual' | 'physical'>('virtual');

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

  async function startSetup() {
    setBusy('setup');
    const res = await startConnectOnboardingAction();
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    if (res.data?.url) window.location.href = res.data.url;
  }

  async function issueVirtual(childWalletId: string) {
    setBusy(`issue-${childWalletId}`);
    const res = await issueCardAction({ childWalletId, type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization' });
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success('Virtual card created!');
    router.refresh();
  }

  async function issueAllVirtual() {
    setBusy('issue-all');
    for (const child of childrenWithoutCards) {
      await issueCardAction({ childWalletId: child.id, type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization' });
    }
    setBusy(null);
    success(`Issued ${childrenWithoutCards.length} virtual card${childrenWithoutCards.length !== 1 ? 's' : ''}!`);
    router.refresh();
  }

  async function toggleFreeze(card: IssuedCard) {
    setBusy(`freeze-${card.id}`);
    const res = await setCardFrozenAction({ cardId: card.id, frozen: !card.isFrozen });
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success(card.isFrozen ? 'Card unfrozen' : 'Card frozen');
    router.refresh();
  }

  // ── Mode A: card provider is not configured → explicit unavailable state ──
  if (!capabilities.connectOnboarding && !capabilities.issuing) {
    return (
      <div>
        <WalletSubnav />
        <PageHeader title={tr('moneyCards.cards')} description="Spending cards are not enabled for this family yet." />
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
        <PageHeader title={tr('moneyCards.cards')} description="Set up safe spending cards for your kids in 3 quick steps." />

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
                  <Button onClick={startSetup} loading={busy === 'setup'} size="lg">
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
      <PageHeader title={tr('moneyCards.cards')} description="Kid-safe spending cards — each purchase checks the Spend balance in real time." />

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
                ? `${childrenWithoutCards[0].name} doesn't have a card yet.`
                : `${childrenWithoutCards.length} children don't have cards yet.`}
            </p>
          </div>
          <Button size="sm" onClick={issueAllVirtual} loading={busy === 'issue-all'}>
            {tr('moneyCards.issueAll')}
          </Button>
        </div>
      )}

      {childWallets.length === 0 ? (
        <EmptyState icon={CreditCard} title={tr('moneyCards.noChildWallets')} description="Add child members to issue cards." />
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
                        disabled={busy === `issue-${child.id}`}
                        className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated disabled:opacity-60 transition"
                      >
                        {busy === `issue-${child.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                        Virtual
                      </button>
                      {capabilities.physicalCards && (
                        <button
                          type="button" onClick={() => { setOrderingCard(child); setIssueType('physical'); }}
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
                        busy={busy} expanded={expanded}
                        onFreeze={() => toggleFreeze(card)}
                        onReveal={() => setRevealing({ cardId: card.id, childName: child.name })}
                        onToggleControls={() => setExpanded(expanded === card.id ? null : card.id)}
                        onSaved={() => { setExpanded(null); router.refresh(); }}
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
          child={orderingCard}
          onClose={() => setOrderingCard(null)}
          onIssued={() => { setOrderingCard(null); router.refresh(); }}
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

function CardRow({ card, canManage, busy, expanded, onFreeze, onReveal, onToggleControls, onSaved }: {
  card: IssuedCard; canManage: boolean; busy: string | null; expanded: string | null;
  onFreeze: () => void; onReveal: () => void; onToggleControls: () => void; onSaved: () => void;
}) {
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
            <button type="button" onClick={onFreeze} disabled={busy === `freeze-${card.id}`}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated disabled:opacity-60 transition">
              {busy === `freeze-${card.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Snowflake className="h-3.5 w-3.5" />}
              {card.isFrozen ? 'Unfreeze' : 'Freeze'}
            </button>
          </div>
        )}
      </div>
      {canManage && expanded === card.id && (
        <CardControlsEditor card={card} onSaved={onSaved} />
      )}
    </div>
  );
}

// ─── Physical Card Order Modal ────────────────────────────────────────────────

function PhysicalCardModal({ child, onClose, onIssued }: {
  child: CardChild; onClose: () => void; onIssued: () => void;
}) {
  const t = useTranslations();
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [limitDollars, setLimitDollars] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const spendLimitCents = limitDollars.trim() ? Math.round(parseFloat(limitDollars) * 100) : null;
    const res = await issueCardAction({
      childWalletId: child.id, type: 'physical',
      spendLimitCents: spendLimitCents && spendLimitCents > 0 ? spendLimitCents : null,
      spendWindow: 'daily',
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not order card');
    success(`Physical card ordered for ${child.name}!`);
    onIssued();
  }

  return (
    <Modal open title={`Order physical card — ${child.name}`} onClose={onClose}>
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
              <span className="text-muted">$</span>
              <Input id={id} type="number" min="1" step="1" value={limitDollars}
                onChange={(e) => setLimitDollars(e.target.value)} placeholder={t('moneyCardsView.noLimit')} />
            </div>
          )}
        </Field>

        <p className="text-xs text-muted">
          {tr('moneyCards.thePhysicalCardWillBeRegistered')} {child.name}{tr('moneyCards.aposSCardholderProfileYouCan')}
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('moneyCards.cancel')}</Button>
          <Button type="submit" loading={loading}>
            <Package className="h-4 w-4" /> {tr('moneyCards.orderCard')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Card Controls Editor ─────────────────────────────────────────────────────

function CardControlsEditor({ card, onSaved }: { card: IssuedCard; onSaved: () => void }) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [limitDollars, setLimitDollars] = useState(card.spendLimitCents != null ? String(card.spendLimitCents / 100) : '');
  const [windowVal, setWindowVal] = useState<SpendWindow>((card.spendWindow as SpendWindow) ?? 'per_authorization');
  const [blocked, setBlocked] = useState<string[]>(card.blockedCategories);
  const [saving, setSaving] = useState(false);

  function toggleCat(value: string) {
    setBlocked((b) => (b.includes(value) ? b.filter((x) => x !== value) : [...b, value]));
  }

  async function save() {
    setSaving(true);
    const trimmed = limitDollars.trim();
    const spendLimitCents = trimmed === '' ? null : Math.round(Number(trimmed) * 100);
    if (spendLimitCents != null && (!Number.isFinite(spendLimitCents) || spendLimitCents <= 0)) {
      setSaving(false);
      return toastError('Enter a valid limit, or leave it blank for no limit.');
    }
    const res = await updateCardControlsAction({ cardId: card.id, spendLimitCents, spendWindow: windowVal, blockedCategories: blocked });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save controls.');
    success('Controls saved');
    onSaved();
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{tr('moneyCards.spendLimitBlankNoLimit')}</span>
          <div className="flex items-center gap-1">
            <span className="text-muted">$</span>
            <input
              type="number" min="0" step="1" inputMode="decimal" value={limitDollars}
              onChange={(e) => setLimitDollars(e.target.value)} placeholder={tr('moneyCards.noLimit')}
              className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm focus-ring"
            />
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
        <Button onClick={save} loading={saving}>{tr('moneyCards.saveControls')}</Button>
      </div>
    </div>
  );
}

function windowShort(w: string): string {
  return SPEND_WINDOWS.find((x) => x.value === w)?.label.replace('Per ', '/ ').toLowerCase() ?? '';
}
