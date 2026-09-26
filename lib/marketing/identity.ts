import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { decideStitch, shouldCarryConsent, type StitchDecision } from './identity-core';
import { escapeLike } from '@/lib/supabase/escape-like';
import { wroteNoRows } from '@/lib/supabase/errors';

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
      .from('crm_contacts').select('id, owner_id').ilike('email', escapeLike(email)).limit(1);
    if (existing?.[0]?.id) {
      contactId = existing[0].id;
      const patch: Record<string, unknown> = { lifecycle_stage: 'customer' };
      const claiming = existing[0].owner_id == null;
      if (claiming) patch.owner_id = params.userId;
      // The read saw no owner; the WRITE now says so too. Filtered on `id` alone,
      // a lead claimed in between — a CRM import, another sign-in — was
      // overwritten: the same race C1-S9-61 closed in resolveContactId. Zero rows
      // on a claim means it is no longer ours to take, so the owner is left
      // alone and only the lifecycle stage is applied. Audit C1-S9-67.
      let write = admin.from('crm_contacts').update(patch as never).eq('id', contactId);
      if (claiming) write = write.is('owner_id', null);
      const { data: patched, error: patchError } = await write.select('id');
      // Read, because the catch below cannot see a resolved PostgREST error and
      // its message claims otherwise.
      if (patchError) console.error('[identity] contact patch failed', { contactId, error: patchError });
      else if (wroteNoRows(patched)) {
        if (claiming) {
          const { error: stageError } = await admin.from('crm_contacts').update({ lifecycle_stage: 'customer' } as never).eq('id', contactId);
          console.error('[identity] contact was claimed by another owner before this sign-in; owner left unchanged', { contactId, stageError });
        } else {
          console.error('[identity] contact patch matched no row', { contactId });
        }
      }
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
      // Logged on zero rows as well (a visitor row deleted since the read);
      // never raised — attribution is not the sign-in. Audit C1-S9-67.
      const { data: stitched, error: stitchError } = await admin.from('mkt_visitors').update({ contact_id: contactId }).eq('id', visitor.id).select('id');
      if (stitchError || wroteNoRows(stitched)) console.error('[identity] visitor stitch failed', { visitorId: visitor.id, error: stitchError ?? 'no rows updated' });
    }
  } catch (e) {
    console.error('[identity] visitor stitch failed (mkt_visitors applied?)', e);
  }

  // 3. Carry the consent ledger forward for same-person outcomes (idempotent —
  //    only the anon's not-yet-attributed rows). Never on a fork.
  if (shouldCarryConsent(decision)) {
    try {
      // Rows deliberately not checked — reason below. Audit C1-S9-67.
      const { error: carryError } = await admin.from('mkt_consent_events')
        .update({ contact_id: contactId } as never)
        .eq('anonymous_id', anonymousId).is('contact_id', null);
      // Rows deliberately not checked: filtered to not-yet-attributed rows, so
      // zero is the ordinary "nothing to carry" case. Audit C1-S9-67.
      // Failing here leaves consent rows unattributed, which is the SAFE
      // direction — consent is never claimed for a contact it was not given
      // for. Worth seeing anyway: the ledger is what /api/privacy/export cites.
      if (carryError) console.error('[identity] consent carry-forward failed', { contactId, error: carryError });
    } catch (e) {
      console.error('[identity] consent carry-forward failed', e);
    }
  }

  return { decision, contactId };
}
