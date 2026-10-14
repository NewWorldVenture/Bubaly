// N16 — the Knowledge Graph module read graph_entities and graph_edges in one
// unpaged request each, so both stopped at PostgREST's 1,000 rows, and with no
// ORDER BY those were an arbitrary 1,000. lib/reasoning/context.ts documents a
// household the twin projector gave 3,709 entities: its module header read
// "Entities (1000)", and its hubs, links, impact and the path finder were all
// worked out over part of the graph, while the server banner above it, paged,
// told the truth.
//
// Driven through the real GraphModule on hook slots, with the hook answering
// exactly what the component's own fetcher reads from an in-memory database
// capped at 1,000 rows a response, as a default Supabase project is.
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { has, nodes, render, settle, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).fetchedQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => ({ PageHeader: (await import('./helpers/module-harness')).ui.PageHeader }));
vi.mock('@/app/(app)/dashboard/graph/twin-actions', () => ({ projectTwinAction: async () => ({ ok: true, entities: 0, edges: 0 }) }));

const { GraphModule } = await import('@/components/modules/graph-module');

const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
let db: InMemorySupabase;
const id = (prefix: string, i: number) => `${prefix}-${String(i).padStart(5, '0')}`;

function household(entities: number, edges: number) {
  db.seed('graph_entities', Array.from({ length: entities }, (_, i) => ({
    id: id('ent', i), family_id: FAMILY, kind: i === 0 ? 'person' : 'activity', name: i === 0 ? 'Mum' : `Thing ${i}`,
    ref_table: null, ref_id: null, attributes: {},
  })));
  // Every edge runs from Mum, so she is the household's hub with a degree of `edges`.
  db.seed('graph_edges', Array.from({ length: edges }, (_, i) => ({
    id: id('edge', i), family_id: FAMILY, source_id: id('ent', 0), target_id: id('ent', 1 + (i % (entities - 1))), relation: 'drives', weight: 1,
  })));
}

async function screen() {
  render(h.hooks, createElement(GraphModule));
  await settle();
  return render(h.hooks, createElement(GraphModule));
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.rows = {};
  h.readErrors = {};
  Object.assign(h.app, { familyId: FAMILY, userId: 'user-1' });
});

describe('the Knowledge Graph module', () => {
  it('counts every entity, past the 1,000 rows one response carries', async () => {
    household(1500, 1200);
    const tree = await screen();
    expect(text(tree)).toContain('Entities (1500)');
    expect(text(tree)).not.toContain('Entities (1000)');
  });

  it('works out the hubs from every edge, not a part of them', async () => {
    household(1500, 1200);
    const tree = await screen();
    // Mum's degree, as the hub list states it.
    const hub = nodes(tree).find((n) => n.type === 'li' && text(n).startsWith('Mum'));
    expect(hub && text(hub)).toBe('Mum1200 links');
  });

  it('says it could not load rather than drawing part of a graph past its ceiling', async () => {
    household(4001, 10);
    const tree = await screen();
    expect(has(tree, 'Could not load the knowledge graph. Refresh and try again.')).toBe(true);
    expect(text(tree)).not.toContain('Entities (');
  });
});
