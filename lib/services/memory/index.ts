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
// PROVENANCE IS A COLUMN (0265), not a prefix in `notes`. It used to be the
// latter — an inferred fact's notes began `Learned by Bubaly` — and that broke
// two ways a family would actually hit: "Clear what Bubaly learned" ran
// `notes ilike 'Learned by Bubaly%'` and took a person's own fact if they
// happened to write that sentence, while `rememberConfirmed` overwrites
// `notes` whenever someone restates a fact the household already holds, which
// erased the marker and hid the row from that clear forever. `source` cannot
// be edited away: the update path below leaves it alone by construction.
//
// `AI_MEMORY_MARKER` survives as the human-readable opening of the note a
// confirmed suggestion carries. It is prose now, not a signal.
//
// `confidence` comes across from the inbox with the fact — `confirmFact` used
// to discard the one number a person most wants when deciding whether to keep
// a belief. `expires_at` is new: a child's coat size and a school year have a
// shelf life, and a stale fact steering a plan is worse than no fact, because
// it looks as certain as a fresh one. There is no `confirmed` column, and
// deliberately so — see 0265's header.
//
// Categories are the 0123 CHECK list. "food" is not one of them: food
// preferences are `preference` facts, which is where `lib/services/meals
// foodProfile` reads them from.
import 'server-only';
import { createHash } from 'node:crypto';
import type { Tables } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { FACT_CATEGORY_LABELS, filterFacts, type FactCategory } from '@/lib/memory/facts';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { getAISettings } from '../ai-settings';
import { scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type FamilyFact = Tables<'family_facts'>;
export type MemorySuggestion = Tables<'family_playbook_suggestions'>;

export type MemorySource = 'user' | 'ai_conversation' | 'ai_inferred' | 'import';
export const MEMORY_SOURCES: MemorySource[] = ['user', 'ai_conversation', 'ai_inferred', 'import'];

/** The marker an AI-sourced fact carries in `notes` — shared with the playbook accept action and 0253's backfill. */
export const AI_MEMORY_MARKER = 'Learned by Bubaly';
/** Inbox signatures written by this service, so `clearAiMemory` can tell them from the playbook miner's. */
const AI_SIGNATURE_PREFIX = 'ai_memory:';
/** The two `family_facts.source` values that mean "Bubaly, not a person". */
export const AI_FACT_SOURCES: MemorySource[] = ['ai_conversation', 'ai_inferred'];

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

export function isAiFact(fact: Pick<FamilyFact, 'source'>): boolean {
  return fact.source === 'ai_conversation' || fact.source === 'ai_inferred';
}

/** A fact whose shelf life has run out. Null `expires_at` means "still true". */
export function isExpiredFact(fact: Pick<FamilyFact, 'expires_at'>, now: Date): boolean {
  if (!fact.expires_at) return false;
  const at = Date.parse(fact.expires_at);
  return Number.isFinite(at) && at <= now.getTime();
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
  /** ISO date or zoned timestamp. Omitted/null or blank clears a restated fact's expiry. */
  expiresAt?: string | null;
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

  // Two independent conditions for the confirmed lane, because it used to have
  // none: `lib/ai/tools/memory.ts` no longer lets the model set `source` (it
  // reports whether the person asked in so many words), and a turn with nobody
  // in it — a cron, a background run — cannot produce a confirmed fact at all,
  // whatever it claims, because there was nobody there to ask.
  const fromPerson = (input.source === 'user' || input.source === 'import') && scope.actorKind !== 'system';
  // The assistant never gets to decide a medical or account fact is true.
  if (!fromPerson && isSensitiveMemory({ category, key, content })) {
    return fail('Medical and account details are only saved when a person enters them directly.', { code: SERVICE_CODES.denied });
  }
  if (fromPerson && scope.actorKind === 'ai' && isSensitiveMemory({ category, key, content })) {
    return fail('Medical and account details are only saved when a person enters them directly.', { code: SERVICE_CODES.denied });
  }

  // Read the deadline once, before either lane, so a malformed one is refused
  // rather than quietly turned into "remember this forever".
  const expiry = readExpiry(input.expiresAt);
  if (!expiry.ok) {
    return fail('That expiry date could not be read, so Bubaly has not saved the memory. Give a real date as 2026-09-30, or a time with its zone as 2026-09-30T17:00:00Z.', { code: SERVICE_CODES.invalidInput });
  }

  // "Allow memory" (Settings → Bubaly AI) is about what BUBALY keeps: the copy
  // reads "Let Bubaly remember what it learns about your family … and use it
  // next time." It was stored, toggled and read by nothing, so a family that
  // switched it off went on being learned from. A person typing a fact into
  // Family Memory is their own record and is untouched by it.
  //
  // Checked after the sensitive-content refusals above, which are absolute and
  // need no settings read to say no.
  if (!fromPerson) {
    const settings = await getAISettings(scope);
    if (!settings.memoryEnabled) {
      return fail('This family has memory switched off, so Bubaly does not keep what it notices.', { code: SERVICE_CODES.denied });
    }
  }

  if (fromPerson) return rememberConfirmed(scope, { category, key, content, memberId: input.memberId ?? null, note: input.note ?? null, pinned: input.pinned ?? false, expiresAt: expiry.at });
  return rememberUnconfirmed(scope, {
    category, key, content, memberId: input.memberId ?? null, source: input.source,
    confidence: clampConfidence(input.confidence), evidence: input.note ?? null,
    // The inbox is where the time-bound facts mostly land — Bubaly noticing
    // "swim class on Thursdays" is exactly the kind of thing that stops being
    // true. Dropping the deadline here meant accepting the card made it
    // permanent (0268).
    expiresAt: expiry.at,
  });
}

function clampConfidence(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value as number)));
}

/**
 * An expiry Bubaly or a person offered.
 *
 * Absent is the honest "no shelf life" — null, undefined and a blank string all
 * mean the caller named no deadline, and the fact is kept until someone forgets
 * it. But a caller who WROTE something and got it wrong asked for a bound, and
 * silently returning null hands them permanence instead: the one outcome they
 * did not ask for, with no signal.
 *
 * `Date.parse` alone is not enough to tell those apart, because it accepts two
 * kinds of input that are worse than a rejection:
 *
 *   '2026-02-30'           -> 2026-03-02T00:00:00Z   a date that does not exist,
 *                                                    silently rolled forward
 *   '2026-09-06T08:00:00'  -> depends on process.env.TZ
 *
 * The first stores a deadline the caller did not name. The second makes the
 * stored instant a property of which machine ran the write, which is not
 * something an expiry may depend on. So only two forms are accepted, and both
 * mean exactly one instant no matter where they are read:
 *
 *   YYYY-MM-DD                    midnight UTC on that day, per the ECMAScript
 *                                 date-only rule; the calendar date is checked
 *                                 by round-trip so 2026-02-30 is refused
 *   YYYY-MM-DDTHH:MM[:SS[.sss]]Z  or the same with an explicit ±HH:MM offset
 *
 * A zoneless datetime is refused rather than guessed. The family's own zone
 * would be the better guess than the server's, but "better guess" is still a
 * guess about when something stops being true, and the caller can say what they
 * mean in one more character.
 *
 * Reported as `{ ok: false }` rather than thrown, because every caller here is
 * already a `ServiceResult` path and this is a message a person can act on.
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONED_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** True when y-m-d is a real calendar date — `Date.parse` rolls 2026-02-30 into March instead of refusing it. */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const at = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(at)) return false;
  const back = new Date(at);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day;
}

function readExpiry(value: string | null | undefined): { ok: true; at: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, at: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, at: null };

  const shape = DATE_ONLY.exec(trimmed) ?? ZONED_DATETIME.exec(trimmed);
  if (!shape) return { ok: false };
  if (!isRealCalendarDate(Number(shape[1]), Number(shape[2]), Number(shape[3]))) return { ok: false };

  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? { ok: true, at: new Date(at).toISOString() } : { ok: false };
}

async function rememberConfirmed(
  scope: ServiceScope,
  input: { category: FactCategory; key: string; content: string; memberId: string | null; note: string | null; pinned: boolean; expiresAt: string | null },
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
        // `source` is deliberately absent. A person restating a fact Bubaly
        // inferred is correcting it, not claiming to have said it first — and
        // under the old notes-prefix scheme this very write was what erased
        // the provenance and hid the row from "clear what Bubaly learned".
        //
        // The expiry is whatever the restatement said. Writing `null` here
        // unconditionally — as this did — threw away a deadline the caller had
        // just supplied, so "remember the swim class runs until December" made
        // it permanent. No deadline given still means no deadline: restating a
        // value is saying it is true now, not that it expires when the old one
        // did.
        expires_at: input.expiresAt,
      })
      .eq('id', existing.id)
      .eq('family_id', scope.familyId)
      .select('*')
      .single();
    if (error || !data) {
      console.error('[service:memory] fact update failed', error);
      return fail(describeDbError(error, 'Could not update that memory.'), { code: SERVICE_CODES.db });
    }
    await recordActivitySafely(scope, { action: 'update', agent: 'memory', title: `Updated what I remember about ${input.key}`, href: '/dashboard/knowledge', memberId: input.memberId });
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
      // A person said this in so many words — `rememberFact` has already
      // established `fromPerson` before routing here — so it carries no
      // confidence score. Null means nobody had to guess.
      source: 'user',
      expires_at: input.expiresAt,
      // family_facts.created_by references auth.users (0123).
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:memory] fact insert failed', error);
    return fail(describeDbError(error, 'Could not save that memory.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, { action: 'create', agent: 'memory', title: `Remembered ${input.key}: ${input.content}`, href: '/dashboard/knowledge', memberId: input.memberId });
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
  input: { category: FactCategory; key: string; content: string; memberId: string | null; source: MemorySource; confidence: number; evidence: string | null; expiresAt: string | null },
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
      expires_at: input.expiresAt,
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
 * Confirmed, unexpired facts, pinned first. Filtering runs in memory over the
 * family's rows (a household has dozens of facts, not thousands) so the match
 * rules stay the same ones the knowledge page uses (`filterFacts`).
 *
 * Expiry is applied HERE and not on the knowledge page: this is what a tool
 * and the context builder read, and a stale fact steering a plan is the whole
 * problem. A person looking at Family Memory should still see the coat size
 * that ran out, greyed, so they can update it — see `listMemories`.
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
  // Same rule as the memory context slice: medical and account facts are for
  // the adults who manage the family, whatever tool or page asks.
  const canSeeSensitive = scope.role === 'system' || isManager(scope.role);
  const visible = (data ?? [])
    .filter((f) => !isExpiredFact(f, scope.now ?? new Date()))
    .filter((f) => canSeeSensitive || !isSensitiveMemory({ category: f.category, key: f.label, content: f.value }));
  const matched = filterFacts(visible, { q: input.query ?? '' });
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

  // Validate the stored timestamp without reformatting it: PostgreSQL can
  // return fractional seconds more precise than the JavaScript clock.
  if (suggestion.expires_at != null && !Number.isFinite(Date.parse(suggestion.expires_at))) {
    return fail('That suggestion has an invalid expiry date. Dismiss it or add an up-to-date memory.', { code: SERVICE_CODES.invalidInput });
  }

  // A card whose own deadline has already passed cannot be accepted into a
  // fact, because the fact would be born invisible: `isExpiredFact` filters it
  // out of every read, so the parent presses Confirm and nothing appears. That
  // is the inbox lying about what the button did. Say so instead — the card
  // stays open, and dismissing it is the honest action left.
  if (suggestion.expires_at && isExpiredFact({ expires_at: suggestion.expires_at }, scopeNow(scope))) {
    return fail('That one had already lapsed, so confirming it would save nothing. Dismiss it, or ask Bubaly again for something current.', { code: SERVICE_CODES.invalidInput });
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
      // Two ways Bubaly comes to believe something, and a family reads them
      // differently: `ai_conversation` is "you said it and I kept it", written
      // by this service's own cards; `ai_inferred` is the playbook miner
      // deriving it from what the household does. Accepting the card confirms
      // the fact — it does not make it something a person stated.
      source: suggestion.signature.startsWith(AI_SIGNATURE_PREFIX) ? 'ai_conversation' : 'ai_inferred',
      // How sure Bubaly was, which the move across used to discard at the one
      // moment a person is deciding whether to keep the belief.
      confidence: suggestion.confidence,
      // And when it stops being true. A card offered as "until December" that
      // became permanent on acceptance was the same discard, one field over.
      expires_at: suggestion.expires_at ?? null,
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

  await recordActivitySafely(scope, { action: 'confirm', agent: 'memory', title: `Confirmed: ${fact.label} — ${fact.value}`, href: '/dashboard/knowledge', memberId: fact.member_id });
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
  await recordActivitySafely(scope, { action: 'delete', agent: 'memory', title: `Forgot ${fact.label}`, href: '/dashboard/knowledge', memberId: fact.member_id });
  return ok({ kind: 'fact', label: fact.label });
}

/**
 * The "Clear memories" setting: remove everything Bubaly learned on its own
 * and leave everything a person entered. Facts are matched by `source` (0265)
 * rather than by a prefix in free text, which used to take a person's own
 * fact if they wrote "Learned by Bubaly" in their note and to miss a real one
 * whose note had since been edited. Inbox cards go by this service's signature
 * prefix — the playbook miner's own cards are its business and stay.
 */
export async function clearAiMemory(scope: ServiceScope): Promise<ServiceResult<{ facts: number; suggestions: number }>> {
  if (!canManage(scope)) return fail("Only a parent or adult can clear Bubaly's memory.", { code: SERVICE_CODES.denied });

  const { data: facts, error: factError } = await scope.db
    .from('family_facts')
    .delete()
    .eq('family_id', scope.familyId)
    .in('source', AI_FACT_SOURCES)
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
  await recordActivitySafely(scope, { action: 'delete', agent: 'memory', title: `Cleared ${counts.facts + counts.suggestions} things Bubaly had learned`, href: '/dashboard/knowledge' });
  return ok(counts);
}
