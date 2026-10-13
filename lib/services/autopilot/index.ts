import 'server-only';
import type { Tables } from '@/lib/database.types';
import { keyedProbe, makeKey } from '@/lib/services/idempotency';
import { scopeNow } from '@/lib/services/scope';
import type { ServiceScope } from '@/lib/services/types';
import { AUTOPILOT_SOURCE_TAG } from '@/lib/reminders/provenance';
import { reminderIsoFor } from '@/lib/autopilot/reminder-time';
import { stampedPayload, type SuggestionStampSource } from '@/lib/autopilot/reminder-key';
import { reminderMemberFor, suggestionVisibleTo } from '@/lib/autopilot/audience';

type Suggestion = Tables<'autopilot_suggestions'>;
export type ResolutionResult =
  | { ok: true; status: 'executed'; reminderId: string }
  | { ok: true; status: 'dismissed' }
  | { ok: false; code: 'unavailable' | 'changed' | 'notFound' | 'unsupported' | 'invalid' | 'contextChanged' | 'accessDenied'; saved?: false }
  | { ok: false; code: 'resolutionPending' | 'sourceChanged'; saved: true; reminderId: string };

export type ResolveSuggestionInput = { suggestionId: string; updatedAt: string; action: 'reminder' | 'dismiss' };

export function suggestionReminderKey(familyId: string, suggestionId: string): string {
  // One source, including across reloads and simultaneous accepts. Never a title,
  // client-minted submission ID, or mutable reminder content.
  return makeKey(['autopilot.createReminder', familyId, suggestionId]);
}

/**
 * The AUTOPILOT_SOURCE_TAG tag an accepted card writes on its reminder. It is
 * copied with the tags onto a repeating reminder's next occurrence, which has
 * no key, so a reader finds the card from it too (lib/autopilot/reminder-cards.ts
 * `sourceTagOf`; the browser's mint is lib/autopilot/reminder-key.ts
 * mintSuggestionSourceTag).
 */
export function suggestionSourceTag(source: SuggestionStampSource): string {
  // Existing tags preserve which proposal was accepted, independently of later
  // edits to the reminder. Exclude status/timestamps: our own resolution updates
  // those. A revised proposal must never inherit an older reminder's success.
  // Exclude, too, the scan's record of the reminder it wrote with the card
  // (stampedPayload): bookkeeping, not the proposal.
  return `${AUTOPILOT_SOURCE_TAG}${makeKey([source.family_id, source.id, source.kind, source.action_type,
    source.title, source.detail, source.member_id, source.urgency, JSON.stringify(stampedPayload(source.payload))])}`;
}

async function readSuggestion(scope: ServiceScope, id: string) {
  return scope.db.from('autopilot_suggestions').select('*')
    .eq('id', id).eq('family_id', scope.familyId).maybeSingle();
}

/** Explicit human acceptance. Policy grants keep their separate manager action. */
export async function resolveSuggestion(scope: ServiceScope, input: ResolveSuggestionInput): Promise<ResolutionResult> {
  if (!scope.userId || !scope.memberId || scope.actorKind !== 'member' || scope.role === 'system') {
    return { ok: false, code: 'contextChanged' };
  }
  let savedId: string | undefined;
  try {
    const read = await readSuggestion(scope, input.suggestionId);
    if (read.error) return { ok: false, code: 'unavailable' };
    const source = read.data;
    if (!source || source.id !== input.suggestionId || source.family_id !== scope.familyId) return { ok: false, code: 'notFound' };
    // A card the reader is not shown (lib/autopilot/audience.ts) is not theirs
    // to accept or dismiss either; answered as absent, like another family's.
    if (!suggestionVisibleTo(source, { role: scope.role, memberId: scope.memberId })) return { ok: false, code: 'notFound' };

    if (input.action === 'reminder') {
      if (source.kind === 'policy' || source.action_type !== 'create_reminder') return { ok: false, code: 'unsupported' };
      const key = suggestionReminderKey(scope.familyId, source.id);
      const receipt = await keyedProbe(scope, 'family_reminders', 'reminder')(key);
      if (!receipt.ok) return { ok: false, code: 'unavailable' };
      if (receipt.data) {
        if (!receipt.data.id || receipt.data.family_id !== scope.familyId || receipt.data.idempotency_key !== key) {
          return { ok: false, code: 'unavailable' };
        }
        savedId = receipt.data.id;
        if (receipt.data.autopilot_origin !== true || receipt.data.autopilot_card_id !== source.id || !receipt.data.tags?.includes(suggestionSourceTag(source))) return { ok: false, code: 'sourceChanged', saved: true, reminderId: savedId };
        if (source.status === 'executed') return { ok: true, status: 'executed', reminderId: savedId };
      }
      // A legacy approval carries no receipt: never replay uncertain old work.
      if (source.status !== 'open' || source.updated_at !== input.updatedAt) {
        return savedId ? { ok: false, code: 'sourceChanged', saved: true, reminderId: savedId } : { ok: false, code: 'changed' };
      }
      if (!savedId) {
        if (source.expires_at && (!Number.isFinite(Date.parse(source.expires_at)) || Date.parse(source.expires_at) <= scopeNow(scope).getTime())) {
          return { ok: false, code: 'changed' };
        }
        const payload = source.payload && !Array.isArray(source.payload) && typeof source.payload === 'object' ? source.payload : {};
        const title = typeof payload.title === 'string' ? payload.title : source.title;
        const rawAt = payload.at === undefined || payload.at === null ? scopeNow(scope).toISOString() : payload.at;
        if (typeof title !== 'string' || !title.trim() || title.length > 1000 || typeof rawAt !== 'string' || !Number.isFinite(Date.parse(rawAt))) {
          return { ok: false, code: 'invalid' };
        }
        // The suggestion is a copy of a source row as the scan last saw it.
        // Moved, cancelled or already reminded since, it must not become a
        // reminder for a time that no longer means anything.
        const live = await sourceStillCurrent(scope, source);
        if (live === 'unavailable') return { ok: false, code: 'unavailable' };
        if (live === 'changed') return { ok: false, code: 'changed' };
        // An instant already past is never delivered (the notifier reads only
        // reminders still ahead of it). A reminder about a DAY (renewal,
        // insurance, refill) moves to the next morning that is; one about an
        // event's time (an appointment, a "leave by") has nothing left to
        // remind anyone of, and the card has changed under the reader.
        const at = reminderIsoFor(source.source_kind, rawAt, scopeNow(scope), scope.tz || 'UTC', source.expires_at);
        if (!at) return { ok: false, code: 'changed' };
        // Who the reminder is FOR: the card's member, except on an insurance
        // card, whose member is whose policy it is and not who renews it — the
        // notice goes to the card's readers instead (lib/autopilot/audience.ts
        // reminderMemberFor; lib/server/notifications.ts).
        const reminderMember = reminderMemberFor(source);
        // A member_id is a family_members FK, not an auth user ID. Check the
        // source recipient belongs here instead of trusting the stored payload.
        if (reminderMember) {
          const member = await scope.db.from('family_members').select('id, family_id, is_active')
            .eq('id', reminderMember).eq('family_id', scope.familyId).eq('is_active', true).maybeSingle();
          if (member.error) return { ok: false, code: 'unavailable' };
          if (!member.data || member.data.id !== reminderMember || member.data.family_id !== scope.familyId || !member.data.is_active) {
            return { ok: false, code: 'invalid' };
          }
        }
        // The database creates the copy and pins its immutable card origin under
        // the current caller's identity. Display tags carry no write authority.
        const created = await scope.db.rpc('create_card_family_reminder', {
          p_card_id: source.id, p_expected_updated_at: input.updatedAt,
          p_at: at, p_source_tag: suggestionSourceTag(source),
        }).maybeSingle();
        if (created.error || !created.data) return { ok: false, code: 'unavailable' };
        if (!created.data.id || created.data.family_id !== scope.familyId || created.data.idempotency_key !== key
          || created.data.autopilot_origin !== true || created.data.autopilot_card_id !== source.id) {
          return { ok: false, code: 'unavailable' };
        }
        savedId = created.data.id;
        if (!created.data.tags?.includes(suggestionSourceTag(source))) return { ok: false, code: 'sourceChanged', saved: true, reminderId: savedId };
      }
      return await stamp(scope, source, 'executed', savedId);
    }

    if (!['open', 'approved'].includes(source.status) || source.updated_at !== input.updatedAt) return { ok: false, code: 'changed' };
    return await stamp(scope, source, 'dismissed');
  } catch (error) {
    console.error('[autopilot-resolution] could not resolve suggestion', error);
    return savedId ? pending(savedId) : { ok: false, code: 'unavailable' };
  }
}

/** The day the scan keyed this occurrence by (`<kind>:<id>:<YYYY-MM-DD>`), if any. */
function keyedDay(source: Suggestion): string | null {
  const day = source.dedupe_key?.split(':').at(-1) ?? '';
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Re-read the row a reminder suggestion was derived from. 'changed' when it is
 * gone, no longer active, or no longer at the occurrence the suggestion names;
 * 'ok' for a suggestion with no source to check.
 */
async function sourceStillCurrent(scope: ServiceScope, source: Suggestion): Promise<'ok' | 'changed' | 'unavailable'> {
  if (!source.source_kind || !source.source_id) return 'ok';
  const id = source.source_id;
  const day = keyedDay(source);
  const sameInstant = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
  const db = scope.db;
  switch (source.source_kind) {
    case 'appointments': {
      const row = await db.from('appointments').select('id, starts_at').eq('id', id).eq('family_id', scope.familyId).maybeSingle();
      if (row.error) return 'unavailable';
      const payload = source.payload && !Array.isArray(source.payload) && typeof source.payload === 'object' ? source.payload : {};
      if (!row.data || !sameInstant(row.data.starts_at, typeof payload.at === 'string' ? payload.at : null)) return 'changed';
      const reminded = await db.from('reminders').select('id').eq('family_id', scope.familyId)
        .eq('related_type', 'appointment').eq('related_id', id).eq('is_done', false).limit(1);
      if (reminded.error) return 'unavailable';
      return (reminded.data?.length ?? 0) > 0 ? 'changed' : 'ok';
    }
    case 'calendar_events': {
      const row = await db.from('calendar_events').select('id, starts_at').eq('id', id).eq('family_id', scope.familyId).maybeSingle();
      if (row.error) return 'unavailable';
      if (!row.data) return 'changed';
      // A moment card expires at the event's start: that is the instant it was built from.
      return !source.expires_at || sameInstant(row.data.starts_at, source.expires_at) ? 'ok' : 'changed';
    }
    case 'renewals': {
      const row = await db.from('renewals').select('id, expires_at, status').eq('id', id).eq('family_id', scope.familyId).maybeSingle();
      if (row.error) return 'unavailable';
      if (!row.data || row.data.status !== 'active') return 'changed';
      return !day || String(row.data.expires_at ?? '').slice(0, 10) === day ? 'ok' : 'changed';
    }
    case 'family_insurance_policies': {
      const row = await db.from('family_insurance_policies').select('id, renewal_date, is_active').eq('id', id).eq('family_id', scope.familyId).maybeSingle();
      if (row.error) return 'unavailable';
      if (!row.data || !row.data.is_active) return 'changed';
      return !day || String(row.data.renewal_date ?? '').slice(0, 10) === day ? 'ok' : 'changed';
    }
    case 'medications': {
      const row = await db.from('medications').select('id, refill_on, is_active').eq('id', id).eq('family_id', scope.familyId).maybeSingle();
      if (row.error) return 'unavailable';
      if (!row.data || !row.data.is_active) return 'changed';
      return !day || String(row.data.refill_on ?? '').slice(0, 10) === day ? 'ok' : 'changed';
    }
    default:
      return 'ok';
  }
}

function pending(reminderId: string): ResolutionResult {
  return { ok: false, code: 'resolutionPending', saved: true, reminderId };
}

async function stamp(scope: ServiceScope, source: Suggestion, status: 'executed' | 'dismissed', reminderId?: string): Promise<ResolutionResult> {
  const written = await scope.db.from('autopilot_suggestions')
    .update({ status, resolved_at: scopeNow(scope).toISOString(), resolved_by: scope.userId })
    .eq('id', source.id).eq('family_id', scope.familyId).eq('status', source.status).eq('updated_at', source.updated_at)
    .select('id, family_id, status').maybeSingle();
  if (!written.error && written.data?.id === source.id && written.data.family_id === scope.familyId && written.data.status === status) {
    return status === 'executed' && reminderId ? { ok: true, status, reminderId } : { ok: true, status: 'dismissed' };
  }
  // Concurrent accepts may already have committed this exact resolution.
  const current = await readSuggestion(scope, source.id);
  if (reminderId && current.data && (suggestionSourceTag(current.data) !== suggestionSourceTag(source) || current.data.status !== source.status && current.data.status !== status)) {
    return { ok: false, code: 'sourceChanged', saved: true, reminderId };
  }
  if (!current.error && current.data?.id === source.id && current.data.family_id === scope.familyId && current.data.status === status) {
    return status === 'executed' && reminderId ? { ok: true, status, reminderId } : { ok: true, status: 'dismissed' };
  }
  return reminderId ? pending(reminderId) : { ok: false, code: written.error ? 'unavailable' : 'changed' };
}
