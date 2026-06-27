'use client';

import { useMemo, useState } from 'react';
import {
  Package, Plus, Trash2, Edit2, AlertTriangle, Clock, ShoppingCart,
  PackageCheck, Minus, Boxes,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
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

type PantryItem = Tables<'pantry_items'>;

const CATEGORIES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Pantry', 'Frozen', 'Beverages', 'Household', 'Other'];

const TONE_CLASS: Record<string, string> = {
  danger: 'danger', warning: 'warning', caution: 'warning', success: 'success', neutral: 'neutral',
};

export function PantryModule() {
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
    const next = Math.max(0, Number(item.quantity) + delta);
    const supabase = createClient();
    const { error } = await supabase.from('pantry_items').update({ quantity: next }).eq('id', item.id);
    if (error) return toastError(describeDbError(error));
    void refresh();
  }

  async function removeItem(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('pantry_items').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Removed');
    void refresh();
  }

  // Add a set of items to the family's grocery list (creating one if needed).
  async function addToGrocery(rows: PantryItem[]) {
    if (rows.length === 0) return;
    const supabase = createClient();
    let { data: list } = await supabase.from('grocery_lists').select('id')
      .eq('family_id', familyId).eq('is_archived', false).order('created_at').limit(1).maybeSingle();
    if (!list) {
      const { data: created, error } = await supabase.from('grocery_lists')
        .insert({ family_id: familyId, name: 'Groceries', created_by: userId }).select('id').single();
      if (error || !created) return toastError(describeDbError(error, 'Could not create a grocery list'));
      list = created;
    }
    const items = rows.map((r) => ({
      family_id: familyId, list_id: list!.id, name: r.name,
      quantity: r.unit ? `${r.low_threshold ?? 1} ${r.unit}` : null,
      category: r.category ?? 'Pantry', created_by: userId,
    }));
    const { error } = await supabase.from('grocery_items').insert(items);
    if (error) return toastError(describeDbError(error));
    success(`Added ${items.length} item${items.length > 1 ? 's' : ''} to your grocery list`);
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title="Pantry & Inventory"
        description="Track what's in your pantry, fridge, and freezer — never buy doubles or let food expire."
        action={<div className="flex items-center gap-2"><AiInsight kind="pantry" iconOnly /><Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> Add item</Button></div>}
      />

      {/* Stats */}
      <div className="grid-stats">
        {[
          { label: 'Items tracked', value: summary.total, icon: '📦', color: 'text-brand' },
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
              <Clock className="h-4 w-4 text-warning" /> Use it soon
            </h2>
            <Button size="sm" variant="outline" onClick={() => addToGrocery(expiring)}>
              <ShoppingCart className="h-4 w-4" /> Restock all
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
                  <button onClick={() => removeItem(item.id)} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-elevated hover:text-success" title="Used it up">
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
              <AlertTriangle className="h-4 w-4 text-amber-400" /> Running low
            </h2>
            <Button size="sm" variant="outline" onClick={() => addToGrocery(low)}>
              <ShoppingCart className="h-4 w-4" /> Add all to grocery list
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
        <EmptyState icon={Boxes} title="Your pantry is empty"
          description="Add the food and household items you keep on hand to track quantities and expiration dates."
          action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add your first item</Button>} />
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
                    <Package className="h-4 w-4 shrink-0 text-brand" />
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
                      <button onClick={() => adjustQty(item, -1)} className="rounded-md p-1 text-muted hover:bg-elevated hover:text-fg" aria-label="Decrease"><Minus className="h-3.5 w-3.5" /></button>
                      <span className="w-10 text-center text-sm font-semibold tabular-nums">{Number(item.quantity)}{item.unit ? <span className="text-[10px] text-muted"> {item.unit}</span> : ''}</span>
                      <button onClick={() => adjustQty(item, 1)} className="rounded-md p-1 text-muted hover:bg-elevated hover:text-fg" aria-label="Increase"><Plus className="h-3.5 w-3.5" /></button>
                    </div>
                    <button onClick={() => { setEditing(item); setOpen(true); }} className="rounded-lg p-1.5 text-muted hover:text-brand" aria-label="Edit"><Edit2 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => removeItem(item.id)} className="rounded-lg p-1.5 text-muted hover:text-danger" aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
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
    const supabase = createClient();
    const { error } = item
      ? await supabase.from('pantry_items').update(payload).eq('id', item.id)
      : await supabase.from('pantry_items').insert({ ...payload, family_id: familyId, created_by: userId });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    success(item ? 'Updated' : 'Item added');
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={item ? 'Edit item' : 'Add pantry item'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Item name" required>
          {(id) => <Input id={id} name="name" defaultValue={item?.name ?? ''} placeholder="Olive oil, Eggs, Paper towels…" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Location">
            {(id) => (
              <Select id={id} name="location" defaultValue={item?.location ?? 'pantry'}>
                {PANTRY_LOCATIONS.map((l) => <option key={l.id} value={l.id}>{l.emoji} {l.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Category">
            {(id) => (
              <Select id={id} name="category" defaultValue={item?.category ?? 'Pantry'}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Quantity">{(id) => <Input id={id} name="quantity" type="number" min={0} step="any" defaultValue={item?.quantity ?? 1} />}</Field>
          <Field label="Unit">{(id) => <Input id={id} name="unit" defaultValue={item?.unit ?? ''} placeholder="cans, lbs" />}</Field>
          <Field label="Low at" hint="Restock threshold">{(id) => <Input id={id} name="low_threshold" type="number" min={0} step="any" defaultValue={item?.low_threshold ?? ''} placeholder="1" />}</Field>
        </div>
        <Field label="Expiration date" hint="Leave blank for non-perishables">
          {(id) => <Input id={id} name="expires_at" type="date" defaultValue={item?.expires_at ?? ''} />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isStaple} onChange={(e) => setIsStaple(e.target.checked)} className="h-4 w-4 rounded border-border" />
          Staple — always keep this stocked
        </label>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" defaultValue={item?.notes ?? ''} placeholder="Brand, where to buy…" className="min-h-[50px]" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{item ? 'Save' : 'Add item'}</Button>
        </div>
      </form>
    </Modal>
  );
}
