'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { revalidatePath } from 'next/cache';
import type { TrustLevel } from '@/lib/guardian/trust';
import type { RoutingMode } from '@/lib/guardian/pipeline';
import { runLearningForFamily } from '@/lib/guardian/learning-run';

type ActionResult<T = void> = { ok: true; data?: T } | { ok: false; error: string };

// ── Contacts ────────────────────────────────────────────────────────────────

export async function upsertContactAction(input: {
  id?: string;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  trust_level: TrustLevel;
  member_id?: string;
}): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;

  const payload = {
    family_id: familyId,
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    notes: input.notes?.trim() || null,
    trust_level: input.trust_level,
    trust_override: true,
    member_id: input.member_id || null,
    created_by: userId,
  };

  let result: { data: { id: string } | null; error: { message: string } | null };
  if (input.id) {
    result = await (db.from('guardian_contacts') as ReturnType<typeof supabase.from>)
      .update({ ...payload, created_by: undefined })
      .eq('id', input.id)
      .eq('family_id', familyId)
      .select('id')
      .single() as typeof result;
  } else {
    result = await (db.from('guardian_contacts') as ReturnType<typeof supabase.from>)
      .insert(payload)
      .select('id')
      .single() as typeof result;
  }

  if (result.error) return { ok: false, error: result.error.message };
  const id = (result.data as { id: string }).id;

  await (db.from('guardian_audit_log') as ReturnType<typeof supabase.from>).insert({
    family_id: familyId,
    actor_user_id: userId,
    actor: 'parent',
    action: input.id ? 'contact.updated' : 'contact.created',
    entity_type: 'guardian_contacts',
    entity_id: id,
    detail: { trust_level: input.trust_level, name: input.name },
  });

  revalidatePath('/guardian');
  revalidatePath('/guardian/contacts');
  return { ok: true, data: { id } };
}

export async function deleteContactAction(contactId: string): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const { error } = await (db.from('guardian_contacts') as ReturnType<typeof supabase.from>)
    .delete()
    .eq('id', contactId)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/guardian/contacts');
  return { ok: true };
}

export async function updateContactTrustAction(
  contactId: string,
  trustLevel: TrustLevel,
): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const familyId = ctx.active.familyId;

  const { error } = await (db.from('guardian_contacts') as ReturnType<typeof supabase.from>)
    .update({ trust_level: trustLevel, trust_override: true })
    .eq('id', contactId)
    .eq('family_id', familyId);

  if (error) return { ok: false, error: error.message };

  await (db.from('guardian_audit_log') as ReturnType<typeof supabase.from>).insert({
    family_id: familyId,
    actor_user_id: ctx.user.id,
    actor: 'parent',
    action: 'contact.trust_updated',
    entity_type: 'guardian_contacts',
    entity_id: contactId,
    detail: { trust_level: trustLevel },
  });

  revalidatePath('/guardian/contacts');
  revalidatePath('/guardian');
  return { ok: true };
}

// ── Member Profile ───────────────────────────────────────────────────────────

export async function upsertMemberProfileAction(input: {
  member_id: string;
  ai_persona_name?: string;
  ai_greeting_template?: string;
  voicemail_greeting?: string;
  current_context?: string;
  default_mode_unknown?: RoutingMode;
  default_mode_known?: RoutingMode;
  default_mode_suspected_spam?: RoutingMode;
  context_overrides?: Record<string, RoutingMode>;
}): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const familyId = ctx.active.familyId;

  const payload: Record<string, unknown> = {
    family_id: familyId,
    member_id: input.member_id,
  };
  if (input.ai_persona_name !== undefined) payload.ai_persona_name = input.ai_persona_name;
  if (input.ai_greeting_template !== undefined) payload.ai_greeting_template = input.ai_greeting_template;
  if (input.voicemail_greeting !== undefined) payload.voicemail_greeting = input.voicemail_greeting;
  if (input.current_context !== undefined) payload.current_context = input.current_context;
  if (input.default_mode_unknown !== undefined) payload.default_mode_unknown = input.default_mode_unknown;
  if (input.default_mode_known !== undefined) payload.default_mode_known = input.default_mode_known;
  if (input.default_mode_suspected_spam !== undefined) payload.default_mode_suspected_spam = input.default_mode_suspected_spam;
  if (input.context_overrides !== undefined) payload.context_overrides = input.context_overrides;

  const { error } = await (db.from('guardian_member_profiles') as ReturnType<typeof supabase.from>)
    .upsert(payload, { onConflict: 'family_id,member_id' });

  if (error) return { ok: false, error: error.message };

  revalidatePath('/guardian/settings');
  revalidatePath('/guardian');
  return { ok: true };
}

export async function updateContextAction(
  memberId: string,
  context: string,
): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  const { error } = await (db.from('guardian_member_profiles') as ReturnType<typeof supabase.from>)
    .update({ current_context: context })
    .eq('member_id', memberId)
    .eq('family_id', ctx.active.familyId);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/guardian');
  return { ok: true };
}

/**
 * Assign (or clear) the Bubaly Guardian phone number for a member.
 * Normalizes to E.164 and enforces uniqueness across the family's profiles.
 */
export async function assignGuardianPhoneAction(input: {
  member_id: string;
  phone: string;
}): Promise<ActionResult<{ phone: string | null }>> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const familyId = ctx.active.familyId;

  // Normalize: strip everything but digits/+, coerce to E.164 (assume US if 10 digits).
  const raw = input.phone.trim();
  let phone: string | null = null;
  if (raw) {
    const digits = raw.replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) phone = digits;
    else if (digits.length === 10) phone = `+1${digits}`;
    else if (digits.length === 11 && digits.startsWith('1')) phone = `+${digits}`;
    else phone = `+${digits.replace(/^\+/, '')}`;
    if (!/^\+\d{8,15}$/.test(phone)) {
      return { ok: false, error: 'Enter a valid phone number (e.g. (555) 123-4567).' };
    }
  }

  // Guard against assigning the same Guardian number to two members.
  if (phone) {
    const { data: clash } = await (db.from('guardian_member_profiles') as ReturnType<typeof supabase.from>)
      .select('member_id')
      .eq('family_id', familyId)
      .eq('guardian_phone', phone)
      .neq('member_id', input.member_id)
      .maybeSingle();
    if (clash) return { ok: false, error: 'That number is already assigned to another family member.' };
  }

  const { error } = await (db.from('guardian_member_profiles') as ReturnType<typeof supabase.from>)
    .upsert(
      { family_id: familyId, member_id: input.member_id, guardian_phone: phone },
      { onConflict: 'family_id,member_id' },
    );

  if (error) return { ok: false, error: error.message };

  await (db.from('guardian_audit_log') as ReturnType<typeof supabase.from>).insert({
    family_id: familyId,
    actor_user_id: ctx.user.id,
    actor: 'parent',
    action: phone ? 'profile.guardian_phone_assigned' : 'profile.guardian_phone_cleared',
    entity_type: 'guardian_member_profiles',
    detail: { member_id: input.member_id, guardian_phone: phone },
  });

  revalidatePath('/guardian/settings');
  revalidatePath('/guardian');
  return { ok: true, data: { phone } };
}

// ── Rules ────────────────────────────────────────────────────────────────────

export async function createRuleAction(input: {
  name: string;
  description?: string;
  priority?: number;
  condition_trust_levels?: TrustLevel[];
  condition_time_start?: string;
  condition_time_end?: string;
  condition_days_of_week?: number[];
  condition_contexts?: string[];
  condition_caller_pattern?: string;
  condition_contact_id?: string;
  action_routing_mode: RoutingMode;
  member_id?: string;
}): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;

  const { data, error } = await (db.from('guardian_routing_rules') as ReturnType<typeof supabase.from>)
    .insert({
      family_id: familyId,
      name: input.name,
      description: input.description || null,
      priority: input.priority ?? 100,
      is_active: true,
      member_id: input.member_id || null,
      condition_trust_levels: input.condition_trust_levels || null,
      condition_time_start: input.condition_time_start || null,
      condition_time_end: input.condition_time_end || null,
      condition_days_of_week: input.condition_days_of_week || null,
      condition_contexts: input.condition_contexts || null,
      condition_caller_pattern: input.condition_caller_pattern || null,
      condition_contact_id: input.condition_contact_id || null,
      action_routing_mode: input.action_routing_mode,
      created_by: userId,
      ai_suggested: false,
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) return { ok: false, error: error.message };
  const id = (data as { id: string }).id;

  await (db.from('guardian_audit_log') as ReturnType<typeof supabase.from>).insert({
    family_id: familyId,
    actor_user_id: userId,
    actor: 'parent',
    action: 'rule.created',
    entity_type: 'guardian_routing_rules',
    entity_id: id,
    detail: { name: input.name, action_routing_mode: input.action_routing_mode },
  });

  revalidatePath('/guardian/rules');
  return { ok: true, data: { id } };
}

export async function toggleRuleAction(ruleId: string, isActive: boolean): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const { error } = await (db.from('guardian_routing_rules') as ReturnType<typeof supabase.from>)
    .update({ is_active: isActive })
    .eq('id', ruleId)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/guardian/rules');
  return { ok: true };
}

export async function deleteRuleAction(ruleId: string): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const { error } = await (db.from('guardian_routing_rules') as ReturnType<typeof supabase.from>)
    .delete()
    .eq('id', ruleId)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/guardian/rules');
  return { ok: true };
}

// ── Suggestions ─────────────────────────────────────────────────────────────

/**
 * Run the Adaptive AI Learning loop on demand (parent taps "Scan for tips").
 * Analyzes recent communications and proposes parent-approvable changes.
 */
export async function generateGuardianSuggestionsAction(): Promise<ActionResult<{ created: number }>> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const result = await runLearningForFamily(supabase, ctx.active.familyId);
  revalidatePath('/guardian');
  return { ok: true, data: { created: result.created } };
}

export async function reviewSuggestionAction(
  suggestionId: string,
  decision: 'approved' | 'dismissed',
  note?: string,
): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;

  const { data: suggestion } = await (db.from('guardian_suggestions') as ReturnType<typeof supabase.from>)
    .select('*')
    .eq('id', suggestionId)
    .eq('family_id', familyId)
    .maybeSingle();

  if (!suggestion) return { ok: false, error: 'Suggestion not found' };

  await (db.from('guardian_suggestions') as ReturnType<typeof supabase.from>).update({
    status: decision,
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    review_note: note || null,
  }).eq('id', suggestionId);

  if (decision === 'approved') {
    const s = suggestion as {
      suggestion_type: string;
      proposed_contact_id: string | null;
      proposed_trust_level: TrustLevel | null;
      proposed_rule_data: Record<string, unknown> | null;
    };

    if (s.suggestion_type === 'update_trust' && s.proposed_contact_id && s.proposed_trust_level) {
      await (db.from('guardian_contacts') as ReturnType<typeof supabase.from>)
        .update({ trust_level: s.proposed_trust_level, trust_override: true })
        .eq('id', s.proposed_contact_id)
        .eq('family_id', familyId);
    }

    if (s.suggestion_type === 'new_rule' && s.proposed_rule_data) {
      await (db.from('guardian_routing_rules') as ReturnType<typeof supabase.from>).insert({
        ...s.proposed_rule_data,
        family_id: familyId,
        ai_suggested: true,
        approved_by: userId,
        approved_at: new Date().toISOString(),
      });
    }

    await (db.from('guardian_audit_log') as ReturnType<typeof supabase.from>).insert({
      family_id: familyId,
      actor_user_id: userId,
      actor: 'parent',
      action: 'suggestion.approved',
      entity_type: 'guardian_suggestions',
      entity_id: suggestionId,
    });
  }

  revalidatePath('/guardian');
  return { ok: true };
}

// ── Escalation Acknowledge ───────────────────────────────────────────────────

export async function acknowledgeEscalationAction(escalationId: string): Promise<ActionResult> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const db = withGuardianTables(supabase);
  const { error } = await (db.from('guardian_escalations') as ReturnType<typeof supabase.from>)
    .update({ acknowledged_by: ctx.user.id, acknowledged_at: new Date().toISOString() })
    .eq('id', escalationId)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/guardian');
  return { ok: true };
}
