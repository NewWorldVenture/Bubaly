'use client';

import { useMemo, useState } from 'react';
import {
  Package, Plus, Trash2, Edit2, AlertTriangle, Clock, ShoppingCart,
  PackageCheck, Minus, Boxes,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { adjustPantryQuantityAction, removePantryItemAction, savePantryItemAction } from '@/app/(app)/dashboard/pantry/actions';
import { addGroceryItemsAction } from '@/app/(app)/dashboard/grocery/actions';
import { describeGroceryAdd, groceryAddWasNoOp } from '@/lib/groceries/add-summary';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import {
  PANTRY_LOCATIONS, locationMeta, expiryStatus, isLowStock, expiringSoon,
  lowStockItems, groupByLocation, pantrySummary, type PantryLocation,
} from '@/lib/pantry/logic';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type PantryItem = Tables<'pantry_items'>;

const CATEGORIES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Pantry', 'Frozen', 'Beverages', 'Household', 'Other'];

const TONE_CLASS: Record<string, string> = {
  danger: 'danger', warning: 'warning', caution: 'warning', success: 'success', neutral: 'neutral',
};

export function PantryModule() {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PantryItem | null>(null);

  const { data: items, loading, error, refresh } = useRealtimeQuery<PantryItem>({
    table: 'pantry_items', familyId, deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('pantry_items').select('*').eq('family_id', familyId)
        .order('expires_at', { ascending: true, nullsFirst: false }).order('name'),
  });

  const summary = useMemo(() => pantrySummary(items), [items]);
  const expiring = useMemo(() => expiringSoon(items, 5), [items]);
  const low = useMemo(() => lowStockItems(items), [items]);
  const groups = useMemo(() => groupByLocation(items), [items]);

  async function adjustQty(item: PantryItem, delta: number) {
    // The DELTA, not a total computed here. `next` used to come from what this
    // page last rendered, so two people unpacking the shopping and each tapping
    // +1 both read the same number and both wrote the same number.
    const res = await adjustPantryQuantityAction(item.id, delta);
    if (!res.ok) return toastError(res.error);
    void refresh();
  }

  async function removeItem(id: string) {
    const supabase = createClient();
    const res = await removePantryItemAction(id);
    if (!res.ok) return toastError(res.error);
    success('Removed');
    void refresh();
  }

  // Add a set of items to the family's grocery list.
  //
  // The find-the-list-or-create-one dance this used to do in the browser is
  // `ensureDefaultList`, which the service calls when no list id is given — the
  // exact fork the service layer exists to remove. Restocking is also where the
  // duplicate bites hardest: the low-stock items are the staples most likely to
  // be on the list already.
  async function addToGrocery(rows: PantryItem[]) {
    if (rows.length === 0) return;
    const result = await addGroceryItemsAction({
      items: rows.map((r) => ({
        name: r.name,
        quantity: r.unit ? `${r.low_threshold ?? 1} ${r.unit}` : null,
        category: r.category ?? 'Pantry',
      })),
    });
    if (!result.ok) return toastError(result.error);
    if (groceryAddWasNoOp(result)) return toastError(describeGroceryAdd(result));
    success(describeGroceryAdd(result));
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title={t('pantry.pantryInventory')}
        description="Track what's in your pantry, fridge, and freezer — never buy doubles or let food expire."
        action={<div className="flex items-center gap-2"><AiInsight kind="pantry" iconOnly /><Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> {t('pantry.addItem')}</Button></div>}
      />

      {/* Stats */}
      <div className="grid-stats">
        {[
          { label: 'Items tracked', value: summary.total, icon: '📦', color: 'text-brand-text' },
          { label: 'Expiring soon', value: summary.expiringSoon, icon: '⏳', color: 'text-warning' },
          { label: 'Expired', value: summary.expired, icon: '⚠️', color: 'text-danger' },
          { label: 'Running low', value: summary.lowStock, icon: '🛒', color: 'text-amber-400' },
        ].map((s) => (
          <div key={s.label} className="stat-card">
            <span className="text-2xl">{s.icon}</span>
            <div>
              <div className={cn('text-xl font-bold', s.color)}>{s.value}</div>
              <div className="text-[11px] text-muted">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Expiring soon alert */}
      {expiring.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Clock className="h-4 w-4 text-warning" /> {t('pantry.useItSoon')}
            </h2>
            <Button size="sm" variant="outline" onClick={() => addToGrocery(expiring)}>
              <ShoppingCart className="h-4 w-4" /> {t('pantry.restockAll')}
            </Button>
          </div>
          <ul className="space-y-2">
            {expiring.map((item) => {
              const st = expiryStatus(item.expires_at);
              return (
                <li key={item.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                  <span className="text-lg">{locationMeta(item.location).emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <Badge tone={TONE_CLASS[st.tone] as 'warning'}>{st.label}</Badge>
                  </div>
                  <button onClick={() => removeItem(item.id)} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-elevated hover:text-success" title={t('pantry.usedItUp')}>
                    <PackageCheck className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Running low */}
      {low.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <AlertTriangle className="h-4 w-4 text-amber-400" /> {t('pantry.runningLow')}
            </h2>
            <Button size="sm" variant="outline" onClick={() => addToGrocery(low)}>
              <ShoppingCart className="h-4 w-4" /> {t('pantry.addAllToGroceryList')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {low.map((item) => (
              <span key={item.id} className="flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-xs font-medium">
                {item.name} <span className="text-muted">· {Number(item.quantity)}{item.unit ? ` ${item.unit}` : ''}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Inventory by location */}
      {items.length === 0 ? (
        <EmptyState icon={Boxes} title={t('pantry.yourPantryIsEmpty')}
          description="Add the food and household items you keep on hand to track quantities and expiration dates."
          action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> {t('pantry.addYourFirstItem')}</Button>} />
      ) : (
        groups.map(({ location, items: rows }) => (
          <Card key={location}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <span>{locationMeta(location).emoji}</span> {locationMeta(location).label}
              </h2>
              <Badge tone="neutral">{rows.length}</Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {rows.map((item) => {
                const st = expiryStatus(item.expires_at);
                const lowS = isLowStock(item);
                return (
                  <div key={item.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                    <Package className="h-4 w-4 shrink-0 text-brand-text" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.name}
                        {item.is_staple && <span className="ml-1.5 text-[10px] text-muted">staple</span>}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        {item.category && <span className="text-[11px] text-muted">{item.category}</span>}
                        {item.expires_at && <Badge tone={TONE_CLASS[st.tone] as 'neutral'}>{st.label}</Badge>}
                        {lowS && <Badge tone="warning">Low</Badge>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => adjustQty(item, -1)} className="rounded-md p-1 text-muted hover:bg-elevated hover:text-fg" aria-label={t('pantry.decrease')}><Minus className="h-3.5 w-3.5" /></button>
                      <span className="w-10 text-center text-sm font-semibold tabular-nums">{Number(item.quantity)}{item.unit ? <span className="text-[10px] text-muted"> {item.unit}</span> : ''}</span>
                      <button onClick={() => adjustQty(item, 1)} className="rounded-md p-1 text-muted hover:bg-elevated hover:text-fg" aria-label={t('pantry.increase')}><Plus className="h-3.5 w-3.5" /></button>
                    </div>
                    <button onClick={() => { setEditing(item); setOpen(true); }} className="rounded-lg p-1.5 text-muted hover:text-brand-text" aria-label={t('pantry.edit')}><Edit2 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => removeItem(item.id)} className="rounded-lg p-1.5 text-muted hover:text-danger" aria-label={t('pantry.remove')}><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                );
              })}
            </div>
          </Card>
        ))
      )}

      {open && (
        <PantryItemModal
          item={editing} familyId={familyId} userId={userId}
          onClose={() => { setOpen(false); setEditing(null); }}
          onSaved={() => { setOpen(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function PantryItemModal({ item, familyId, userId, onClose, onSaved }: {
  item: PantryItem | null; familyId: string; userId: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [isStaple, setIsStaple] = useState(item?.is_staple ?? false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) return toastError('Name is required');
    const payload = {
      name,
      category: String(form.get('category') ?? '').trim() || null,
      location: String(form.get('location') ?? 'pantry') as PantryLocation,
      quantity: Number(form.get('quantity') ?? 1),
      unit: String(form.get('unit') ?? '').trim() || null,
      low_threshold: form.get('low_threshold') ? Number(form.get('low_threshold')) : null,
      expires_at: String(form.get('expires_at') ?? '') || null,
      is_staple: isStaple,
      notes: String(form.get('notes') ?? '').trim() || null,
    };
    setLoading(true);
    // `savePantryItem`, not `pantryAdjust`: the latter carries only quantity,
    // unit, location and expiry, so it would drop the category, threshold,
    // staple flag and notes this form sets.
    const res = await savePantryItemAction(item?.id ?? null, {
      name: payload.name,
      category: payload.category,
      location: payload.location,
      quantity: payload.quantity,
      unit: payload.unit,
      lowThreshold: payload.low_threshold,
      expiresAt: payload.expires_at,
      isStaple: payload.is_staple,
      notes: payload.notes,
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error);
    success(item ? 'Updated' : 'Item added');
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={item ? 'Edit item' : 'Add pantry item'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t('pantry.itemName')} required>
          {(id) => <Input id={id} name="name" defaultValue={item?.name ?? ''} placeholder={t('pantry.oliveOilEggsPaperTowels')} autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('pantry.location')}>
            {(id) => (
              <Select id={id} name="location" defaultValue={item?.location ?? 'pantry'}>
                {PANTRY_LOCATIONS.map((l) => <option key={l.id} value={l.id}>{l.emoji} {l.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('pantry.category')}>
            {(id) => (
              <Select id={id} name="category" defaultValue={item?.category ?? 'Pantry'}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('pantry.quantity')}>{(id) => <Input id={id} name="quantity" type="number" inputMode="decimal" min={0} step="any" defaultValue={item?.quantity ?? 1} />}</Field>
          <Field label={t('pantry.unit')}>{(id) => <Input id={id} name="unit" defaultValue={item?.unit ?? ''} placeholder={t('pantry.cansLbs')} />}</Field>
          <Field label={t('pantry.lowAt')} hint="Restock threshold">{(id) => <Input id={id} name="low_threshold" type="number" inputMode="decimal" min={0} step="any" defaultValue={item?.low_threshold ?? ''} placeholder="1" />}</Field>
        </div>
        <Field label={t('pantry.expirationDate')} hint="Leave blank for non-perishables">
          {(id) => <Input id={id} name="expires_at" type="date" defaultValue={item?.expires_at ?? ''} />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isStaple} onChange={(e) => setIsStaple(e.target.checked)} className="h-4 w-4 rounded border-border" />
          {t('pantry.stapleAlwaysKeepThisStocked')}
        </label>
        <Field label={t('pantry.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={item?.notes ?? ''} placeholder={t('pantry.brandWhereToBuy')} className="min-h-[50px]" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{t('pantry.cancel')}</Button>
          <Button type="submit" loading={loading}>{item ? 'Save' : 'Add item'}</Button>
        </div>
      </form>
    </Modal>
  );
}
