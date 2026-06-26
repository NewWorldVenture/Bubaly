'use client';

// Gift management — create shareable gift links per child and approve the gifts
// relatives send. Approving credits the child's wallet (gift_received) via the
// immutable ledger. 100% Supabase-wired through the wallet server actions.
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Gift, Plus, Copy, Check, X, Link2, QrCode, Share2, Download } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { formatCents } from '@/lib/wallet/ledger';
import { occasionLabel, parseSuggestedAmounts, giftPath, GIFT_OCCASIONS } from '@/lib/wallet/gift';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { createGiftLinkAction, approveGiftAction, dismissGiftAction } from '@/app/(app)/wallet/actions';

export type GiftLinkRow = { id: string; token: string; occasion: string | null; isActive: boolean; childName: string | null; qrDataUri: string | null };
export type PendingGift = { id: string; giverName: string | null; amountCents: number; message: string | null; occasion: string | null; childName: string | null };
export type ChildOpt = { id: string; name: string };

export function GiftView({ links, pending, childOptions, canManage }: {
  links: GiftLinkRow[]; pending: PendingGift[]; childOptions: ChildOpt[]; canManage: boolean;
}) {
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
      <PageHeader title="Family Wallet" description="Let grandparents and relatives gift with a simple link."
        action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Gift Link</Button> : undefined} />
      <WalletSubnav />

      {/* Pending gifts to approve */}
      {pending.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2.5 text-xs font-bold uppercase tracking-widest text-brand">Gifts to approve</h2>
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
                    <button onClick={() => approve(g)} className="flex items-center gap-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90"><Check className="h-3.5 w-3.5" /> Approve</button>
                    <button onClick={() => dismiss(g)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger" aria-label="Decline"><X className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gift links */}
      <h2 className="mb-2.5 text-xs font-bold uppercase tracking-widest text-muted">Gift links</h2>
      {links.length === 0 ? (
        <EmptyState icon={Gift} title="No gift links yet"
          description="Create a link and share it with grandparents — they can gift in seconds."
          action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Gift Link</Button> : undefined} />
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
  const { success } = useToast();
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const url = typeof window !== 'undefined' ? `${window.location.origin}${giftPath(link.token)}` : giftPath(link.token);
  const shareTitle = `A gift for ${link.childName ?? 'our child'}`;

  // Web Share API is only available in secure contexts on supporting browsers.
  useEffect(() => { setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true); success('Link copied');
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }

  async function share() {
    try {
      await navigator.share({ title: shareTitle, text: `${shareTitle} — gift in seconds:`, url });
    } catch { /* user cancelled or unsupported */ }
  }

  function downloadQr() {
    if (!link.qrDataUri) return;
    const a = document.createElement('a');
    a.href = link.qrDataUri;
    a.download = `gift-${link.childName ? link.childName.toLowerCase().replace(/\s+/g, '-') : link.token.slice(0, 8)}-qr.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    success('QR code downloaded');
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-surface text-muted"><Link2 className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{link.childName ?? 'Child'} · {occasionLabel(link.occasion)}</p>
          <p className="truncate text-xs text-muted">{giftPath(link.token)}{link.isActive ? '' : ' · inactive'}</p>
        </div>
        <div className="flex items-center gap-1">
          {link.qrDataUri && (
            <button onClick={() => setShowQr((v) => !v)} className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:border-brand/40 hover:text-brand transition" title="Show QR code">
              <QrCode className="h-3.5 w-3.5" />
            </button>
          )}
          {canShare && (
            <button onClick={share} className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:border-brand/40 hover:text-brand transition" title="Share link">
              <Share2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button onClick={copy} className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-brand/40 hover:text-brand transition">
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      {showQr && link.qrDataUri && (
        <div className="border-t border-border p-4 flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={link.qrDataUri} alt="Gift link QR code" width={160} height={160} className="rounded-lg" />
          <p className="text-xs text-muted text-center">Scan to open the gift page · {giftPath(link.token)}</p>
          <button onClick={downloadQr} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-brand/40 hover:text-brand transition">
            <Download className="h-3.5 w-3.5" /> Download QR
          </button>
        </div>
      )}
    </div>
  );
}

function CreateLinkModal({ childOptions, onClose }: { childOptions: ChildOpt[]; onClose: () => void }) {
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
    <Modal open onClose={onClose} title="New Gift Link">
      <form onSubmit={submit} className="space-y-4">
        {childOptions.length === 0 ? (
          <p className="text-sm text-muted">Activate the Family Wallet and add children first.</p>
        ) : (
          <>
            <Field label="For which child?">{(id) => (
              <select id={id} value={childId} onChange={(e) => setChildId(e.target.value)} className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
                {childOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}</Field>
            <Field label="Occasion">{(id) => (
              <select id={id} name="occasion" className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
                <option value="">None</option>
                {GIFT_OCCASIONS.map((o) => <option key={o} value={o}>{occasionLabel(o)}</option>)}
              </select>
            )}</Field>
            <Field label="Suggested amounts (USD, comma-separated)">{(id) => <Input id={id} name="suggested" placeholder="25, 50, 100" defaultValue="25, 50, 100" />}</Field>
            <Field label="Message to share (optional)">{(id) => <Input id={id} name="message" placeholder="Help Mia reach her bike goal!" />}</Field>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading} disabled={childOptions.length === 0}>Create Link</Button>
        </div>
      </form>
    </Modal>
  );
}
