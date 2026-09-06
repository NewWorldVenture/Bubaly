'use client';

import { useState, useTransition } from 'react';
import { Pencil, Trash2, Plus, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { REWARD_KINDS, REWARD_KIND_LABELS } from '@/lib/marketing/loyalty';
import { saveRewardAction, deleteRewardAction } from './actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type Reward = {
  id: string; name: string; description: string | null; cost_points: number; kind: string;
  value_cents: number | null; image_url: string | null; stock: number | null; is_active: boolean; sort: number;
};

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

function RewardForm({ reward, onDone }: { reward?: Reward; onDone: () => void }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  return (
    <form
      action={(fd) => start(async () => { await saveRewardAction(fd); onDone(); })}
      className="grid gap-3 rounded-xl border border-border bg-elevated/40 p-3 sm:grid-cols-2"
    >
      {reward && <input type="hidden" name="id" value={reward.id} />}
      <label className="space-y-1 sm:col-span-2"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.rewardName')}</span><input name="name" required defaultValue={reward?.name ?? ''} className={inputCls} placeholder={t('adminMarketingLoyaltyRewardEditor.eG10AccountCredit')} /></label>
      <label className="space-y-1 sm:col-span-2"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.description')}</span><input name="description" defaultValue={reward?.description ?? ''} className={inputCls} /></label>
      <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.costPoints')}</span><input type="number" min="0" name="cost_points" required defaultValue={reward?.cost_points ?? 0} className={inputCls} /></label>
      <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.kind')}</span>
        <select name="kind" defaultValue={reward?.kind ?? 'credit'} className={inputCls}>
          {REWARD_KINDS.map((k) => <option key={k} value={k}>{REWARD_KIND_LABELS[k]}</option>)}
        </select>
      </label>
      <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.valueCentsOptional')}</span><input type="number" min="0" name="value_cents" defaultValue={reward?.value_cents ?? ''} className={inputCls} placeholder={t('adminMarketingLoyaltyRewardEditor.eG100010')} /></label>
      <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.stockBlankUnlimited')}</span><input type="number" min="0" name="stock" defaultValue={reward?.stock ?? ''} className={inputCls} /></label>
      <label className="space-y-1 sm:col-span-2"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.imageUrlOptional')}</span><input name="image_url" defaultValue={reward?.image_url ?? ''} className={inputCls} /></label>
      <label className="space-y-1"><span className="block text-xs font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.sortOrder')}</span><input type="number" name="sort" defaultValue={reward?.sort ?? 0} className={inputCls} /></label>
      <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={reward?.is_active ?? true} className="h-4 w-4 rounded border-border" /> {t('adminMarketingLoyaltyRewardEditor.active')}</label>
      <div className="flex items-center gap-2 sm:col-span-2">
        <button disabled={pending} className="inline-flex h-10 items-center gap-1 rounded-xl bg-brand px-4 text-sm font-medium text-brand-fg disabled:opacity-60">{pending && <Loader2 className="h-4 w-4 animate-spin" />} {t('adminMarketingLoyaltyRewardEditor.saveReward')}</button>
        <button type="button" onClick={onDone} className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-muted">{t('adminMarketingLoyaltyRewardEditor.cancel')}</button>
      </div>
    </form>
  );
}

export function RewardRow({ reward }: { reward: Reward }) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  if (editing) return <RewardForm reward={reward} onDone={() => setEditing(false)} />;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold">{reward.name}</p>
          <Badge tone="brand">{reward.cost_points.toLocaleString()} pts</Badge>
          {!reward.is_active && <Badge tone="neutral">{t('adminMarketingLoyaltyRewardEditor.inactive')}</Badge>}
        </div>
        {reward.description && <p className="mt-0.5 text-sm text-muted">{reward.description}</p>}
        <p className="mt-1 text-xs text-muted">{REWARD_KIND_LABELS[reward.kind] ?? reward.kind}{reward.stock != null ? ` · ${reward.stock} in stock` : ' · unlimited'}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs">
        <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /> {t('adminMarketingLoyaltyRewardEditor.edit')}</button>
        <button onClick={() => start(async () => { await deleteRewardAction(reward.id); })} disabled={pending} className="inline-flex items-center gap-1 text-muted hover:text-danger">{pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}</button>
      </div>
    </div>
  );
}

export function AddReward() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  if (open) return <RewardForm onDone={() => setOpen(false)} />;
  return (
    <button onClick={() => setOpen(true)} className="inline-flex h-10 items-center gap-1 rounded-xl border border-dashed border-border px-4 text-sm font-medium text-muted hover:text-fg">
      <Plus className="h-4 w-4" /> {t('adminMarketingLoyaltyRewardEditor.addReward')}
    </button>
  );
}
