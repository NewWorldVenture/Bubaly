'use client';

import { useEffect, useState } from 'react';
import { ShoppingCart, Plus, Trash2, Sparkles, ListPlus } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import type { Tables } from '@/lib/database.types';

type Item = Tables<'grocery_items'>;

/** Monday→Sunday of the current week as ISO dates. */
function weekRange(): { from: string; to: string } {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now); monday.setDate(now.getDate() - day); monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

export function GroceryModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [listId, setListId] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [genBusy, setGenBusy] = useState(false);

  // Ensure an active grocery list exists.
  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data } = await supabase.from('grocery_lists').select('*')
        .eq('family_id', familyId).eq('is_archived', false).order('created_at').limit(1);
      setListId(data?.[0]?.id ?? null);
      setListLoading(false);
    })();
  }, [familyId]);

  const { data: items, loading, error, refresh } = useRealtimeQuery<Item>({
    table: 'grocery_items',
    familyId,
    deps: [familyId, listId],
    fetcher: (supabase) =>
      listId
        ? supabase.from('grocery_items').select('*').eq('list_id', listId).order('is_checked').order('created_at')
        : Promise.resolve({ data: [], error: null }),
  });

  async function createList() {
    const supabase = createClient();
    const { data, error } = await supabase.from('grocery_lists')
      .insert({ family_id: familyId, name: 'Groceries', created_by: userId }).select('id').single();
    if (error || !data) return toastError(error?.message ?? 'Could not create list');
    setListId(data.id);
  }

  async function addItem(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!listId) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim();
    const quantity = String(fd.get('quantity') ?? '').trim() || null;
    if (!name) return;
    setAdding(true);
    const supabase = createClient();
    const { error } = await supabase.from('grocery_items').insert({ family_id: familyId, list_id: listId, name, quantity, created_by: userId });
    setAdding(false);
    if (error) return toastError(error.message);
    form.reset();
    void refresh();
  }

  async function toggle(item: Item) {
    const supabase = createClient();
    await supabase.from('grocery_items').update({ is_checked: !item.is_checked }).eq('id', item.id);
    void refresh();
  }

  async function remove(id: string) {
    const supabase = createClient();
    await supabase.from('grocery_items').delete().eq('id', id);
    void refresh();
  }

  async function clearChecked() {
    if (!listId) return;
    const supabase = createClient();
    await supabase.from('grocery_items').delete().eq('list_id', listId).eq('is_checked', true);
    success('Cleared checked items');
    void refresh();
  }

  async function generateFromMeals() {
    if (!listId) return;
    setGenBusy(true);
    const supabase = createClient();
    const { from, to } = weekRange();
    const { error } = await supabase.rpc('grocery_from_meal_plan', { p_family_id: familyId, p_from: from, p_to: to, p_list_id: listId });
    setGenBusy(false);
    if (error) return toastError(error.message);
    success('Added ingredients from this week’s meals');
    void refresh();
  }

  if (listLoading) return <LoadingBlock />;

  if (!listId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Grocery" description="Shared, real-time shopping lists." />
        <EmptyState icon={ShoppingCart} title="No grocery list yet" description="Create your family’s shared list."
          action={<Button onClick={createList}><ListPlus className="h-4 w-4" /> Create list</Button>} />
      </div>
    );
  }

  const unchecked = items.filter((i) => !i.is_checked);
  const checked = items.filter((i) => i.is_checked);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Grocery"
        description={`${unchecked.length} to buy · ${checked.length} in cart`}
        action={
          <>
            <Button variant="secondary" loading={genBusy} onClick={generateFromMeals}>
              <Sparkles className="h-4 w-4" /> From meals
            </Button>
            {checked.length > 0 && <Button variant="ghost" onClick={clearChecked}>Clear cart</Button>}
          </>
        }
      />

      <Card>
        <form onSubmit={addItem} className="mb-4 flex flex-col gap-2 sm:flex-row">
          <Input name="name" placeholder="Add an item…" className="flex-1" required />
          <Input name="quantity" placeholder="Qty (2 lbs)" className="sm:w-36" />
          <Button type="submit" loading={adding}><Plus className="h-4 w-4" /> Add</Button>
        </form>

        {loading ? (
          <LoadingBlock />
        ) : error ? (
          <ErrorState message={error} onRetry={refresh} />
        ) : items.length === 0 ? (
          <EmptyState icon={ShoppingCart} title="List is empty" description="Add items above, or pull them from this week’s meal plan." />
        ) : (
          <div className="space-y-1">
            {unchecked.map((i) => (
              <Row key={i.id} item={i} onToggle={() => toggle(i)} onRemove={() => remove(i.id)} />
            ))}
            {checked.length > 0 && (
              <>
                <p className="px-1 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-muted">In cart</p>
                {checked.map((i) => (
                  <Row key={i.id} item={i} onToggle={() => toggle(i)} onRemove={() => remove(i.id)} />
                ))}
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ item, onToggle, onRemove }: { item: Item; onToggle: () => void; onRemove: () => void }) {
  return (
    <div className="group flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-elevated">
      <button
        onClick={onToggle}
        aria-label={item.is_checked ? 'Mark as needed' : 'Mark as bought'}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition ${item.is_checked ? 'border-success bg-success text-white' : 'border-border'}`}
      >
        {item.is_checked && <span className="text-xs">✓</span>}
      </button>
      <span className={`flex-1 text-sm ${item.is_checked ? 'text-muted line-through' : ''}`}>
        {item.name}{item.quantity ? <span className="ml-2 text-xs text-muted">{item.quantity}</span> : null}
      </span>
      <button onClick={onRemove} className="rounded-lg p-1.5 text-muted opacity-0 transition group-hover:opacity-100 hover:text-danger" aria-label="Remove">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
