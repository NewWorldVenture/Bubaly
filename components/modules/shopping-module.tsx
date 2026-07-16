'use client';

// Multi-store shopping lists built on existing grocery_lists + grocery_items tables
import { useEffect, useMemo, useState } from 'react';
import {
  ShoppingBag, Plus, Trash2, Check, Search, X, ChevronDown, ChevronUp,
  ShoppingCart, Pencil, Archive, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type GroceryList = Tables<'grocery_lists'>;
type GroceryItem = Tables<'grocery_items'>;

const STORE_PRESETS = [
  { name: 'Grocery', icon: 'ðŸ›’', color: '#7c5dfa', store: null },
  { name: 'Costco', icon: 'ðŸª', color: '#e63c30', store: 'costco' },
  { name: 'Walmart', icon: 'ðŸŸ¡', color: '#0071dc', store: 'walmart' },
  { name: 'Target', icon: 'ðŸŽ¯', color: '#cc0000', store: 'target' },
  { name: 'Whole Foods', icon: 'ðŸŒ¿', color: '#00674b', store: 'whole_foods' },
  { name: 'Amazon Fresh', icon: 'ðŸ“¦', color: '#ff9900', store: 'amazon_fresh' },
  { name: 'Trader Joe\'s', icon: 'ðŸŒº', color: '#d4001a', store: 'trader_joes' },
  { name: 'Custom', icon: 'ðŸ“', color: '#6b7280', store: null },
] as const;

const CATEGORIES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Pantry', 'Beverages', 'Frozen', 'Household', 'Personal Care', 'Baby', 'Pet', 'Other'];

export function ShoppingModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const { run, isPending } = useAction({ onError: (e) => toastError(describeDbError(e)) });

  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [newListOpen, setNewListOpen] = useState(false);
  const [addingText, setAddingText] = useState('');
  const [addingCategory, setAddingCategory] = useState('Other');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingList, setEditingList] = useState<GroceryList | null>(null);

  const { data: lists, loading: listsLoading, error: listsError, refresh: refreshLists } = useRealtimeQuery<GroceryList>({
    table: 'grocery_lists', familyId, deps: [familyId],
    fetcher: (sb) =>
      sb.from('grocery_lists').select('*').eq('family_id', familyId).is('archived_at', null)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
  });

  const { data: items, loading: itemsLoading, error: itemsError, refresh: refreshItems } = useRealtimeQuery<GroceryItem>({
    table: 'grocery_items', familyId, deps: [familyId, activeListId],
    fetcher: (sb) => {
      if (!activeListId) return Promise.resolve({ data: [], error: null });
      return sb.from('grocery_items').select('*').eq('list_id', activeListId)
        .order('is_checked', { ascending: true }).order('category').order('created_at');
    },
  });

  // Auto-select first list
  useEffect(() => {
    if (lists.length > 0 && !activeListId) {
      setActiveListId(lists[0].id);
    }
  }, [lists, activeListId]);

  const activeList = lists.find((l) => l.id === activeListId);
  const error = listsError || itemsError;
  const refresh = () => { void refreshLists(); void refreshItems(); };

  const filtered = useMemo(() =>
    items.filter((i) => !search || i.name.toLowerCase().includes(search.toLowerCase())),
    [items, search]);

  const byCategory = useMemo(() => {
    const map = new Map<string, GroceryItem[]>();
    for (const cat of CATEGORIES) map.set(cat, []);
    for (const item of filtered) {
      const cat = item.category ?? 'Other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(item);
    }
    return [...map.entries()].filter(([, items]) => items.length > 0);
  }, [filtered]);

  const checkedCount = items.filter((i) => i.is_checked).length;
  const totalCount = items.length;

  function addItem(e: React.FormEvent) {
    e.preventDefault();
    const name = addingText.trim();
    if (!name || !activeListId) return;
    if (name.length > 120) { toastError('Item name is too long (max 120 characters)'); return; }
    return run('add-item', async () => {
      const { error } = await createClient().from('grocery_items').insert({
        family_id: familyId, list_id: activeListId, name, category: addingCategory, created_by: userId,
      });
      if (error) throw error;
      setAddingText('');
      void refreshItems();
    });
  }

  function toggleItem(item: GroceryItem) {
    return run(`toggle:${item.id}`, async () => {
      const { error } = await createClient().from('grocery_items').update({ is_checked: !item.is_checked }).eq('id', item.id);
      if (error) throw error;
      void refreshItems();
    });
  }

  function deleteItem(id: string) {
    return run(`delete:${id}`, async () => {
      const { error } = await createClient().from('grocery_items').delete().eq('id', id);
      if (error) throw error;
      void refreshItems();
    });
  }

  function clearChecked() {
    return run('clear-checked', async () => {
      const checkedIds = items.filter((i) => i.is_checked).map((i) => i.id);
      if (!checkedIds.length) return;
      const { error } = await createClient().from('grocery_items').delete().in('id', checkedIds);
      if (error) throw error;
      success(`Cleared ${checkedIds.length} completed items`);
      void refreshItems();
    });
  }

  function archiveList(id: string) {
    return run(`archive:${id}`, async () => {
      const { error } = await createClient().from('grocery_lists').update({ archived_at: new Date().toISOString() } as never).eq('id', id);
      if (error) throw error;
      success('List archived');
      setActiveListId(lists.find((l) => l.id !== id)?.id ?? null);
      void refreshLists();
    });
  }

  function toggleCollapse(cat: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  if (listsLoading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load shopping lists. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="module-with-sidebar">
      {/* â”€â”€ List sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex w-full flex-col lg:w-56 xl:w-64 flex-shrink-0">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold">My Lists</h2>
          <button onClick={() => setNewListOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-brand/15 text-brand-text hover:bg-brand/25 transition">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="space-y-1">
          {lists.map((list) => {
            const isActive = list.id === activeListId;
            const listItems = /* approximate */ items.filter((i) => i.list_id === list.id);
            return (
              <button key={list.id} onClick={() => setActiveListId(list.id)}
                className={cn(
                  'group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition',
                  isActive ? 'bg-brand/15 text-brand-text' : 'hover:bg-elevated/40 text-muted',
                )}>
                <span className="text-lg">{(list as Record<string, unknown>).list_icon as string ?? 'ðŸ›’'}</span>
                <div className="flex-1 min-w-0">
                  <p className={cn('truncate text-sm font-medium', isActive && 'text-brand-text font-bold')}>{list.name}</p>
                  <p className="text-[10px]">{activeListId === list.id ? `${totalCount} items` : ''}</p>
                </div>
                {isActive && (
                  <button onClick={(e) => { e.stopPropagation(); setEditingList(list); }}
                    className="opacity-0 group-hover:opacity-100 rounded p-1 hover:bg-black/10">
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </button>
            );
          })}
          <button onClick={() => setNewListOpen(true)}
            className="flex w-full items-center gap-2 rounded-xl border-2 border-dashed border-border px-3 py-2 text-sm text-muted hover:border-brand/40 hover:text-brand-text transition">
            <Plus className="h-3.5 w-3.5" /> New list
          </button>
        </div>
      </div>

      {/* â”€â”€ Main shopping list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="module-main">
        {!activeList ? (
          <EmptyState icon={ShoppingBag} title="No lists yet"
            description="Create a shopping list for any store."
            action={<Button onClick={() => setNewListOpen(true)}><Plus className="h-4 w-4" /> Create List</Button>} />
        ) : (
          <>
            {/* List header */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{(activeList as Record<string, unknown>).list_icon as string ?? 'ðŸ›’'}</span>
                <h2 className="text-xl font-bold">{activeList.name}</h2>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <AiInsight kind="shopping" />
                {checkedCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearChecked} disabled={isPending('clear-checked')}>
                    <Check className="h-3.5 w-3.5 text-success" /> Clear {checkedCount} done
                  </Button>
                )}
                <div className="flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-1.5">
                  <Search className="h-3.5 w-3.5 text-muted" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Searchâ€¦"
                    className="w-28 bg-transparent text-sm placeholder:text-muted outline-none" />
                  {search && <button onClick={() => setSearch('')}><X className="h-3.5 w-3.5 text-muted" /></button>}
                </div>
              </div>
            </div>

            {/* Progress bar */}
            {totalCount > 0 && (
              <div className="flex items-center gap-3">
                <div className="flex-1 overflow-hidden rounded-full bg-elevated h-2">
                  <div className="h-full rounded-full bg-success transition-all duration-500"
                    style={{ width: `${(checkedCount / totalCount) * 100}%` }} />
                </div>
                <span className="text-xs text-muted">{checkedCount}/{totalCount}</span>
              </div>
            )}

            {/* Items by category */}
            {itemsLoading ? <SkeletonList /> : byCategory.length === 0 ? (
              <EmptyState icon={ShoppingCart} title="List is empty"
                description="Add items below to get started." />
            ) : (
              <div className="space-y-3">
                {byCategory.map(([cat, catItems]) => {
                  const isCollapsed = collapsed.has(cat);
                  const catChecked = catItems.filter((i) => i.is_checked).length;
                  return (
                    <div key={cat} className="overflow-hidden rounded-2xl border border-border">
                      <button onClick={() => toggleCollapse(cat)}
                        className="flex w-full items-center gap-3 bg-surface/40 px-4 py-2.5 text-left hover:bg-elevated/30 transition">
                        <span className="text-sm font-semibold">{cat}</span>
                        <span className="text-xs text-muted">{catItems.length} item{catItems.length !== 1 ? 's' : ''}</span>
                        {catChecked > 0 && <Badge tone="success">{catChecked} done</Badge>}
                        <div className="ml-auto">
                          {isCollapsed ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronUp className="h-4 w-4 text-muted" />}
                        </div>
                      </button>
                      {!isCollapsed && (
                        <div className="divide-y divide-border/40">
                          {catItems.map((item) => (
                            <div key={item.id}
                              className={cn('group flex items-center gap-3 px-4 py-2.5 hover:bg-elevated/20 transition',
                                item.is_checked && 'opacity-60')}>
                              <button onClick={() => toggleItem(item)} disabled={isPending(`toggle:${item.id}`)} aria-label={item.is_checked ? 'Uncheck item' : 'Check item'}
                                className={cn('flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2 transition disabled:opacity-60',
                                  item.is_checked ? 'border-success bg-success' : 'border-border hover:border-success/50')}>
                                {isPending(`toggle:${item.id}`) ? <Loader2 className="h-3 w-3 animate-spin text-muted" /> : item.is_checked && <Check className="h-3 w-3 text-fg" />}
                              </button>
                              <span className={cn('flex-1 text-sm', item.is_checked && 'line-through text-muted')}>
                                {item.name}
                              </span>
                              {item.quantity && (
                                <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand-text">
                                  {item.quantity}
                                </span>
                              )}
                              {(item as Record<string, unknown>).note ? (
                                <span className="text-xs text-muted">{String((item as Record<string, unknown>).note)}</span>
                              ) : null}
                              <button onClick={() => deleteItem(item.id)} disabled={isPending(`delete:${item.id}`)} aria-label="Delete item"
                                className="rounded p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:text-danger disabled:opacity-50">
                                {isPending(`delete:${item.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Quick add */}
            <form onSubmit={addItem} className="flex items-center gap-2">
              <select value={addingCategory} onChange={(e) => setAddingCategory(e.target.value)}
                className="rounded-xl border border-border bg-surface/60 px-2 py-2 text-xs text-muted focus:outline-none">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input value={addingText} onChange={(e) => setAddingText(e.target.value)}
                placeholder="+ Add itemâ€¦"
                className="flex-1 rounded-xl border border-dashed border-border bg-transparent px-4 py-2 text-sm placeholder:text-muted focus:border-brand/50 focus:outline-none transition" />
              {addingText && <Button type="submit" size="sm" disabled={isPending('add-item')}>Add</Button>}
            </form>
          </>
        )}
      </div>

      {/* New list modal */}
      {newListOpen && (
        <NewListModal familyId={familyId} userId={userId}
          onClose={() => setNewListOpen(false)}
          onCreated={(id) => { setActiveListId(id); setNewListOpen(false); void refreshLists(); }} />
      )}

      {/* Edit list modal */}
      {editingList && (
        <EditListModal list={editingList}
          onClose={() => setEditingList(null)}
          onSaved={() => { setEditingList(null); void refreshLists(); }}
          onArchive={() => { archiveList(editingList.id); setEditingList(null); }} />
      )}
    </div>
  );
}

function NewListModal({ familyId, userId, onClose, onCreated }: {
  familyId: string; userId: string;
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('ðŸ›’');
  const [preset, setPreset] = useState<typeof STORE_PRESETS[number]>(STORE_PRESETS[0]);

  function selectPreset(p: typeof STORE_PRESETS[number]) {
    setPreset(p);
    setName(p.name);
    setIcon(p.icon);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const trimmed = name.trim();
    if (!trimmed) { toastError('Give your list a name'); return; }
    if (trimmed.length > 80) { toastError('List name is too long (max 80 characters)'); return; }
    if (!familyId) { toastError('No active family â€” reload and try again.'); return; }
    setLoading(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from('grocery_lists').insert({
        family_id: familyId, name: trimmed, created_by: userId,
        list_icon: icon, store: preset.store,
      } as never).select('id').single();
      if (error || !data) { toastError(describeDbError(error)); return; }
      onCreated(data.id);
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="New Shopping List">
      <form onSubmit={create} className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium">Quick start from store</label>
          <div className="grid grid-cols-4 gap-2">
            {STORE_PRESETS.map((p) => (
              <button key={p.name} type="button" onClick={() => selectPreset(p)}
                className={cn('flex flex-col items-center gap-1 rounded-xl border p-2 text-xs transition',
                  preset.name === p.name ? 'border-brand/60 bg-brand/10' : 'border-border hover:bg-elevated')}>
                <span className="text-2xl">{p.icon}</span>
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <Field label="List name" required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Grocery List, Costco Runâ€¦" autoFocus />}
        </Field>
        <Field label="Icon">
          {() => (
            <div className="flex flex-wrap gap-2">
              {['ðŸ›’', 'ðŸª', 'ðŸŽ¯', 'ðŸ“¦', 'ðŸŒ¿', 'ðŸŒº', 'ðŸ ', 'ðŸ•', 'ðŸ’Š', 'ðŸ¾'].map((e) => (
                <button key={e} type="button" onClick={() => setIcon(e)}
                  className={cn('rounded-xl p-2 text-xl hover:bg-elevated transition', icon === e && 'bg-brand/15 ring-2 ring-brand/40')}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create List</Button>
        </div>
      </form>
    </Modal>
  );
}

function EditListModal({ list, onClose, onSaved, onArchive }: {
  list: GroceryList; onClose: () => void; onSaved: () => void; onArchive: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(list.name);
  const [icon, setIcon] = useState((list as Record<string, unknown>).list_icon as string ?? 'ðŸ›’');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const trimmed = name.trim();
    if (!trimmed) { toastError('Give your list a name'); return; }
    if (trimmed.length > 80) { toastError('List name is too long (max 80 characters)'); return; }
    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from('grocery_lists').update({ name: trimmed, list_icon: icon } as never).eq('id', list.id);
      if (error) { toastError(describeDbError(error)); return; }
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit List">
      <form onSubmit={save} className="space-y-4">
        <Field label="List name">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label="Icon">
          {() => (
            <div className="flex flex-wrap gap-2">
              {['ðŸ›’', 'ðŸª', 'ðŸŽ¯', 'ðŸ“¦', 'ðŸŒ¿', 'ðŸŒº', 'ðŸ ', 'ðŸ•', 'ðŸ’Š', 'ðŸ¾'].map((e) => (
                <button key={e} type="button" onClick={() => setIcon(e)}
                  className={cn('rounded-xl p-2 text-xl hover:bg-elevated transition', icon === e && 'bg-brand/15 ring-2 ring-brand/40')}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </Field>
        <div className="flex items-center justify-between pt-2">
          <Button type="button" variant="ghost" onClick={onArchive}>
            <Archive className="h-4 w-4" /> Archive
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading}>Save</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
