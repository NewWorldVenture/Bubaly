// Twin projection — service-callable core (no request context), shared by the
// on-demand server action and the model-refresh cron. Reads the family's real
// cross-domain tables, runs the pure projector, and upserts the result into the
// knowledge graph. Idempotent. Works with either an RLS user client or the
// service client (the cron passes the service client + null creator).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  projectTwin, projectionSummary, eventWindow, stalePrunableEntityIds,
  type TwinSnapshot,
} from './project';

type DB = SupabaseClient<Database>;

export type TwinProjectionResult = { ok: boolean; error?: string; entities: number; edges: number };

/** Row caps, so one huge household cannot blow the 4000-entity graph read budget. */
const ROW_LIMIT = 500;

/**
 * A read that failed is not an empty table. Log which table refused and hand the
 * caller a truthful error so the surface renders "Could not rebuild … Retry"
 * rather than a graph that silently lost a whole domain.
 */
function firstReadFailure(reads: Array<[string, { error: { message: string } | null }]>): string | null {
  for (const [table, res] of reads) {
    if (res.error) {
      console.error(`[twin] ${table} read failed`, res.error);
      return res.error.message;
    }
  }
  return null;
}

export async function runTwinProjection(sb: DB, familyId: string, createdBy: string | null, now: Date = new Date()): Promise<TwinProjectionResult> {
  const eventRange = eventWindow(now);
  const [members, pets, vehicles, classes, teams, routines, places, accounts, providers] = await Promise.all([
    sb.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    sb.from('pets').select('id, name, species').eq('family_id', familyId).eq('is_active', true),
    sb.from('vehicles').select('id, nickname, make, model, primary_driver').eq('family_id', familyId).is('deleted_at', null),
    sb.from('school_classes').select('id, member_id, subject').eq('family_id', familyId),
    sb.from('teams').select('id, member_id, sport').eq('family_id', familyId).eq('is_active', true),
    sb.from('family_routines').select('id, member_id, title').eq('family_id', familyId).eq('status', 'active'),
    sb.from('family_places').select('id, name').eq('family_id', familyId),
    sb.from('financial_accounts').select('id, name').eq('family_id', familyId),
    sb.from('health_providers').select('id, member_id, name, specialty').eq('family_id', familyId),
  ]);

  // M3 — the four kinds the household actually runs on. Read alongside the
  // people/pets/places core so one projection produces one coherent graph.
  const [events, homes, storageLocations, homeAssets, inventory, warranties, projects, bills, paperwork, renewals, preferences] = await Promise.all([
    sb.from('calendar_events').select('id, title, starts_at, ends_at, all_day, category, location, assignee_id')
      .eq('family_id', familyId).gte('starts_at', eventRange.from).lt('starts_at', eventRange.to).limit(ROW_LIMIT),
    sb.from('homes').select('id, name').eq('family_id', familyId).is('deleted_at', null),
    sb.from('home_locations').select('id, name, kind').eq('family_id', familyId).limit(ROW_LIMIT),
    sb.from('home_assets').select('id, name, category, home_id, location, warranty_until').eq('family_id', familyId).limit(ROW_LIMIT),
    sb.from('inventory_items').select('id, name, category, location_id, owner_member_id, status, value_cents')
      .eq('family_id', familyId).neq('status', 'disposed').limit(ROW_LIMIT),
    sb.from('home_warranties').select('id, name, provider, asset_id, home_id, expires_on, status')
      .eq('family_id', familyId).is('deleted_at', null).limit(ROW_LIMIT),
    sb.from('home_projects').select('id, title, status, room, owner_id, priority')
      .eq('family_id', familyId).in('status', ['idea', 'planning', 'quoting', 'scheduled', 'in_progress', 'on_hold']).limit(ROW_LIMIT),
    sb.from('bills').select('id, name, amount, due_date, status, category')
      .eq('family_id', familyId).neq('status', 'paid').limit(ROW_LIMIT),
    sb.from('paperwork_items').select('id, title, status, due_on, amount, kind, actions')
      .eq('family_id', familyId).in('status', ['needs_action', 'in_progress']).limit(ROW_LIMIT),
    sb.from('renewals').select('id, title, member_id, expires_at, cost, category, status')
      .eq('family_id', familyId).eq('status', 'active').limit(ROW_LIMIT),
    sb.from('family_facts').select('id, member_id, label, value, source, confidence')
      .eq('family_id', familyId).eq('category', 'preference').limit(ROW_LIMIT),
  ]);

  const readError = firstReadFailure([
    ['family_members', members], ['pets', pets], ['vehicles', vehicles], ['school_classes', classes],
    ['teams', teams], ['family_routines', routines], ['family_places', places],
    ['financial_accounts', accounts], ['health_providers', providers],
    ['calendar_events', events], ['homes', homes], ['home_locations', storageLocations],
    ['home_assets', homeAssets], ['inventory_items', inventory], ['home_warranties', warranties],
    ['home_projects', projects], ['bills', bills], ['paperwork_items', paperwork],
    ['renewals', renewals], ['family_facts', preferences],
  ]);
  if (readError) return { ok: false, error: readError, entities: 0, edges: 0 };

  const snap: TwinSnapshot = {
    members: (members.data ?? []).map((m) => ({ id: m.id, name: m.display_name })),
    pets: (pets.data ?? []).map((p) => ({ id: p.id, name: p.name, species: p.species })),
    vehicles: (vehicles.data ?? []).map((v) => ({
      id: v.id, label: v.nickname || [v.make, v.model].filter(Boolean).join(' ') || null, primary_driver: v.primary_driver,
    })),
    classes: (classes.data ?? []).map((c) => ({ id: c.id, member_id: c.member_id, subject: c.subject })),
    teams: (teams.data ?? []).map((t) => ({ id: t.id, member_id: t.member_id, sport: t.sport })),
    routines: (routines.data ?? []).map((r) => ({ id: r.id, member_id: r.member_id, title: r.title })),
    places: (places.data ?? []).map((p) => ({ id: p.id, name: p.name })),
    accounts: (accounts.data ?? []).map((a) => ({ id: a.id, name: a.name })),
    providers: (providers.data ?? []).map((p) => ({ id: p.id, member_id: p.member_id, name: p.name, specialty: p.specialty })),
    events: (events.data ?? []).map((e) => ({
      id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at,
      all_day: e.all_day, category: e.category, location: e.location, assignee_id: e.assignee_id,
    })),
    homes: (homes.data ?? []).map((h) => ({ id: h.id, name: h.name })),
    storageLocations: (storageLocations.data ?? []).map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
    homeAssets: (homeAssets.data ?? []).map((a) => ({
      id: a.id, name: a.name, category: a.category, home_id: a.home_id, location: a.location, warranty_until: a.warranty_until,
    })),
    inventory: (inventory.data ?? []).map((i) => ({
      id: i.id, name: i.name, category: i.category, location_id: i.location_id,
      owner_member_id: i.owner_member_id, status: i.status, value_cents: i.value_cents,
    })),
    warranties: (warranties.data ?? []).map((w) => ({
      id: w.id, name: w.name, provider: w.provider, asset_id: w.asset_id, home_id: w.home_id,
      expires_on: w.expires_on, status: w.status,
    })),
    projects: (projects.data ?? []).map((p) => ({
      id: p.id, title: p.title, status: p.status, room: p.room, owner_id: p.owner_id, priority: p.priority,
    })),
    bills: (bills.data ?? []).map((b) => ({
      id: b.id, name: b.name, amount: b.amount, due_date: b.due_date, status: b.status, category: b.category,
    })),
    paperwork: (paperwork.data ?? []).map((p) => ({
      id: p.id, title: p.title, status: p.status, due_on: p.due_on, amount: p.amount, kind: p.kind, actions: p.actions,
    })),
    renewals: (renewals.data ?? []).map((r) => ({
      id: r.id, title: r.title, member_id: r.member_id, expires_at: r.expires_at,
      cost: r.cost, category: r.category, status: r.status,
    })),
    preferences: (preferences.data ?? []).map((f) => ({
      id: f.id, member_id: f.member_id, label: f.label, value: f.value, source: f.source, confidence: f.confidence,
    })),
  };

  const projection = projectTwin(snap, { now });

  if (projection.entities.length > 0) {
    const entityRows = projection.entities.map((e) => ({
      family_id: familyId, kind: e.kind, name: e.name, ref_table: e.refTable, ref_id: e.refId,
      // Provenance lives in the jsonb because graph_entities has no source /
      // observed_at / confidence columns (adding them needs a migration).
      attributes: (e.attributes ?? {}) as Database['public']['Tables']['graph_entities']['Insert']['attributes'],
      created_by: createdBy,
    }));
    const { error: entErr } = await sb.from('graph_entities').upsert(entityRows, { onConflict: 'family_id,ref_table,ref_id' });
    if (entErr) {
      console.error('[twin] graph_entities upsert failed', entErr);
      return { ok: false, error: entErr.message, entities: 0, edges: 0 };
    }
  }

  const { data: idRows, error: readErr } = await sb.from('graph_entities')
    .select('id, ref_table, ref_id, attributes').eq('family_id', familyId).not('ref_id', 'is', null);
  if (readErr) {
    console.error('[twin] graph_entities read failed', readErr);
    return { ok: false, error: readErr.message, entities: 0, edges: 0 };
  }

  // Prune: a node whose source row is gone (an event that fell out of the
  // horizon, a sold vehicle, a paid bill) must not linger claiming to be
  // current. Only rows this projector owns and stamped are eligible — a
  // hand-made node survives. Edges cascade with the node (0129 FKs).
  const stale = stalePrunableEntityIds(idRows ?? [], projection);
  if (stale.length) {
    const { error: pruneErr } = await sb.from('graph_entities').delete().eq('family_id', familyId).in('id', stale);
    if (pruneErr) {
      console.error('[twin] graph_entities prune failed', pruneErr);
      return { ok: false, error: pruneErr.message, entities: 0, edges: 0 };
    }
  }
  const pruned = new Set(stale);

  const idByKey = new Map<string, string>();
  for (const r of idRows ?? []) {
    if (r.ref_table && r.ref_id && !pruned.has(r.id)) idByKey.set(`${r.ref_table}:${r.ref_id}`, r.id);
  }

  if (projection.entities.length === 0) return { ok: true, entities: 0, edges: 0 };

  const edgeRows = projection.edges
    .map((e) => {
      const source_id = idByKey.get(e.sourceKey);
      const target_id = idByKey.get(e.targetKey);
      if (!source_id || !target_id) return null;
      return {
        family_id: familyId, source_id, target_id, relation: e.relation, weight: e.weight,
        attributes: { provenance: { source: 'projection', observed_at: now.toISOString() } } as Database['public']['Tables']['graph_edges']['Insert']['attributes'],
        created_by: createdBy,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (edgeRows.length) {
    const { error: edgeErr } = await sb.from('graph_edges').upsert(edgeRows, { onConflict: 'family_id,source_id,target_id,relation' });
    if (edgeErr) {
      console.error('[twin] graph_edges upsert failed', edgeErr);
      return { ok: false, error: edgeErr.message, entities: 0, edges: 0 };
    }
  }

  const summary = projectionSummary(projection);
  return { ok: true, entities: summary.entities, edges: edgeRows.length };
}
