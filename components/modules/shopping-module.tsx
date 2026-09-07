'use client';

// Multi-store shopping lists built on existing grocery_lists + grocery_items tables
import { useEffect, useMemo, useState } from 'react';
import {
  ShoppingBag, Plus, Trash2, Check, Search, X, ChevronDown, ChevronUp,
  ShoppingCart, Pencil, Archive, Loader2, Copy, ExternalLink, PackageCheck,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import {
  addGroceryItemsAction, clearCheckedGroceriesAction, recordShoppingTripAction,
  removeGroceryItemAction, setGroceryItemCheckedAction,
} from '@/app/(app)/dashboard/grocery/actions';
import { describeGroceryAdd, groceryAddWasNoOp } from '@/lib/groceries/add-summary';
import { RETAILERS, buildShoppingText, itemSearchUrl, retailerById } from '@/lib/grocery/retailers';
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
import { useTranslations } from '@/components/i18n/locale-provider';

type GroceryList = Tables<'grocery_lists'>;
type GroceryItem = Tables<'grocery_items'>;

const STORE_PRESETS = [
  { name: 'Grocery', icon: '🛒', color: '#7c5dfa', store: null },
  { name: 'Costco', icon: '🏪', color: '#e63c30', store: 'costco' },
  { name: 'Walmart', icon: '🟡', color: '#0071dc', store: 'walmart' },
  { name: 'Target', icon: '🎯', color: '#cc0000', store: 'target' },
  { name: 'Whole Foods', icon: '🌿', color: '#00674b', store: 'whole_foods' },
  { name: 'Amazon Fresh', icon: '📦', color: '#ff9900', store: 'amazon_fresh' },
  { name: 'Trader Joe\'s', icon: '🌺', color: '#d4001a', store: 'trader_joes' },
  { name: 'Custom', icon: '📝', color: '#6b7280', store: null },
] as const;

const CATEGORIES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Pantry', 'Beverages', 'Frozen', 'Household', 'Personal Care', 'Baby', 'Pet', 'Other'];

export function ShoppingModule() {
  const t = useTranslations();
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
  const [retailerId, setRetailerId] = useState<string | null>(null);
  const [boughtOpen, setBoughtOpen] = useState(false);

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

  // The hand-off is built from what is STILL TO BUY. An item already in the
  // trolley has no business in a search link or in the pasted list.
  const openItems = useMemo(() => items.filter((i) => !i.is_checked), [items]);
  const checkedItems = useMemo(() => items.filter((i) => i.is_checked), [items]);
  const checkedCount = checkedItems.length;
  const totalCount = items.length;
  const retailer = retailerId ? retailerById(retailerId) : undefined;

  /**
   * Copy-paste hand-off. Bubaly holds no retailer ordering credentials, so it
   * does not pretend to place an order: this puts the outstanding lines on the
   * clipboard for the store's own bulk-add box, and the family completes the
   * order in the retailer's cart.
   */
  function copyList() {
    return run('copy-list', async () => {
      const text = buildShoppingText(openItems.map((i) => ({ name: i.name, quantity: i.quantity })));
      if (!text) { toastError(t('shoppingModule.thereIsNothingLeftTo')); return; }
      if (!navigator?.clipboard?.writeText) { toastError(t('shoppingModule.thisBrowserWouldNotLet')); return; }
      try {
        await navigator.clipboard.writeText(text);
        success(t('shoppingModule.listCopied', { count: openItems.length }));
      } catch {
        toastError(t('shoppingModule.thisBrowserWouldNotLet'));
      }
    });
  }

  function addItem(e: React.FormEvent) {
    e.preventDefault();
    const name = addingText.trim();
    if (!name || !activeListId) return;
    if (name.length > 120) { toastError('Item name is too long (max 120 characters)'); return; }
    return run('add-item', async () => {
      // Through the service, which skips a name already on this list under
      // `normalizeName` — case, a trailing plural 's' and spacing are not
      // differences. The raw insert had no idea milk was already there.
      const result = await addGroceryItemsAction({ items: [{ name, category: addingCategory }], listId: activeListId });
      if (!result.ok) throw new Error(result.error);
      // Say which of the two happened. "Nothing visibly changed" is the outcome
      // a family reads as a bug.
      if (groceryAddWasNoOp(result)) toastError(describeGroceryAdd(result));
      setAddingText('');
      void refreshItems();
    });
  }

  function toggleItem(item: GroceryItem) {
    return run(`toggle:${item.id}`, async () => {
      const result = await setGroceryItemCheckedAction(item.id, !item.is_checked);
      if (!result.ok) throw new Error(result.error);
      void refreshItems();
    });
  }

  function deleteItem(id: string) {
    return run(`delete:${id}`, async () => {
      const result = await removeGroceryItemAction(id);
      if (!result.ok) throw new Error(result.error);
      void refreshItems();
    });
  }

  function clearChecked() {
    return run('clear-checked', async () => {
      if (!activeListId) return;
      // The LIST, not the ids this render happens to hold. Sending
      // `.in('id', checkedIds)` cleared whatever the browser last saw, so an item
      // a partner ticked on their phone between render and tap survived the
      // clear. The service asks the database what is checked, when asked.
      const result = await clearCheckedGroceriesAction(activeListId);
      if (!result.ok) throw new Error(result.error);
      if (result.removed === 0) return;
      success(`Cleared ${result.removed} completed item${result.removed === 1 ? '' : 's'}`);
      void refreshItems();
    });
  }

  function archiveList(id: string) {
    return run(`archive:${id}`, async () => {
      const { error } = await createClient().from('grocery_lists').update({ archived_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      success(t('shoppingModule.listArchived'));
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
  if (error) return <ErrorState message={t('shoppingModule.couldNotLoadShoppingLists')} onRetry={refresh} />;

  return (
    <div className="module-with-sidebar">
      {/* ── List sidebar ─────────────────────────────────────── */}
      <div className="flex w-full flex-col lg:w-56 xl:w-64 flex-shrink-0">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold">{t('shopping.myLists')}</h2>
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
                <span className="text-lg">{(list as Record<string, unknown>).list_icon as string ?? '🛒'}</span>
                <div className="flex-1 min-w-0">
                  <p className={cn('truncate text-sm font-medium', isActive && 'text-brand-text font-bold')}>{list.name}</p>
                  <p className="text-[10px]">{activeListId === list.id ? `${totalCount} items` : ''}</p>
                </div>
                {isActive && (
                  <button onClick={(e) => { e.stopPropagation(); setEditingList(list); }}
                    aria-label={t('shopping.editList')}
                    className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100 rounded p-1 hover:bg-black/10">
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </button>
            );
          })}
          <button onClick={() => setNewListOpen(true)}
            className="flex w-full items-center gap-2 rounded-xl border-2 border-dashed border-border px-3 py-2 text-sm text-muted hover:border-brand/40 hover:text-brand-text transition">
            <Plus className="h-3.5 w-3.5" /> {t('shopping.newList')}
          </button>
        </div>
      </div>

      {/* ── Main shopping list ───────────────────────────────── */}
      <div className="module-main">
        {!activeList ? (
          <EmptyState icon={ShoppingBag} title={t('shopping.noListsYet')}
            description={t('shoppingModule.createAShoppingListFor')}
            action={<Button onClick={() => setNewListOpen(true)}><Plus className="h-4 w-4" /> {t('shopping.createList')}</Button>} />
        ) : (
          <>
            {/* List header */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{(activeList as Record<string, unknown>).list_icon as string ?? '🛒'}</span>
                <h2 className="text-xl font-bold">{activeList.name}</h2>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <AiInsight kind="shopping" />
                {checkedCount > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setBoughtOpen(true)}>
                    <PackageCheck className="h-3.5 w-3.5 text-success" /> {t('shoppingModule.bought')}
                  </Button>
                )}
                {checkedCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearChecked} disabled={isPending('clear-checked')}>
                    <Check className="h-3.5 w-3.5 text-success" /> {t('shopping.clear')} {checkedCount} done
                  </Button>
                )}
                <div className="flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-1.5">
                  <Search className="h-3.5 w-3.5 text-muted" />
                  <input value={search} inputMode="search" enterKeyHint="search" onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
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

            {/* ── Purchase hand-off ─────────────────────────────────────
                Links, not orders. Bubaly holds no retailer ordering
                credentials, so there is no "order placed" state to fake: each
                chip opens that store's own grocery search for an item still on
                the list, and "copy list" puts the outstanding lines on the
                clipboard for the store's bulk-add box.

                NO PAID RELATIONSHIP EXISTS WITH ANY OF THESE STORES. The set
                and its order are fixed in lib/grocery/retailers.ts, there are
                no affiliate tags, referral parameters or commission links in
                the URLs, and nothing here is ranked or promoted by payment. If
                that ever changes it must be disclosed on this surface, not
                buried in a URL. */}
            {openItems.length > 0 && (
              <div className="rounded-2xl border border-border bg-surface/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold">{t('shoppingModule.shopThisList')}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {RETAILERS.map((r) => (
                      <button key={r.id} type="button"
                        onClick={() => setRetailerId((current) => (current === r.id ? null : r.id))}
                        aria-pressed={retailerId === r.id}
                        className={cn(
                          'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition',
                          retailerId === r.id ? 'border-brand/60 bg-brand/10 font-semibold' : 'border-border hover:bg-elevated/40',
                        )}>
                        <span aria-hidden>{r.emoji}</span> {r.name}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={copyList} disabled={isPending('copy-list')}>
                      <Copy className="h-3.5 w-3.5" /> {t('shoppingModule.copyList')}
                    </Button>
                    {retailer && (
                      <a href={retailer.storeUrl} target="_blank" rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 rounded-xl border border-border px-2.5 py-1.5 text-xs hover:bg-elevated/40 transition">
                        <ExternalLink className="h-3.5 w-3.5" /> {t('shoppingModule.openStore', { store: retailer.name })}
                      </a>
                    )}
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-muted">
                  {retailer
                    ? t('shoppingModule.useTheLinkOnAn', { store: retailer.name })
                    : t('shoppingModule.pickAStoreToGet')}
                  {' '}
                  {t('shoppingModule.bubalyIsNotPaidBy')}
                </p>
              </div>
            )}

            {/* Items by category */}
            {itemsLoading ? <SkeletonList /> : byCategory.length === 0 ? (
              <EmptyState icon={ShoppingCart} title={t('shopping.listIsEmpty')}
                description={t('shoppingModule.addItemsBelowToGet')} />
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
                              {retailer && !item.is_checked && (
                                <a href={itemSearchUrl(retailer.id, item.name)} target="_blank" rel="noreferrer noopener"
                                  aria-label={t('shoppingModule.searchStoreForItem', { store: retailer.name, item: item.name })}
                                  className="rounded p-1 text-muted transition hover:text-brand-text">
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                              )}
                              <button onClick={() => deleteItem(item.id)} disabled={isPending(`delete:${item.id}`)} aria-label={t('shopping.deleteItem')}
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
                placeholder={t('shopping.addItem')}
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

      {/* Bought → pantry (+ the purchase, only when someone typed an amount) */}
      {boughtOpen && activeListId && (
        <BoughtModal listId={activeListId} items={checkedItems}
          onClose={() => setBoughtOpen(false)}
          onDone={() => { setBoughtOpen(false); void refreshItems(); }} />
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
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🛒');
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
    if (!trimmed) { toastError(t('shoppingModule.giveYourListAName')); return; }
    if (trimmed.length > 80) { toastError('List name is too long (max 80 characters)'); return; }
    if (!familyId) { toastError(t('shoppingModule.noActiveFamilyReloadAnd')); return; }
    setLoading(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from('grocery_lists').insert({
        family_id: familyId, name: trimmed, created_by: userId,
        list_icon: icon, store: preset.store,
      }).select('id').single();
      if (error || !data) { toastError(describeDbError(error)); return; }
      onCreated(data.id);
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('shopping.newShoppingList')}>
      <form onSubmit={create} className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium">{t('shopping.quickStartFromStore')}</label>
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
        <Field label={t('shopping.listName')} required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('shopping.groceryListCostcoRun')} autoFocus />}
        </Field>
        <Field label={t('shopping.icon')}>
          {() => (
            <div className="flex flex-wrap gap-2">
              {['🛒', '🏪', '🎯', '📦', '🌿', '🌺', '🏠', '🍕', '💊', '🐾'].map((e) => (
                <button key={e} type="button" onClick={() => setIcon(e)}
                  className={cn('rounded-xl p-2 text-xl hover:bg-elevated transition', icon === e && 'bg-brand/15 ring-2 ring-brand/40')}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{t('shopping.cancel')}</Button>
          <Button type="submit" loading={loading}>{t('shopping.createList')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function EditListModal({ list, onClose, onSaved, onArchive }: {
  list: GroceryList; onClose: () => void; onSaved: () => void; onArchive: () => void;
}) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(list.name);
  const [icon, setIcon] = useState((list as Record<string, unknown>).list_icon as string ?? '🛒');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const trimmed = name.trim();
    if (!trimmed) { toastError(t('shoppingModule.giveYourListAName')); return; }
    if (trimmed.length > 80) { toastError('List name is too long (max 80 characters)'); return; }
    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from('grocery_lists').update({ name: trimmed, list_icon: icon }).eq('id', list.id);
      if (error) { toastError(describeDbError(error)); return; }
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('shopping.editList')}>
      <form onSubmit={save} className="space-y-4">
        <Field label={t('shopping.listName')}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label={t('shopping.icon')}>
          {() => (
            <div className="flex flex-wrap gap-2">
              {['🛒', '🏪', '🎯', '📦', '🌿', '🌺', '🏠', '🍕', '💊', '🐾'].map((e) => (
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
            <Archive className="h-4 w-4" /> {t('shopping.archive')}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('shopping.cancel')}</Button>
            <Button type="submit" loading={loading}>{t('shopping.save')}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The end of a shop.
 *
 * Two things happen here and the copy says exactly which: everything ticked off
 * goes into the pantry and comes off the list, and — ONLY if someone types a
 * total — the charge is recorded on the household books. There is no default
 * amount and no estimate: Bubaly has no receipt, so it does not put a number on
 * a family's books that nobody gave it. The confirmation afterwards reports the
 * two halves separately, because "in the pantry" and "on the books" are
 * different facts and a shop can produce one without the other.
 */
function BoughtModal({ listId, items, onClose, onDone }: {
  listId: string;
  items: GroceryItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const typed = amount.trim();
    const parsed = typed ? Number(typed.replace(',', '.')) : null;
    if (typed && (!Number.isFinite(parsed) || (parsed as number) <= 0)) {
      toastError(t('shoppingModule.enterATotalAboveZero'));
      return;
    }
    setSaving(true);
    try {
      const result = await recordShoppingTripAction({
        listId,
        amount: parsed,
        merchant: merchant.trim() || null,
      });
      if (!result.ok) { toastError(result.error); return; }
      if (result.pantryFailed.length > 0) {
        // The list is deliberately left alone when a pantry write fails, so
        // the retry does the same thing rather than something new.
        toastError(t('shoppingModule.couldNotPutTheseIn', {
          names: result.pantryFailed.map((f) => f.name).join(', '),
        }));
        return;
      }
      const stocked = t('shoppingModule.putItemsInYourPantry', { count: result.pantryUpdated.length });
      if (result.purchaseError) toastError(`${stocked} ${t('shoppingModule.thePurchaseWasNotRecorded', { reason: result.purchaseError })}`);
      else if (result.purchaseRecorded) success(`${stocked} ${t('shoppingModule.purchaseRecordedOnTheHousehold')}`);
      else success(stocked);
      onDone();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('shoppingModule.bought')}>
      <form onSubmit={confirm} className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium">{t('shoppingModule.whatYouBought')}</p>
          <ul className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border bg-surface/30 p-3">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-sm">
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                <span className="flex-1 truncate">{item.name}</span>
                {item.quantity && <span className="text-xs text-muted">{item.quantity}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-muted">{t('shoppingModule.theseGoIntoYourPantry')}</p>
        </div>
        <Field label={t('shoppingModule.totalSpent')}>
          {(id) => (
            <Input id={id} value={amount} inputMode="decimal" placeholder={t('shoppingModule.optional')}
              onChange={(e) => setAmount(e.target.value)} />
          )}
        </Field>
        <Field label={t('shoppingModule.store')}>
          {(id) => (
            <Input id={id} value={merchant} placeholder={t('shoppingModule.optional')}
              onChange={(e) => setMerchant(e.target.value)} />
          )}
        </Field>
        <p className="text-[11px] text-muted">{t('shoppingModule.leaveTheTotalBlankIf')}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{t('shopping.cancel')}</Button>
          <Button type="submit" loading={saving}>{t('shoppingModule.putItInThePantry')}</Button>
        </div>
      </form>
    </Modal>
  );
}
