// lib/guardian/learning-run.ts — runs the Adaptive AI Learning loop for one family.
// Reads recent communications + the trust graph, runs the pure analyzer, de-dupes
// against existing pending suggestions, and inserts the new proposals. Shared by
// the parent-triggered server action and the nightly cron so the logic lives once.

import type { SupabaseClient } from '@supabase/supabase-js';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { analyzeCommunications, type CommSummary, type ContactSummary } from './learning';

/** How far back the learning loop looks. */
const LOOKBACK_DAYS = 60;
const MAX_COMMS = 1000;

export type LearningRunResult = { analyzed: number; created: number; skipped: number };

export async function runLearningForFamily(
  supabase: SupabaseClient,
  familyId: string,
): Promise<LearningRunResult> {
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: comms }, { data: contacts }, { data: pending }] = await Promise.all([
    gFrom('guardian_communications')
      .select('from_number, contact_id, scam_detected, trust_level_at_time, started_at')
      .eq('family_id', familyId)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(MAX_COMMS),
    gFrom('guardian_contacts')
      .select('id, phone, name, trust_level, trust_override')
      .eq('family_id', familyId),
    gFrom('guardian_suggestions')
      .select('evidence, suggestion_type, proposed_contact_id, proposed_trust_level')
      .eq('family_id', familyId)
      .eq('status', 'pending'),
  ]);

  const drafts = analyzeCommunications({
    communications: (comms ?? []) as unknown as CommSummary[],
    contacts: (contacts ?? []) as unknown as ContactSummary[],
  });

  // Build the set of dedupeKeys already represented by a pending suggestion.
  // We reconstruct each pending suggestion's key from its stored evidence/fields.
  const existingKeys = new Set<string>();
  for (const p of (pending ?? []) as Array<{
    evidence: Record<string, unknown> | null;
    suggestion_type: string;
    proposed_contact_id: string | null;
    proposed_trust_level: string | null;
  }>) {
    const ev = p.evidence ?? {};
    const phone = typeof ev.phone === 'string' ? ev.phone : null;
    if (p.suggestion_type === 'block_contact' || p.suggestion_type === 'flag_scam') {
      if (phone) existingKeys.add(`block:${phone}`);
      if (p.proposed_contact_id) existingKeys.add(`block:${p.proposed_contact_id}`);
    } else if (p.suggestion_type === 'update_trust') {
      if (phone && p.proposed_trust_level) existingKeys.add(`trust:${phone}:${p.proposed_trust_level}`);
      if (p.proposed_contact_id && p.proposed_trust_level) existingKeys.add(`trust:${p.proposed_contact_id}:${p.proposed_trust_level}`);
    } else if (p.suggestion_type === 'new_rule') {
      existingKeys.add('rule:quiet_hours_unknown');
    }
  }

  let created = 0;
  let skipped = 0;
  for (const draft of drafts) {
    if (existingKeys.has(draft.dedupeKey)) { skipped++; continue; }
    const { error } = await gFrom('guardian_suggestions').insert({
      family_id: familyId,
      suggestion_type: draft.suggestion_type,
      title: draft.title,
      reasoning: draft.reasoning,
      evidence: draft.evidence,
      proposed_contact_id: draft.proposed_contact_id ?? null,
      proposed_trust_level: draft.proposed_trust_level ?? null,
      proposed_rule_data: draft.proposed_rule_data ?? null,
    });
    if (error) { skipped++; continue; }
    existingKeys.add(draft.dedupeKey);
    created++;
  }

  // Audit the learning run (best-effort).
  if (created > 0) {
    await gFrom('guardian_audit_log').insert({
      family_id: familyId,
      actor: 'ai',
      action: 'learning.suggestions_generated',
      entity_type: 'guardian_suggestions',
      detail: { created, skipped, analyzed: (comms ?? []).length },
    }).then(() => {}, () => {});
  }

  return { analyzed: (comms ?? []).length, created, skipped };
}
