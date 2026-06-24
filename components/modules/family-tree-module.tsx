'use client';

import { useMemo, useState } from 'react';
import {
  GitBranch, Plus, Trash2, Users, TreePine, Eye, ChevronDown, ChevronRight, Edit2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import {
  buildTree, treeStats, groupByGeneration, relationshipLabel, lifespan,
  RELATIONSHIPS, type TreeNode,
} from '@/lib/family-tree/tree';
import type { Tables } from '@/lib/database.types';

type Node = Tables<'family_tree_nodes'>;

const blank = (): {
  name: string; relationship: string; parent_node_id: string;
  birth_year: string; death_year: string; birth_place: string; bio: string;
  member_id: string;
} => ({
  name: '', relationship: 'other', parent_node_id: '', birth_year: '', death_year: '',
  birth_place: '', bio: '', member_id: '',
});

const GEN_COLORS = [
  'border-violet-500/40 bg-violet-500/10',
  'border-blue-500/40 bg-blue-500/10',
  'border-emerald-500/40 bg-emerald-500/10',
  'border-amber-500/40 bg-amber-500/10',
  'border-pink-500/40 bg-pink-500/10',
  'border-cyan-500/40 bg-cyan-500/10',
];

export function FamilyTreeModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: nodes, loading } = useRealtimeQuery<Node>({
    table: 'family_tree_nodes', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_tree_nodes').select('*').eq('family_id', familyId).order('created_at', { ascending: true }),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [editNode, setEditNode] = useState<Node | null>(null);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'tree' | 'generations'>('tree');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Node | null>(null);

  const all = useMemo(() => nodes ?? [], [nodes]);
  const tree = useMemo(() => buildTree(all), [all]);
  const stats = useMemo(() => treeStats(all), [all]);
  const gens = useMemo(() => groupByGeneration(tree), [tree]);

  function toggleExpand(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.name.trim()) return;
    setSaving(true);
    const row = {
      name: form.name.trim(),
      relationship: form.relationship,
      parent_node_id: form.parent_node_id || null,
      birth_year: form.birth_year ? parseInt(form.birth_year) : null,
      death_year: form.death_year ? parseInt(form.death_year) : null,
      birth_place: form.birth_place.trim() || null,
      bio: form.bio.trim() || null,
      member_id: form.member_id || null,
    };
    const { error } = await createClient().from('family_tree_nodes').insert({
      ...row, family_id: familyId, created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(error.message);
    success('Added to family tree');
    setForm(null);
  }

  async function update(e: React.FormEvent) {
    e.preventDefault();
    if (!editNode) return;
    setSaving(true);
    const f = form!;
    const { error } = await createClient().from('family_tree_nodes').update({
      name: f.name.trim(),
      relationship: f.relationship,
      parent_node_id: f.parent_node_id || null,
      birth_year: f.birth_year ? parseInt(f.birth_year) : null,
      death_year: f.death_year ? parseInt(f.death_year) : null,
      birth_place: f.birth_place.trim() || null,
      bio: f.bio.trim() || null,
      member_id: f.member_id || null,
    }).eq('id', editNode.id);
    setSaving(false);
    if (error) return toastError(error.message);
    success('Updated');
    setEditNode(null); setForm(null);
  }

  async function remove(id: string) {
    if (!confirm('Remove this person from the tree?')) return;
    const { error } = await createClient().from('family_tree_nodes').delete().eq('id', id);
    if (error) toastError(error.message); else success('Removed');
  }

  function startEdit(n: Node) {
    setEditNode(n);
    setForm({
      name: n.name, relationship: n.relationship,
      parent_node_id: n.parent_node_id ?? '', birth_year: n.birth_year?.toString() ?? '',
      death_year: n.death_year?.toString() ?? '', birth_place: n.birth_place ?? '',
      bio: n.bio ?? '', member_id: n.member_id ?? '',
    });
  }

  if (loading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Family Tree"
        description="Map your family history and preserve your heritage."
        action={
          <div className="flex items-center gap-2">
            {all.length > 0 && (
              <div className="flex rounded-xl border border-border bg-surface/60 text-xs">
                <button onClick={() => setView('tree')} className={`px-3 py-1.5 rounded-l-xl transition ${view === 'tree' ? 'bg-brand text-white' : 'text-muted hover:text-fg'}`}>
                  <TreePine className="inline h-3.5 w-3.5 mr-1" />Tree
                </button>
                <button onClick={() => setView('generations')} className={`px-3 py-1.5 rounded-r-xl transition ${view === 'generations' ? 'bg-brand text-white' : 'text-muted hover:text-fg'}`}>
                  <Users className="inline h-3.5 w-3.5 mr-1" />Generations
                </button>
              </div>
            )}
            <Button onClick={() => { setEditNode(null); setForm(blank()); }}>
              <Plus className="h-4 w-4" /> Add person
            </Button>
          </div>
        }
      />

      {/* Stats bar */}
      {all.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-border bg-surface/40 p-4 text-center">
            <p className="text-2xl font-bold">{stats.total}</p>
            <p className="text-xs text-muted">People</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface/40 p-4 text-center">
            <p className="text-2xl font-bold">{stats.generations}</p>
            <p className="text-xs text-muted">Generations</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface/40 p-4 text-center">
            <p className="text-2xl font-bold">{stats.living}</p>
            <p className="text-xs text-muted">Living</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface/40 p-4 text-center">
            <p className="text-2xl font-bold">{stats.deceased}</p>
            <p className="text-xs text-muted">Deceased</p>
          </div>
        </div>
      )}

      {all.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="Your family tree is empty"
          description="Start by adding the oldest generation you know — grandparents, great-grandparents — and build down from there."
          action={<Button onClick={() => { setEditNode(null); setForm(blank()); }}><Plus className="h-4 w-4" /> Add first person</Button>}
        />
      ) : view === 'tree' ? (
        /* Hierarchical tree view */
        <div className="space-y-1">
          {tree.map((root) => (
            <TreeBranch
              key={root.id}
              node={root}
              depth={0}
              expanded={expanded}
              memberById={memberById}
              onToggle={toggleExpand}
              onView={setDetail}
              onEdit={startEdit}
              onDelete={remove}
            />
          ))}
        </div>
      ) : (
        /* Generations view */
        <div className="space-y-6">
          {gens.map((g) => (
            <div key={g.generation}>
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">
                {g.label} <span className="text-xs font-normal">· {g.nodes.length} {g.nodes.length === 1 ? 'person' : 'people'}</span>
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {g.nodes.map((n) => {
                  const mem = n.member_id ? memberById.get(n.member_id) : null;
                  const raw = all.find((r) => r.id === n.id)!;
                  return (
                    <div key={n.id} className={`rounded-2xl border p-4 ${GEN_COLORS[g.generation % GEN_COLORS.length]}`}>
                      <div className="flex items-start gap-3">
                        {mem ? (
                          <Avatar name={mem.display_name} color={mem.color} size={40} />
                        ) : (
                          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-elevated text-muted">
                            <Users className="h-4 w-4" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold">{n.name}</p>
                          <p className="text-xs text-muted">
                            {relationshipLabel(n.relationship)}
                            {lifespan(n) ? ` · ${lifespan(n)}` : ''}
                          </p>
                          {n.birth_place && <p className="mt-0.5 text-xs text-muted">{n.birth_place}</p>}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button onClick={() => startEdit(raw)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg">
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => remove(n.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      {n.bio && <p className="mt-2 text-sm text-fg/80">{n.bio}</p>}
                      {n.children.length > 0 && (
                        <p className="mt-2 text-xs text-muted">{n.children.length} {n.children.length === 1 ? 'child' : 'children'}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {detail && (
        <Modal open onClose={() => setDetail(null)} title={detail.name}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-muted">Relationship:</span> {relationshipLabel(detail.relationship)}</div>
              {detail.birth_year && <div><span className="text-muted">Born:</span> {detail.birth_year}{detail.birth_place ? `, ${detail.birth_place}` : ''}</div>}
              {detail.death_year && <div><span className="text-muted">Died:</span> {detail.death_year}</div>}
              {detail.member_id && memberById.get(detail.member_id) && (
                <div><span className="text-muted">Linked member:</span> {memberById.get(detail.member_id)!.display_name}</div>
              )}
            </div>
            {detail.bio && <p className="text-sm text-fg/90">{detail.bio}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDetail(null)}>Close</Button>
              <Button variant="secondary" onClick={() => { setDetail(null); startEdit(detail); }}><Edit2 className="h-4 w-4" /> Edit</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Add / Edit modal */}
      {form && (
        <Modal open onClose={() => { setForm(null); setEditNode(null); }} title={editNode ? 'Edit person' : 'Add to family tree'}>
          <form onSubmit={editNode ? update : save} className="space-y-3">
            <Field label="Name" required>
              {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Grandma Rose" required />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Relationship">
                {(id) => (
                  <Select id={id} value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })}>
                    {RELATIONSHIPS.map((r) => <option key={r} value={r}>{relationshipLabel(r)}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Parent in tree">
                {(id) => (
                  <Select id={id} value={form.parent_node_id} onChange={(e) => setForm({ ...form, parent_node_id: e.target.value })}>
                    <option value="">— Root (no parent) —</option>
                    {all.filter((n) => editNode ? n.id !== editNode.id : true).map((n) => (
                      <option key={n.id} value={n.id}>{n.name}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Birth year">
                {(id) => <Input id={id} type="number" min="1800" max="2030" value={form.birth_year} onChange={(e) => setForm({ ...form, birth_year: e.target.value })} placeholder="1942" />}
              </Field>
              <Field label="Death year">
                {(id) => <Input id={id} type="number" min="1800" max="2030" value={form.death_year} onChange={(e) => setForm({ ...form, death_year: e.target.value })} />}
              </Field>
              <Field label="Birthplace">
                {(id) => <Input id={id} value={form.birth_place} onChange={(e) => setForm({ ...form, birth_place: e.target.value })} placeholder="Naples, Italy" />}
              </Field>
            </div>
            <Field label="Link to family member (optional)">
              {(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
                  <option value="">— None —</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Bio / Notes">
              {(id) => <Textarea id={id} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="Tell their story…" rows={3} />}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => { setForm(null); setEditNode(null); }}>Cancel</Button>
              <Button type="submit" loading={saving}>{editNode ? 'Save' : 'Add person'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function TreeBranch({
  node, depth, expanded, memberById, onToggle, onView, onEdit, onDelete,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  memberById: Map<string, { display_name: string; color: string | null }>;
  onToggle: (id: string) => void;
  onView: (n: any) => void;
  onEdit: (n: any) => void;
  onDelete: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const mem = node.member_id ? memberById.get(node.member_id) : null;

  return (
    <div style={{ marginLeft: depth * 24 }}>
      <div className="group flex items-center gap-2 rounded-xl px-3 py-2 transition hover:bg-surface/40">
        {hasChildren ? (
          <button onClick={() => onToggle(node.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted hover:bg-elevated">
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="w-6" />
        )}

        {mem ? (
          <Avatar name={mem.display_name} color={mem.color} size={28} />
        ) : (
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-elevated text-muted">
            <Users className="h-3.5 w-3.5" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">{node.name}</span>
          <span className="ml-2 text-xs text-muted">{relationshipLabel(node.relationship)}</span>
          {lifespan(node) && <span className="ml-2 text-xs text-muted">· {lifespan(node)}</span>}
          {node.death_year != null && <span className="ml-1 text-xs text-muted/50">†</span>}
        </div>

        {hasChildren && (
          <span className="text-xs text-muted">{node.children.length}</span>
        )}

        <div className="hidden shrink-0 gap-1 group-hover:flex">
          <button onClick={() => onView(node)} className="rounded-lg p-1 text-muted hover:bg-elevated hover:text-fg" title="View">
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => onEdit(node)} className="rounded-lg p-1 text-muted hover:bg-elevated hover:text-fg" title="Edit">
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => onDelete(node.id)} className="rounded-lg p-1 text-muted hover:bg-elevated hover:text-danger" title="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {isOpen && hasChildren && node.children.map((child) => (
        <TreeBranch
          key={child.id}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          memberById={memberById}
          onToggle={onToggle}
          onView={onView}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
