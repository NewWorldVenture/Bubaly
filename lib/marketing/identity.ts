import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { decideStitch, shouldCarryConsent, type StitchDecision } from './identity-core';

type Admin = SupabaseClient<Database>;

export type StitchResult = { decision: StitchDecision; contactId: string | null };

/**
 * Identity stitch: when an anonymous visitor signs up / logs in, connect their
 * anonymous CDP spine (`mkt_visitors`) to their durable `crm_contacts` lead by
 * email, and carry their consent ledger forward (stamp `mkt_consent_events.
 * contact_id`). This is what turns anonymous acquisition data into attributed,
 * per-person marketing ROI.
 *
 * Best-effort + idempotent: dedupes the contact by email, never downgrades an
 * existing lead/customer, and on a `fork` (a DIFFERENT contact already owns this
 * device's visitor row → a second person on a shared device) it deliberately
 * does NOTHING to the existing rows, returning `fork` so the caller rotates the
 * anonymous id and the new person starts a clean spine.
 */
export async function stitchVisitorIdentity(
  admin: Admin,
  params: { anonymousId: string; email: string; userId: string },
): Promise<StitchResult> {
  const email = params.email.trim().toLowerCase();
  const anonymousId = params.anonymousId.trim();
  if (!anonymousId || !email) return { decision: 'noop', contactId: null };

  // 1. Find or create the durable contact (dedupe by email; never downgrade).
  let contactId: string;
  try {
    const { data: existing } = await admin
      .from('crm_contacts').select('id, owner_id').ilike('email', email).limit(1);
    if (existing?.[0]?.id) {
      contactId = existing[0].id;
      const patch: Record<string, unknown> = { lifecycle_stage: 'customer' };
      if (existing[0].owner_id == null) patch.owner_id = params.userId;
      await admin.from('crm_contacts').update(patch as never).eq('id', contactId);
    } else {
      const { data: created } = await admin.from('crm_contacts').insert({
        email, owner_id: params.userId,
        lead_source: 'signup', lead_status: 'customer', lifecycle_stage: 'customer',
      } as never).select('id').single();
      if (!created) return { decision: 'noop', contactId: null };
      contactId = created.id;
    }
  } catch (e) {
    console.error('[identity] contact upsert failed (crm_contacts applied?)', e);
    return { decision: 'noop', contactId: null };
  }

  // 2. Decide how to stitch the visitor spine.
  let decision: StitchDecision = 'noop';
  try {
    const { data: visitor } = await admin
      .from('mkt_visitors').select('id, contact_id').eq('anonymous_id', anonymousId).maybeSingle();
    decision = decideStitch({
      visitorFound: !!visitor,
      visitorContactId: visitor?.contact_id ?? null,
      targetContactId: contactId,
    });
    if (decision === 'link' && visitor) {
      await admin.from('mkt_visitors').update({ contact_id: contactId }).eq('id', visitor.id);
    }
  } catch (e) {
    console.error('[identity] visitor stitch failed (mkt_visitors applied?)', e);
  }

  // 3. Carry the consent ledger forward for same-person outcomes (idempotent —
  //    only the anon's not-yet-attributed rows). Never on a fork.
  if (shouldCarryConsent(decision)) {
    try {
      await admin.from('mkt_consent_events')
        .update({ contact_id: contactId } as never)
        .eq('anonymous_id', anonymousId).is('contact_id', null);
    } catch (e) {
      console.error('[identity] consent carry-forward failed', e);
    }
  }

  return { decision, contactId };
}
