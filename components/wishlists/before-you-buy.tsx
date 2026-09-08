'use client';

// "Before you buy" — the panel that answers a purchase from the family's own
// records (M17). The verdict on screen is DETERMINISTIC: it comes from the pure
// advisor over inventory, home equipment, the closet, remembered preferences
// and the budget, so it renders identically with no AI key configured. The
// optional "market ideas" button below it is the only part that needs a model,
// and it is grounded in this same result.
//
// Honesty: a failed read renders a retryable error, never a calm "nothing
// found" — see adviseBeforeBuying, which fails closed.

import { useCallback, useEffect, useState } from 'react';
import { ShoppingCart, PackageCheck, Plug, Heart, Wallet, ListChecks, ShieldCheck } from 'lucide-react';
import { adviseBeforeBuying, type BeforeYouBuyResult } from '@/app/(app)/dashboard/wishlists/actions';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ErrorState, Spinner } from '@/components/ui/states';
import { useTranslations } from '@/components/i18n/locale-provider';
import { cn } from '@/lib/utils/cn';
import type { AdviceReason, OwnedMatch, OwnedSource, PurchaseVerdict } from '@/lib/purchases/advisor';

const usd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);

const VERDICT_STYLES: Record<PurchaseVerdict, string> = {
  clear: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  tight: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  conflict: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
};

const VERDICT_KEYS: Record<PurchaseVerdict, string> = {
  clear: 'beforeYouBuy.nothingInTheWay',
  tight: 'beforeYouBuy.worthASecondLook',
  conflict: 'beforeYouBuy.thisNeedsADecision',
};

const REASON_KEYS: Record<AdviceReason, string> = {
  over_budget: 'beforeYouBuy.thisWouldTakeTheBudget',
  owned_duplicate: 'beforeYouBuy.youAlreadyOwnSomethingThat',
  already_purchased: 'beforeYouBuy.someoneHasAlreadyBoughtThis',
  budget_tight: 'beforeYouBuy.itFitsButWouldLeave',
  no_budget: 'beforeYouBuy.noBudgetCoversThisSo',
  clear: 'beforeYouBuy.nothingYouOwnOrSaved',
};

const SOURCE_KEYS: Record<OwnedSource, string> = {
  inventory: 'beforeYouBuy.homeInventory',
  home_asset: 'beforeYouBuy.homeEquipment',
  wardrobe: 'beforeYouBuy.closet',
};

/**
 * A matched row that is not simply sitting where it belongs says so. "You
 * already own one" reads very differently when the one you own is lent out, in
 * for repair or in the wash, and leaving the status off makes the panel sound
 * more certain than the row is. Statuses that mean the family no longer has the
 * thing at all (disposed, lost, donated, outgrown) never reach here — the
 * advisor drops those rows before matching.
 */
const STATUS_KEYS: Record<string, string> = {
  lent: 'beforeYouBuy.lentOut',
  in_repair: 'beforeYouBuy.beingRepaired',
  laundry: 'beforeYouBuy.inTheWash',
  storage: 'beforeYouBuy.inStorage',
};

type Props = {
  /** What the family is thinking of buying. */
  text: string;
  priceDollars?: number | null;
  url?: string | null;
  /**
   * The wish this panel hangs off, when it hangs off one. It is excluded from
   * the wish-list check: a wish always matches its own title, and reporting the
   * card you are looking at back to you is a finding with nothing behind it.
   */
  wishId?: string | null;
  /** Compact trigger for a card footer. */
  className?: string;
};

export function BeforeYouBuy({ text, priceDollars, url, wishId, className }: Props) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BeforeYouBuyResult | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setResult(
        await adviseBeforeBuying({
          text,
          priceDollars: priceDollars ?? null,
          url: url ?? null,
          excludeWishId: wishId ?? null,
        }),
      );
    } catch (err) {
      console.error('[purchase-advisor] advice request failed', err);
      setResult({ ok: false, error: t('beforeYouBuy.couldNotCheckThisPurchase') });
    } finally {
      setLoading(false);
    }
  }, [text, priceDollars, url, wishId, t]);

  useEffect(() => {
    if (open && !result && !loading) void run();
  }, [open, result, loading, run]);

  const answered = result && result.ok ? result : null;
  const advice = answered?.advice ?? null;
  const budgetRestricted = answered?.budgetRestricted ?? false;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn('h-7 gap-1 text-xs', className)}
        onClick={() => setOpen(true)}
      >
        <ShoppingCart className="h-3.5 w-3.5" /> {t('beforeYouBuy.beforeYouBuy')}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('beforeYouBuy.beforeYouBuy')}
        description={t('beforeYouBuy.checkedAgainstWhatYouAlready')}
      >
        <div className="space-y-4">
          <p className="text-sm font-semibold text-fg">{text}</p>

          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> {t('beforeYouBuy.checkingWhatYouAlreadyOwn')}
            </div>
          )}

          {!loading && result && !result.ok && (
            <ErrorState message={result.error} onRetry={() => void run()} />
          )}

          {!loading && advice && (
            <div className="space-y-4">
              <div className={cn('rounded-2xl border p-3', VERDICT_STYLES[advice.verdict])}>
                <div className="text-xs font-semibold uppercase tracking-wide">{t(VERDICT_KEYS[advice.verdict])}</div>
                <p className="mt-1 text-sm text-fg">
                  {t(REASON_KEYS[advice.reason], { category: advice.budget?.category ?? '' })}
                </p>
              </div>

              {advice.duplicates.length > 0 && (
                <Section icon={PackageCheck} title={t('beforeYouBuy.youAlreadyOwn')}>
                  {advice.duplicates.map((match) => (
                    <MatchRow
                      key={`${match.source}-${match.id}`}
                      match={match}
                      sourceLabel={t(SOURCE_KEYS[match.source])}
                      statusLabel={match.status && STATUS_KEYS[match.status] ? t(STATUS_KEYS[match.status]) : null}
                    />
                  ))}
                </Section>
              )}

              {advice.compatibility.length > 0 && (
                <Section icon={Plug} title={t('beforeYouBuy.checkItFitsWhatYou')}>
                  {advice.compatibility.map((match) => (
                    <MatchRow
                      key={`${match.source}-${match.id}`}
                      match={match}
                      sourceLabel={t(SOURCE_KEYS[match.source])}
                      statusLabel={match.status && STATUS_KEYS[match.status] ? t(STATUS_KEYS[match.status]) : null}
                    />
                  ))}
                </Section>
              )}

              {advice.preferences.length > 0 && (
                <Section icon={Heart} title={t('beforeYouBuy.whatYouToldUs')}>
                  {advice.preferences.map((pref) => (
                    <div key={pref.id} className="rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
                      <span className="font-medium text-fg">{pref.label}</span>
                      <span className="text-muted"> — {pref.value}</span>
                    </div>
                  ))}
                </Section>
              )}

              {advice.alreadyOnList.length > 0 && (
                <Section icon={ListChecks} title={t('beforeYouBuy.alreadyOnAWishList')}>
                  {advice.alreadyOnList.map((wish) => (
                    <div key={wish.id} className="rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
                      <span className="font-medium text-fg">{wish.title}</span>
                      {wish.purchased && <span className="text-muted"> — {t('beforeYouBuy.alreadyBought')}</span>}
                    </div>
                  ))}
                </Section>
              )}

              <Section icon={Wallet} title={t('beforeYouBuy.budget')}>
                {budgetRestricted ? (
                  <p className="text-sm text-muted">{t('beforeYouBuy.theHouseholdBudgetIsPrivate')}</p>
                ) : !advice.budget ? (
                  <p className="text-sm text-muted">{t('beforeYouBuy.addAPriceToCheck')}</p>
                ) : advice.budget.unbudgeted ? (
                  <p className="text-sm text-muted">
                    {t('beforeYouBuy.noBudgetCoversThisPurchase', { amount: usd(advice.priceCents ?? 0) })}
                  </p>
                ) : (
                  <p className="text-sm text-muted">
                    {t('beforeYouBuy.spentOfLimitUsedLeftAfter', {
                      category: advice.budget.category,
                      spent: usd(advice.budget.spentCents),
                      limit: usd(advice.budget.limitCents),
                      remaining: usd(advice.budget.remainingAfterCents),
                    })}
                  </p>
                )}
              </Section>

              <p className="flex items-start gap-1.5 text-xs text-muted">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                {t('beforeYouBuy.nothingHereIsSponsoredNo')}
              </p>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <AiInsight
                  kind="purchase_advisor"
                  label={t('beforeYouBuy.marketIdeas')}
                  params={{ item: text, priceCents: advice.priceCents ?? null, wishId: wishId ?? null }}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => void run()}>
                  {t('beforeYouBuy.checkAgain')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <Icon className="h-3.5 w-3.5" /> {title}
      </div>
      {children}
    </div>
  );
}

function MatchRow({ match, sourceLabel, statusLabel }: { match: OwnedMatch; sourceLabel: string; statusLabel: string | null }) {
  const spec = [match.brand, match.model].filter(Boolean).join(' ');
  return (
    <div className="rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
      <div className="font-medium text-fg">{match.name}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
        <span>{sourceLabel}</span>
        {spec && <span>· {spec}</span>}
        {match.detail && <span>· {match.detail}</span>}
        {statusLabel && <span>· {statusLabel}</span>}
      </div>
    </div>
  );
}
