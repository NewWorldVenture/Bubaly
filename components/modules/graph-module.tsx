'use client';

// Family Knowledge Graph — the reasoning substrate. Models the household as typed
// entities linked by typed edges, so the AI (and the family) can reason across
// relationships: trace how two things connect, and see the blast radius when
// something changes. 100% Supabase + family-scoped. The heavy lifting lives in the
// pure, tested engine at lib/graph/reason.ts.
import { useMemo, useState } from 'react';
import {
  Network, GitBranch, Zap, Users, Plus, X, ArrowRight, Sparkles, Trash2, Route,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import {
  buildIndex, neighbours, findPath, describePath, propagateImpact, hubs,
  type Graph, type GraphEntity, type EntityKind,
} from '@/lib/graph/reason';
import { projectTwinAction } from '@/app/(app)/dashboard/graph/twin-actions';
import type { Tables } from '@/lib/database.types';

type EntityRow = Tables<'graph_entities'>;
type EdgeRow = Tables<'graph_edges'>;

const KINDS: EntityKind[] = ['person', 'activity', 'place', 'org', 'event', 'item', 'pet', 'topic', 'other'];
const KIND_STYLE: Record<string, string> = {
  person: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  activity: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  place: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  org: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  event: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  item: 'text-teal-300 bg-teal-500/10 border-teal-500/30',
  pet: 'text-orange-300 bg-orange-500/10 border-orange-500/30',
  topic: 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30',
  other: 'text-muted border-border',
};

export function GraphModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: entityRows, loading: le } = useRealtimeQuery<EntityRow>({
    table: 'graph_entities', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('graph_entities').select('*').eq('family_id', familyId),
  });
  const { data: edgeRows, loading: ld } = useRealtimeQuery<EdgeRow>({
    table: 'graph_edges', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('graph_edges').select('*').eq('family_id', familyId),
  });
  const loading = le || ld;

  const graph: Graph = useMemo(() => ({
    entities: (entityRows ?? []).map((e) => ({
      id: e.id, kind: e.kind as EntityKind, name: e.name, refTable: e.ref_table, refId: e.ref_id,
      attributes: (e.attributes as Record<string, unknown>) ?? {},
    })),
    edges: (edgeRows ?? []).map((e) => ({
      id: e.id, sourceId: e.source_id, targetId: e.target_id, relation: e.relation, weight: Number(e.weight),
    })),
  }), [entityRows, edgeRows]);

  const index = useMemo(() => buildIndex(graph), [graph]);
  const topHubs = useMemo(() => hubs(index, 5), [index]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? index.byId.get(selectedId) ?? null : null;
  const selectedNeighbours = selected ? neighbours(index, selected.id) : [];
  const selectedImpact = selected ? propagateImpact(index, selected.id).slice(0, 8) : [];

  // "How are these related?" path finder.
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const path = fromId && toId ? findPath(index, fromId, toId) : null;

  // Add entity / edge modals.
  const [addEntity, setAddEntity] = useState(false);
  const [addEdge, setAddEdge] = useState(false);

  // Rebuild the graph from the family's real cross-domain data (the twin projector).
  const [projecting, setProjecting] = useState(false);
  async function rebuildFromData() {
    setProjecting(true);
    const res = await projectTwinAction();
    setProjecting(false);
    if (!res.ok) { toastError(res.error ?? 'Could not rebuild the twin'); return; }
    if (res.entities === 0) { toastError('No family data to project yet — add members, teams, etc.'); return; }
    success(`Twin synced — ${res.entities} entities, ${res.edges} links from your data`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge Graph"
        description="The household modelled as linked, typed relationships — so the AI can reason, not just retrieve."
        action={
          <>
            <Button onClick={rebuildFromData} disabled={projecting}>
              <Sparkles className="size-4" /> {projecting ? 'Syncing…' : 'Rebuild from data'}
            </Button>
            <Button variant="secondary" onClick={() => setAddEntity(true)}><Plus className="size-4" /> Entity</Button>
            <Button variant="secondary" onClick={() => setAddEdge(true)} disabled={graph.entities.length < 2}>
              <GitBranch className="size-4" /> Link
            </Button>
          </>
        }
      />

      {loading ? (
        <SkeletonList count={4} />
      ) : graph.entities.length === 0 ? (
        <EmptyState onAdd={() => setAddEntity(true)} onRebuild={rebuildFromData} projecting={projecting} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left: entity list + hubs */}
          <div className="space-y-4 lg:col-span-1">
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted">
                <Users className="size-4" /> Entities ({graph.entities.length})
              </h3>
              <div className="max-h-80 space-y-1 overflow-y-auto">
                {graph.entities.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => setSelectedId(e.id)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition',
                      selectedId === e.id ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted/5',
                    )}
                  >
                    <span className="truncate">{e.name}</span>
                    <span className={cn('ml-2 shrink-0 rounded-full border px-2 py-0.5 text-[10px]', KIND_STYLE[e.kind] ?? KIND_STYLE.other)}>
                      {e.kind}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {topHubs.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-4">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted">
                  <Sparkles className="size-4" /> Household hubs
                </h3>
                <p className="mb-2 text-xs text-muted">The most connected things — where coordination concentrates.</p>
                <ul className="space-y-1.5">
                  {topHubs.map((h) => (
                    <li key={h.entity.id} className="flex items-center justify-between text-sm">
                      <button onClick={() => setSelectedId(h.entity.id)} className="truncate hover:underline">{h.entity.name}</button>
                      <span className="text-xs text-muted">{h.degree} links</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Right: reasoning panels */}
          <div className="space-y-4 lg:col-span-2">
            {/* Path finder */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted">
                <Route className="size-4" /> How are these related?
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={fromId} onChange={(e) => setFromId(e.target.value)} className="min-w-40 flex-1">
                  <option value="">From…</option>
                  {graph.entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </Select>
                <ArrowRight className="size-4 text-muted" />
                <Select value={toId} onChange={(e) => setToId(e.target.value)} className="min-w-40 flex-1">
                  <option value="">To…</option>
                  {graph.entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </Select>
              </div>
              {fromId && toId && (
                <div className="mt-3 rounded-lg border border-border bg-muted/5 p-3 text-sm">
                  {path ? (
                    <span className="font-mono text-xs leading-relaxed">{describePath(index, path)}</span>
                  ) : (
                    <span className="text-muted">No relationship path found — try linking them.</span>
                  )}
                </div>
              )}
            </div>

            {/* Selected entity: connections + impact */}
            {selected ? (
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', KIND_STYLE[selected.kind] ?? KIND_STYLE.other)}>{selected.kind}</span>
                  <h3 className="text-base font-semibold">{selected.name}</h3>
                </div>

                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Directly connected</h4>
                {selectedNeighbours.length === 0 ? (
                  <p className="text-sm text-muted">Not linked to anything yet.</p>
                ) : (
                  <div className="mb-4 flex flex-wrap gap-2">
                    {selectedNeighbours.map((n, i) => (
                      <button
                        key={`${n.entity.id}-${i}`}
                        onClick={() => setSelectedId(n.entity.id)}
                        className="rounded-full border border-border px-3 py-1 text-xs hover:bg-muted/5"
                      >
                        <span className="text-muted">{n.direction === 'out' ? n.relation : `←${n.relation}`} </span>
                        {n.entity.name}
                      </button>
                    ))}
                  </div>
                )}

                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  <Zap className="size-3.5" /> If this changes, it ripples to…
                </h4>
                {selectedImpact.length === 0 ? (
                  <p className="text-sm text-muted">Nothing downstream — this is a leaf.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {selectedImpact.map((imp) => (
                      <li key={imp.entity.id} className="flex items-center gap-2 text-sm">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/10">
                          <div className="h-full rounded-full bg-amber-400/70" style={{ width: `${Math.round(imp.score * 100)}%` }} />
                        </div>
                        <button onClick={() => setSelectedId(imp.entity.id)} className="w-32 truncate text-right hover:underline">{imp.entity.name}</button>
                        <span className="w-10 text-right text-xs text-muted">{Math.round(imp.score * 100)}%</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
                Select an entity to see its connections and impact.
              </div>
            )}
          </div>
        </div>
      )}

      {addEntity && (
        <AddEntityModal
          familyId={familyId} userId={userId}
          onClose={() => setAddEntity(false)}
          onSaved={(name) => { success(`Added ${name}`); setAddEntity(false); }}
          onError={toastError}
        />
      )}
      {addEdge && (
        <AddEdgeModal
          familyId={familyId} userId={userId} entities={graph.entities}
          onClose={() => setAddEdge(false)}
          onSaved={() => { success('Linked'); setAddEdge(false); }}
          onError={toastError}
        />
      )}
    </div>
  );
}

function EmptyState({ onAdd, onRebuild, projecting }: { onAdd: () => void; onRebuild: () => void; projecting: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-10 text-center">
      <Network className="mx-auto mb-3 size-8 text-muted" />
      <h3 className="mb-1 text-base font-semibold">Build your family&apos;s graph</h3>
      <p className="mx-auto mb-4 max-w-md text-sm text-muted">
        Pull in the people, activities, schools, teams, vehicles and places you already track —
        or add them by hand. Once relationships are explicit, the AI can trace dependencies and
        predict ripple effects.
      </p>
      <div className="flex justify-center gap-2">
        <Button onClick={onRebuild} disabled={projecting}>
          <Sparkles className="size-4" /> {projecting ? 'Syncing…' : 'Build from my family data'}
        </Button>
        <Button variant="secondary" onClick={onAdd}><Plus className="size-4" /> Add manually</Button>
      </div>
    </div>
  );
}

function AddEntityModal({ familyId, userId, onClose, onSaved, onError }: {
  familyId: string; userId: string | null; onClose: () => void;
  onSaved: (name: string) => void; onError: (m: string) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<EntityKind>('person');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) { onError('Name is required'); return; }
    setSaving(true);
    const sb = createClient();
    const { error } = await sb.from('graph_entities').insert({ family_id: familyId, name: n, kind, created_by: userId });
    setSaving(false);
    if (error) { onError(describeDbError(error)); return; }
    onSaved(n);
  }
  return (
    <Modal open onClose={onClose} title="Add entity">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Emma, Soccer, Grandma's house…" autoFocus />}</Field>
        <Field label="Kind">{(id) => (
          <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as EntityKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
        )}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function AddEdgeModal({ familyId, userId, entities, onClose, onSaved, onError }: {
  familyId: string; userId: string | null; entities: GraphEntity[];
  onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [relation, setRelation] = useState('');
  const [weight, setWeight] = useState('0.8');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceId || !targetId) { onError('Pick both ends'); return; }
    if (sourceId === targetId) { onError('An entity can’t link to itself'); return; }
    const rel = relation.trim();
    if (!rel) { onError('Describe the relationship'); return; }
    setSaving(true);
    const sb = createClient();
    const { error } = await sb.from('graph_edges').insert({
      family_id: familyId, source_id: sourceId, target_id: targetId, relation: rel,
      weight: Math.min(1, Math.max(0, Number(weight) || 0.8)), created_by: userId,
    });
    setSaving(false);
    if (error) { onError(describeDbError(error)); return; }
    onSaved();
  }
  return (
    <Modal open onClose={onClose} title="Link two entities">
      <form onSubmit={submit} className="space-y-3">
        <Field label="From">{(id) => (
          <Select id={id} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">Choose…</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Relationship">{(id) => <Input id={id} value={relation} onChange={(e) => setRelation(e.target.value)} placeholder="plays, at, coached_by, needs, affects…" />}</Field>
        <Field label="To">{(id) => (
          <Select id={id} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Choose…</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Strength (0–1) — how strongly a change propagates">{(id) => (
          <Input id={id} type="number" min="0" max="1" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} />
        )}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Linking…' : 'Link'}</Button>
        </div>
      </form>
    </Modal>
  );
}
