import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';

type Admin = SupabaseClient<Database>;

/**
 * Capture a demo-gate email as a DURABLE marketing lead + enroll it in the
 * demo follow-up campaign.
 *
 * Why this exists: `demo_sessions.email` is written to the ONE shared demo
 * account's row, so the next visitor's submission overwrites it — useless for
 * marketing. This writes a per-email `crm_contacts` row instead (deduped, never
 * downgrading an existing customer), then fires the `demo_started` automation
 * event so any active demo follow-up workflow runs in real time.
 *
 * Best-effort by contract: pass the service-role client, and callers wrap this so
 * a missing marketing table (crm_contacts / marketing_automation_*) can never
 * block the demo. Idempotent per email (the CRM upsert dedups; the automation
 * run dedups on the subject key).
 */
export async function captureDemoLead(admin: Admin, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return;

  try {
    // Durable CRM lead — dedup by email. Only INSERT when new so we never
    // downgrade an existing customer/lead's status back to a demo lead.
    const { data: existing } = await admin
      .from('crm_contacts').select('id').ilike('email', email).limit(1);
    if (!existing?.[0]?.id) {
      await admin.from('crm_contacts').insert({
        email,
        lead_source: 'demo',
        lead_status: 'lead',
        lifecycle_stage: 'lead',
        notes: JSON.stringify({ demo: true, captured_at: new Date().toISOString() }),
      } as never);
    }
  } catch (e) {
    console.error('[demo] crm lead upsert failed (crm_contacts applied?)', e);
  }

  try {
    // Enroll in the demo follow-up campaign (any active `demo_started` workflow).
    await fireAutomationEvent(admin, {
      trigger: 'demo_started',
      email,
      subjectKey: eventSubjectKey('demo_started', [email]),
      context: { source: 'demo' },
    });
  } catch (e) {
    console.error('[demo] demo_started automation fire failed', e);
  }
}
