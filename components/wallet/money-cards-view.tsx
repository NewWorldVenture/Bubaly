'use client';

// Wallet → Cards. Consumer-facing card management. Capability-aware: it renders
// the real-money setup + card tools only when Stripe mode is available for this
// family, and otherwise shows a friendly "your wallet works today" state. Per
// spec, NO technical jargon (Treasury/Issuing/Connect/webhook) appears here.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, ShieldCheck, Snowflake, Sparkles, Loader2, SlidersHorizontal } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { formatCents } from '@/lib/wallet/ledger';
import {
  SPEND_WINDOWS, BLOCKABLE_CATEGORIES, type SpendWindow,
} from '@/lib/wallet/card-controls';
import {
  startConnectOnboardingAction, issueCardAction, setCardFrozenAction, updateCardControlsAction,
} from '@/app/(app)/money/actions';

export type CardChild = { id: string; name: string; color: string | null };
export type IssuedCard = {
  id: string; childWalletId: string; type: 'virtual' | 'physical';
  status: string; last4: string | null; brand: string | null; isFrozen: boolean;
  spendLimitCents: number | null; spendWindow: string; blockedCategories: string[];
};
type Caps = { connectOnboarding: boolean; issuing: boolean; physicalCards: boolean };

export function MoneyCardsView({
  capabilities, accountReady, onboardingStarted, childWallets, cards, canManage,
}: {
  capabilities: Caps; accountReady: boolean; onboardingStarted: boolean;
  childWallets: CardChild[]; cards: IssuedCard[]; canManage: boolean;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const cardsByChild = new Map<string, IssuedCard[]>();
  for (const c of cards) {
    const list = cardsByChild.get(c.childWalletId) ?? [];
    list.push(c); cardsByChild.set(c.childWalletId, list);
  }

  async function startSetup() {
    setBusy('setup');
    const res = await startConnectOnboardingAction();
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    if (res.data?.url) window.location.href = res.data.url;
  }

  async function issue(childWalletId: string) {
    setBusy(`issue-${childWalletId}`);
    const res = await issueCardAction({ childWalletId, type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization' });
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success('Card created');
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

  // ── Mode A: real-money cards not available for this family → friendly state ──
  if (!capabilities.connectOnboarding && !capabilities.issuing) {
    return (
      <div>
        <WalletSubnav />
        <PageHeader title="Cards" description="Give kids a safe way to spend — coming to your family soon." />
        <div className="mt-4 rounded-2xl border border-border bg-surface/40 p-6">
          <EmptyState
            icon={CreditCard}
            title="Spending cards are on the way"
            description="Your Family Wallet already tracks allowances, gifts, savings goals and chore rewards today. Kid-safe spending cards will appear here when they're ready for your family — no action needed."
          />
        </div>
      </div>
    );
  }

  // ── Mode B: available, but parent hasn't finished setup ──
  if (!accountReady) {
    return (
      <div>
        <WalletSubnav />
        <PageHeader title="Cards" description="Set up safe spending cards for your kids." />
        <div className="mt-4 rounded-2xl border border-border bg-surface/40 p-6 text-center">
          <Sparkles className="mx-auto h-10 w-10 text-brand" />
          <h3 className="mt-3 text-lg font-semibold">Give your kids a safe way to spend</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Each purchase is checked against their Spend balance in real time, so they can never overspend.
            You can freeze a card any time. A quick, secure setup verifies your identity first.
          </p>
          {canManage ? (
            <Button className="mt-4" onClick={startSetup} loading={busy === 'setup'}>
              {onboardingStarted ? 'Finish setup' : 'Set up cards'}
            </Button>
          ) : (
            <p className="mt-4 text-sm text-muted">Ask a parent to set this up.</p>
          )}
        </div>
      </div>
    );
  }

  // ── Mode C: ready → manage per-child cards ──
  return (
    <div>
      <WalletSubnav />
      <PageHeader title="Cards" description="Safe spending cards — purchases check the child's Spend balance in real time." />
      {childWallets.length === 0 ? (
        <EmptyState icon={CreditCard} title="No child wallets yet" description="Add child members to issue cards." />
      ) : (
        <div className="mt-4 space-y-4">
          {childWallets.map((child) => {
            const childCards = cardsByChild.get(child.id) ?? [];
            return (
              <div key={child.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={child.name} color={child.color ?? undefined} size={36} className="rounded-full" />
                    <p className="font-semibold">{child.name}</p>
                  </div>
                  {canManage && (
                    <Button variant="secondary" onClick={() => issue(child.id)} loading={busy === `issue-${child.id}`}>
                      Add card
                    </Button>
                  )}
                </div>
                {childCards.length === 0 ? (
                  <p className="text-sm text-muted">No card yet.</p>
                ) : (
                  <div className="space-y-2">
                    {childCards.map((card) => (
                      <div key={card.id} className="rounded-xl border border-border bg-bg/40 p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <CreditCard className={`h-5 w-5 ${card.isFrozen ? 'text-muted' : 'text-brand'}`} />
                            <div>
                              <p className="text-sm font-medium">
                                {card.brand ?? 'Card'} •••• {card.last4 ?? '----'}
                                {card.type === 'physical' && <span className="ml-1 text-xs text-muted">(physical)</span>}
                              </p>
                              <p className="text-xs text-muted flex items-center gap-1">
                                {card.isFrozen
                                  ? <><Snowflake className="h-3 w-3" /> Frozen</>
                                  : <><ShieldCheck className="h-3 w-3 text-success" /> Active</>}
                                {card.spendLimitCents != null && (
                                  <span className="ml-1">· {formatCents(card.spendLimitCents)} {windowShort(card.spendWindow)}</span>
                                )}
                                {card.blockedCategories.length > 0 && <span className="ml-1">· {card.blockedCategories.length} blocked</span>}
                              </p>
                            </div>
                          </div>
                          {canManage && (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button" onClick={() => setExpanded(expanded === card.id ? null : card.id)}
                                className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated"
                              >
                                <SlidersHorizontal className="h-3.5 w-3.5" /> Controls
                              </button>
                              <button
                                type="button" onClick={() => toggleFreeze(card)} disabled={busy === `freeze-${card.id}`}
                                className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-elevated disabled:opacity-60"
                              >
                                {busy === `freeze-${card.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Snowflake className="h-3.5 w-3.5" />}
                                {card.isFrozen ? 'Unfreeze' : 'Freeze'}
                              </button>
                            </div>
                          )}
                        </div>
                        {canManage && expanded === card.id && (
                          <CardControlsEditor card={card} onSaved={() => { setExpanded(null); router.refresh(); }} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function windowShort(w: string): string {
  return SPEND_WINDOWS.find((x) => x.value === w)?.label.replace('Per ', '/ ').toLowerCase() ?? '';
}

// Per-card spending controls editor: a limit + window + blocked-category toggles.
// Mirrors to Stripe (limit/window) and our auth webhook (blocked categories).
function CardControlsEditor({ card, onSaved }: { card: IssuedCard; onSaved: () => void }) {
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
    success('Spending controls saved');
    onSaved();
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Spend limit (leave blank for none)</span>
          <div className="flex items-center gap-1">
            <span className="text-muted">$</span>
            <input
              type="number" min="0" step="1" inputMode="decimal" value={limitDollars}
              onChange={(e) => setLimitDollars(e.target.value)} placeholder="No limit"
              className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm focus-ring"
            />
          </div>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Resets</span>
          <select
            value={windowVal} onChange={(e) => setWindowVal(e.target.value as SpendWindow)}
            className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm focus-ring"
          >
            {SPEND_WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </label>
      </div>

      <div>
        <span className="mb-1.5 block text-xs font-medium text-muted">Block these categories</span>
        <div className="flex flex-wrap gap-1.5">
          {BLOCKABLE_CATEGORIES.map((c) => {
            const on = blocked.includes(c.value);
            return (
              <button
                key={c.value} type="button" onClick={() => toggleCat(c.value)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${on ? 'border-danger/40 bg-danger/10 text-danger' : 'border-border text-muted hover:border-danger/30'}`}
              >
                {c.emoji} {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={save} loading={saving}>Save controls</Button>
      </div>
    </div>
  );
}
