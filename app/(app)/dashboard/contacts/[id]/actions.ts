'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import { isAIConfigured, resolveProvider, describeAIError } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
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
  const occurredOn = String(formData.get('occurred_on') ?? '') || new Date().toISOString().slice(0, 10);
  const amountRaw = String(formData.get('amount') ?? '').trim();
  const amount = amountRaw ? Number(amountRaw) : null;
  if (!contactId || !title) return;

  const ctx = await requireUserContext();
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
  if (error) throw new Error(describeActionError(error, t('actions.couldNotLogThatInteraction')));
  revalidatePath(`/dashboard/contacts/${contactId}`);
}

/** Remove a logged interaction (family-scoped). */
export async function deleteInteractionAction(input: { id: string; contactId: string }): Promise<void> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('contact_interactions')
    .delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) throw new Error(describeActionError(error, t('actions.couldNotDeleteThatInteraction')));
  revalidatePath(`/dashboard/contacts/${input.contactId}`);
}

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
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const { data: contact } = await supabase
    .from('family_contacts').select('*')
    .eq('id', contactId).eq('family_id', familyId).maybeSingle();
  if (!contact) return { ok: false, error: t('actions.contactNotFound') };

  if (!(await isAIConfigured())) {
    return { ok: false, error: t('actions.aiIsnTConfiguredYet') };
  }

  // Ground strictly in logged history + linked communications + birthday.
  const { data: rawInts } = await supabase
    .from('contact_interactions').select('*')
    .eq('contact_id', contactId).eq('family_id', familyId)
    .order('occurred_on', { ascending: false }).limit(12);

  let comms: CommunicationLike[] = [];
  try {
    const { data } = await supabase
      .from('family_communications')
      .select('id, channel, direction, subject, summary, received_at')
      .eq('contact_id', contactId).eq('family_id', familyId)
      .order('received_at', { ascending: false }).limit(8);
    comms = (data ?? []) as CommunicationLike[];
  } catch { /* table not present in this env */ }

  const timeline = buildContactTimeline({
    interactions: (rawInts ?? []).map((i): LoggedInteraction => ({
      id: i.id, kind: i.kind as LoggedInteraction['kind'], occurred_on: i.occurred_on,
      title: i.title, note: i.note, amount: i.amount,
    })),
    communications: comms,
    birthdayMonth: contact.birthday_month,
    birthdayDay: contact.birthday_day,
  });
  const health = contactHealth(timeline, contact.name);

  const historyLines = timeline.slice(0, 8)
    .map((e) => `- ${e.date}: ${e.title}${e.detail ? ` (${e.detail})` : ''}`)
    .join('\n') || '- (no logged history yet)';

  const toneWord = tone === 'brief' ? 'short and low-key' : tone === 'playful' ? 'light and playful' : 'warm and genuine';
  const system =
    'You help a busy parent write a ready-to-send message to reconnect with someone in their life ' +
    '(family, friend, coach, caregiver). Ground the message ONLY in the provided history — never invent ' +
    'shared events, names, dates, plans, or feelings that aren’t there. If you need a detail the notes ' +
    'don’t give, use one brief bracketed placeholder like [day that works]. Write it from the family to ' +
    'the contact, first person. Keep it under 60 words, natural (like a real text), no subject line, no ' +
    'sign-off block — just the message. Return ONLY the message text.';
  const user =
    `Contact: ${contact.name}${contact.relationship ? ` (${contact.relationship})` : ''}\n` +
    `Time since last contact: ${health.daysSince == null ? 'no logged history' : `${health.daysSince} days`}\n` +
    `Desired tone: ${toneWord}\n\n` +
    `Recent history (most recent first):\n${historyLines}\n\n` +
    'Write the reconnect message to send.';

  try {
    // The contact's name stays off the row: who a family is trying to reconnect
    // with is not something the request ledger needs to carry.
    const message = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'contacts.reconnect', text: 'Draft a reconnect message' },
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
