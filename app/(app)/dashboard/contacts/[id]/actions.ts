'use server';

import { revalidatePath } from 'next/cache';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { todayKeyFor } from '@/lib/services/scope';
import { createServer } from '@/lib/supabase/server';
import type { Tables } from '@/lib/database.types';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { refusalError, refusalForError } from '@/lib/actions/refusal';
import { isAIConfigured, resolveProvider, describeAIError } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { assertAIAllowance } from '@/lib/server/ai-access';
import { fenceUntrusted, fenceUntrustedBlock, UNTRUSTED_CONTENT_RULE } from '@/lib/ai/safety/untrusted';
import { isWithheldFromGuest } from '@/lib/auth/guest-scope';
import {
  buildContactTimeline, contactHealth,
  type LoggedInteraction, type CommunicationLike,
} from '@/lib/contacts/timeline';

/** Log a visit / call / gift / favor / note against a contact. */
export async function logInteractionAction(formData: FormData): Promise<void> {
  const t = await getTranslations();
  const contactId = String(formData.get('contact_id') ?? '');
  const kind = String(formData.get('kind') ?? 'note');
  const title = String(formData.get('title') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim() || null;
  const amountRaw = String(formData.get('amount') ?? '').trim();
  const amount = amountRaw ? Number(amountRaw) : null;
  if (!contactId || !title) return;

  const ctx = await requireUserContext();
  // The family's day, not the host's: an interaction logged in the evening was
  // being dated tomorrow.
  const occurredOn = String(formData.get('occurred_on') ?? '') || todayKeyFor(ctx);
  const supabase = await createServer();
  const { error } = await supabase.from('contact_interactions').insert({
    family_id: ctx.active.familyId,
    contact_id: contactId,
    kind: ['visit', 'call', 'message', 'gift', 'favor', 'note'].includes(kind) ? kind : 'note',
    occurred_on: occurredOn,
    title: title.slice(0, 200),
    note,
    amount: Number.isFinite(amount as number) ? amount : null,
    created_by: ctx.user.id,
  });
  if (error) throw refusalError(describeActionError(error, t('actions.couldNotLogThatInteraction')), refusalForError(error));
  revalidatePath(`/dashboard/contacts/${contactId}`);
}

/** Remove a logged interaction (family-scoped). */
export async function deleteInteractionAction(input: { id: string; contactId: string }): Promise<void> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // Returning without throwing is what tells the timeline the entry is gone.
  // Audit C1-S9-60.
  const { data: deleted, error } = await supabase.from('contact_interactions')
    .delete().eq('id', input.id).eq('family_id', ctx.active.familyId).select('id');
  if (error) throw refusalError(describeActionError(error, t('actions.couldNotDeleteThatInteraction')), refusalForError(error));
  if (wroteNoRows(deleted)) throw new Error(t('actions.couldNotDeleteThatInteraction'));
  revalidatePath(`/dashboard/contacts/${input.contactId}`);
}

/** Matches the inbox intake's budget — see app/(app)/dashboard/inbox/actions.ts. */
const AI_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

export type ReconnectResult = { ok: true; message: string; tone: string } | { ok: false; error: string };

/**
 * The "AI writes the reconnect message" lift for the Relationship Timeline: the
 * health card can tell you it's time to reach out — this drafts the actual
 * short, warm message to send. Key-gated (honest fallback with no AI key),
 * grounded ONLY in what the family logged about this person (name, relationship,
 * recent touches) — never invents shared history — with bracketed placeholders
 * for anything it doesn't know. Stateless: returns the draft for one-tap copy;
 * a fresh timeline yields a fresh message, so nothing to persist or stale.
 */
export async function draftReconnectMessageAction(
  contactId: string,
  tone: 'warm' | 'brief' | 'playful' = 'warm',
): Promise<ReconnectResult> {
  const t = await getTranslations();
  if (!contactId) return { ok: false, error: t('actions.invalidContact') };
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const historyFailure = (source: 'contact' | 'interactions' | 'communications'): ReconnectResult => {
    // Report the failed boundary without copying private history or provider details.
    console.error('[contacts-reconnect] required read failed', { source });
    return { ok: false, error: t('contactTimeline.historyUnavailable') };
  };
  let supabase: Awaited<ReturnType<typeof createServer>>;
  let contact: Tables<'family_contacts'> | null;
  try {
    supabase = await createServer();
    const { data, error } = await supabase
      .from('family_contacts').select('*')
      .eq('id', contactId).eq('family_id', familyId).maybeSingle();
    if (error) return historyFailure('contact');
    contact = data;
  } catch { return historyFailure('contact'); }
  if (!contact) return { ok: false, error: t('actions.contactNotFound') };

  if (!(await isAIConfigured())) {
    return { ok: false, error: t('actions.aiIsnTConfiguredYet') };
  }

  // Ground strictly in logged history + linked communications + birthday.
  let rawInts: Tables<'contact_interactions'>[];
  let comms: CommunicationLike[];
  let historySource: 'interactions' | 'communications' = 'interactions';
  try {
    const interactions = await supabase
      .from('contact_interactions').select('*')
      .eq('contact_id', contactId).eq('family_id', familyId)
      .order('occurred_on', { ascending: false }).limit(12);
    if (interactions.error || !Array.isArray(interactions.data)) return historyFailure('interactions');
    rawInts = interactions.data;

    historySource = 'communications';
    // The household inbox's rows, which a guest is not shown (the page beside
    // this leaves them off a guest's timeline); a guest's draft is grounded in
    // the logged interactions only.
    if (ctx.active.role === 'guest' && isWithheldFromGuest('/dashboard/inbox')) {
      comms = [];
    } else {
      const { data, error } = await supabase
        .from('family_communications')
        .select('id, channel, direction, subject, summary, received_at')
        .eq('contact_id', contactId).eq('family_id', familyId)
        .order('received_at', { ascending: false }).limit(8);
      if (error || !Array.isArray(data)) return historyFailure('communications');
      comms = data as CommunicationLike[];
    }
  } catch { return historyFailure(historySource); }

  // Reaches a paid provider, so it carries the same budget as every API route
  // that does and as the inbox intake. Audit C3-S4-01.
  //
  // Placed HERE, after the required reads, deliberately: the inbox intake —
  // the same request filed as an action — puts it after its loads and directly
  // before the AI work. Putting it earlier makes the budget preempt this
  // action's own read-boundary contract, so a failed history read would report
  // "too many requests" instead of the failure that actually happened.
  const limited = await enforceAIRateLimit(supabase, `ai-requests:${ctx.user.id}`, AI_RATE_LIMIT);
  if (!limited.ok) return { ok: false, error: t('inboxActions.tooManyRequestsRightNow') };
  // The draft files an `ai_requests` row below, so the Free plan's monthly AI
  // allowance applies here as on every other helper (and a trial that ended
  // unpaid, or a closed account, gets none).
  const access = await assertAIAllowance(ctx, { db: supabase });
  if (!access.ok) return { ok: false, error: access.error };

  const timeline = buildContactTimeline({
    t,
    interactions: rawInts.map((i): LoggedInteraction => ({
      id: i.id, kind: i.kind as LoggedInteraction['kind'], occurred_on: i.occurred_on,
      title: i.title, note: i.note, amount: i.amount,
    })),
    communications: comms,
    birthdayMonth: contact.birthday_month,
    birthdayDay: contact.birthday_day,
  });
  const health = contactHealth(timeline, contact.name, t);

  // Every line below is text someone else wrote or imported — a pasted school
  // email's first line, its summary, a vCard's name — and it shapes a message
  // sent in the parent's own voice. It is fenced as data — the history as one
  // block, line by line, the way /api/ai/insights fences its household rows,
  // and the contact's name and relationship each on their own — and the system
  // prompt carries the rule that says so (lib/ai/safety/untrusted.ts).
  const history = timeline.slice(0, 8)
    .map((e) => `- ${e.date}: ${e.title}${e.detail ? ` (${e.detail})` : ''}`)
    .join('\n');
  const historyLines = history ? fenceUntrustedBlock('contact_history', history, 4000) : '- (no logged history yet)';

  const toneWord = tone === 'brief' ? 'short and low-key' : tone === 'playful' ? 'light and playful' : 'warm and genuine';
  const { locale } = await getLocaleContext();
  const system =
    'You help a busy parent write a ready-to-send message to reconnect with someone in their life ' +
    '(family, friend, coach, caregiver). Ground the message ONLY in the provided history — never invent ' +
    'shared events, names, dates, plans, or feelings that aren’t there. If you need a detail the notes ' +
    'don’t give, use one brief bracketed placeholder like [day that works]. Write it from the family to ' +
    'the contact, first person. Keep it under 60 words, natural (like a real text), no subject line, no ' +
    'sign-off block — just the message. Return ONLY the message text. ' +
    `Write the message in the selected locale: ${locale.code}.\n\n${UNTRUSTED_CONTENT_RULE}`;
  const user =
    `Contact: ${fenceUntrusted('contact', contact.name)}${contact.relationship ? ` (${fenceUntrusted('contact', contact.relationship)})` : ''}\n` +
    `Time since last contact: ${health.daysSince == null ? 'no logged history' : `${health.daysSince} days`}\n` +
    `Desired tone: ${toneWord}\n\n` +
    `Recent history (most recent first):\n${historyLines}\n\n` +
    'Write the reconnect message to send.';

  try {
    // The contact's name stays off the row: who a family is trying to reconnect
    // with is not something the request ledger needs to carry.
    const message = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'contacts.reconnect', text: t('contactTimeline.draftRequestTitle') },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 220 });
        obs.used(provider.model, completion.usage);
        const out = (completion.text || '').trim();
        if (!out) obs.failed(new Error('The model returned an empty message.'));
        return out;
      },
    );
    if (!message) return { ok: false, error: t('actions.couldNotDraftAMessage') };
    return { ok: true, message, tone };
  } catch (err) {
    return { ok: false, error: describeAIError(err).message };
  }
}
