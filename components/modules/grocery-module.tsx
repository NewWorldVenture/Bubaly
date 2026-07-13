'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, MoreHorizontal, Search, SlidersHorizontal, ShoppingBag, Check, ExternalLink, Copy, Store } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils/cn';
import { RETAILERS, itemSearchUrl, buildShoppingText, type Retailer } from '@/lib/grocery/retailers';
import type { Tables } from '@/lib/database.types';

type Item = Tables<'grocery_items'>;
type GroceryList = Tables<'grocery_lists'>;

const CATEGORIES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Pantry', 'Beverages', 'Household', 'Other'];
const CATEGORY_ICONS: Record<string, string> = {
  'Produce': '🥬', 'Dairy & Eggs': '🧀', 'Meat & Seafood': '🥩',
  'Pantry': '🫙', 'Beverages': '🧃', 'Household': '🧹', 'Other': '🛒',
};
const CATEGORY_COLORS: Record<string, string> = {
  'Produce': '#22c55e', 'Dairy & Eggs': '#3b82f6', 'Meat & Seafood': '#ef4444',
  'Pantry': '#f59e0b', 'Beverages': '#8b5cf6', 'Household': '#14b8a6', 'Other': '#6b7280',
};


export function GroceryModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [listId, setListId] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [addingItem, setAddingItem] = useState('');
  const [addingCategory, setAddingCategory] = useState('Produce');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [searchQ, setSearchQ] = useState('');
  const [tab, setTab] = useState<'all' | 'mine' | 'store'>('all');
  const [shopRetailer, setShopRetailer] = useState<Retailer | null>(null);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data } = await supabase.from('grocery_lists').select('*').eq('family_id', familyId).eq('is_archived', false).order('created_at').limit(1);
      if (data?.[0]) {
        setListId(data[0].id);
      } else {
        const { data: created } = await supabase.from('grocery_lists').insert({ family_id: familyId, name: 'Groceries', created_by: userId }).select('id').single();
        if (created) setListId(created.id);
      }
      setListLoading(false);
    })();
  }, [familyId, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: items, loading, error, refresh } = useRealtimeQuery<Item>({
    table: 'grocery_items', familyId, deps: [familyId, listId],
    fetcher: (supabase) =>
      listId
        ? supabase.from('grocery_items').select('*').eq('list_id', listId).order('category').order('created_at')
        : Promise.resolve({ data: [], error: null }),
  });

  const filtered = useMemo(() =>
    items.filter(i => !searchQ || i.name.toLowerCase().includes(searchQ.toLowerCase())),
    [items, searchQ]);

  const byCategory = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const cat of CATEGORIES) map.set(cat, []);
    for (const item of filtered) {
      const cat = item.category ?? 'Other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(item);
    }
    return [...map.entries()].filter(([, items]) => items.length > 0);
  }, [filtered]);

  const checked = items.filter(i => i.is_checked).length;
  const unchecked = items.filter(i => !i.is_checked).length;

  async function toggleItem(item: Item) {
    const supabase = createClient();
    const { error } = await supabase.from('grocery_items').update({ is_checked: !item.is_checked }).eq('id', item.id);
    if (error) return toastError(describeDbError(error));
    void refresh();
  }

  async function deleteItem(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('grocery_items').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    void refresh();
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const name = addingItem.trim();
    if (!name || !listId) return;
    const supabase = createClient();
    const { error } = await supabase.from('grocery_items').insert({ family_id: familyId, list_id: listId, name, category: addingCategory, created_by: userId });
    if (error) return toastError(describeDbError(error));
    setAddingItem(''); void refresh();
  }

  async function shareList() {
    const pending = items.filter(i => !i.is_checked);
    if (pending.length === 0) return toastError('Nothing to share — the list is all checked off!');
    const text = `🛒 Grocery list\n\n${pending.map(i => `• ${i.name}${i.quantity ? ` (${i.quantity})` : ''}`).join('\n')}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Grocery list', text });
      } else {
        await navigator.clipboard.writeText(text);
        success('List copied to clipboard');
      }
    } catch { /* user cancelled share, or clipboard unavailable */ }
  }

  function toggleCollapse(cat: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  if (listLoading || loading) return <SkeletonList count={6} />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  // Donut data for sidebar
  const donutSegments = CATEGORIES.map(cat => ({
    cat, value: items.filter(i => (i.category ?? 'Other') === cat).length, color: CATEGORY_COLORS[cat] ?? '#6b7280',
  })).filter(s => s.value > 0);

  return (
    <div className="module-with-sidebar">
      {/* Main */}
      <div className="module-main overflow-y-auto">
        {/* Header */}
        <div className="flex-shrink-0 border-b border-border px-5 py-4">
          <PageHeader
            title="Groceries"
            description="Stay organized and never forget an item."
            action={
              <div className="flex flex-wrap items-center gap-2">
                <AiInsight kind="grocery" />
                <Button variant="outline" size="sm">
                  <SlidersHorizontal className="h-4 w-4" /> Reorder
                </Button>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-3 py-2">
                  <Search className="h-4 w-4 text-muted" />
                  <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search groceries…" className="bg-transparent text-sm outline-none w-28 sm:w-36 placeholder:text-muted" />
                </div>
                <Button size="sm" onClick={() => document.getElementById('quick-add-input')?.focus()}>
                  <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Add Item</span>
                </Button>
              </div>
            }
          />

          {/* Tabs */}
          <div className="tab-bar mt-4">
            {([['all', 'All Items'], ['mine', 'My Items'], ['store', 'By Store']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)}
                className={cn('tab-item', tab === key ? 'tab-item-active' : 'tab-item-inactive')}>
                {label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <button onClick={shareList} className="text-xs text-brand-text hover:underline">Share List</button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid-stats mt-4">
            {[
              { label: 'Total Items', value: items.length, icon: '🛒', color: 'text-brand-text' },
              { label: 'Completed', value: checked, icon: '✅', color: 'text-green-400' },
              { label: 'To Buy', value: unchecked, icon: '📋', color: 'text-amber-400' },
              { label: 'Est. Total', value: '$—', icon: '💰', color: 'text-blue-400' },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-4 py-3">
                <span className="text-2xl">{s.icon}</span>
                <div>
                  <div className={cn('text-xl font-bold', s.color)}>{s.value}</div>
                  <div className="text-[11px] text-muted">{s.label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Category sections */}
        <div className="flex-1 px-5 py-4 space-y-3">
          {byCategory.length === 0 && (
            <div className="flex flex-col items-center py-16 text-center">
              <ShoppingBag className="mb-3 h-12 w-12 text-muted opacity-50" />
              <p className="text-sm font-medium">Your list is empty</p>
              <p className="text-xs text-muted">Add items below to get started.</p>
            </div>
          )}

          {byCategory.map(([cat, catItems]) => {
            const isCollapsed = collapsed.has(cat);
            const catChecked = catItems.filter(i => i.is_checked).length;
            return (
              <div key={cat} className="overflow-hidden rounded-xl border border-border bg-surface/30">
                <button onClick={() => toggleCollapse(cat)}
                  className="flex w-full items-center gap-3 border-b border-border bg-surface/40 px-4 py-2.5 text-left hover:bg-elevated/30 transition">
                  <span className="text-base">{CATEGORY_ICONS[cat] ?? '🛒'}</span>
                  <span className="text-sm font-semibold">{cat}</span>
                  <span className="text-xs text-muted">{catItems.length} item{catItems.length !== 1 ? 's' : ''}</span>
                  <div className="ml-auto flex items-center gap-3">
                    <span className="hidden text-xs text-muted sm:inline">Est. —</span>
                    {isCollapsed ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronUp className="h-4 w-4 text-muted" />}
                  </div>
                </button>

                {!isCollapsed && (
                  <div>
                    {catItems.map((item, idx) => (
                      <div key={item.id}
                        className={cn('group flex items-center gap-3 px-4 py-2.5 transition hover:bg-elevated/20',
                          idx < catItems.length - 1 && 'border-b border-border/50')}>
                        <button onClick={() => toggleItem(item)}
                          className={cn('flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border transition',
                            item.is_checked ? 'bg-brand border-brand' : 'border-border hover:border-brand/50')}>
                          {item.is_checked && <Check className="h-3 w-3 text-brand-fg" />}
                        </button>
                        <span className={cn('flex-1 text-sm font-medium', item.is_checked && 'line-through text-muted')}>{item.name}</span>
                        {item.quantity && <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand-text">{item.quantity}</span>}
                        <div className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
                          <button onClick={() => deleteItem(item.id)} className="rounded p-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                          <button aria-label="More options" className="rounded p-1 text-muted hover:text-fg"><MoreHorizontal className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Quick add */}
          <form onSubmit={addItem} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <select value={addingCategory} onChange={e => setAddingCategory(e.target.value)}
              className="rounded-lg border border-border bg-surface/60 px-2 py-2 text-xs text-muted focus:outline-none">
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input id="quick-add-input" value={addingItem} onChange={e => setAddingItem(e.target.value)}
              placeholder="+ Add item…"
              className="min-w-0 flex-1 rounded-lg border border-dashed border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted focus:border-brand/50 focus:outline-none transition" />
            {addingItem && (
              <Button type="submit" size="sm">Add</Button>
            )}
          </form>

          {/* Buy Online / delivery hand-off */}
          <div className="rounded-xl border border-border bg-surface/30 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand/20 text-xl">🛒</div>
                <div>
                  <p className="text-sm font-semibold">Shop online &amp; get it delivered</p>
                  <p className="text-xs text-muted">Send your list straight to a store — one tap opens each item in their cart.</p>
                </div>
              </div>
              <div className="ml-0 flex flex-wrap items-center gap-2 sm:ml-auto">
                {RETAILERS.map(r => (
                  <button key={r.id} onClick={() => setShopRetailer(r)}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-2.5 py-1.5 text-xs font-semibold hover:bg-elevated transition"
                    title={`Shop your list at ${r.name}`}>
                    <span className="text-base">{r.emoji}</span> {r.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {shopRetailer && (
        <ShopOnlineModal
          retailer={shopRetailer}
          items={items.filter(i => !i.is_checked)}
          onClose={() => setShopRetailer(null)}
        />
      )}

      {/* Right sidebar */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        {/* Shopping Summary donut */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">Shopping Summary</p>
            <span className="text-[10px] text-muted">This Week</span>
          </div>
          <div className="flex items-center gap-3">
            <SimpleDonut segments={donutSegments.map(s => ({ value: s.value, color: s.color }))} center="$—" />
            <div className="space-y-1.5 text-xs">
              {donutSegments.slice(0, 4).map(s => (
                <div key={s.cat} className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-muted truncate max-w-[80px]">{s.cat}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Quick Tips */}
        <div className="sidebar-card">
          <div className="mb-1 text-sm font-semibold">Quick Tips</div>
          <div className="mb-3 text-[10px] text-muted">Organize your shopping</div>
          <div className="space-y-2 text-xs text-muted">
            <p>Use categories to group items by aisle for faster shopping.</p>
            <p>Check off items as you shop — they stay at the bottom for reference.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShopOnlineModal({ retailer, items, onClose }: {
  retailer: Retailer; items: Item[]; onClose: () => void;
}) {
  const { success } = useToast();

  async function copyList() {
    const text = buildShoppingText(items.map(i => ({ name: i.name, quantity: i.quantity })));
    try {
      await navigator.clipboard.writeText(text);
      success('Shopping list copied — paste it into the store');
    } catch {
      success('Copy not available in this browser');
    }
  }

  return (
    <Modal open onClose={onClose}
      title={`Shop at ${retailer.name}`}
      description="We open each item in the store's own search so you can add it to your cart and check out there. Nothing is ordered automatically.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <a href={retailer.storeUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-elevated">
            <Store className="h-4 w-4" /> Open {retailer.name}
          </a>
          <Button type="button" variant="outline" size="sm" onClick={copyList} disabled={items.length === 0}>
            <Copy className="h-4 w-4" /> Copy list
          </Button>
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-muted">Everything on your list is already checked off. 🎉</p>
        ) : (
          <ul className="max-h-72 space-y-1.5 overflow-y-auto">
            {items.map(item => (
              <li key={item.id}>
                <a href={itemSearchUrl(retailer.id, item.name)} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm hover:bg-elevated transition">
                  <span className="flex-1 font-medium">{item.name}</span>
                  {item.quantity && <span className="text-xs text-muted">{item.quantity}</span>}
                  <ExternalLink className="h-3.5 w-3.5 text-brand-text" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function SimpleDonut({ segments, center }: { segments: { value: number; color: string }[]; center: string }) {
  const R = 28; const C = 2 * Math.PI * R;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let cum = 0;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" className="flex-shrink-0">
      <circle cx="34" cy="34" r={R} fill="none" stroke="#1e2d40" strokeWidth="8" />
      {segments.map((s, i) => {
        const dash = (s.value / total) * C; const gap = C - dash;
        const off = C - cum * C / total;
        cum += s.value;
        return <circle key={i} cx="34" cy="34" r={R} fill="none" stroke={s.color} strokeWidth="8" strokeDasharray={`${dash} ${gap}`} strokeDashoffset={off} style={{ transform: 'rotate(-90deg)', transformOrigin: '34px 34px' }} />;
      })}
      <text x="34" y="34" textAnchor="middle" dominantBaseline="central" fill="white" fontSize="10" fontWeight="bold">{center}</text>
    </svg>
  );
}
