'use client';

// Wallet → Gifts → Pay-ID. Parents claim a short, memorable handle that resolves
// at /pay/<handle> to a child's gift link, so relatives don't copy long tokens.
import { useState } from 'react';
import { AtSign, Copy, Check, Trash2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useRouter } from 'next/navigation';
import { normalizeHandle, handleError, payHandleUrl } from '@/lib/wallet/pay-handle';
import { claimPayHandleAction, releasePayHandleAction } from '@/app/(app)/wallet/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type PayHandleRow = { id: string; handle: string; childWalletId: string | null; childName: string | null };
export type PayHandleChild = { id: string; name: string };

export function PayHandleManager({ handles, childOptions, canManage, baseUrl }: {
  handles: PayHandleRow[]; childOptions: PayHandleChild[]; canManage: boolean; baseUrl: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [target, setTarget] = useState<string>(''); // '' = family-level
  const [handle, setHandle] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const normalized = normalizeHandle(handle);
  const err = handle ? handleError(handle) : null;
  const canSubmit = !!normalized && !err && !saving;

  async function claim() {
    if (!canSubmit) return;
    setSaving(true);
    const res = await claimPayHandleAction({ childWalletId: target || null, handle: normalized });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not claim that Pay-ID');
    success(`Pay-ID @${normalized} is yours`);
    setHandle(''); setTarget('');
    router.refresh();
  }

  async function copy(h: string) {
    const url = payHandleUrl(baseUrl, h);
    try { await navigator.clipboard.writeText(url); setCopied(h); setTimeout(() => setCopied(null), 1500); }
    catch { toastError('Could not copy'); }
  }

  async function release(id: string) {
    if (typeof window !== 'undefined' && !window.confirm('Release this Pay-ID? The link will stop working.')) return;
    const res = await releasePayHandleAction({ id });
    if (!res.ok) return toastError(res.error ?? 'Could not release');
    success('Pay-ID released');
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="mb-1 flex items-center gap-2">
        <AtSign className="h-4 w-4 text-brand-text" />
        <h3 className="font-semibold">Pay-ID</h3>
      </div>
      <p className="mb-3 text-xs text-muted">{t('payHandleManager.aShortMemorableLinkRelativesCan')}</p>

      {handles.length > 0 && (
        <div className="mb-3 space-y-2">
          {handles.map((h) => (
            <div key={h.id} className="flex items-center justify-between gap-2 rounded-xl border border-border bg-bg/40 p-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{baseUrl.replace(/^https?:\/\//, '')}/pay/{h.handle}</p>
                <p className="text-xs text-muted">→ {h.childName ?? 'Whole family'}</p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <button type="button" onClick={() => copy(h.handle)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs hover:bg-elevated">
                  {copied === h.handle ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                {canManage && (
                  <button type="button" onClick={() => release(h.id)}
                    className="inline-flex items-center rounded-lg border border-border px-2 py-1.5 text-xs text-muted hover:bg-elevated hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {canManage && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-stretch gap-2">
            <select value={target} onChange={(e) => setTarget(e.target.value)}
              className="h-10 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">
              <option value="">{t('payHandleManager.wholeFamily')}</option>
              {childOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="flex min-w-[160px] flex-1 items-center rounded-lg border border-border bg-bg px-2">
              <span className="text-muted">@</span>
              <input
                value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="mia"
                maxLength={20} className="h-10 w-full bg-transparent px-1 text-sm outline-none"
              />
            </div>
            <Button onClick={claim} loading={saving} disabled={!canSubmit}>
              <Plus className="mr-1 h-4 w-4" /> {t('payHandleManager.claim')}
            </Button>
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
          {!err && normalized && (
            <p className="text-xs text-muted">{baseUrl.replace(/^https?:\/\//, '')}/pay/<span className="font-medium text-fg">{normalized}</span></p>
          )}
        </div>
      )}
    </div>
  );
}
