// Household search — one query across everything the family has recorded.
//
// WHAT THIS IS NOT (yet): the audit's build calls for a SECURITY INVOKER
// `search_household(family_id, q, limit)` RPC UNIONing pg_trgm similarity over
// these tables, plus GIN trigram indexes. That is a migration, and only the
// repository owner adds migrations. So this version fans out one family-scoped
// `ilike` per source under the caller's own client — RLS therefore applies to
// every source exactly as it would to the RPC — and ranks the union in code
// (`lib/search/rank.ts`). `searchHousehold(scope, q, limit)` is the signature
// the RPC will keep: when the function lands, only the fan-out below is
// replaced, and neither the AI tool, the command bar nor the results page
// changes.
//
// TWO RULES THIS FILE EXISTS TO HOLD:
//
// 1. A SOURCE THAT FAILS IS REPORTED, NEVER DROPPED. Eleven reads run in
//    parallel and any one of them can fail on its own (a dropped policy, a
//    renamed column, a timeout). Swallowing that would render "no bills match"
//    for a household whose bills simply could not be read — the exact
//    conflation of "nothing" with "the database did not answer" the honesty
//    rule forbids. Each failure lands in `partial` with its table name so the
//    caller can say which sources are missing, and when EVERY source fails the
//    whole call fails closed with a retryable error rather than returning a
//    tidy empty page.
//
// 2. MONEY AND ACCOUNT NUMBERS ARE NOT FOR EVERY MEMBER. Bills, warranties and
//    renewals carry amounts, providers and policy identifiers; a child or a
//    guest searching the house does not get them, mirroring the rule
//    `lib/services/documents` already applies to sensitive files and
//    `lib/ai/context/policy.ts` applies to the money slice. Those sources are
//    not queried at all for a non-manager, and the kinds withheld are reported
//    in `withheld` so the UI can say so instead of implying the household owns
//    no bills.
//
// Column names below were read off the CREATE TABLEs (0002 notes/documents/
// calendar_events, 0006 bills, 0029 trips, 0033 renewals, 0070 vacations,
// 0130 family_decisions, 0242 inventory_items, the home_warranties table and
// family_facts), not assumed.
import 'server-only';
import { isManager } from '@/lib/constants/roles';
import { rankHits, type SearchHit, type SearchKind } from '@/lib/search/rank';
import { isSensitiveDocument } from '@/lib/documents/sensitivity';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

/** Below this a query matches half the house; the caller gets an invalid-input refusal. */
export const MIN_QUERY_CHARS = 2;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** Rows pulled per source before ranking. Enough that the ranker has a choice, small enough to stay one round trip. */
export const PER_SOURCE_LIMIT = 25;

/** A source that could not be searched, and the message a person can be shown. */
export type SearchSourceFailure = { table: string; error: string };

export type HouseholdSearch = {
  /** The query as searched (trimmed). */
  query: string;
  hits: SearchHit[];
  /** Sources that errored. Non-empty means the answer is incomplete and says so. */
  partial: SearchSourceFailure[];
  /** Tables actually queried — the evidence for "we looked here". */
  searched: string[];
  /** Kinds this member is not allowed to search (money, account numbers). */
  withheld: SearchKind[];
};

type SourceRow = Record<string, unknown>;

/**
 * The query as a safe `ilike` pattern for a PostgREST `or()` expression.
 *
 * Neither defence here is against SQL injection — PostgREST parameterises the
 * value. `%` and `_` are LIKE wildcards, so a query containing them would
 * quietly match far more than the person typed; `,` `(` `)` `"` `\` are the
 * `or()` grammar's own punctuation, so a query containing them would be parsed
 * as extra clauses against columns that do not exist. Both become spaces.
 */
export function likePattern(query: string): string {
  return `%${sanitizeQuery(query)}%`;
}

/** The query with wildcard and grammar characters neutralised, whitespace collapsed. */
export function sanitizeQuery(query: string): string {
  return query.replace(/[%_,()"\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function orExpression(columns: string[], pattern: string): string {
  return columns.map((column) => `${column}.ilike.${pattern}`).join(',');
}

const str = (row: SourceRow, column: string): string | null => {
  const value = row[column];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** One line of context under the title, from whichever fields carry any. */
function snippetFrom(parts: Array<string | null | undefined>, max = 160): string | null {
  const text = parts.filter((part): part is string => Boolean(part && part.trim())).join(' · ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Money and account-number sources. Parents and adults only — see rule 2 above. */
export const MANAGER_ONLY_KINDS: readonly SearchKind[] = ['bill', 'warranty', 'renewal'];

/**
 * Parents and adults may search the money sources; a cron with no human behind
 * it may not, which is the same line `lib/services/documents` draws for
 * sensitive files.
 */
function canSearchMoney(scope: ServiceScope): boolean {
  return scope.role !== 'system' && isManager(scope.role);
}

/** Sensitive documents (Secure Vault, legal, medical, financial, identity) are manager-only too. */
function canSeeSensitiveDocuments(scope: ServiceScope): boolean {
  return scope.role !== 'system' && isManager(scope.role);
}

type SourceOutcome = { hits: Array<Omit<SearchHit, 'score'>>; failure: SearchSourceFailure | null };

/**
 * Run one source's read, converting BOTH a PostgREST error and a thrown
 * transport failure into a reported failure. Nothing here rethrows: one broken
 * table must not take the other ten with it.
 */
async function readSource(
  table: string,
  run: () => PromiseLike<{ data: unknown; error: unknown }>,
  toHits: (rows: SourceRow[]) => Array<Omit<SearchHit, 'score'>>,
): Promise<SourceOutcome> {
  try {
    const { data, error } = await run();
    if (error) {
      console.error(`[service:search] ${table} read failed`, error);
      return { hits: [], failure: { table, error: describeDbError(error, 'Could not search this source.') } };
    }
    return { hits: toHits(Array.isArray(data) ? (data as SourceRow[]) : []), failure: null };
  } catch (error) {
    console.error(`[service:search] ${table} read failed`, error);
    return { hits: [], failure: { table, error: describeDbError(error, 'Could not search this source.') } };
  }
}

/**
 * Search everything the caller is allowed to see, ranked, with evidence.
 *
 * Returns `ok` with a possibly-partial answer, or `fail` when the query is too
 * short or when every source the caller may search errored — an all-sources
 * failure is a failure, not an empty household.
 */
export async function searchHousehold(
  scope: ServiceScope,
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<ServiceResult<HouseholdSearch>> {
  const q = sanitizeQuery(query ?? '');
  if (q.length < MIN_QUERY_CHARS) {
    return fail(`Search for at least ${MIN_QUERY_CHARS} characters.`, { code: SERVICE_CODES.invalidInput });
  }
  const cap = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const pattern = likePattern(q);
  const db = scope.db;
  const family = scope.familyId;
  const money = canSearchMoney(scope);
  const sensitiveDocs = canSeeSensitiveDocuments(scope);

  const sources: Array<{ table: string; run: () => Promise<SourceOutcome> }> = [
    {
      table: 'documents',
      run: () => readSource('documents', () => db
        .from('documents')
        .select('id, title, category, is_secure, expires_at, created_at, updated_at')
        .eq('family_id', family)
        .or(orExpression(['title', 'category'], pattern))
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      (rows) => rows
        // A child searching the house does not surface the passport scan. The
        // same rule `listDocuments` applies, applied here rather than trusted
        // to be applied downstream.
        .filter((row) => sensitiveDocs || !isSensitiveDocument({
          is_secure: Boolean(row.is_secure),
          category: str(row, 'category'),
        }))
        .map((row) => ({
          kind: 'document' as const,
          id: String(row.id),
          title: str(row, 'title') ?? 'Untitled document',
          snippet: snippetFrom([str(row, 'category')]),
          table: 'documents',
          occurredAt: str(row, 'expires_at') ?? str(row, 'updated_at') ?? str(row, 'created_at'),
          href: '/dashboard/documents',
        }))),
    },
    {
      table: 'inventory_items',
      run: () => readSource('inventory_items', () => db
        .from('inventory_items')
        .select('id, name, brand, model, serial_number, notes, purchased_on, created_at, updated_at')
        .eq('family_id', family)
        .or(orExpression(['name', 'brand', 'model', 'serial_number', 'notes'], pattern))
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      (rows) => rows.map((row) => ({
        kind: 'item' as const,
        id: String(row.id),
        title: str(row, 'name') ?? 'Untitled item',
        snippet: snippetFrom([str(row, 'brand'), str(row, 'model'), str(row, 'notes')]),
        table: 'inventory_items',
        occurredAt: str(row, 'purchased_on') ?? str(row, 'updated_at') ?? str(row, 'created_at'),
        href: '/dashboard/inventory',
      }))),
    },
    {
      table: 'trips',
      run: () => readSource('trips', () => db
        .from('trips')
        .select('id, name, destination, notes, start_date, created_at, updated_at')
        .eq('family_id', family)
        .or(orExpression(['name', 'destination', 'notes'], pattern))
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      (rows) => rows.map((row) => ({
        kind: 'trip' as const,
        id: String(row.id),
        title: str(row, 'name') ?? 'Untitled trip',
        snippet: snippetFrom([str(row, 'destination'), str(row, 'notes')]),
        table: 'trips',
        occurredAt: str(row, 'start_date') ?? str(row, 'updated_at') ?? str(row, 'created_at'),
        href: '/dashboard/trips',
      }))),
    },
    {
      table: 'vacations',
      run: () => readSource('vacations', () => db
        .from('vacations')
        .select('id, title, destination, description, notes, start_date, created_at, updated_at')
        .eq('family_id', family)
        .or(orExpression(['title', 'destination', 'description', 'notes'], pattern))
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      (rows) => rows.map((row) => ({
        kind: 'vacation' as const,
        id: String(row.id),
        title: str(row, 'title') ?? 'Untitled vacation',
        snippet: snippetFrom([str(row, 'destination'), str(row, 'description')]),
        table: 'vacations',
        occurredAt: str(row, 'start_date') ?? str(row, 'updated_at') ?? str(row, 'created_at'),
        // The one source with a per-record route; everything else links to the
        // list page it already lives on rather than to a URL that 404s.
        href: `/dashboard/vacations/${String(row.id)}`,
      }))),
    },
    {
      table: 'family_decisions',
      run: () => readSource('family_decisions', () => db
        .from('family_decisions')
        .select('id, question, detail, status, created_at, updated_at')
        .eq('family_id', family)
        .or(orExpression(['question', 'detail'], pattern))
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      (rows) => rows.map((row) => ({
        kind: 'decision' as const,
        id: String(row.id),
        title: str(row, 'question') ?? 'Untitled decision',
        snippet: snippetFrom([str(row, 'detail')]),
        table: 'family_decisions',
        occurredAt: str(row, 'updated_at') ?? str(row, 'created_at'),
        href: '/dashboard/decisions',
      }))),
    },
    {
      table: 'calendar_events',
      run: () => readSource('calendar_events', () => db
        .from('calendar_events')
        .select('id, title, description, location, starts_at, created_at, updated_at')
        .eq('family_id', family)
        .or(orExpression(['title', 'description', 'location'], pattern))
        .order('starts_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      (rows) => rows.map((row) => ({
        kind: 'event' as const,
        id: String(row.id),
        title: str(row, 'title') ?? 'Untitled event',
        snippet: snippetFrom([str(row, 'location'), str(row, 'description')]),
        table: 'calendar_events',
        occurredAt: str(row, 'starts_at') ?? str(row, 'updated_at') ?? str(row, 'created_at'),
        href: '/dashboard/calendar',
      }))),
    },
    {
      table: 'notes',
      run: () => readSource('notes', () => db
        .from('notes')
        .select('id, title, body, created_at, updated_at')
        .eq('family_id', family)
        .or(orExpression(['title', 'body'], pattern))
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      (rows) => rows.map((row) => ({
        kind: 'note' as const,
        id: String(row.id),
        title: str(row, 'title') ?? str(row, 'body')?.slice(0, 80) ?? 'Untitled note',
        snippet: snippetFrom([str(row, 'body')]),
        table: 'notes',
        occurredAt: str(row, 'updated_at') ?? str(row, 'created_at'),
        href: '/dashboard/notes',
      }))),
    },
    {
      table: 'family_facts',
      run: () => readSource('family_facts', () => db
        .from('family_facts')
        .select('id, label, value, notes, category, created_at, updated_at')
        .eq('family_id', family)
        .or(orExpression(['label', 'value', 'notes'], pattern))
        .order('updated_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      (rows) => rows.map((row) => ({
        kind: 'fact' as const,
        id: String(row.id),
        title: str(row, 'label') ?? 'Untitled memory',
        snippet: snippetFrom([str(row, 'value'), str(row, 'notes')]),
        table: 'family_facts',
        occurredAt: str(row, 'updated_at') ?? str(row, 'created_at'),
        href: '/dashboard/knowledge',
      }))),
    },
  ];

  if (money) {
    sources.push(
      {
        table: 'bills',
        run: () => readSource('bills', () => db
          .from('bills')
          .select('id, name, category, due_date, status, created_at, updated_at')
          .eq('family_id', family)
          .or(orExpression(['name', 'category'], pattern))
          .order('due_date', { ascending: false })
          .limit(PER_SOURCE_LIMIT),
        (rows) => rows.map((row) => ({
          kind: 'bill' as const,
          id: String(row.id),
          title: str(row, 'name') ?? 'Untitled bill',
          snippet: snippetFrom([str(row, 'category'), str(row, 'status')]),
          table: 'bills',
          occurredAt: str(row, 'due_date') ?? str(row, 'updated_at') ?? str(row, 'created_at'),
          href: '/dashboard/bills',
        }))),
      },
      {
        table: 'home_warranties',
        run: () => readSource('home_warranties', () => db
          .from('home_warranties')
          .select('id, name, provider, coverage, warranty_type, notes, expires_on, created_at, updated_at')
          .eq('family_id', family)
          .is('deleted_at', null)
          .or(orExpression(['name', 'provider', 'coverage', 'notes'], pattern))
          .order('updated_at', { ascending: false })
          .limit(PER_SOURCE_LIMIT),
        // `policy_number` is searchable in neither direction: it is not matched
        // and it is never returned. A search result is not the place a policy
        // identifier should leak out of the warranty screen.
        (rows) => rows.map((row) => ({
          kind: 'warranty' as const,
          id: String(row.id),
          title: str(row, 'name') ?? 'Untitled warranty',
          snippet: snippetFrom([str(row, 'provider'), str(row, 'warranty_type'), str(row, 'coverage')]),
          table: 'home_warranties',
          occurredAt: str(row, 'expires_on') ?? str(row, 'updated_at') ?? str(row, 'created_at'),
          href: '/dashboard/home/warranties',
        }))),
      },
      {
        table: 'renewals',
        run: () => readSource('renewals', () => db
          .from('renewals')
          .select('id, title, category, notes, expires_at, status, created_at, updated_at')
          .eq('family_id', family)
          .or(orExpression(['title', 'category', 'notes'], pattern))
          .order('expires_at', { ascending: false })
          .limit(PER_SOURCE_LIMIT),
        (rows) => rows.map((row) => ({
          kind: 'renewal' as const,
          id: String(row.id),
          title: str(row, 'title') ?? 'Untitled renewal',
          snippet: snippetFrom([str(row, 'category'), str(row, 'notes')]),
          table: 'renewals',
          occurredAt: str(row, 'expires_at') ?? str(row, 'updated_at') ?? str(row, 'created_at'),
          href: '/dashboard/renewals',
        }))),
      },
    );
  }

  const outcomes = await Promise.all(sources.map((source) => source.run()));
  const partial = outcomes.map((outcome) => outcome.failure).filter((f): f is SearchSourceFailure => f !== null);

  // Every source failing is not an empty household — it is an outage, and the
  // caller must be able to render a retryable error rather than "no results".
  if (partial.length === sources.length) {
    return fail('Could not search your household right now.', { code: SERVICE_CODES.db, retryable: true });
  }

  const hits = rankHits(q, outcomes.flatMap((outcome) => outcome.hits), { now: scope.now, limit: cap });

  return ok({
    query: q,
    hits,
    partial,
    searched: sources.filter((source) => !partial.some((f) => f.table === source.table)).map((source) => source.table),
    withheld: money ? [] : [...MANAGER_ONLY_KINDS],
  });
}
