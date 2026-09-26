import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { decideStitch, shouldCarryConsent, type StitchDecision } from './identity-core';
import { escapeLike } from '@/lib/supabase/escape-like';

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
 * anonymous id and the new person starts a clean spine. When a read the decision
 * rests on fails, it returns `unknown` and writes nothing further: no second
 * contact, no link, no consent carried (see identity-core.ts).
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
    const { data: existing, error: lookupError } = await admin
      .from('crm_contacts').select('id, owner_id').ilike('email', escapeLike(email)).limit(1);
    // Only a list that came back says "no contact with this email". An error —
    // or a result that is not a list (postgrest-js resolves an empty-bodied 404
    // with neither data nor error) — says nothing, and inserting on it forks this
    // person into a second contact that crm_contacts has no unique key to
    // refuse. That new id then no longer matches the one this device's visitor
    // row carries, so step 2 would call their own sign-in a stranger's 'fork'.
    if (lookupError || !Array.isArray(existing)) {
      console.error('[identity] contact lookup failed', { error: lookupError ?? 'no result list' });
      return { decision: 'unknown', contactId: null };
    }
    if (existing[0]?.id) {
      contactId = existing[0].id;
      const patch: Record<string, unknown> = { lifecycle_stage: 'customer' };
      if (existing[0].owner_id == null) patch.owner_id = params.userId;
      const { error: patchError } = await admin.from('crm_contacts').update(patch as never).eq('id', contactId);
      // Read, because the catch below cannot see a resolved PostgREST error and
      // its message claims otherwise.
      if (patchError) console.error('[identity] contact patch failed', { contactId, error: patchError });
    } else {
      const { data: created, error: createError } = await admin.from('crm_contacts').insert({
        email, owner_id: params.userId,
        lead_source: 'signup', lead_status: 'customer', lifecycle_stage: 'customer',
      } as never).select('id').single();
      if (createError || !created) {
        console.error('[identity] contact create failed', { error: createError ?? 'no row returned' });
        return { decision: 'unknown', contactId: null };
      }
      contactId = created.id;
    }
  } catch (e) {
    console.error('[identity] contact upsert failed (crm_contacts applied?)', e);
    return { decision: 'unknown', contactId: null };
  }

  // 2. Decide how to stitch the visitor spine. Seeded 'unknown', not 'noop':
  //    until the visitor row has actually been read, nothing says this device
  //    belongs to the person signing in, and 'noop' would carry consent to them.
  let decision: StitchDecision = 'unknown';
  try {
    const { data: visitors, error: visitorError } = await admin
      .from('mkt_visitors').select('id, contact_id').eq('anonymous_id', anonymousId).limit(1);
    // A failed read is not "no visitor". The fork guard can only fire on the
    // contact_id this row carries, so without the row there is no guard — and
    // step 3 would stamp the browser's unattributed consent rows (whoever last
    // answered the banner on it) with this person's contact id.
    if (visitorError || !Array.isArray(visitors)) {
      console.error('[identity] visitor lookup failed', { error: visitorError ?? 'no result list' });
      return { decision: 'unknown', contactId };
    }
    const visitor = visitors[0] ?? null;
    decision = decideStitch({
      visitorFound: !!visitor,
      visitorContactId: visitor?.contact_id ?? null,
      targetContactId: contactId,
    });
    if (decision === 'link' && visitor) {
      const { error: stitchError } = await admin.from('mkt_visitors').update({ contact_id: contactId }).eq('id', visitor.id);
      if (stitchError) console.error('[identity] visitor stitch failed', { visitorId: visitor.id, error: stitchError });
    }
  } catch (e) {
    console.error('[identity] visitor stitch failed (mkt_visitors applied?)', e);
  }

  // 3. Carry the consent ledger forward for same-person outcomes (idempotent —
  //    only the anon's not-yet-attributed rows). Never on a fork, and never
  //    on 'unknown' — the thrown-error catch above leaves the seed in place.
  if (shouldCarryConsent(decision)) {
    try {
      const { error: carryError } = await admin.from('mkt_consent_events')
        .update({ contact_id: contactId } as never)
        .eq('anonymous_id', anonymousId).is('contact_id', null);
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
