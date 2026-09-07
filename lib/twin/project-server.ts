// Twin projection — service-callable core (no request context), shared by the
// on-demand server action and the model-refresh cron. Reads the family's real
// cross-domain tables, runs the pure projector, and upserts the result into the
// knowledge graph. Idempotent. Works with either an RLS user client or the
// service client (the cron passes the service client + null creator).

import type { SupabaseClient } from '@supabase/supabase-js';
import { settleAll } from '@/lib/supabase/settle';
import type { Database } from '@/lib/database.types';
import { projectTwin, projectionSummary, type TwinSnapshot } from './project';

type DB = SupabaseClient<Database>;

export type TwinProjectionResult = { ok: boolean; error?: string; entities: number; edges: number };

export async function runTwinProjection(sb: DB, familyId: string, createdBy: string | null): Promise<TwinProjectionResult> {
  const [members, pets, vehicles, classes, teams, routines, places, accounts, providers] = await settleAll([
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

  const firstErr = [members, pets, vehicles, classes, teams, routines, places, accounts, providers].find((r) => r.error)?.error;
  if (firstErr) return { ok: false, error: firstErr.message, entities: 0, edges: 0 };

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
  };

  const projection = projectTwin(snap);
  if (projection.entities.length === 0) return { ok: true, entities: 0, edges: 0 };

  const entityRows = projection.entities.map((e) => ({
    family_id: familyId, kind: e.kind, name: e.name, ref_table: e.refTable, ref_id: e.refId, created_by: createdBy,
  }));
  const { error: entErr } = await sb.from('graph_entities').upsert(entityRows, { onConflict: 'family_id,ref_table,ref_id' });
  if (entErr) return { ok: false, error: entErr.message, entities: 0, edges: 0 };

  const { data: idRows, error: readErr } = await sb.from('graph_entities')
    .select('id, ref_table, ref_id').eq('family_id', familyId).not('ref_id', 'is', null);
  if (readErr) return { ok: false, error: readErr.message, entities: 0, edges: 0 };
  const idByKey = new Map<string, string>();
  for (const r of idRows ?? []) if (r.ref_table && r.ref_id) idByKey.set(`${r.ref_table}:${r.ref_id}`, r.id);

  const edgeRows = projection.edges
    .map((e) => {
      const source_id = idByKey.get(e.sourceKey);
      const target_id = idByKey.get(e.targetKey);
      if (!source_id || !target_id) return null;
      return { family_id: familyId, source_id, target_id, relation: e.relation, weight: e.weight, created_by: createdBy };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (edgeRows.length) {
    const { error: edgeErr } = await sb.from('graph_edges').upsert(edgeRows, { onConflict: 'family_id,source_id,target_id,relation' });
    if (edgeErr) return { ok: false, error: edgeErr.message, entities: 0, edges: 0 };
  }

  const summary = projectionSummary(projection);
  return { ok: true, entities: summary.entities, edges: edgeRows.length };
}
