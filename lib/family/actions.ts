'use server';
// lib/family/actions.ts
// Secure, server-side write paths for the Bubaly modules. Every action:
//   1. resolves the signed-in user + active family on the server (never trusts a
//      client-supplied family_id),
//   2. writes through the RLS-bound server client (is_family_member enforces
//      isolation as a hard boundary on top of this code),
//   3. only allows a whitelisted set of tables + columns (no arbitrary writes),
//   4. records an audit log entry.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { describeActionError } from '@/lib/supabase/errors';
import { knowledgeGraphTarget, toCanonicalGraphRow } from '@/lib/twin/project';

// Tables a member may write through these generic actions, with the columns
// each accepts. family_id / created_by / updated_by are always set server-side.
const WRITABLE: Record<string, string[]> = {
  family_routines: ['member_id', 'title', 'description', 'category', 'time_of_day', 'days_of_week', 'status'],
  family_digital_twin_profiles: ['member_id', 'strengths', 'notes', 'ai_insights', 'stress_baseline', 'preferences', 'responsibilities'],
  family_ai_recommendations: ['member_id', 'category', 'title', 'body', 'priority', 'cta_href', 'source', 'status'],
  family_stress_signals: ['member_id', 'signal_type', 'weight', 'source', 'occurred_on', 'notes'],
  family_automation_rules: ['name', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'is_enabled', 'requires_approval'],
  family_knowledge_nodes: ['member_id', 'node_type', 'label', 'ref_table', 'ref_id', 'weight'],
  family_knowledge_edges: ['source_id', 'target_id', 'relation', 'weight'],
  family_emergency_contacts: ['member_id', 'name', 'relationship', 'phone', 'alt_phone', 'email', 'address', 'is_primary', 'can_pickup', 'priority', 'notes'],
  family_emergency_plans: ['title', 'plan_type', 'content', 'safe_location', 'instructions', 'is_active'],
  family_memories: ['member_id', 'title', 'body', 'kind', 'memory_date', 'tags', 'is_favorite'],
  family_milestones: ['member_id', 'title', 'description', 'milestone_date', 'category'],
};

// Sensitive surfaces only managers (parent/adult) may modify.
const MANAGER_ONLY = new Set([
  'family_automation_rules',
  'family_emergency_contacts',
  'family_emergency_plans',
  'family_digital_twin_profiles',
]);

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

function actionFailure(operation: string, error: unknown): ActionResult {
  console.error(`[family-action] ${operation} failed:`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
}

function pick(table: string, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = WRITABLE[table];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (raw[key] !== undefined && raw[key] !== '') out[key] = raw[key];
  }
  return out;
}

// M3 — one graph, not two. The legacy `family_knowledge_nodes`/`_edges` tables
// (0022) are a second knowledge graph that nothing renders and that no reasoning
// surface reads; `graph_entities`/`graph_edges` (0129) is the canonical one that
// `loadFamilyContext` walks. A write aimed at the legacy tables is translated and
// landed in the canonical graph, stamped `provenance.source = 'manual'`, so a
// hand-made node is reasoned over like every other node — and is distinguishable
// from a projected one. The legacy tables are left untouched.
function graphWrite(table: string, values: Record<string, unknown>): { target: string; payload: Record<string, unknown> } {
  const target = knowledgeGraphTarget(table);
  if (!target) return { target: table, payload: pick(table, values) };
  return { target, payload: toCanonicalGraphRow(target, pick(table, values), new Date().toISOString()) };
}

export async function createFamilyRecord(
  table: string,
  values: Record<string, unknown>,
): Promise<ActionResult> {
  if (!(table in WRITABLE)) return { ok: false, error: 'Unknown record type.' };
  const ctx = await requireUserContext();
  if (MANAGER_ONLY.has(table) && !isManager(ctx.active.role)) {
    return { ok: false, error: 'Only parents and adults can change this.' };
  }
  const supabase = await createServer();
  const { target, payload: mapped } = graphWrite(table, values);
  const payload: Record<string, unknown> = {
    ...mapped,
    family_id: ctx.active.familyId,
    created_by: ctx.user.id,
  };
  const writer = supabase.from(target as any) as any;
  // A canonical node that mirrors an existing row is unique on
  // (family_id, ref_table, ref_id) (0129), so a manual write naming a row the
  // projector already covers updates that node instead of failing on the index.
  const query = target === 'graph_entities' && payload.ref_table && payload.ref_id
    ? writer.upsert(payload, { onConflict: 'family_id,ref_table,ref_id' })
    : writer.insert(payload);
  const { data, error } = await query.select('id').single();
  if (error) return actionFailure('create that record', error);
  await supabase.from('audit_logs').insert({
    family_id: ctx.active.familyId, actor_id: ctx.user.id,
    action: 'create', resource: target, resource_id: data?.id ?? null,
  });
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id: data?.id };
}

export async function updateFamilyRecord(
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<ActionResult> {
  if (!(table in WRITABLE)) return { ok: false, error: 'Unknown record type.' };
  const ctx = await requireUserContext();
  if (MANAGER_ONLY.has(table) && !isManager(ctx.active.role)) {
    return { ok: false, error: 'Only parents and adults can change this.' };
  }
  const supabase = await createServer();
  const { target, payload: mapped } = graphWrite(table, values);
  // graph_entities / graph_edges have no `updated_by` column (0129); every other
  // whitelisted table does.
  const payload = target === table ? { ...mapped, updated_by: ctx.user.id } : mapped;
  const { error } = await (supabase.from(target as any) as any)
    .update(payload).eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('update that record', error);
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}

export async function deleteFamilyRecord(table: string, id: string): Promise<ActionResult> {
  if (!(table in WRITABLE)) return { ok: false, error: 'Unknown record type.' };
  const ctx = await requireUserContext();
  if (MANAGER_ONLY.has(table) && !isManager(ctx.active.role)) {
    return { ok: false, error: 'Only parents and adults can change this.' };
  }
  const supabase = await createServer();
  const target = knowledgeGraphTarget(table) ?? table;
  const { error } = await (supabase.from(target as any) as any)
    .delete().eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('delete that record', error);
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}

/** Accept / dismiss / complete an AI recommendation. */
export async function setRecommendationStatus(
  id: string,
  status: 'accepted' | 'dismissed' | 'done',
): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('family_ai_recommendations')
    .update({ status, updated_by: ctx.user.id })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('update that recommendation', error);
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}

/** Approve or skip a pending autonomous automation run (manager-gated). */
export async function resolveAutomationRun(
  id: string,
  decision: 'approved' | 'skipped',
): Promise<ActionResult> {
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) {
    return { ok: false, error: 'Only parents and adults can approve automations.' };
  }
  const supabase = await createServer();
  const { error } = await supabase
    .from('family_automation_runs')
    .update({
      status: decision === 'approved' ? 'approved' : 'skipped',
      approved_by: ctx.user.id,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId);
  if (error) return actionFailure('resolve that automation', error);
  await supabase.from('audit_logs').insert({
    family_id: ctx.active.familyId, actor_id: ctx.user.id,
    action: decision === 'approved' ? 'approve' : 'skip',
    resource: 'family_automation_runs', resource_id: id,
  });
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}
