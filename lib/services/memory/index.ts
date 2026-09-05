// Family memory: what Bubaly is allowed to remember, and how it forgets.
//
// TWO TABLES, ONE POLICY (§14 of the spec, §4.1 of the map):
//   `family_facts` (0123) holds CONFIRMED knowledge — what a person said to
//   remember, or what they accepted from the inbox. `recallFacts` and the
//   memory context slice read only this table, so nothing the assistant merely
//   inferred can steer a plan until a person has agreed with it.
//   `family_playbook_suggestions` (0126) is the UNCONFIRMED inbox. It already
//   carries `confidence`, `evidence` and a unique `signature`, which is why an
//   AI-inferred memory is written there rather than into the facts table with
//   a flag: the columns the policy needs exist today on the inbox and not on
//   the facts. `confirmFact` moves a suggestion across, exactly as the
//   playbook page's accept action does.
//
// WHAT `family_facts` DOES NOT HAVE: `source`, `confidence`, `confirmed` or a
// metadata jsonb (0123 defines id, family_id, member_id, category, label,
// value, notes, is_pinned, created_by and the timestamps — nothing else).
// Migration 0253 will add them; until then provenance is carried the way the
// repo already carries it: an AI-sourced fact's `notes` starts with
// `Learned by Bubaly` (the marker the playbook accept action writes and the
// 0253 backfill keys on). `clearAiMemory` deletes exactly those rows plus the
// AI-sourced inbox entries, and nothing a person typed.
//
// Categories are the 0123 CHECK list. "food" is not one of them: food
// preferences are `preference` facts, which is where `lib/services/meals
// foodProfile` reads them from.
import 'server-only';
import { createHash } from 'node:crypto';
import type { Tables } from '@/lib/database.types';
import { FACT_CATEGORY_LABELS, filterFacts, type FactCategory } from '@/lib/memory/facts';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type FamilyFact = Tables<'family_facts'>;
export type MemorySuggestion = Tables<'family_playbook_suggestions'>;

export type MemorySource = 'user' | 'ai_conversation' | 'ai_inferred' | 'import';
export const MEMORY_SOURCES: MemorySource[] = ['user', 'ai_conversation', 'ai_inferred', 'import'];

/** The marker an AI-sourced fact carries in `notes` — shared with the playbook accept action and 0253's backfill. */
export const AI_MEMORY_MARKER = 'Learned by Bubaly';
/** Inbox signatures written by this service, so `clearAiMemory` can tell them from the playbook miner's. */
const AI_SIGNATURE_PREFIX = 'ai_memory:';

/**
 * Categories the assistant must never write on its own. Medical facts belong
 * in the health profile where a person enters them deliberately; account
 * facts are credentials by another name. Both are readable through the
 * modules that own them, never inferred from a chat.
 */
export const SENSITIVE_MEMORY_CATEGORIES: FactCategory[] = ['medical', 'account'];

const SENSITIVE_TERMS = /\b(ssn|social security|passport (?:no|number)|password|passcode|pin\b|bank|routing|account number|card number|credit card|iban|allerg(?:y|ies|ic)|diagnos|prescription|medication|therap|hiv|pregnan|salary)\b/i;

/**
 * True when a memory should not be written by the assistant: the category is
 * sensitive, or the words are, whatever category was chosen. Exported so the
 * tool and the service refuse on the same rule.
 */
export function isSensitiveMemory(input: { category?: string | null; key: string; content: string }): boolean {
  if (input.category && (SENSITIVE_MEMORY_CATEGORIES as string[]).includes(input.category)) return true;
  return SENSITIVE_TERMS.test(`${input.key} ${input.content}`);
}

function isCategory(value: unknown): value is FactCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FACT_CATEGORY_LABELS, value);
}

function canManage(scope: ServiceScope): boolean {
  return scope.role === 'system' || scope.role === 'parent' || scope.role === 'adult';
}

export function isAiFact(fact: Pick<FamilyFact, 'notes'>): boolean {
  return Boolean(fact.notes && fact.notes.startsWith(AI_MEMORY_MARKER));
}

export type RememberInput = {
  category?: FactCategory | string | null;
  /** The label a person would look the fact up under: "Shoe size", "Doesn't eat". */
  key: string;
  content: string;
  source: MemorySource;
  /** 0–100. Explicit user statements are 100 by definition. */
  confidence?: number | null;
  memberId?: string | null;
  /** Free-text context. For AI sources this is the evidence shown on the inbox card. */
  note?: string | null;
  pinned?: boolean;
};

export type RememberResult =
  | { kind: 'fact'; fact: FamilyFact; updated: boolean }
  | { kind: 'suggestion'; suggestion: MemorySuggestion; duplicate: boolean };

/**
 * Remember something.
 *
 * `source: 'user'` (or an import a person ran) writes a confirmed fact; the
 * same key for the same person is UPDATED rather than duplicated because
 * "remember Ava's shoe size is 3" said twice means one shoe size. Any AI
 * source lands in the inbox unconfirmed with its confidence and evidence,
 * deduplicated on a signature of (member, category, key) so a conversation
 * that circles back to the same inference does not stack cards.
 */
export async function rememberFact(scope: ServiceScope, input: RememberInput): Promise<ServiceResult<RememberResult>> {
  const key = input.key?.trim() ?? '';
  const content = input.content?.trim() ?? '';
  if (!key) return fail('A memory needs a label.', { code: SERVICE_CODES.invalidInput });
  if (!content) return fail('A memory needs something to remember.', { code: SERVICE_CODES.invalidInput });
  if (key.length > 120 || content.length > 2000) return fail('That is too long to store as one memory.', { code: SERVICE_CODES.invalidInput });
  if (!MEMORY_SOURCES.includes(input.source)) return fail('Unknown memory source.', { code: SERVICE_CODES.invalidInput });
  const category: FactCategory = isCategory(input.category) ? input.category : 'other';

  const fromPerson = input.source === 'user' || input.source === 'import';
  // The assistant never gets to decide a medical or account fact is true.
  if (!fromPerson && isSensitiveMemory({ category, key, content })) {
    return fail('Medical and account details are only saved when a person enters them directly.', { code: SERVICE_CODES.denied });
  }
  if (fromPerson && scope.actorKind === 'ai' && isSensitiveMemory({ category, key, content })) {
    return fail('Medical and account details are only saved when a person enters them directly.', { code: SERVICE_CODES.denied });
  }

  if (fromPerson) return rememberConfirmed(scope, { category, key, content, memberId: input.memberId ?? null, note: input.note ?? null, pinned: input.pinned ?? false });
  return rememberUnconfirmed(scope, {
    category, key, content, memberId: input.memberId ?? null, source: input.source,
    confidence: clampConfidence(input.confidence), evidence: input.note ?? null,
  });
}

function clampConfidence(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value as number)));
}

async function rememberConfirmed(
  scope: ServiceScope,
  input: { category: FactCategory; key: string; content: string; memberId: string | null; note: string | null; pinned: boolean },
): Promise<ServiceResult<RememberResult>> {
  let probe = scope.db
    .from('family_facts')
    .select('*')
    .eq('family_id', scope.familyId)
    .ilike('label', input.key.replace(/[%_]/g, (m) => `\\${m}`))
    .limit(1);
  probe = input.memberId ? probe.eq('member_id', input.memberId) : probe.is('member_id', null);
  const { data: existing, error: probeError } = await probe.maybeSingle();
  if (probeError) {
    console.error('[service:memory] fact probe failed', probeError);
    return fail(describeDbError(probeError, 'Could not check what is already remembered.'), { code: SERVICE_CODES.db });
  }

  if (existing) {
    const { data, error } = await scope.db
      .from('family_facts')
      .update({
        value: input.content,
        category: input.category,
        notes: input.note?.trim() || null,
        is_pinned: input.pinned || existing.is_pinned,
      })
      .eq('id', existing.id)
      .eq('family_id', scope.familyId)
      .select('*')
      .single();
    if (error || !data) {
      console.error('[service:memory] fact update failed', error);
      return fail(describeDbError(error, 'Could not update that memory.'), { code: SERVICE_CODES.db });
    }
    await recordActivitySafely(scope, { agent: 'memory', title: `Updated what I remember about ${input.key}`, href: '/dashboard/knowledge', memberId: input.memberId });
    return ok({ kind: 'fact', fact: data, updated: true });
  }

  const { data, error } = await scope.db
    .from('family_facts')
    .insert({
      family_id: scope.familyId,
      member_id: input.memberId,
      category: input.category,
      label: input.key,
      value: input.content,
      notes: input.note?.trim() || null,
      is_pinned: input.pinned,
      // family_facts.created_by references auth.users (0123).
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:memory] fact insert failed', error);
    return fail(describeDbError(error, 'Could not save that memory.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, { agent: 'memory', title: `Remembered ${input.key}: ${input.content}`, href: '/dashboard/knowledge', memberId: input.memberId });
  return ok({ kind: 'fact', fact: data, updated: false });
}

/** Stable inbox key: the same inference about the same person is one card. */
export function memorySignature(input: { memberId: string | null; category: string; key: string }): string {
  const digest = createHash('sha256')
    .update(`${input.memberId ?? 'family'}|${input.category}|${input.key.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
  return `${AI_SIGNATURE_PREFIX}${digest}`;
}

async function rememberUnconfirmed(
  scope: ServiceScope,
  input: { category: FactCategory; key: string; content: string; memberId: string | null; source: MemorySource; confidence: number; evidence: string | null },
): Promise<ServiceResult<RememberResult>> {
  const signature = memorySignature(input);
  const { data: existing, error: probeError } = await scope.db
    .from('family_playbook_suggestions')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('signature', signature)
    .maybeSingle();
  if (probeError) {
    console.error('[service:memory] suggestion probe failed', probeError);
    return fail(describeDbError(probeError, 'Could not check the memory inbox.'), { code: SERVICE_CODES.db });
  }
  // A dismissed or accepted card is a decision; re-suggesting it would nag.
  if (existing) return ok({ kind: 'suggestion', suggestion: existing, duplicate: true });

  const evidence = input.evidence?.trim() || (input.source === 'ai_conversation' ? 'Mentioned in a conversation' : 'Noticed from household activity');
  const { data, error } = await scope.db
    .from('family_playbook_suggestions')
    .insert({
      family_id: scope.familyId,
      member_id: input.memberId,
      category: input.category,
      label: input.key,
      value: input.content,
      evidence,
      confidence: input.confidence,
      signature,
      status: 'suggested',
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:memory] suggestion insert failed', error);
    return fail(describeDbError(error, 'Could not save that to the memory inbox.'), { code: SERVICE_CODES.db });
  }
  return ok({ kind: 'suggestion', suggestion: data, duplicate: false });
}

export type RecallInput = { query?: string | null; category?: FactCategory | string | null; memberId?: string | null; limit?: number };

/**
 * Confirmed facts only, pinned first. Filtering runs in memory over the
 * family's rows (a household has dozens of facts, not thousands) so the
 * match rules stay the same ones the knowledge page uses (`filterFacts`).
 */
export async function recallFacts(scope: ServiceScope, input: RecallInput = {}): Promise<ServiceResult<FamilyFact[]>> {
  let q = scope.db
    .from('family_facts')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('is_pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(500);
  if (isCategory(input.category)) q = q.eq('category', input.category);
  if (input.memberId) q = q.eq('member_id', input.memberId);

  const { data, error } = await q;
  if (error) {
    console.error('[service:memory] recall failed', error);
    return fail(describeDbError(error, 'Could not read what I remember.'), { code: SERVICE_CODES.db });
  }
  const matched = filterFacts(data ?? [], { q: input.query ?? '' });
  return ok(matched.slice(0, Math.min(Math.max(input.limit ?? 50, 1), 200)));
}

export type Memories = { facts: FamilyFact[]; pending: MemorySuggestion[] };

/** Everything, for the review screen: confirmed facts plus what is waiting for a yes. */
export async function listMemories(scope: ServiceScope, input: { memberId?: string | null } = {}): Promise<ServiceResult<Memories>> {
  let facts = scope.db.from('family_facts').select('*').eq('family_id', scope.familyId)
    .order('is_pinned', { ascending: false }).order('updated_at', { ascending: false }).limit(500);
  let pending = scope.db.from('family_playbook_suggestions').select('*').eq('family_id', scope.familyId)
    .eq('status', 'suggested').order('confidence', { ascending: false }).limit(200);
  if (input.memberId) {
    facts = facts.eq('member_id', input.memberId);
    pending = pending.eq('member_id', input.memberId);
  }
  const [factsRes, pendingRes] = await Promise.all([facts, pending]);
  const error = factsRes.error ?? pendingRes.error;
  if (error) {
    console.error('[service:memory] list failed', error);
    return fail(describeDbError(error, 'Could not load family memory.'), { code: SERVICE_CODES.db });
  }
  return ok({ facts: factsRes.data ?? [], pending: pendingRes.data ?? [] });
}

/**
 * Accept an inbox card into confirmed memory. Idempotent: an already-accepted
 * card returns its fact. The `notes` marker is what lets `clearAiMemory` and
 * 0253's backfill tell this fact from one a person typed.
 */
export async function confirmFact(scope: ServiceScope, suggestionId: string): Promise<ServiceResult<{ fact: FamilyFact | null; alreadyAccepted: boolean }>> {
  if (!canManage(scope)) return fail('Only a parent or adult can confirm what Bubaly remembers.', { code: SERVICE_CODES.denied });
  const { data: suggestion, error: readError } = await scope.db
    .from('family_playbook_suggestions')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('id', suggestionId)
    .maybeSingle();
  if (readError) {
    console.error('[service:memory] suggestion read failed', readError);
    return fail(describeDbError(readError, 'Could not read that suggestion.'), { code: SERVICE_CODES.db });
  }
  if (!suggestion) return fail('That suggestion could not be found.', { code: SERVICE_CODES.notFound });

  if (suggestion.status === 'accepted') {
    if (!suggestion.fact_id) return ok({ fact: null, alreadyAccepted: true });
    const { data: fact, error } = await scope.db.from('family_facts').select('*').eq('family_id', scope.familyId).eq('id', suggestion.fact_id).maybeSingle();
    if (error) {
      console.error('[service:memory] accepted fact read failed', error);
      return fail(describeDbError(error, 'Could not read that memory.'), { code: SERVICE_CODES.db });
    }
    return ok({ fact: fact ?? null, alreadyAccepted: true });
  }

  const { data: fact, error: insertError } = await scope.db
    .from('family_facts')
    .insert({
      family_id: scope.familyId,
      member_id: suggestion.member_id,
      category: suggestion.category,
      label: suggestion.label,
      value: suggestion.value,
      notes: suggestion.evidence ? `${AI_MEMORY_MARKER} — ${suggestion.evidence}` : AI_MEMORY_MARKER,
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (insertError || !fact) {
    console.error('[service:memory] confirm insert failed', insertError);
    return fail(describeDbError(insertError, 'Could not save that memory.'), { code: SERVICE_CODES.db });
  }

  const { error: updateError } = await scope.db
    .from('family_playbook_suggestions')
    .update({ status: 'accepted', fact_id: fact.id })
    .eq('family_id', scope.familyId)
    .eq('id', suggestionId);
  if (updateError) {
    // The fact exists; leaving the card open would let it be confirmed twice.
    console.error('[service:memory] suggestion accept failed', updateError);
    const { error: undoError } = await scope.db.from('family_facts').delete().eq('family_id', scope.familyId).eq('id', fact.id);
    if (undoError) console.error('[service:memory] confirm rollback failed', undoError);
    return fail(describeDbError(updateError, 'Could not confirm that memory.'), { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, { agent: 'memory', title: `Confirmed: ${fact.label} — ${fact.value}`, href: '/dashboard/knowledge', memberId: fact.member_id });
  return ok({ fact, alreadyAccepted: false });
}

/**
 * Forget one thing. A fact is deleted; an inbox card is dismissed (kept, so
 * the same inference is not re-suggested tomorrow). Members below adult may
 * only forget facts about themselves.
 */
export async function forgetFact(
  scope: ServiceScope,
  id: string,
  opts: { kind?: 'fact' | 'suggestion' } = {},
): Promise<ServiceResult<{ kind: 'fact' | 'suggestion'; label: string }>> {
  if (!id?.trim()) return fail('Which memory?', { code: SERVICE_CODES.invalidInput });
  const kind = opts.kind ?? 'fact';

  if (kind === 'suggestion') {
    const { data, error } = await scope.db
      .from('family_playbook_suggestions')
      .update({ status: 'dismissed' })
      .eq('family_id', scope.familyId)
      .eq('id', id)
      .select('label')
      .maybeSingle();
    if (error) {
      console.error('[service:memory] suggestion dismiss failed', error);
      return fail(describeDbError(error, 'Could not dismiss that.'), { code: SERVICE_CODES.db });
    }
    if (!data) return fail('That suggestion could not be found.', { code: SERVICE_CODES.notFound });
    return ok({ kind: 'suggestion', label: data.label });
  }

  const { data: fact, error: readError } = await scope.db
    .from('family_facts')
    .select('id, label, member_id, notes')
    .eq('family_id', scope.familyId)
    .eq('id', id)
    .maybeSingle();
  if (readError) {
    console.error('[service:memory] fact read failed', readError);
    return fail(describeDbError(readError, 'Could not read that memory.'), { code: SERVICE_CODES.db });
  }
  if (!fact) return fail('That memory could not be found.', { code: SERVICE_CODES.notFound });
  if (!canManage(scope) && fact.member_id !== scope.memberId) {
    return fail('Only a parent or adult can forget a memory about someone else.', { code: SERVICE_CODES.denied });
  }

  const { error } = await scope.db.from('family_facts').delete().eq('family_id', scope.familyId).eq('id', id);
  if (error) {
    console.error('[service:memory] fact delete failed', error);
    return fail(describeDbError(error, 'Could not forget that.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, { agent: 'memory', title: `Forgot ${fact.label}`, href: '/dashboard/knowledge', memberId: fact.member_id });
  return ok({ kind: 'fact', label: fact.label });
}

/**
 * The "Clear memories" setting: remove everything Bubaly learned on its own
 * and leave everything a person entered. Facts are matched by the provenance
 * marker; inbox cards by this service's signature prefix (the playbook miner's
 * own cards are its business and stay).
 */
export async function clearAiMemory(scope: ServiceScope): Promise<ServiceResult<{ facts: number; suggestions: number }>> {
  if (!canManage(scope)) return fail("Only a parent or adult can clear Bubaly's memory.", { code: SERVICE_CODES.denied });

  const { data: facts, error: factError } = await scope.db
    .from('family_facts')
    .delete()
    .eq('family_id', scope.familyId)
    .ilike('notes', `${AI_MEMORY_MARKER}%`)
    .select('id');
  if (factError) {
    console.error('[service:memory] clear facts failed', factError);
    return fail(describeDbError(factError, "Could not clear Bubaly's memory."), { code: SERVICE_CODES.db });
  }

  const { data: suggestions, error: suggestionError } = await scope.db
    .from('family_playbook_suggestions')
    .delete()
    .eq('family_id', scope.familyId)
    .ilike('signature', `${AI_SIGNATURE_PREFIX}%`)
    .select('id');
  if (suggestionError) {
    console.error('[service:memory] clear suggestions failed', suggestionError);
    return fail(describeDbError(suggestionError, 'Cleared the learned facts but not the inbox — try again.'), { code: SERVICE_CODES.db });
  }

  const counts = { facts: (facts ?? []).length, suggestions: (suggestions ?? []).length };
  await recordActivitySafely(scope, { agent: 'memory', title: `Cleared ${counts.facts + counts.suggestions} things Bubaly had learned`, href: '/dashboard/knowledge' });
  return ok(counts);
}
