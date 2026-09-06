// The family's document store, read the way a careful adult would read it:
// titles and dates freely, the file itself only when the reader is allowed
// to hold it.
//
// Backed by `documents` (0002, `is_favorite` 0109, `is_secure` 0117) and the
// private `documents` Storage bucket (0007, 25 MB, folder-per-family RLS).
// `vacation_documents` (0070) is the join that lets a trip know which passport
// is which.
//
// SENSITIVITY. A document is sensitive when the family flagged it
// (`is_secure`, the Secure Vault) or when its category is one that is private
// by nature — identity, legal, medical, financial. Sensitive documents are:
//   • withheld from listings for non-manager roles (a child's assistant does
//     not learn that "Divorce decree.pdf" exists), and
//   • readable (signed URL) only by parent/adult callers.
// `documents` is a HIGH_STAKES_AI_DOMAIN, so the tool gate already restricts
// reads by role; the checks here are the second door for server actions and
// crons that never pass through the gate.
//
// Signed URLs are short-lived (2 minutes by default, matching the browser
// helper in `lib/storage/documents.ts`): a link that outlives the request
// that asked for it is a link that can be pasted somewhere it should not be.
import 'server-only';
import type { Tables, VacDocKind } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { dayKeyInTz, scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type DocumentRow = Tables<'documents'>;
export type VacationDocumentRow = Tables<'vacation_documents'>;

const BUCKET = 'documents';
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_URL_TTL_SECONDS = 120;
const MAX_URL_TTL_SECONDS = 15 * 60;
const MAX_ROWS = 500;


const DOC_KINDS: VacDocKind[] = ['passport', 'id', 'visa', 'ticket', 'boarding_pass', 'hotel_confirmation', 'rental_confirmation', 'insurance', 'itinerary', 'medical', 'other'];

// One definition, in `lib/documents/sensitivity` so the browser can honour it
// too — the Files hub is where a person is about to put a passport in the
// Vault, and a rule the client cannot see is a rule it cannot obey.
export { SENSITIVE_CATEGORIES, isSensitiveCategory, isSensitiveDocument } from '@/lib/documents/sensitivity';
import { isSensitiveDocument } from '@/lib/documents/sensitivity';

/** Parents and adults may hold sensitive files; a cron with no human behind it may not. */
function canReadSensitive(scope: ServiceScope): boolean {
  return scope.role !== 'system' && isManager(scope.role);
}

export type DocumentMeta = {
  id: string;
  title: string;
  category: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  expiresAt: string | null;
  memberId: string | null;
  assetId: string | null;
  isSecure: boolean;
  /** True when reading the file requires a manager; listings never carry the path itself. */
  sensitive: boolean;
  createdAt: string;
};

function toMeta(row: DocumentRow): DocumentMeta {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    expiresAt: row.expires_at,
    memberId: row.member_id,
    assetId: row.asset_id,
    isSecure: row.is_secure,
    sensitive: isSensitiveDocument(row),
    createdAt: row.created_at,
  };
}

function visibleTo(scope: ServiceScope, rows: DocumentRow[]): DocumentRow[] {
  return canReadSensitive(scope) ? rows : rows.filter((row) => !isSensitiveDocument(row));
}

export type ListDocumentsInput = {
  category?: string | null;
  memberId?: string | null;
  query?: string | null;
  limit?: number;
};

/** Titles and metadata only, newest first. Sensitive rows are omitted for non-managers. */
export async function listDocuments(scope: ServiceScope, input: ListDocumentsInput = {}): Promise<ServiceResult<DocumentMeta[]>> {
  let query = scope.db
    .from('documents')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(input.limit ?? 100, 1), MAX_ROWS));
  if (input.category?.trim()) query = query.ilike('category', input.category.trim().replace(/[%_]/g, (m) => `\\${m}`));
  if (input.memberId) query = query.eq('member_id', input.memberId);
  if (input.query?.trim()) query = query.ilike('title', `%${input.query.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`);
  const { data, error } = await query;
  if (error) {
    console.error('[service:documents] list failed', error);
    return fail(describeDbError(error, 'Could not load your documents.'), { code: SERVICE_CODES.db });
  }
  return ok(visibleTo(scope, data ?? []).map(toMeta));
}

/**
 * Documents whose `expires_at` falls on or before `date` (YYYY-MM-DD), soonest
 * first — the input to renewal reminders and the vacation passport check.
 * Already-expired documents are included: they are the most urgent kind.
 */
export async function expiringBefore(scope: ServiceScope, date: string, input: { memberId?: string | null } = {}): Promise<ServiceResult<DocumentMeta[]>> {
  if (!DAY_KEY.test(date)) return fail('The date must be YYYY-MM-DD.', { code: SERVICE_CODES.invalidInput });
  let query = scope.db
    .from('documents')
    .select('*')
    .eq('family_id', scope.familyId)
    .not('expires_at', 'is', null)
    .lte('expires_at', date)
    .order('expires_at', { ascending: true })
    .limit(MAX_ROWS);
  if (input.memberId) query = query.eq('member_id', input.memberId);
  const { data, error } = await query;
  if (error) {
    console.error('[service:documents] expiry read failed', error);
    return fail(describeDbError(error, 'Could not check document expiry dates.'), { code: SERVICE_CODES.db });
  }
  return ok(visibleTo(scope, data ?? []).map(toMeta));
}

export type ReadDocumentResult = {
  document: DocumentMeta;
  url: string;
  expiresAt: string;
};

/**
 * A short-lived signed URL for one document. Sensitive documents require a
 * manager; a foreign id reads as "not found" rather than "forbidden" so the
 * response does not confirm the id exists.
 */
export async function readDocument(scope: ServiceScope, documentId: string, input: { expiresInSeconds?: number } = {}): Promise<ServiceResult<ReadDocumentResult>> {
  if (!documentId?.trim()) return fail('Which document?', { code: SERVICE_CODES.invalidInput });
  const { data, error } = await scope.db
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (error) {
    console.error('[service:documents] read failed', error);
    return fail(describeDbError(error, 'Could not load that document.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That document could not be found.', { code: SERVICE_CODES.notFound });
  if (isSensitiveDocument(data) && !canReadSensitive(scope)) {
    return fail('That document is private to the adults in this family.', { code: SERVICE_CODES.denied });
  }

  const ttl = Math.min(Math.max(Math.round(input.expiresInSeconds ?? DEFAULT_URL_TTL_SECONDS), 30), MAX_URL_TTL_SECONDS);
  const signed = await scope.db.storage.from(BUCKET).createSignedUrl(data.storage_path, ttl);
  if (signed.error || !signed.data?.signedUrl) {
    console.error('[service:documents] signed url failed', signed.error);
    return fail(describeDbError(signed.error, 'Could not open that document right now.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, { agent: 'documents', title: `Opened "${data.title}"`, href: '/dashboard/documents' });
  return ok({
    document: toMeta(data),
    url: signed.data.signedUrl,
    expiresAt: new Date(scopeNow(scope).getTime() + ttl * 1000).toISOString(),
  });
}

export type LinkToVacationInput = {
  documentId: string;
  vacationId: string;
  kind?: VacDocKind | null;
  memberId?: string | null;
  title?: string | null;
  expiresOn?: string | null;
};

/**
 * Attach a stored document to a trip as a travel document. Re-linking the
 * same document returns the existing row, so a retried "attach the passports"
 * step cannot list one passport twice on the readiness card.
 */
export async function linkToVacation(scope: ServiceScope, input: LinkToVacationInput): Promise<ServiceResult<{ link: VacationDocumentRow; created: boolean }>> {
  if (!input.documentId?.trim() || !input.vacationId?.trim()) return fail('A document and a trip are both needed.', { code: SERVICE_CODES.invalidInput });
  if (input.kind && !DOC_KINDS.includes(input.kind)) return fail('That travel document kind is not one Bubaly knows.', { code: SERVICE_CODES.invalidInput });
  if (input.expiresOn && !DAY_KEY.test(input.expiresOn)) return fail('The expiry date must be YYYY-MM-DD.', { code: SERVICE_CODES.invalidInput });

  const [doc, trip] = await Promise.all([
    scope.db.from('documents').select('*').eq('id', input.documentId).eq('family_id', scope.familyId).maybeSingle(),
    scope.db.from('vacations').select('id, title').eq('id', input.vacationId).eq('family_id', scope.familyId).maybeSingle(),
  ]);
  if (doc.error || trip.error) {
    console.error('[service:documents] link lookup failed', doc.error ?? trip.error);
    return fail(describeDbError(doc.error ?? trip.error, 'Could not load that document or trip.'), { code: SERVICE_CODES.db });
  }
  if (!doc.data) return fail('That document could not be found.', { code: SERVICE_CODES.notFound });
  if (!trip.data) return fail('That trip could not be found.', { code: SERVICE_CODES.notFound });
  if (isSensitiveDocument(doc.data) && !canReadSensitive(scope)) {
    return fail('That document is private to the adults in this family.', { code: SERVICE_CODES.denied });
  }

  const { data: existing, error: existingError } = await scope.db
    .from('vacation_documents')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('vacation_id', input.vacationId)
    .eq('document_id', input.documentId)
    .limit(1)
    .maybeSingle();
  if (existingError) {
    console.error('[service:documents] link probe failed', existingError);
    return fail(describeDbError(existingError, 'Could not check whether that document is already on the trip.'), { code: SERVICE_CODES.db });
  }
  if (existing) return ok({ link: existing, created: false });

  const kind = input.kind ?? inferDocKind(doc.data);
  const { data, error } = await scope.db
    .from('vacation_documents')
    .insert({
      family_id: scope.familyId,
      vacation_id: input.vacationId,
      document_id: input.documentId,
      kind,
      title: input.title?.trim() || doc.data.title,
      member_id: input.memberId ?? doc.data.member_id,
      expires_on: input.expiresOn ?? (doc.data.expires_at ? doc.data.expires_at.slice(0, 10) : null),
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:documents] link insert failed', error);
    return fail(describeDbError(error, 'Could not attach that document to the trip.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, { agent: 'documents', title: `Attached "${data.title}" to ${trip.data.title}`, href: `/dashboard/vacations/${trip.data.id}` });
  return ok({ link: data, created: true });
}

/** Best guess at a travel-document kind from the stored category/title, used only when the caller gave none. */
export function inferDocKind(doc: Pick<DocumentRow, 'category' | 'title'>): VacDocKind {
  const text = `${doc.category ?? ''} ${doc.title}`.toLowerCase();
  if (/passport/.test(text)) return 'passport';
  if (/\bvisa\b/.test(text)) return 'visa';
  if (/boarding/.test(text)) return 'boarding_pass';
  if (/ticket/.test(text)) return 'ticket';
  if (/hotel|lodging|airbnb|reservation/.test(text)) return 'hotel_confirmation';
  if (/rental|car hire/.test(text)) return 'rental_confirmation';
  if (/insurance/.test(text)) return 'insurance';
  if (/itinerar/.test(text)) return 'itinerary';
  if (/medical|prescription|vaccin|immuni/.test(text)) return 'medical';
  if (/\bid\b|licen[cs]e|identity/.test(text)) return 'id';
  return 'other';
}

/** Today's key in the family's zone — exported so callers computing "expiring within N days" share one definition. */
export function todayKey(scope: ServiceScope): string {
  return dayKeyInTz(scopeNow(scope), scope.tz);
}
