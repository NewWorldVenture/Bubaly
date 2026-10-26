import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { FROM_EMAIL, emailEnabled, APP_URL } from '@/lib/email';
import { getMarketingCustomersWithError, evaluateSegment, type SegmentRules } from '@/lib/marketing/customers';
import { unsubUrl } from '@/lib/marketing/unsubscribe';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';
import { canonicalMailbox } from '@/lib/server/canonical-mailbox';
import { isChildLoginEmail } from '@/lib/onboarding/child-login';

type DB = SupabaseClient<Database>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * The most addresses one send of a campaign may go to.
 *
 * An audience past it is sent IN PARTS, never cut. The list used to be sliced
 * to its first thousand and the campaign recorded `sent`: the preview, the
 * confirm dialog and the console all said 1,000 as if that were everyone, and
 * the oldest families past the cut could never be reached by that campaign
 * again, because a `sent` row cannot be sent. It was then refused outright,
 * which left an audience no segment rule can split (1,200 free families: one
 * lifecycle, one plan, no LTV) with no way to be emailed at all. A send now
 * reaches the first MAX_RECIPIENTS, records them as delivered and puts the
 * campaign back to `draft` with what it held back (outcome `capped`), and Send
 * resumes for the rest, skipping every address already delivered.
 */
export const MAX_RECIPIENTS = 1000;
/** Resend's batch API takes up to 100 messages per request. */
const BATCH_SIZE = 100;
/** Suppression rows read per request, and the most the read takes before it refuses rather than guess. */
const SUPPRESSION_PAGE = 1000;
const SUPPRESSION_CEILING = 200_000;

/**
 * Every suppressed INBOX (lib/server/canonical-mailbox.ts), read whole.
 *
 * The campaign used to drop an address only when a row was stored under the
 * exact spelling it was about to mail. The automation sender also asks under
 * the canonical inbox and every stored spelling of it (automation-steps.ts
 * suppressionFor), because one person opts out under one spelling and is
 * mailed under another: an automation mail to `janedoe@gmail.com` unsubscribed
 * there, and the account's own `jane.doe@gmail.com` kept getting campaigns.
 * Folding every stored row to its inbox applies that rule to the whole list,
 * legacy rows stored only under a `+tag` spelling included.
 *
 * Read whole on the key, a page at a time, because this lookup IS the opt-out:
 * a row that does not come back reads as consent. An incomplete read throws.
 */
async function suppressedInboxes(supabase: DB): Promise<Set<string>> {
  const inboxes = new Set<string>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    let query = supabase.from('marketing_suppressions').select('email')
      .order('email', { ascending: true }).limit(SUPPRESSION_PAGE);
    if (cursor !== null) query = query.gt('email', cursor);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) throw new Error('Could not load marketing suppression preferences.');
    if (data.length === 0) return inboxes;
    for (const row of data) {
      // The database's own key and collation drive the cursor; a key read twice
      // is a page that did not move on, and a loop that trusted it never ends.
      if (typeof row.email !== 'string' || seen.has(row.email)) throw new Error('Could not load marketing suppression preferences.');
      seen.add(row.email);
      inboxes.add(canonicalMailbox(row.email));
      cursor = row.email;
    }
    if (seen.size > SUPPRESSION_CEILING) throw new Error('Could not load marketing suppression preferences.');
  }
}

/**
 * Resolve the deduped, valid, non-suppressed recipient list for a campaign:
 * every eligible address, uncapped (sendEmailCampaign sends an audience past
 * MAX_RECIPIENTS in parts rather than cutting it).
 */
export async function resolveRecipients(
  supabase: DB,
  campaign: { segment_id: string | null },
): Promise<string[]> {
  const customerResult = await getMarketingCustomersWithError(supabase);
  if (customerResult.error) throw new Error('Could not load marketing customers for this campaign.');
  // A family that closed its account (families.closed_at) is not marketed to.
  // Closing writes no suppression row, so nothing else stops it, and the
  // scheduled automation runner already leaves these families out
  // (automation-runner.ts): the two senders now agree.
  const customers = customerResult.customers.filter((c) => !c.closedAt);

  let pool = customers;
  if (campaign.segment_id) {
    const { data: seg, error: segmentError } = await supabase.from('marketing_segments')
      .select('rules').eq('id', campaign.segment_id).is('deleted_at', null).maybeSingle();
    if (segmentError) throw new Error('Could not load the campaign audience segment.');
    if (!seg) throw new Error('The campaign audience segment no longer exists.');
    pool = evaluateSegment(customers, (seg.rules ?? {}) as SegmentRules);
  }

  // Never a kid login's synthetic address: the campaign goes out through
  // Resend's batch API directly, past sendReactEmail's refusal, and a family
  // whose only login is a kid login has that address as its owner's.
  const emails = new Set<string>();
  for (const c of pool) {
    const e = c.ownerEmail?.trim().toLowerCase();
    if (e && EMAIL_RE.test(e) && !isChildLoginEmail(e)) emails.add(e);
  }

  // Remove suppressed inboxes (unsubscribes, bounces, complaints), under any
  // spelling the opt-out was recorded with.
  if (emails.size > 0) {
    const suppressed = await suppressedInboxes(supabase);
    for (const e of [...emails]) if (suppressed.has(canonicalMailbox(e))) emails.delete(e);
  }

  return [...emails];
}

/**
 * What earlier attempts of a campaign delivered, kept in its metadata.
 *
 * `delivered` holds every address a batch was ACCEPTED for; `pending` the batch
 * whose outcome is not known (the provider refused it, or never answered).
 * `attempt` names the send that wrote it, and every write of a send is fenced
 * on it.
 */
export type CampaignDelivery = {
  attempt: string;
  delivered: string[];
  pending: string[] | null;
  outcome?: 'complete' | 'capped' | 'provider_rejected' | 'provider_unreachable' | 'state_unrecorded';
  /** A `capped` send's count of eligible addresses it left for the next send. */
  held?: number;
};

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The delivery record a campaign's metadata carries, or null when no send has written one. */
export function campaignDelivery(metadata: unknown): CampaignDelivery | null {
  const raw = plainObject(plainObject(metadata).delivery);
  if (typeof raw.attempt !== 'string') return null;
  return {
    attempt: raw.attempt,
    delivered: strings(raw.delivered),
    pending: Array.isArray(raw.pending) ? strings(raw.pending) : null,
    ...(typeof raw.outcome === 'string' ? { outcome: raw.outcome as CampaignDelivery['outcome'] } : {}),
    ...(typeof raw.held === 'number' && Number.isFinite(raw.held) ? { held: raw.held } : {}),
  };
}

/**
 * Who a send of this campaign would mail now: the eligible audience minus
 * every address an earlier attempt already delivered to. The preview and the
 * send both answer from this, so the count an admin confirms is the count sent.
 */
export async function campaignAudience(
  supabase: DB,
  campaign: { segment_id: string | null; metadata?: unknown },
): Promise<{ remaining: string[]; alreadySent: number; prior: CampaignDelivery | null }> {
  const eligible = await resolveRecipients(supabase, campaign);
  const prior = campaignDelivery(campaign.metadata);
  const delivered = new Set(prior?.delivered ?? []);
  return { remaining: eligible.filter((e) => !delivered.has(e)), alreadySent: delivered.size, prior };
}

/**
 * A campaign send that stopped for a reason the console can name. `sent` is
 * what THIS attempt delivered, `total` what the campaign has delivered in all
 * and `audience` the number this attempt set out to reach.
 */
export class CampaignSendError extends Error {
  constructor(
    readonly code: 'provider_rejected' | 'provider_unreachable' | 'state_unrecorded',
    readonly sent: number,
    readonly total: number,
    readonly audience: number,
  ) {
    super(code === 'state_unrecorded'
      ? 'Provider accepted the send, but delivery state could not be recorded. Do not retry until the campaign is checked.'
      : 'Provider rejected the send');
    this.name = 'CampaignSendError';
  }
}

/**
 * The provider idempotency key for one batch: the campaign and exactly the
 * addresses in it. A retry of the same batch (the one a timeout or a refusal
 * left unknown) goes under the same key, and Resend folds it instead of
 * mailing the batch twice; a different batch can never collide with it.
 */
function batchKey(campaignId: string, chunk: readonly string[]): string {
  return `marketing-campaign/${campaignId}/${createHash('sha256').update(chunk.join('\n')).digest('hex').slice(0, 40)}`;
}

function footer(appUrl: string, email: string): string {
  const url = unsubUrl(appUrl, email);
  return `<hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb" /><p style="color:#9ca3af;font-size:12px;line-height:18px;margin-top:16px">You're receiving this because you have a Bubaly account. <a href="${url}" style="color:#6b7280">Unsubscribe</a>.</p>`;
}

/** `sent`: what this send delivered. `remaining`: the eligible addresses it held back for the next (MAX_RECIPIENTS). */
type SendResult = { sent: number; remaining: number };

/**
 * Whether a Send of this campaign has no one left to mail and only finishes
 * it: an earlier send was capped, and every address it held back has since
 * left the audience (unsubscribed, bounced, or its family closed or lost its
 * owner). Such a campaign used to be refused as having no recipients, so it
 * stayed `draft` for good, and the console kept saying Send reaches the rest.
 * The preview answers this too, so the console offers the finishing Send.
 */
export function finishesCappedCampaign(prior: CampaignDelivery | null, remaining: readonly string[]): boolean {
  return prior?.outcome === 'capped' && (prior.pending ?? []).length === 0 && remaining.length === 0;
}

/**
 * Record a capped campaign with no one left as `sent` (outcome `complete`,
 * recipients the addresses it delivered), mailing no one. Fenced on the record
 * it was read with, as a send's reservation is, so a concurrent Send that
 * reserved it first leaves this one with nothing to write.
 */
async function finishCappedCampaign(supabase: DB, campaignId: string, metadata: unknown, prior: CampaignDelivery): Promise<SendResult> {
  const { data: finished, error } = await supabase.from('marketing_email_campaigns')
    .update({
      status: 'sent', sent_at: new Date().toISOString(), recipients: prior.delivered.length,
      metadata: {
        ...plainObject(metadata),
        delivery: { attempt: randomUUID(), delivered: prior.delivered, pending: null, outcome: 'complete', finishedAt: new Date().toISOString() },
      } as Json,
    })
    .eq('id', campaignId).is('deleted_at', null).eq('status', 'draft')
    .eq('metadata->delivery->>attempt', prior.attempt)
    .select('id').maybeSingle();
  if (error) throw new Error('Could not record the email campaign as sent.');
  if (!finished) throw new Error('Campaign is already sending, sent, or no longer available.');
  return { sent: 0, remaining: 0 };
}

/**
 * Sends a marketing email campaign for real via the Resend batch API. Never
 * fakes a send: throws if no provider key, no recipients, or already sent.
 * Tags each message with the campaign id so the Resend webhook can attribute
 * opens/clicks, and includes a working unsubscribe link + List-Unsubscribe header.
 *
 * A send that stops partway is RESUMED, never repeated. Each accepted batch is
 * recorded (metadata.delivery.delivered, and `recipients`) before the next one
 * goes, so a later batch the provider refuses, or a request that throws or
 * times out, leaves the row `failed` with what already went out. It used to
 * leave `failed` with nothing recorded — and the console's Send mailed everyone
 * from the first batch again — or, on a throw, `sending` for good with no count
 * and no way back. Sending a `failed` campaign again now mails only the
 * addresses not yet delivered, the unknown batch first and under its own
 * idempotency key.
 */
export async function sendEmailCampaign(supabase: DB, campaignId: string, appUrl = APP_URL): Promise<SendResult> {
  const { data: c, error } = await supabase.from('marketing_email_campaigns')
    .select('*').eq('id', campaignId).is('deleted_at', null).maybeSingle();
  if (error) throw new Error('Could not load the email campaign.');
  if (!c) throw new Error('Campaign not found.');
  if (c.status === 'sent' || c.status === 'sending') throw new Error('Campaign already sent');
  if (!emailEnabled()) throw new Error('No email provider configured (set RESEND_API_KEY)');
  if (!c.subject?.trim()) throw new Error('Add a subject before sending');

  const { remaining, alreadySent, prior } = await campaignAudience(supabase, c);
  if (remaining.length === 0) {
    if (prior && finishesCappedCampaign(prior, remaining)) return finishCappedCampaign(supabase, campaignId, c.metadata, prior);
    throw new Error('No eligible recipients (after suppression/consent filtering)');
  }

  // The batch an earlier attempt could not confirm goes first and whole, so it
  // carries the same idempotency key it was first sent under.
  const remainingSet = new Set(remaining);
  const unknown = (prior?.pending ?? []).filter((e) => remainingSet.has(e));
  const unknownSet = new Set(unknown);
  // Past MAX_RECIPIENTS this send takes the first of them, the unknown batch
  // included, and holds the rest for the next one (see MAX_RECIPIENTS).
  const rest = remaining.filter((e) => !unknownSet.has(e)).slice(0, Math.max(0, MAX_RECIPIENTS - unknown.length));
  const held = remaining.length - unknown.length - rest.length;
  const batches: string[][] = unknown.length > 0 ? [unknown] : [];
  for (let i = 0; i < rest.length; i += BATCH_SIZE) batches.push(rest.slice(i, i + BATCH_SIZE));

  const attempt = randomUUID();
  const base = plainObject(c.metadata);
  let delivered = [...(prior?.delivered ?? [])];
  const state = (pending: string[] | null, outcome?: CampaignDelivery['outcome']): Json => ({
    ...base,
    delivery: {
      attempt, delivered, pending,
      ...(outcome ? { outcome, finishedAt: new Date().toISOString() } : {}),
      ...(outcome === 'capped' ? { held } : {}),
    },
  }) as Json;

  // Reserve the row atomically. A second browser tab or retried request must
  // never be able to send the same campaign concurrently — and a retry must
  // reserve only the record it read: another attempt may have run, delivered
  // and failed again in between, and a send from the older record would mail
  // its batches a second time.
  const reserve = supabase.from('marketing_email_campaigns')
    .update({ status: 'sending', metadata: state(prior?.pending ?? null) })
    .eq('id', campaignId)
    .is('deleted_at', null)
    .in('status', ['draft', 'failed']);
  const { data: reserved, error: reserveError } = await (prior
    ? reserve.eq('metadata->delivery->>attempt', prior.attempt)
    : reserve.is('metadata->delivery', null)
  ).select('id').maybeSingle();
  if (reserveError) throw new Error('Could not reserve the email campaign for sending.');
  if (!reserved) throw new Error('Campaign is already sending, sent, or no longer available.');

  /** A write of this attempt's own claim: zero rows means the claim was lost. */
  const record = (fields: Database['public']['Tables']['marketing_email_campaigns']['Update']) =>
    supabase.from('marketing_email_campaigns').update(fields)
      .eq('id', campaignId).eq('status', 'sending').eq('metadata->delivery->>attempt', attempt)
      .select('id').maybeSingle();

  /** Stop here: the row goes to `failed` with what went out, so the next send resumes rather than repeats. */
  const stop = async (code: CampaignSendError['code'], pending: string[] | null): Promise<never> => {
    const { data: failed, error: failedError } = await record({ status: 'failed', recipients: delivered.length, metadata: state(pending, code) });
    if (failedError || !failed) {
      // Left `sending`: the console offers no Send for it, which is the safe
      // way to be wrong about a campaign whose delivery is not on record.
      console.error('[marketing send] failed-state update failed', failedError ?? new Error('Campaign claim was lost.'));
      throw new CampaignSendError('state_unrecorded', delivered.length - alreadySent, delivered.length, remaining.length);
    }
    throw new CampaignSendError(code, delivered.length - alreadySent, delivered.length, remaining.length);
  };

  const from = c.from_name ? `${c.from_name} <${FROM_EMAIL.replace(/^.*</, '').replace(/>$/, '')}>` : FROM_EMAIL;
  const baseHtml = c.body_html?.trim() || `<p>${(c.preview_text ?? '').replace(/</g, '&lt;')}</p>`;

  for (const chunk of batches) {
    const payload = chunk.map((to) => ({
      from,
      to,
      subject: c.subject,
      html: `${baseHtml}${footer(appUrl, to)}`,
      headers: { 'List-Unsubscribe': `<${unsubUrl(appUrl, to)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: [{ name: 'campaign', value: campaignId }],
    }));

    let res: Response;
    try {
      res = await fetchWithDeadline('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': batchKey(campaignId, chunk),
        },
        body: JSON.stringify(payload),
      }, 15_000);
    } catch (fetchError) {
      // A deadline or a dropped connection: the provider may have taken this
      // batch. It is recorded as unknown and retried first, under its key.
      console.error('[marketing send] provider request failed', fetchError);
      return stop('provider_unreachable', chunk);
    }

    if (!res.ok) {
      const bounded = await readBoundedResponseText(res, 64 * 1024);
      console.error('[marketing send failed]', res.status, bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]');
      return stop('provider_rejected', chunk);
    }
    delivered = [...delivered, ...chunk];
    // Recorded before the next batch goes, so a stop after this point knows it.
    const { data: progressed, error: progressError } = await record({ recipients: delivered.length, metadata: state(null) });
    if (progressError || !progressed) {
      console.error('[marketing send] progress update failed', progressError ?? new Error('Campaign claim was lost.'));
      return stop('state_unrecorded', null);
    }
  }

  // A send that held addresses back goes back to `draft` (the only other
  // status Send takes) with what it delivered and what it held, so the next
  // Send reaches the rest; the last one records `sent`.
  const { data: sentCampaign, error: sentError } = await record(held > 0
    ? { status: 'draft', recipients: delivered.length, metadata: state(null, 'capped') }
    : { status: 'sent', sent_at: new Date().toISOString(), recipients: delivered.length, metadata: state(null, 'complete') });
  if (sentError || !sentCampaign) {
    console.error('[marketing send] delivery-state update failed', sentError ?? new Error('Campaign claim was lost after provider acceptance.'));
    throw new CampaignSendError('state_unrecorded', delivered.length - alreadySent, delivered.length, remaining.length);
  }

  return { sent: delivered.length - alreadySent, remaining: held };
}
