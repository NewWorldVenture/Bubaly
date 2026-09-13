import 'server-only';
import { createHash } from 'node:crypto';
import type { createServiceClient } from '@/lib/supabase/server';
import type { Json, Tables } from '@/lib/database.types';
import {
  isTwilioConfigured, searchAvailableNumber, provisionNumber,
} from '@/lib/guardian/twilio';
import { submitRequest } from '@/lib/ai/runs/intake';
import { paperworkKindFields, triagePaperwork, type PaperworkKind } from '@/lib/paperwork/triage';
import { systemScopeForFamily } from '@/lib/services/scope';
import { enrichPaperworkEntities, PaperworkEnrichmentError } from '@/lib/services/paperwork';
import { classifyIntent, summarizeInbound, shouldNotifyFamily, shouldPlanInbound, type InboundChannel } from './routing';

type Admin = ReturnType<typeof createServiceClient>;
export type ContactChannel = Tables<'family_contact_channels'>;
type ContactCenterError = { message: string; code?: string };

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://www.bubaly.com').replace(/\/$/, '');
}

/** Read a family's contact channel, creating the empty row on first access. */
export async function getOrCreateChannelResult(admin: Admin, familyId: string): Promise<{
  data: ContactChannel | null;
  error: ContactCenterError | null;
}> {
  const { data, error } = await admin.from('family_contact_channels').select('*').eq('family_id', familyId).maybeSingle();
  if (error) return { data: null, error };
  if (data) return { data: data as ContactChannel, error: null };
  const created = await admin
    .from('family_contact_channels')
    .upsert({ family_id: familyId }, { onConflict: 'family_id' })
    .select('*')
    .maybeSingle();
  return { data: (created.data ?? null) as ContactChannel | null, error: created.error };
}

export async function getOrCreateChannel(admin: Admin, familyId: string): Promise<ContactChannel | null> {
  const result = await getOrCreateChannelResult(admin, familyId);
  if (result.error) console.error('[contact-center] channel read/create failed', result.error);
  return result.data;
}

/** Resolve the family that owns a dedicated inbound number (webhook routing). */
export async function resolveFamilyByNumberResult(admin: Admin, toNumber: string): Promise<{
  familyId: string | null;
  error: ContactCenterError | null;
}> {
  const { data, error } = await admin
    .from('family_contact_channels')
    .select('family_id')
    .eq('phone_number', toNumber)
    .maybeSingle();
  return { familyId: data?.family_id ?? null, error };
}

export async function resolveFamilyByNumber(admin: Admin, toNumber: string): Promise<string | null> {
  const result = await resolveFamilyByNumberResult(admin, toNumber);
  if (result.error) console.error('[contact-center] phone routing read failed', result.error);
  return result.familyId;
}

/** Resolve the family that owns a bubaly.com local-part (inbound email routing). */
export async function resolveFamilyByEmailLocalResult(admin: Admin, local: string): Promise<{
  familyId: string | null;
  error: ContactCenterError | null;
}> {
  const { data, error } = await admin
    .from('family_contact_channels')
    .select('family_id,email_local')
    // Keep legacy mixed-case addresses, but treat the local-part literally:
    // an allowed underscore must not select another family's address.
    .ilike('email_local', local.replace(/[\\%_]/g, '\\$&'))
    .limit(2)
    .maybeSingle();
  if (error) return { familyId: null, error };
  if (!data) return { familyId: null, error: null };
  if (typeof data.email_local !== 'string' || data.email_local.toLowerCase() !== local.toLowerCase()
    || typeof data.family_id !== 'string' || !data.family_id.trim()) {
    return { familyId: null, error: { message: 'Family email ownership could not be verified.' } };
  }
  return { familyId: data.family_id, error: null };
}

export async function resolveFamilyByEmailLocal(admin: Admin, local: string): Promise<string | null> {
  const result = await resolveFamilyByEmailLocalResult(admin, local);
  if (result.error) console.error('[contact-center] email routing read failed', result.error);
  return result.familyId;
}

/**
 * Buy + wire a dedicated Twilio number for a family. Key-gated: with no Twilio
 * config it flips the row to `pending` (a human/owner provisions it) and returns
 * a skipped result — the rest of the Contact Center works without it. Never
 * throws; returns a discriminated result.
 */
export async function provisionFamilyNumber(
  admin: Admin, familyId: string, areaCode?: string,
): Promise<{ ok: true; phoneNumber: string } | { ok: false; skipped: boolean; error?: string }> {
  const channel = await getOrCreateChannelResult(admin, familyId);
  if (channel.error) return { ok: false, skipped: false, error: 'Could not load the family contact channel.' };
  if (!isTwilioConfigured()) {
    const { error } = await admin.from('family_contact_channels').update({ provisioning_status: 'pending' }).eq('family_id', familyId);
    if (error) return { ok: false, skipped: false, error: 'Could not save the phone request.' };
    return { ok: false, skipped: true };
  }
  try {
    const number = await searchAvailableNumber(areaCode);
    if (!number) return { ok: false, skipped: false, error: 'No numbers available for that area code.' };
    const provisioned = await provisionNumber({
      phoneNumber: number,
      voiceUrl: `${appUrl()}/api/contact-center/voice`,
      smsUrl: `${appUrl()}/api/contact-center/sms`,
      friendlyName: `Bubaly Family ${familyId.slice(0, 8)}`,
    });
    const { error } = await admin.from('family_contact_channels').update({
      phone_number: provisioned.phoneNumber,
      phone_number_sid: provisioned.sid,
      provisioning_status: 'active',
    }).eq('family_id', familyId);
    if (error) return { ok: false, skipped: false, error: 'The number was provisioned but could not be saved. Please contact support.' };
    return { ok: true, phoneNumber: provisioned.phoneNumber };
  } catch (e) {
    const { error: statusError } = await admin.from('family_contact_channels').update({ provisioning_status: 'failed' }).eq('family_id', familyId);
    if (statusError) console.error('[contact-center] failed to save provisioning failure status', statusError);
    console.error('[contact-center] number provisioning failed', e);
    return { ok: false, skipped: false, error: 'Could not provision a number. Please try again.' };
  }
}

export type InboundRecord = {
  intent: string;
  escalated: boolean;
  messageId: string | null;
  /**
   * TRUE only when THIS call created the row. A provider that fires the same
   * webhook twice (0214 says in as many words that it will) arrives here a
   * second time with `inserted: false`, and the caller must not route it again:
   * the planner de-dupes on `client_request_id`, but a second paperwork row, a
   * second entry in the household queue and a double count in `countNeedsYou`
   * have nothing stopping them.
   */
  inserted: boolean;
  /** The ref this delivery is identified by — the provider's, or a derived one. */
  providerRef: string;
};

/**
 * Identify a delivery the provider gave no id for.
 *
 * `uq_inbox_provider_ref` is partial (`where provider_ref is not null`), so a
 * null ref de-dupes nothing: an email with no Message-Id, delivered twice, was
 * two rows, two runs and two copies of the same bill. The ref is therefore
 * derived from what the delivery IS — family, channel, sender, subject, body —
 * and namespaced `derived:` so it is never mistaken for something a provider
 * sent. The trade is that two byte-identical messages to one family on one
 * channel collapse into one row; that is the safer half of the trade, and it is
 * only reachable when the provider supplied no id at all.
 */
function derivedProviderRef(input: {
  familyId: string; channel: InboundChannel; from?: string; subject?: string; body: string;
}): string {
  const digest = createHash('sha256')
    .update([input.familyId, input.channel, input.from ?? '', input.subject ?? '', input.body].join('\u0000'))
    .digest('hex');
  return `derived:${digest.slice(0, 32)}`;
}

/** Share the exact intake identity with durable work recorded before capture. */
export function inboundProviderRef(input: { familyId: string; channel: InboundChannel; from?: string; subject?: string; body: string; providerRef?: string }): string {
  return (input.providerRef ?? '').trim() || derivedProviderRef(input);
}

/** The index is global: a duplicate must still belong to this inbound family. */
export async function findInboundMessage(admin: Admin, input: { familyId: string; channel: InboundChannel; providerRef: string }, signal?: AbortSignal): Promise<string | null> {
  const found = await admin.from('family_inbox_messages')
    .select('id,family_id,channel,provider_ref,direction', { count: 'exact' })
    .eq('channel', input.channel).eq('provider_ref', input.providerRef).limit(2).abortSignal(signal ?? AbortSignal.timeout(5000));
  if (found.error || !Array.isArray(found.data) || found.count !== found.data.length || found.data.length > 1) throw new Error('Inbound identity read failed');
  const row = found.data[0];
  if (!row) return null;
  if (!row.id || row.family_id !== input.familyId || row.channel !== input.channel || row.provider_ref !== input.providerRef || row.direction !== 'inbound') throw new Error('Inbound identity mismatch');
  return row.id;
}

/**
 * File an inbound message into the family's unified inbox. Runs the deterministic
 * concierge classification, de-dupes on the provider ref, and pings the family
 * (best-effort) when the intent is urgent. Returns the classified intent and —
 * load-bearing for the caller — whether this delivery was NEW.
 */
export async function recordInboundMessage(admin: Admin, input: {
  familyId: string; channel: InboundChannel; from?: string; to?: string;
  subject?: string; body: string; providerRef?: string; aiSummary?: string; aiIntent?: string;
}, signal?: AbortSignal): Promise<InboundRecord> {
  const intent = input.aiIntent ?? classifyIntent(input.body);
  const summary = input.aiSummary ?? summarizeInbound(input.body);
  const escalate = shouldNotifyFamily((intent as ReturnType<typeof classifyIntent>));
  const providerRef = inboundProviderRef(input);

  const seen = await findInboundMessage(admin, { ...input, providerRef }, signal);
  if (seen) return { intent, escalated: escalate, messageId: seen, inserted: false, providerRef };

  // PostgreSQL cannot infer the partial provider-ref index from a bare
  // PostgREST on_conflict target. Insert and resolve only a verified collision.
  const { data, error } = await admin.from('family_inbox_messages').insert({
    family_id: input.familyId,
    channel: input.channel,
    direction: 'inbound',
    from_addr: input.from ?? null,
    to_addr: input.to ?? null,
    subject: input.subject ?? null,
    body: input.body,
    ai_summary: summary,
    ai_intent: intent,
    provider_ref: providerRef,
  })
    .select('id').abortSignal(signal ?? AbortSignal.timeout(5000));
  if (error) {
    if (error.code === '23505') {
      const duplicate = await findInboundMessage(admin, { ...input, providerRef }, signal);
      if (duplicate) return { intent, escalated: escalate, messageId: duplicate, inserted: false, providerRef };
    }
    throw new Error('Inbound message persistence failed');
  }

  const messageId: string | null = data?.[0]?.id ?? null;
  if (messageId) return { intent, escalated: escalate, messageId, inserted: true, providerRef };

  throw new Error('Inbound message persistence returned no identity');
}

/** Paperwork triage kinds worth filing: a form, a bill, a receipt, a reservation. */
const FILEABLE_PAPERWORK: ReadonlySet<PaperworkKind> = new Set<PaperworkKind>([
  'permission_slip', 'school_notice', 'medical_form', 'sports',
  'bill_or_payment', 'event_flyer', 'receipt', 'reservation',
]);

export type InboundRouteOutcome = {
  /** True only when an `ai_requests` row exists for this message. */
  routed: boolean;
  requestId: string | null;
  runId: string | null;
  paperworkItemId: string | null;
  reason: 'filed' | 'not_actionable' | 'no_text' | 'no_scope' | 'intake_failed';
};

/**
 * M20's missing half: after an inbound message is filed, hand the actionable
 * ones to the planner so they become work instead of a line in a log.
 *
 * It goes through `submitRequest` — the same intake the Ask bar uses — under a
 * SYSTEM scope for the family, so trust gating, the approval spine and the run
 * ledger are exactly the ones already in place. Nothing is auto-executed here
 * that a person would not have to approve when they asked for it themselves.
 *
 * A REDELIVERY MUST NOT PLAN TWICE, and that is guarded in two places: the
 * webhook only calls this when `recordInboundMessage` reports it actually
 * inserted the row, and the provider ref becomes the request's
 * `client_request_id`, so an intake that is reached anyway re-finds the request
 * it already made rather than planning again.
 *
 * `ai_handled` is written only after the request is persisted; there is no
 * `request_id` column to stamp (see the migration ask), so the link between the
 * row and its run is not claimed anywhere it cannot be proved.
 *
 * Paperwork persistence/enrichment failures throw a retryable error. The email
 * adapter must revisit saved paperwork before its existing planner dedupe.
 */
export async function routeInboundToPlanner(admin: Admin, input: {
  familyId: string;
  channel: InboundChannel;
  messageId: string | null;
  subject?: string | null;
  body: string;
  intent: string;
  providerRef?: string | null;
  sender?: string | null;
  /** Injectable for tests; production uses the real intake. */
  submit?: typeof submitRequest;
  now?: Date;
}): Promise<InboundRouteOutcome> {
  const empty: InboundRouteOutcome = { routed: false, requestId: null, runId: null, paperworkItemId: null, reason: 'not_actionable' };

  const text = [(input.subject ?? '').trim(), (input.body ?? '').trim()].filter(Boolean).join('\n\n').slice(0, 4_000);
  if (!text) return { ...empty, reason: 'no_text' };

  // Paperwork first, and BEFORE the planner gate — which is what makes the
  // sentence below true rather than aspirational. An emailed bill or
  // reservation is a record the family needs whether or not the planner does
  // anything with the message, and the intents the planner declines are
  // precisely where that matters most: "Final notice: invoice #4471, $240.00
  // due March 9" matches the spam rule in routing.ts on the words "final
  // notice", so it was classified `spam`, returned here before this line, and
  // filed NOTHING — while triagePaperwork reads that same text as
  // bill_or_payment with its amount and due date. The bill the household most
  // needed on file was the one the router was most confident to drop.
  //
  // Filed idempotently: the webhook's caller already skips a redelivery, and
  // the filer itself refuses to make the same record twice.
  const paperworkItemId = input.channel === 'email'
    ? await fileInboundPaperwork(admin, input.familyId, text, input.now, input.providerRef, input.sender)
    : null;

  // The planner gate applies only to PLANNING. A message that is not worth a
  // run can still be worth a record, and the outcome now reports the row it
  // filed rather than a bare `not_actionable`.
  if (!shouldPlanInbound(input.intent)) return { ...empty, paperworkItemId };

  const scope = await systemScopeForFamily(admin, input.familyId);
  if (!scope) return { ...empty, paperworkItemId, reason: 'no_scope' };

  const submit = input.submit ?? submitRequest;
  const clientRequestId = input.providerRef ? `inbound:${input.channel}:${input.providerRef}` : null;
  const filed = await submit(scope, { text, clientRequestId }, { now: input.now });
  if (!filed.ok) {
    console.error('[contact-center] inbound routing to the planner failed', filed.error);
    return { ...empty, paperworkItemId, reason: 'intake_failed' };
  }

  if (input.messageId) {
    const { error } = await admin
      .from('family_inbox_messages')
      .update({ ai_handled: true })
      .eq('id', input.messageId)
      .eq('family_id', input.familyId);
    // The request exists either way; a failed stamp is a display gap, not a
    // lost message, so it is logged rather than thrown.
    if (error) console.error('[contact-center] handled stamp failed', error);
  }

  return {
    routed: true,
    requestId: filed.data.requestId,
    runId: filed.data.runId,
    paperworkItemId,
    reason: 'filed',
  };
}

/**
 * Run the deterministic paperwork triage over an inbound email and file it when
 * it recognises something. Only columns 0169 actually defines are written, and
 * a kind the CHECK does not admit ('receipt', 'reservation') is stored as its
 * closest admitted value with the finer kind kept in `meta`.
 *
 * IDEMPOTENT, because a webhook fires twice and a family must not be shown two
 * copies of one water bill. A saved delivery's provider_ref is checked first,
 * so an edited source body remains the same item on retry. The legacy fallback
 * is raw_text under family_id. Enrichment only updates metadata and compares
 * the saved row version before writing, preserving later user edits.
 */
export async function fileInboundPaperwork(
  admin: Admin, familyId: string, text: string, now?: Date, providerRef?: string | null, sender?: string | null,
): Promise<string | null> {
  const triage = triagePaperwork(text, now ?? new Date());
  if (!FILEABLE_PAPERWORK.has(triage.kind)) return null;
  const rawText = text.slice(0, 20_000);

  // The delivery identity survives a person's edit to raw_text. Fall back to
  // the legacy text key only when no item for this delivery has been filed.
  const byDelivery = providerRef ? await admin.from('paperwork_items').select('id')
    .eq('family_id', familyId).contains('meta', { source: 'inbound_email', provider_ref: providerRef }).limit(1).maybeSingle() : null;
  if (byDelivery?.error) {
    console.error('[contact-center] inbound paperwork delivery read failed', byDelivery.error);
    throw new PaperworkEnrichmentError('Could not check the saved paperwork delivery. Retry.');
  }
  const existing = byDelivery?.data?.id ? byDelivery : await admin
    .from('paperwork_items')
    .select('id')
    .eq('family_id', familyId)
    .eq('raw_text', rawText)
    .limit(1)
    .maybeSingle();
  if (existing.error) {
    console.error('[contact-center] inbound paperwork de-dupe read failed', existing.error);
    throw new PaperworkEnrichmentError('Could not check the saved paperwork. Retry.');
  }
  const enrich = async (id: string) => {
    const scope = await systemScopeForFamily(admin, familyId, { now });
    if (!scope) throw new PaperworkEnrichmentError('Could not read the paperwork household. Retry.');
    const result = await enrichPaperworkEntities(scope, id);
    if (!result.ok) throw new PaperworkEnrichmentError(result.error);
    return id;
  };
  if (existing.data?.id) return enrich(existing.data.id);

  const fields = paperworkKindFields(triage.kind);
  const { data, error } = await admin
    .from('paperwork_items')
    .insert({
      family_id: familyId,
      kind: fields.kind,
      title: triage.title,
      summary: triage.summary,
      raw_text: rawText,
      sender: sender ?? null,
      due_on: triage.due_on,
      amount: triage.amount,
      urgency: triage.urgency,
      // `actions` is a jsonb column; the triage result is a plain array of flat
      // records, which is valid JSON but not structurally `Json` to TypeScript.
      actions: triage.actions as unknown as Json,
      meta: { ...fields.meta, source: 'inbound_email', provider_ref: providerRef ?? null },
    })
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[contact-center] inbound paperwork insert failed', error);
    throw new PaperworkEnrichmentError('Could not save the paperwork. Retry.');
  }
  if (!data?.id) throw new PaperworkEnrichmentError('Could not confirm the saved paperwork. Retry.');
  return enrich(data.id);
}

/** Record an outbound message the concierge sent (auto-reply), for the timeline. */
export async function recordOutboundMessage(admin: Admin, input: {
  familyId: string; channel: InboundChannel; to?: string; body: string;
}): Promise<void> {
  const { error } = await admin.from('family_inbox_messages').insert({
    family_id: input.familyId,
    channel: input.channel,
    direction: 'outbound',
    to_addr: input.to ?? null,
    body: input.body,
    ai_handled: true,
    status: 'read',
  });
  if (error) {
    console.error('[contact-center] outbound message persistence failed', error);
    throw new Error('Outbound message persistence failed');
  }
}
