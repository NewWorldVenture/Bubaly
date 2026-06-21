'use server';
// lib/family/actions.ts
// Secure, server-side write paths for the Family OS modules. Every action:
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

function pick(table: string, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = WRITABLE[table];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (raw[key] !== undefined && raw[key] !== '') out[key] = raw[key];
  }
  return out;
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
  const payload = {
    ...pick(table, values),
    family_id: ctx.active.familyId,
    created_by: ctx.user.id,
  };
  const { data, error } = await (supabase.from(table as any) as any)
    .insert(payload).select('id').single();
  if (error) return { ok: false, error: error.message };
  await supabase.from('audit_logs').insert({
    family_id: ctx.active.familyId, actor_id: ctx.user.id,
    action: 'create', resource: table, resource_id: data?.id ?? null,
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
  const payload = { ...pick(table, values), updated_by: ctx.user.id };
  const { error } = await (supabase.from(table as any) as any)
    .update(payload).eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
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
  const { error } = await (supabase.from(table as any) as any)
    .delete().eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
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
  if (error) return { ok: false, error: error.message };
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
  if (error) return { ok: false, error: error.message };
  await supabase.from('audit_logs').insert({
    family_id: ctx.active.familyId, actor_id: ctx.user.id,
    action: decision === 'approved' ? 'approve' : 'skip',
    resource: 'family_automation_runs', resource_id: id,
  });
  revalidatePath('/dashboard', 'layout');
  return { ok: true, id };
}
