// lib/privacy/export.ts — "Export my family's data", built the honest way.
//
// Every section is read through the domain services under the CALLER's
// `ServiceScope`: the same role checks that decide what a person sees in the
// app decide what lands in their file (`assertFinanceReader` refuses a teen the
// transactions; `listDocuments` withholds a child's view of the Vault), and RLS
// applies underneath because the scope carries the caller's own client. There
// is no bucket and no service-role read: the export is a view of what the
// person could already open, written down.
//
// A section that cannot be read FAILS THE EXPORT. A file that quietly says
// `"calendar": []` after a dropped read is the reassuring-but-wrong answer the
// strategy forbids; a person deleting their account on the strength of that
// file would lose the events it claims they never had. The caller gets the
// list of sections that failed and shows a retryable error instead.
import 'server-only';
import { isManager } from '@/lib/constants/roles';
import { searchEvents } from '@/lib/services/calendar';
import { listDocuments } from '@/lib/services/documents';
import { getMembers, getPreferences } from '@/lib/services/family';
import { listTransactions } from '@/lib/services/finances';
import { listOpen as listOpenGroceries } from '@/lib/services/groceries';
import { listMemories, PENDING_SUGGESTION_LIMIT } from '@/lib/services/memory';
import { listAllRoutines } from '@/lib/services/routines';
import { listClassRoster, listEventsBetween } from '@/lib/services/school';
import { normalizeCalendarWindowInstant } from '@/lib/briefing/calendar-window';
import { describeDbError } from '@/lib/supabase/errors';
import { dayKeyInTz, scopeNow, zonedDayBoundsMs } from '@/lib/services/scope';
import { listPracticesBetween, listTeams } from '@/lib/services/sports';
import { searchTodos } from '@/lib/services/tasks';
import { listTrips } from '@/lib/services/trips';
import { fail, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { EXPORT_NOT_INCLUDED } from './export-coverage';

export const EXPORT_FORMAT_VERSION = 1;

export type ExportSectionKey =
  | 'family'
  | 'members'
  | 'calendar'
  | 'todos'
  | 'memories'
  | 'documents'
  | 'trips'
  | 'groceries'
  | 'school'
  | 'sports'
  | 'routines'
  | 'finances';

export type ExportSectionSpec = {
  key: ExportSectionKey;
  /** Read only for parent/adult callers; other roles do not get the section at all. */
  managerOnly: boolean;
  /**
   * The most rows the backing service returns. Written into the file so a
   * family with more knows the section is a window, not the whole.
   */
  limit: number | null;
};

/**
 * The catalogue of what an export holds, in file order. Adding a section is a
 * product decision as much as a code one: it must go through a service that
 * applies the role rule, or it becomes the one place a child reads the
 * finances.
 */
export const EXPORT_SECTIONS: readonly ExportSectionSpec[] = [
  { key: 'family', managerOnly: false, limit: null },
  { key: 'members', managerOnly: false, limit: null },
  { key: 'calendar', managerOnly: false, limit: 200 },
  { key: 'todos', managerOnly: false, limit: 200 },
  { key: 'memories', managerOnly: false, limit: 500 },
  { key: 'documents', managerOnly: false, limit: 500 },
  { key: 'trips', managerOnly: false, limit: 200 },
  { key: 'groceries', managerOnly: false, limit: 500 },
  { key: 'school', managerOnly: false, limit: 500 },
  { key: 'sports', managerOnly: false, limit: 500 },
  { key: 'routines', managerOnly: false, limit: null },
  { key: 'finances', managerOnly: true, limit: 5000 },
];

/** Which sections a role receives. Pure, so the boundary is testable on its own. */
export function sectionsForRole(role: string | null | undefined): ExportSectionKey[] {
  const manager = isManager(role);
  return EXPORT_SECTIONS.filter((s) => manager || !s.managerOnly).map((s) => s.key);
}

export type ExportSection = {
  key: ExportSectionKey;
  /** How many top-level rows the section carries. */
  count: number;
  /** The service's ceiling, when it has one; `count === limit` means "maybe more". */
  limit: number | null;
  /**
   * True when the section is a window on the data: `count` reached `limit`,
   * the family has rows outside `window`, or the family holds as many rows as
   * the service's cap (counted before any role filter, so a non-manager's
   * shorter list cannot pass for the whole).
   */
  truncated: boolean;
  /**
   * The dates a section was read between, for the sections read by date. The
   * file says so rather than presenting a two-year window as everything: an
   * event older than a year, or a weekly series started 14 months ago, is not
   * in it, and `truncated` is true when the family has any such row.
   */
  window?: { from: string; to: string };
  /**
   * The members section only: whether removed (`isActive: false`) members are
   * in it. True for a parent or adult, who manage removals; every other role's
   * roster hides removed members in the app, so their file does too.
   */
  includesRemovedMembers?: boolean;
  data: unknown;
};

export type FamilyExport = {
  format: 'bubaly-family-export';
  version: number;
  exportedAt: string;
  family: { id: string; name: string; timezone: string };
  exportedBy: { userId: string | null; memberId: string | null; role: string };
  /** Sections the caller's role does not receive, named so the file says what it omits. */
  withheld: ExportSectionKey[];
  /**
   * The modules the export does not read at all, for any role (health, journal,
   * locations, credentials, wallet, ...): lib/privacy/export-coverage.ts. The
   * file is presented as a copy of the family's data and recommended before a
   * deletion request, so what it leaves out is written in it.
   */
  notIncluded: string[];
  sections: ExportSection[];
};

export type ExportFailure = { key: ExportSectionKey; error: string };

export type ExportBuild =
  | { ok: true; data: FamilyExport }
  | { ok: false; failed: ExportFailure[] };

function dayKey(scope: ServiceScope, offsetDays: number): string {
  const now = scopeNow(scope);
  return dayKeyInTz(new Date(now.getTime() + offsetDays * 86_400_000), scope.tz);
}

type SectionRead = ServiceResult<{ data: unknown; count: number; window?: { from: string; to: string }; beyondWindow?: boolean; capped?: boolean; includesRemovedMembers?: boolean }>;

/** The instants a school or sports read between two family dates spans: the first day's midnight to the last day's last millisecond. */
function familyDayWindow(scope: ServiceScope, window: { from: string; to: string }): { from: string; to: string } {
  return {
    from: new Date(zonedDayBoundsMs(window.from, scope.tz).start).toISOString(),
    to: new Date(zonedDayBoundsMs(window.to, scope.tz).end - 1).toISOString(),
  };
}

/**
 * Whether the family has stored rows of `table` that the windowed read left
 * out, counted exactly. A count that cannot be read fails the section: the
 * file would otherwise claim to be complete on the strength of a missing number.
 */
async function rowsBeyondWindow(scope: ServiceScope, table: 'calendar_events' | 'school_events' | 'sports_events' | 'transactions', outside: string): Promise<ServiceResult<boolean>> {
  const { count, error } = await scope.db.from(table).select('id', { count: 'exact', head: true })
    .eq('family_id', scope.familyId).or(outside);
  if (error || typeof count !== 'number') {
    console.error(`[privacy] export ${table} window count failed`, { familyId: scope.familyId, error });
    return fail(describeDbError(error, 'Could not check for older or later rows.'), { code: SERVICE_CODES.db });
  }
  return { ok: true, data: count > 0 };
}

/**
 * Whether the family holds at least `cap` rows of what `count` counts — the
 * service's own ceiling, so the read may have left rows out. Counted BEFORE the
 * role filter: `listMemories` and `listDocuments` read to their cap and then
 * drop the sensitive rows for a non-manager, so a count taken after the filter
 * could sit under the cap while the table did not, and the file said it was
 * complete. `listMemories` also reads pending suggestions to their own cap,
 * which the facts count never saw. A count that cannot be read fails the
 * section, as `rowsBeyondWindow` does.
 */
async function rowsAtCap(scope: ServiceScope, what: string, cap: number, count: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<ServiceResult<boolean>> {
  const { count: rows, error } = await count();
  if (error || typeof rows !== 'number') {
    console.error(`[privacy] export ${what} count failed`, { familyId: scope.familyId, error });
    return fail(describeDbError(error, 'Could not count the family’s rows.'), { code: SERVICE_CODES.db });
  }
  return { ok: true, data: rows >= cap };
}

/**
 * One reader per section. Each returns the SERVICE's answer untouched, so a
 * refusal (`denied`) or a database error surfaces as a failure of that
 * section rather than an empty array.
 */
async function readSection(scope: ServiceScope, key: ExportSectionKey): Promise<SectionRead> {
  switch (key) {
    case 'family': {
      const r = await getPreferences(scope);
      return r.ok ? { ok: true, data: { data: r.data, count: 1 } } : r;
    }
    case 'members': {
      // Removed members for a parent or adult only. Every in-app roster hides
      // `is_active = false` rows, and this read used to include them for every
      // role, so a child's or guest's file carried the birthday, auth user id
      // and avatar of an ex-partner or former caregiver the roster never showed
      // them. The file says which it holds (includesRemovedMembers).
      const includeInactive = isManager(scope.role);
      const r = await getMembers(scope, { includeInactive, requireComplete: true });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length, includesRemovedMembers: includeInactive } } : r;
    }
    case 'calendar': {
      const window = { from: dayKey(scope, -365), to: dayKey(scope, 365) };
      const r = await searchEvents(scope, { ...window, limit: 200, expandSeries: false });
      if (!r.ok) return r;
      // The same bounds searchEvents read between: `from` inclusive, `to` inclusive.
      const beyond = await rowsBeyondWindow(scope, 'calendar_events',
        `starts_at.lt.${normalizeCalendarWindowInstant(window.from, scope.tz)},starts_at.gt.${normalizeCalendarWindowInstant(window.to, scope.tz)}`);
      if (!beyond.ok) return beyond;
      return { ok: true, data: { data: r.data, count: r.data.length, window, beyondWindow: beyond.data } };
    }
    case 'todos': {
      const r = await searchTodos(scope, { limit: 200 });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length } } : r;
    }
    case 'memories': {
      const r = await listMemories(scope);
      if (!r.ok) return r;
      const [facts, pending] = await Promise.all([
        rowsAtCap(scope, 'family_facts', 500, () => scope.db.from('family_facts').select('id', { count: 'exact', head: true }).eq('family_id', scope.familyId)),
        rowsAtCap(scope, 'family_playbook_suggestions', PENDING_SUGGESTION_LIMIT, () => scope.db.from('family_playbook_suggestions').select('id', { count: 'exact', head: true })
          .eq('family_id', scope.familyId).eq('status', 'suggested')),
      ]);
      if (!facts.ok) return facts;
      if (!pending.ok) return pending;
      return { ok: true, data: { data: r.data, count: r.data.facts.length, capped: facts.data || pending.data } };
    }
    case 'documents': {
      const r = await listDocuments(scope, { limit: 500 });
      if (!r.ok) return r;
      const cap = await rowsAtCap(scope, 'documents', 500, () => scope.db.from('documents').select('id', { count: 'exact', head: true }).eq('family_id', scope.familyId));
      if (!cap.ok) return cap;
      return { ok: true, data: { data: r.data, count: r.data.length, capped: cap.data } };
    }
    case 'trips': {
      const r = await listTrips(scope, { includeFinished: true, limit: 200 });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length } } : r;
    }
    case 'groceries': {
      const r = await listOpenGroceries(scope, { limit: 500 });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.items.length } } : r;
    }
    case 'school': {
      const window = { from: dayKey(scope, -365), to: dayKey(scope, 365) };
      const bounds = familyDayWindow(scope, window);
      const [events, classes, beyond] = await Promise.all([
        listEventsBetween(scope, { ...window, limit: 500 }),
        listClassRoster(scope, { limit: 500 }),
        rowsBeyondWindow(scope, 'school_events', `starts_at.lt.${bounds.from},starts_at.gt.${bounds.to}`),
      ]);
      if (!events.ok) return events;
      if (!classes.ok) return classes;
      if (!beyond.ok) return beyond;
      return { ok: true, data: { data: { events: events.data, classes: classes.data }, count: events.data.length + classes.data.length, window, beyondWindow: beyond.data } };
    }
    case 'sports': {
      const window = { from: dayKey(scope, -365), to: dayKey(scope, 365) };
      // listPracticesBetween reads one-offs that start in the window and every
      // series still running in it. Left out: one-offs before or after it, a
      // series that starts after it or ended before it, and a row whose
      // recurrence is unset (neither of its reads matches one).
      const { from, to } = familyDayWindow(scope, window);
      const [teams, practices, beyond] = await Promise.all([
        listTeams(scope, { activeOnly: false }),
        listPracticesBetween(scope, { ...window, limit: 500 }),
        rowsBeyondWindow(scope, 'sports_events', `recurrence.is.null,and(recurrence.eq.none,starts_at.lt.${from}),and(recurrence.eq.none,starts_at.gt.${to}),and(recurrence.neq.none,starts_at.gt.${to}),and(recurrence.neq.none,recurrence_until.lte.${from})`),
      ]);
      if (!teams.ok) return teams;
      if (!practices.ok) return practices;
      if (!beyond.ok) return beyond;
      return { ok: true, data: { data: { teams: teams.data, events: practices.data }, count: teams.data.length + practices.data.length, window, beyondWindow: beyond.data } };
    }
    case 'routines': {
      const r = await listAllRoutines(scope);
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length } } : r;
    }
    case 'finances': {
      const r = await listTransactions(scope, { from: dayKey(scope, -730), to: dayKey(scope, 0), limit: 5000 });
      if (!r.ok) return r;
      // Transaction dates are family-local dates, so use the finance reader's
      // actual inclusive range without converting it to UTC instants.
      const window = r.data.range;
      const beyond = await rowsBeyondWindow(scope, 'transactions', `date.lt.${window.from},date.gt.${window.to}`);
      if (!beyond.ok) return beyond;
      return { ok: true, data: { data: r.data, count: r.data.transactions.length, window, beyondWindow: beyond.data, capped: !r.data.complete } };
    }
  }
}

/**
 * Assemble the export for `scope`. Sections are read in parallel; the
 * result is all-or-nothing (see the file header for why).
 */
export async function buildFamilyExport(scope: ServiceScope): Promise<ExportBuild> {
  const keys = sectionsForRole(scope.role);
  const withheld = EXPORT_SECTIONS.map((s) => s.key).filter((k) => !keys.includes(k));
  const specs = new Map(EXPORT_SECTIONS.map((s) => [s.key, s] as const));

  const reads = await Promise.all(keys.map(async (key) => ({ key, read: await readSection(scope, key) })));

  const failed: ExportFailure[] = [];
  const sections: ExportSection[] = [];
  for (const { key, read } of reads) {
    if (!read.ok) {
      console.error(`[privacy] export ${key} read failed`, { familyId: scope.familyId, error: read.error, code: read.code });
      failed.push({ key, error: read.error });
      continue;
    }
    const limit = specs.get(key)?.limit ?? null;
    sections.push({
      key,
      count: read.data.count,
      limit,
      truncated: (limit !== null && read.data.count >= limit) || read.data.beyondWindow === true || read.data.capped === true,
      ...(read.data.window ? { window: read.data.window } : {}),
      ...(read.data.includesRemovedMembers !== undefined ? { includesRemovedMembers: read.data.includesRemovedMembers } : {}),
      data: read.data.data,
    });
  }
  if (failed.length) return { ok: false, failed };

  const family = sections.find((s) => s.key === 'family')?.data as { familyId: string; familyName: string; timezone: string } | undefined;
  return {
    ok: true,
    data: {
      format: 'bubaly-family-export',
      version: EXPORT_FORMAT_VERSION,
      exportedAt: scopeNow(scope).toISOString(),
      family: { id: scope.familyId, name: family?.familyName ?? '', timezone: family?.timezone ?? scope.tz },
      exportedBy: { userId: scope.userId, memberId: scope.memberId, role: scope.role },
      withheld,
      notIncluded: [...EXPORT_NOT_INCLUDED],
      sections,
    },
  };
}

/**
 * Serialise the export as a stream of UTF-8 JSON chunks, one section per
 * chunk. The data is already in memory — the stream exists so a large family
 * is not turned into one multi-megabyte string on top of that — and the
 * output is ordinary JSON a person can open.
 */
export function serializeExport(exportData: FamilyExport): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { sections, ...head } = exportData;
  const chunks: string[] = [];
  const headJson = JSON.stringify(head, null, 2);
  // Drop the closing brace so the sections can follow inside the same object.
  chunks.push(`${headJson.slice(0, -1).trimEnd()},\n  "sections": [`);
  sections.forEach((section, i) => {
    chunks.push(`${i ? ',' : ''}\n    ${JSON.stringify(section)}`);
  });
  chunks.push('\n  ]\n}\n');

  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

/** `bubaly-export-<family>-<YYYY-MM-DD>.json`, safe for a Content-Disposition header. */
export function exportFilename(familyName: string, exportedAt: string): string {
  // NFKD splits "Ü" into "U" + a combining mark; the mark is dropped so the
  // letter survives instead of becoming a stray hyphen.
  const slug = familyName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'family';
  return `bubaly-export-${slug}-${exportedAt.slice(0, 10)}.json`;
}
