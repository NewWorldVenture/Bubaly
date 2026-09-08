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
import { listMemories } from '@/lib/services/memory';
import { listRoutines } from '@/lib/services/routines';
import { listClasses, listEventsBetween } from '@/lib/services/school';
import { dayKeyInTz, scopeNow } from '@/lib/services/scope';
import { listPracticesBetween, listTeams } from '@/lib/services/sports';
import { searchTodos } from '@/lib/services/tasks';
import { listTrips } from '@/lib/services/trips';
import type { ServiceResult, ServiceScope } from '@/lib/services/types';

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
  /** True when `count` reached `limit`: the section is a window on the data. */
  truncated: boolean;
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

type SectionRead = ServiceResult<{ data: unknown; count: number }>;

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
      const r = await getMembers(scope, { includeInactive: true });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length } } : r;
    }
    case 'calendar': {
      const r = await searchEvents(scope, { from: dayKey(scope, -365), to: dayKey(scope, 365), limit: 200 });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length } } : r;
    }
    case 'todos': {
      const r = await searchTodos(scope, { limit: 200 });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length } } : r;
    }
    case 'memories': {
      const r = await listMemories(scope);
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.facts.length } } : r;
    }
    case 'documents': {
      const r = await listDocuments(scope, { limit: 500 });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length } } : r;
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
      const [events, classes] = await Promise.all([
        listEventsBetween(scope, { from: dayKey(scope, -365), to: dayKey(scope, 365), limit: 500 }),
        listClasses(scope),
      ]);
      if (!events.ok) return events;
      if (!classes.ok) return classes;
      return { ok: true, data: { data: { events: events.data, classes: classes.data }, count: events.data.length + classes.data.length } };
    }
    case 'sports': {
      const [teams, practices] = await Promise.all([
        listTeams(scope, { activeOnly: false }),
        listPracticesBetween(scope, { from: dayKey(scope, -365), to: dayKey(scope, 365), limit: 500 }),
      ]);
      if (!teams.ok) return teams;
      if (!practices.ok) return practices;
      return { ok: true, data: { data: { teams: teams.data, events: practices.data }, count: teams.data.length + practices.data.length } };
    }
    case 'routines': {
      const r = await listRoutines(scope, { includeDisabled: true });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.length } } : r;
    }
    case 'finances': {
      const r = await listTransactions(scope, { from: dayKey(scope, -730), to: dayKey(scope, 0), limit: 5000 });
      return r.ok ? { ok: true, data: { data: r.data, count: r.data.transactions.length } } : r;
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
      truncated: limit !== null && read.data.count >= limit,
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
