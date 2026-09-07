'use client';

// Gift management — create shareable gift links per child and approve the gifts
// relatives send. Approving credits the child's wallet (gift_received) via the
// immutable ledger. 100% Supabase-wired through the wallet server actions.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Gift, Plus, Copy, Check, X, Link2, QrCode as QrIcon } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { QrCode } from '@/components/ui/qr-code';
import { useToast } from '@/components/ui/toast';
import { formatCents } from '@/lib/wallet/ledger';
import { occasionLabel, parseSuggestedAmounts, giftPath, GIFT_OCCASIONS } from '@/lib/wallet/gift';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { createGiftLinkAction, approveGiftAction, dismissGiftAction } from '@/app/(app)/wallet/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type GiftLinkRow = { id: string; token: string; occasion: string | null; isActive: boolean; childName: string | null };
export type PendingGift = { id: string; giverName: string | null; amountCents: number; message: string | null; occasion: string | null; childName: string | null };
export type ChildOpt = { id: string; name: string };

export function GiftView({ links, pending, childOptions, canManage }: {
  links: GiftLinkRow[]; pending: PendingGift[]; childOptions: ChildOpt[]; canManage: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [creating, setCreating] = useState(false);

  async function approve(g: PendingGift) {
    const res = await approveGiftAction({ giftPaymentId: g.id });
    if (!res.ok) return toastError(res.error ?? 'Could not approve');
    success(`Added ${formatCents(g.amountCents)} to ${g.childName ?? 'the wallet'}`);
    router.refresh();
  }
  async function dismiss(g: PendingGift) {
    const res = await dismissGiftAction({ giftPaymentId: g.id });
    if (!res.ok) return toastError(res.error ?? 'Could not dismiss');
    success('Gift declined');
    router.refresh();
  }

  return (
    <div className="module-page">
      <PageHeader title={t('gift.familyWallet')} description="Let grandparents and relatives gift with a simple link."
        action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {t('gift.newGiftLink')}</Button> : undefined} />
      <WalletSubnav />

      {/* Pending gifts to approve */}
      {pending.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2.5 text-xs font-bold uppercase tracking-widest text-brand-text">{t('gift.giftsToApprove')}</h2>
          <div className="space-y-2">
            {pending.map((g) => (
              <div key={g.id} className="flex items-center gap-3 rounded-2xl border border-brand/20 bg-brand/5 p-4">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-lg">🎁</div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{formatCents(g.amountCents)} from {g.giverName ?? 'someone'}</p>
                  <p className="truncate text-xs text-muted">for {g.childName ?? 'your child'}{g.message ? ` · “${g.message}”` : ''}</p>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => approve(g)} className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90"><Check className="h-3.5 w-3.5" />{' '}{t('giftView.approve')}</button>
                    <button onClick={() => dismiss(g)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger" aria-label={t('giftView.decline')}><X className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gift links */}
      <h2 className="mb-2.5 text-xs font-bold uppercase tracking-widest text-muted">{t('gift.giftLinks')}</h2>
      {links.length === 0 ? (
        <EmptyState icon={Gift} title={t('gift.noGiftLinksYet')}
          description="Create a link and share it with grandparents — they can gift in seconds."
          action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {t('gift.newGiftLink')}</Button> : undefined} />
      ) : (
        <div className="space-y-2">
          {links.map((l) => <GiftLinkCard key={l.id} link={l} />)}
        </div>
      )}

      {creating && <CreateLinkModal childOptions={childOptions} onClose={() => setCreating(false)} />}
    </div>
  );
}

function GiftLinkCard({ link }: { link: GiftLinkRow }) {
  const t = useTranslations();
  const { success } = useToast();
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const url = typeof window !== 'undefined' ? `${window.location.origin}${giftPath(link.token)}` : giftPath(link.token);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true); success('Link copied');
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  return (
    <>
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-surface text-muted"><Link2 className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{link.childName ?? 'Child'} · {occasionLabel(link.occasion)}</p>
          <p className="truncate text-xs text-muted">{giftPath(link.token)}{link.isActive ? '' : ' · inactive'}</p>
        </div>
        <button onClick={() => setShowQr(true)} aria-label={t('gift.showQrCode')}
          className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-brand/40 hover:text-brand-text transition">
          <QrIcon className="h-3.5 w-3.5" /> <span className="hidden sm:inline">QR</span>
        </button>
        <button onClick={copy} className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-brand/40 hover:text-brand-text transition">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {showQr && (
        <Modal open title={t('gift.scanToGift')} onClose={() => setShowQr(false)}>
          <div className="flex flex-col items-center gap-4">
            <p className="text-center text-sm text-muted">
              {link.childName ?? 'Child'} · {occasionLabel(link.occasion)}{t('gift.pointAPhoneCameraAtThis')}
            </p>
            <div className="rounded-2xl bg-white p-4">
              <QrCode value={url} size={220} />
            </div>
            <p className="break-all text-center text-[11px] text-muted">{url}</p>
            <button onClick={copy} className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand/90 transition">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function CreateLinkModal({ childOptions, onClose }: { childOptions: ChildOpt[]; onClose: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [childId, setChildId] = useState(childOptions[0]?.id ?? '');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!childId) return toastError('Pick a child.');
    const form = new FormData(e.currentTarget);
    setLoading(true);
    const res = await createGiftLinkAction({
      childWalletId: childId,
      occasion: String(form.get('occasion') || '') || null,
      message: String(form.get('message') || '').trim() || null,
      suggestedCents: parseSuggestedAmounts(String(form.get('suggested') || '')),
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not create link');
    success('Gift link created');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={t('gift.newGiftLink')}>
      <form onSubmit={submit} className="space-y-4">
        {childOptions.length === 0 ? (
          <p className="text-sm text-muted">{t('gift.activateTheFamilyWalletAndAdd')}</p>
        ) : (
          <>
            <Field label={t('gift.forWhichChild')}>{(id) => (
              <select id={id} value={childId} onChange={(e) => setChildId(e.target.value)} className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
                {childOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}</Field>
            <Field label={t('gift.occasion')}>{(id) => (
              <select id={id} name="occasion" className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
                <option value="">{t('giftView.none')}</option>
                {GIFT_OCCASIONS.map((o) => <option key={o} value={o}>{occasionLabel(o)}</option>)}
              </select>
            )}</Field>
            <Field label={t('gift.suggestedAmountsUsdCommaSeparated')}>{(id) => <Input id={id} name="suggested" placeholder="25, 50, 100" defaultValue="25, 50, 100" />}</Field>
            <Field label={t('gift.messageToShareOptional')}>{(id) => <Input id={id} name="message" placeholder={t('giftView.helpMiaReachHerBike')} />}</Field>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> {t('gift.cancel')}</Button>
          <Button type="submit" loading={loading} disabled={childOptions.length === 0}>{t('gift.createLink')}</Button>
        </div>
      </form>
    </Modal>
  );
}
