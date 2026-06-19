'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, MoreHorizontal, Search, SlidersHorizontal, ShoppingBag, Check, X as XIcon } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
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

const SMART_SUGGESTIONS = [
  { name: 'Greek Yogurt', reason: 'Often bought with berries', emoji: '🫙' },
  { name: 'Oat Milk', reason: 'Low on this item', emoji: '🥛' },
  { name: 'Chicken Breast', reason: 'Based on your meal plan', emoji: '🍗' },
];

const MY_LISTS_MOCK = [
  { name: 'Main Grocery List', items: 42, active: true },
  { name: 'Costco Run', items: 18 },
  { name: 'Quick Trip', items: 7 },
  { name: 'Party Supplies', items: 11 },
];

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
  }, [familyId]);

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
    if (error) return toastError(error.message);
    void refresh();
  }

  async function deleteItem(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('grocery_items').delete().eq('id', id);
    if (error) return toastError(error.message);
    void refresh();
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const name = addingItem.trim();
    if (!name || !listId) return;
    const supabase = createClient();
    const { error } = await supabase.from('grocery_items').insert({ family_id: familyId, list_id: listId, name, category: addingCategory, created_by: userId });
    if (error) return toastError(error.message);
    setAddingItem(''); void refresh();
  }

  function toggleCollapse(cat: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  if (listLoading || loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  // Donut data for sidebar
  const donutSegments = CATEGORIES.map(cat => ({
    cat, value: items.filter(i => (i.category ?? 'Other') === cat).length, color: CATEGORY_COLORS[cat] ?? '#6b7280',
  })).filter(s => s.value > 0);

  return (
    <div className="flex h-full min-h-0 gap-0">
      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Header */}
        <div className="flex-shrink-0 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl font-bold">Groceries</h1>
              <p className="mt-0.5 text-sm text-muted">Stay organized and never forget an item.</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm font-medium hover:bg-elevated transition">
                <SlidersHorizontal className="h-4 w-4" /> Reorder
              </button>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/60 px-3 py-2">
                <Search className="h-4 w-4 text-muted" />
                <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search groceries…" className="bg-transparent text-sm outline-none w-36 placeholder:text-muted" />
              </div>
              <button onClick={() => document.getElementById('quick-add-input')?.focus()} className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 transition">
                <Plus className="h-4 w-4" /> Add Item
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="mt-4 flex items-center gap-1">
            {([['all', 'All Items'], ['mine', 'My Items'], ['store', 'By Store']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)}
                className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition', tab === key ? 'bg-brand/20 text-brand' : 'text-muted hover:text-foreground hover:bg-elevated')}>
                {label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <button className="text-xs text-brand hover:underline">Share List</button>
              <button className="rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-medium hover:bg-elevated transition">More</button>
            </div>
          </div>

          {/* Stats */}
          <div className="mt-4 grid grid-cols-4 gap-3">
            {[
              { label: 'Total Items', value: items.length, icon: '🛒', color: 'text-brand' },
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
                    <span className="text-xs text-muted">Est. —</span>
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
                          {item.is_checked && <Check className="h-3 w-3 text-white" />}
                        </button>
                        <span className={cn('flex-1 text-sm font-medium', item.is_checked && 'line-through text-muted')}>{item.name}</span>
                        {item.quantity && <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand">{item.quantity}</span>}
                        <div className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
                          <button onClick={() => deleteItem(item.id)} className="rounded p-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                          <button className="rounded p-1 text-muted hover:text-foreground"><MoreHorizontal className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Quick add */}
          <form onSubmit={addItem} className="flex items-center gap-2">
            <select value={addingCategory} onChange={e => setAddingCategory(e.target.value)}
              className="rounded-lg border border-border bg-surface/60 px-2 py-2 text-xs text-muted focus:outline-none">
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input id="quick-add-input" value={addingItem} onChange={e => setAddingItem(e.target.value)}
              placeholder="+ Add item…"
              className="flex-1 rounded-lg border border-dashed border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted focus:border-brand/50 focus:outline-none transition" />
            {addingItem && (
              <button type="submit" className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand/90 transition">Add</button>
            )}
          </form>

          {/* Buy Online section */}
          <div className="rounded-xl border border-border bg-surface/30 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/20 text-xl">🛒</div>
              <div>
                <p className="text-sm font-semibold">Buy Online &amp; Pickup</p>
                <p className="text-xs text-muted">Shop from your favorite stores and pick up when it&apos;s convenient for you.</p>
              </div>
              <div className="ml-auto flex items-center gap-3">
                {[{ name: 'Walmart', emoji: '🏪', label: 'Pickup today' }, { name: 'Kroger', emoji: '🏬', label: 'Pickup tomorrow' }, { name: 'Target', emoji: '🎯', label: 'Pickup today' }].map(s => (
                  <div key={s.name} className="flex flex-col items-center gap-0.5">
                    <span className="text-xl">{s.emoji}</span>
                    <span className="text-[9px] font-semibold">{s.name}</span>
                    <span className="text-[8px] text-muted">{s.label}</span>
                  </div>
                ))}
                <button className="rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-medium hover:bg-elevated transition">View Stores</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right sidebar */}
      <div className="hidden w-64 flex-shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface/20 p-4 lg:flex">
        {/* Shopping Summary donut */}
        <div className="rounded-xl border border-border bg-surface/40 p-4">
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

        {/* My Lists */}
        <div className="rounded-xl border border-border bg-surface/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">My Lists</p>
            <button className="flex items-center gap-1 text-xs text-brand hover:underline"><Plus className="h-3 w-3" /> New List</button>
          </div>
          <div className="space-y-1.5">
            {MY_LISTS_MOCK.map(l => (
              <div key={l.name} className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2', l.active ? 'border-brand/40 bg-brand/10' : 'border-border/50 bg-surface/60 hover:bg-elevated cursor-pointer transition')}>
                <div className={cn('flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-xs', l.active ? 'bg-brand text-white' : 'bg-elevated text-muted')}>
                  {l.active ? '📋' : '📄'}
                </div>
                <div className="min-w-0">
                  <div className={cn('truncate text-xs font-medium', l.active && 'text-brand')}>{l.name}</div>
                  <div className="text-[10px] text-muted">{l.items} items</div>
                </div>
                <MoreHorizontal className="ml-auto h-3.5 w-3.5 text-muted flex-shrink-0" />
              </div>
            ))}
          </div>
          <button className="mt-3 text-xs text-brand hover:underline">View all lists →</button>
        </div>

        {/* Smart Suggestions */}
        <div className="rounded-xl border border-border bg-surface/40 p-4">
          <div className="mb-1 text-sm font-semibold">Smart Suggestions</div>
          <div className="mb-3 text-[10px] text-muted">Based on your meals &amp; history</div>
          <div className="space-y-2">
            {SMART_SUGGESTIONS.map(s => (
              <div key={s.name} className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-surface/60 px-3 py-2">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-elevated text-base">{s.emoji}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{s.name}</div>
                  <div className="text-[10px] text-muted">{s.reason}</div>
                </div>
                <button className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface hover:bg-brand/20 hover:border-brand/50 transition">
                  <Plus className="h-3 w-3 text-muted" />
                </button>
              </div>
            ))}
          </div>
          <button className="mt-3 text-xs text-brand hover:underline">View more suggestions →</button>
        </div>
      </div>
    </div>
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
