import type { Metadata } from 'next';
import { Share2, Users, Network } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty, StatTile } from '@/components/family/shell';
import { layout, edgeLines, mostConnected, type GraphNode, type GraphEdge } from '@/lib/family/knowledge';

export const metadata: Metadata = { title: 'Knowledge Graph' };
export const dynamic = 'force-dynamic';

const TYPE_COLOR: Record<string, string> = {
  member: '#7c5dff', team: '#14b8a6', routine: '#f59e0b',
  class: '#3b82f6', goal: '#ec4899', event: '#22c55e', fact: '#22d3ee',
};
const SIZE = 640;
// Cap facts shown per member so the graph stays legible (pinned facts win).
const FACTS_PER_MEMBER = 3;

export default async function FamilyKnowledgeGraphPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date().toISOString();
  const in14 = new Date(Date.now() + 14 * 86400000).toISOString();

  const [{ data: members }, { data: teams }, { data: routines }, { data: classes }, { data: goals }, { data: events }, { data: facts }] = await Promise.all([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('teams').select('id, team_name, member_id').eq('family_id', familyId).eq('is_active', true).limit(12),
    supabase.from('family_routines').select('id, title, member_id').eq('family_id', familyId).eq('status', 'active').limit(12),
    supabase.from('school_classes').select('id, subject, member_id').eq('family_id', familyId).limit(12),
    supabase.from('goals').select('id, title').eq('family_id', familyId).eq('is_complete', false).limit(8),
    supabase.from('sports_events').select('id, title, member_id').eq('family_id', familyId).gte('starts_at', now).lte('starts_at', in14).limit(10),
    // Member-tagged facts become knowledge nodes (pinned first). Missing table
    // (pre-0123) degrades to null → no fact nodes, never an error.
    supabase.from('family_facts').select('id, label, member_id, is_pinned').eq('family_id', familyId).not('member_id', 'is', null).order('is_pinned', { ascending: false }).limit(60),
  ]);

  // Build a real, data-backed graph: members at the center, their owned items
  // (teams, routines, classes, events) as spokes; family goals link to all.
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const push = (id: string, label: string, type: string) => { nodes.push({ id, label, type }); };

  for (const m of members ?? []) push(`m:${m.id}`, m.display_name, 'member');
  const link = (childId: string, label: string, type: string, memberId: string | null, relation: string) => {
    push(childId, label, type);
    if (memberId) edges.push({ source: `m:${memberId}`, target: childId, relation });
  };
  for (const t of teams ?? []) link(`t:${t.id}`, t.team_name, 'team', t.member_id, 'plays_on');
  for (const r of routines ?? []) link(`r:${r.id}`, r.title, 'routine', r.member_id, 'follows');
  for (const c of classes ?? []) link(`c:${c.id}`, c.subject, 'class', c.member_id, 'enrolled_in');
  for (const e of events ?? []) link(`e:${e.id}`, e.title, 'event', e.member_id, 'scheduled_for');
  for (const g of goals ?? []) {
    push(`g:${g.id}`, g.title, 'goal');
    for (const m of members ?? []) edges.push({ source: `m:${m.id}`, target: `g:${g.id}`, relation: 'works_toward' });
  }
  // Facts the family knows about each member — capped per member (pinned first,
  // which the query already ordered) so the map reads as knowledge, not noise.
  const factCountByMember = new Map<string, number>();
  for (const fct of facts ?? []) {
    const owner = fct.member_id!;
    const n = factCountByMember.get(owner) ?? 0;
    if (n >= FACTS_PER_MEMBER) continue;
    factCountByMember.set(owner, n + 1);
    link(`f:${fct.id}`, fct.label, 'fact', owner, 'knows');
  }

  const positioned = layout(nodes, edges, { width: SIZE, height: SIZE });
  const lines = edgeLines(edges, positioned);
  const hubs = mostConnected(nodes, edges, 5);
  const labelById = new Map(nodes.map((n) => [n.id, n.label]));

  return (
    <div className="space-y-5">
      <PageHeader title="Family Knowledge Graph" description="How everyone and everything in your household connects — and what the AI reasons over." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="People" value={members?.length ?? 0} icon={Users} accent="bg-violet-600" />
        <StatTile label="Nodes" value={nodes.length} icon={Network} accent="bg-blue-600" />
        <StatTile label="Connections" value={edges.length} icon={Share2} accent="bg-emerald-600" />
        <StatTile label="Facts known" value={facts?.length ?? 0} icon={Network} accent="bg-cyan-600" />
        <StatTile label="Goals linked" value={goals?.length ?? 0} icon={Share2} accent="bg-pink-600" />
      </div>

      <SectionCard title="Relationship Map">
        {nodes.length > 0 ? (
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="mx-auto h-auto w-full max-w-[640px]" role="img" aria-label="Family knowledge graph">
              {lines.map((l, i) => (
                <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
              ))}
              {positioned.map((n) => {
                const r = n.type === 'member' ? 9 + Math.min(n.degree, 6) : 6;
                return (
                  <g key={n.id}>
                    <circle cx={n.x} cy={n.y} r={r} fill={TYPE_COLOR[n.type] ?? '#888'} opacity={0.9} />
                    <text x={n.x} y={n.y - r - 4} textAnchor="middle" fontSize={n.type === 'member' ? 12 : 9}
                      fill={n.type === 'member' ? '#fff' : 'rgba(255,255,255,0.55)'} className="select-none">
                      {n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="mt-3 flex flex-wrap justify-center gap-3 text-xs text-muted">
              {Object.entries(TYPE_COLOR).map(([type, color]) => (
                <span key={type} className="inline-flex items-center gap-1.5 capitalize">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} /> {type}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <MiniEmpty icon={Network} text="Add members, teams, classes, goals and Knowledge Base facts to grow the graph." />
        )}
      </SectionCard>

      {hubs.length > 0 && (
        <SectionCard title="Most Connected" description="The nodes the AI leans on most for recommendations">
          <ul className="space-y-2">
            {hubs.map((h) => (
              <li key={h.id} className="flex items-center gap-3 text-sm">
                <span className="h-3 w-3 rounded-full" style={{ background: TYPE_COLOR[h.type] ?? '#888' }} />
                <span className="min-w-0 flex-1 truncate">{labelById.get(h.id)}</span>
                <span className="text-xs text-muted">{h.degree} connection{h.degree === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
