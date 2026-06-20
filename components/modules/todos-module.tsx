'use client';

import { useMemo, useState } from 'react';
import {
  CheckSquare, Plus, Trash2, Check, Flag, Calendar, User,
  ChevronLeft, MoreHorizontal, Circle, Tag, Search, X,
  Pencil, Archive, Filter,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type TodoList = Tables<'todo_lists'>;
type TodoItem = Tables<'todo_items'>;

const PRIORITY_META = {
  low:    { label: 'Low',    color: 'text-muted',         dot: 'bg-muted/50',    flag: 'text-muted/50' },
  medium: { label: 'Medium', color: 'text-blue-400',      dot: 'bg-blue-400',    flag: 'text-blue-400' },
  high:   { label: 'High',   color: 'text-amber-400',     dot: 'bg-amber-400',   flag: 'text-amber-400' },
  urgent: { label: 'Urgent', color: 'text-danger',        dot: 'bg-danger',      flag: 'text-danger' },
};

const LIST_COLORS: Record<string, string> = {
  violet: 'bg-violet-500/20 text-violet-400',
  blue:   'bg-blue-500/20 text-blue-400',
  green:  'bg-green-500/20 text-green-400',
  amber:  'bg-amber-500/20 text-amber-400',
  rose:   'bg-rose-500/20 text-rose-400',
  teal:   'bg-teal-500/20 text-teal-400',
};

const LIST_ICONS = ['📋', '🏠', '💼', '🛒', '🎯', '📚', '🏋️', '✈️', '💡', '🎉'];

export function TodosModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [newListOpen, setNewListOpen] = useState(false);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<TodoItem | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'done' | 'urgent'>('all');

  const { data: lists, loading: listsLoading, refresh: refreshLists } = useRealtimeQuery<TodoList>({
    table: 'todo_lists', familyId, deps: [familyId],
    fetcher: (sb) =>
      sb.from('todo_lists').select('*').eq('family_id', familyId).is('archived_at', null)
        .order('sort_order').order('created_at'),
  });

  const { data: items, loading: itemsLoading, refresh: refreshItems } = useRealtimeQuery<TodoItem>({
    table: 'todo_items', familyId, deps: [familyId, activeListId],
    fetcher: (sb) => {
      if (!activeListId) return Promise.resolve({ data: [], error: null });
      return sb.from('todo_items').select('*').eq('list_id', activeListId)
        .order('is_done').order('priority', { ascending: false }).order('due_date').order('sort_order');
    },
  });

  // Auto-select first list
  if (lists.length > 0 && !activeListId) setActiveListId(lists[0].id);

  const activeList = lists.find((l) => l.id === activeListId);

  const filtered = useMemo(() => {
    let res = items;
    if (search) res = res.filter((i) => i.title.toLowerCase().includes(search.toLowerCase()));
    if (filter === 'active') res = res.filter((i) => !i.is_done);
    if (filter === 'done')   res = res.filter((i) => i.is_done);
    if (filter === 'urgent') res = res.filter((i) => i.priority === 'urgent' && !i.is_done);
    return res;
  }, [items, search, filter]);

  const pending = items.filter((i) => !i.is_done);
  const done    = items.filter((i) => i.is_done);

  async function toggleItem(item: TodoItem) {
    const supabase = createClient();
    await supabase.from('todo_items').update({
      is_done: !item.is_done,
      completed_at: item.is_done ? null : new Date().toISOString(),
    }).eq('id', item.id);
    void refreshItems();
  }

  async function deleteItem(id: string) {
    const supabase = createClient();
    await supabase.from('todo_items').delete().eq('id', id);
    void refreshItems();
  }

  async function clearDone() {
    const supabase = createClient();
    const ids = done.map((i) => i.id);
    if (!ids.length) return;
    await supabase.from('todo_items').delete().in('id', ids);
    success(`Cleared ${ids.length} completed items`);
    void refreshItems();
  }

  if (listsLoading) return <LoadingBlock />;

  return (
    <div className="module-with-sidebar">
      {/* ── List sidebar ─────────────────────────────────────── */}
      <div className="flex w-full flex-col lg:w-52 xl:w-60 flex-shrink-0">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold">My Lists</h2>
          <button onClick={() => setNewListOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-brand/15 text-brand hover:bg-brand/25 transition">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-1">
          {lists.map((list) => {
            const isActive = list.id === activeListId;
            const listItems = items.filter((i) => i.list_id === list.id);
            const pendingCount = listItems.filter((i) => !i.is_done).length;
            return (
              <button key={list.id} onClick={() => setActiveListId(list.id)}
                className={cn(
                  'group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition',
                  isActive ? 'bg-brand/15 text-brand' : 'hover:bg-elevated/40 text-muted',
                )}>
                <span className="text-lg">{list.icon}</span>
                <span className={cn('flex-1 truncate text-sm font-medium', isActive && 'text-brand font-bold')}>
                  {list.name}
                </span>
                {pendingCount > 0 && (
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', isActive ? 'bg-brand/30' : 'bg-elevated text-muted')}>
                    {pendingCount}
                  </span>
                )}
              </button>
            );
          })}

          <button onClick={() => setNewListOpen(true)}
            className="flex w-full items-center gap-2 rounded-xl border-2 border-dashed border-border px-3 py-2 text-sm text-muted hover:border-brand/40 hover:text-brand transition">
            <Plus className="h-3.5 w-3.5" /> New list
          </button>
        </div>

        {/* Summary */}
        {activeList && (
          <div className="mt-4 rounded-xl border border-border bg-surface/40 p-3 text-xs space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted">Total</span>
              <span className="font-semibold">{items.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Active</span>
              <span className="font-semibold text-brand">{pending.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Done</span>
              <span className="font-semibold text-success">{done.length}</span>
            </div>
            <div className="overflow-hidden rounded-full bg-elevated h-1.5 mt-1">
              <div className="h-full bg-success transition-all"
                style={{ width: items.length ? `${(done.length / items.length) * 100}%` : '0%' }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Main to-do view ──────────────────────────────────── */}
      <div className="module-main">
        {!activeList ? (
          <EmptyState icon={CheckSquare} title="No lists yet"
            description="Create a to-do list to get organized."
            action={<Button onClick={() => setNewListOpen(true)}><Plus className="h-4 w-4" /> New List</Button>} />
        ) : (
          <>
            {/* Header */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{activeList.icon}</span>
                <h2 className="text-xl font-bold">{activeList.name}</h2>
                {!activeList.is_shared && <Badge>Private</Badge>}
              </div>
              <div className="ml-auto flex items-center gap-2">
                {done.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearDone}>
                    <Check className="h-3.5 w-3.5 text-success" /> Clear done
                  </Button>
                )}
                <Button size="sm" onClick={() => setNewItemOpen(true)}>
                  <Plus className="h-4 w-4" /> Add Task
                </Button>
              </div>
            </div>

            {/* Filter + search */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-xl border border-border bg-surface/40 p-1 gap-0.5">
                {(['all', 'active', 'done', 'urgent'] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={cn('rounded-lg px-3 py-1 text-xs font-medium capitalize transition',
                      filter === f ? 'bg-brand text-white' : 'text-muted hover:text-fg')}>
                    {f}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
                  className="w-28 bg-transparent text-sm placeholder:text-muted outline-none" />
                {search && <button onClick={() => setSearch('')}><X className="h-3.5 w-3.5 text-muted" /></button>}
              </div>
            </div>

            {/* Items */}
            {itemsLoading ? <LoadingBlock /> : filtered.length === 0 ? (
              <EmptyState icon={CheckSquare} title={filter === 'done' ? 'No completed items' : 'Nothing here yet'}
                description={filter === 'all' ? 'Add your first task above.' : `No ${filter} tasks.`}
                action={filter === 'all' ? <Button onClick={() => setNewItemOpen(true)}><Plus className="h-4 w-4" /> Add Task</Button> : undefined} />
            ) : (
              <div className="space-y-1.5">
                {filtered.map((item) => {
                  const p = PRIORITY_META[item.priority as keyof typeof PRIORITY_META] ?? PRIORITY_META.medium;
                  const assignee = members.find((m) => m.id === item.assigned_to_id);
                  const isOverdue = !item.is_done && item.due_date && item.due_date < new Date().toISOString().slice(0, 10);
                  return (
                    <div key={item.id} className={cn(
                      'group flex items-start gap-3 rounded-xl border p-3 transition hover:bg-elevated/30',
                      item.is_done ? 'border-border/30 opacity-60' : 'border-border',
                    )}>
                      <button onClick={() => toggleItem(item)}
                        className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition',
                          item.is_done ? 'border-success bg-success' : `border-border hover:border-success/50`)}>
                        {item.is_done && <Check className="h-3 w-3 text-white" />}
                      </button>

                      <div className="flex-1 min-w-0">
                        <p className={cn('text-sm font-medium', item.is_done && 'line-through text-muted')}>
                          {item.title}
                        </p>
                        {item.notes && <p className="mt-0.5 text-xs text-muted line-clamp-1">{item.notes}</p>}
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          {item.priority !== 'low' && (
                            <span className={cn('flex items-center gap-1 text-[10px] font-semibold', p.flag)}>
                              <Flag className="h-2.5 w-2.5" /> {p.label}
                            </span>
                          )}
                          {item.due_date && (
                            <span className={cn('flex items-center gap-1 text-[10px]', isOverdue ? 'text-danger font-semibold' : 'text-muted')}>
                              <Calendar className="h-2.5 w-2.5" />
                              {isOverdue ? 'Overdue · ' : ''}{item.due_date}
                            </span>
                          )}
                          {item.tags.map((tag) => (
                            <span key={tag} className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {assignee && (
                          <Avatar name={assignee.display_name} color={assignee.color} size={22} />
                        )}
                        <button onClick={() => setEditingItem(item)}
                          className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-fg transition">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => deleteItem(item.id)}
                          className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger transition">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Modals */}
      {newListOpen && (
        <NewListModal familyId={familyId} userId={userId}
          onClose={() => setNewListOpen(false)}
          onCreated={(id) => { setActiveListId(id); setNewListOpen(false); void refreshLists(); }} />
      )}
      {(newItemOpen || editingItem) && activeListId && (
        <ItemModal familyId={familyId} userId={userId} listId={activeListId} members={members}
          item={editingItem ?? undefined}
          onClose={() => { setNewItemOpen(false); setEditingItem(null); }}
          onSaved={() => { setNewItemOpen(false); setEditingItem(null); void refreshItems(); }} />
      )}
    </div>
  );
}

function NewListModal({ familyId, userId, onClose, onCreated }: {
  familyId: string; userId: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('📋');
  const [color, setColor] = useState('violet');
  const [isShared, setIsShared] = useState(true);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase.from('todo_lists').insert({
      family_id: familyId, name: name.trim(), icon, color, is_shared: isShared,
    }).select('id').single();
    setLoading(false);
    if (error) { toastError(error.message); return; }
    onCreated(data.id);
  }

  return (
    <Modal open onClose={onClose} title="New List">
      <form onSubmit={create} className="space-y-4">
        <Field label="List name" required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, Personal, Shopping…" autoFocus />}
        </Field>
        <Field label="Icon">
          {() => (
            <div className="flex flex-wrap gap-2">
              {LIST_ICONS.map((e) => (
                <button key={e} type="button" onClick={() => setIcon(e)}
                  className={cn('rounded-xl p-2 text-xl hover:bg-elevated transition', icon === e && 'bg-brand/15 ring-2 ring-brand/40')}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="Color">
          {() => (
            <div className="flex gap-2">
              {Object.keys(LIST_COLORS).map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)}
                  className={cn('h-7 w-7 rounded-full', LIST_COLORS[c], color === c && 'ring-2 ring-offset-2 ring-brand')} />
              ))}
            </div>
          )}
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={isShared} onChange={(e) => setIsShared(e.target.checked)} className="accent-brand" />
          Shared with family
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}

function ItemModal({ familyId, userId, listId, members, item, onClose, onSaved }: {
  familyId: string; userId: string; listId: string;
  members: ReturnType<typeof useApp>['members'];
  item?: TodoItem; onClose: () => void; onSaved: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState(item?.title ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [priority, setPriority] = useState(item?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState(item?.due_date ?? '');
  const [assignedTo, setAssignedTo] = useState(item?.assigned_to_id ?? '');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>(item?.tags ?? []);

  function addTag() {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    const supabase = createClient();
    const payload = {
      title: title.trim(), notes: notes || null, priority,
      due_date: dueDate || null, tags,
      assigned_to_id: assignedTo || null,
    };
    const { error } = item
      ? await supabase.from('todo_items').update(payload).eq('id', item.id)
      : await supabase.from('todo_items').insert({ ...payload, family_id: familyId, list_id: listId });
    setLoading(false);
    if (error) { toastError(error.message); return; }
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={item ? 'Edit Task' : 'New Task'}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Title" required>
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />}
        </Field>
        <Field label="Notes">
          {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Optional details…" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            {(id) => (
              <select id={id} value={priority} onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand">
                {Object.entries(PRIORITY_META).map(([val, meta]) => <option key={val} value={val}>{meta.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Due date">
            {(id) => <Input id={id} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
          </Field>
        </div>
        <Field label="Assign to">
          {(id) => (
            <select id={id} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand">
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
          )}
        </Field>
        <div>
          <label className="mb-1 block text-sm font-medium">Tags</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {tags.map((t) => (
              <span key={t} className="flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand">
                {t}
                <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
              placeholder="Add tag…" />
            <Button type="button" variant="secondary" size="sm" onClick={addTag}>Add</Button>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{item ? 'Save' : 'Add Task'}</Button>
        </div>
      </form>
    </Modal>
  );
}
