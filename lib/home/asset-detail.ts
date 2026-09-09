// One home asset, seen whole: what covers it, what paperwork the family has for
// it, what has been done to it, what is still owed on it, and what project in
// its room is in flight.
//
// WHY THIS FILE EXISTS. The home twin was six modules that never met. A family
// could hold the fridge's warranty on /home/warranties, its manual nowhere at
// all, its last repair on /home/service and its open filter task on /home —
// and no surface put those four facts on one page. This composes them, from
// persisted rows only.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//   * No replacement lineage. `home_assets` has no `replaced_by_asset_id` and no
//     `retired_on` (0002 + 0036 are the whole column list), so "this replaced
//     that" cannot be read from a row and is therefore not claimed. The same
//     goes for a Retire action: there is no status-like column on `home_assets`
//     that admits "retired" — `condition` is new/good/fair/poor — so nothing
//     here writes one.
//   * No asset↔project foreign key. `home_projects` (0246) carries `room`, not
//     `asset_id`. The related-projects panel therefore matches the project's
//     ROOM against the asset's LOCATION and says so in its heading; it never
//     presents a room match as a declared link.
//
// The composer is pure so it can be tested directly; the loader takes the
// client so a test can drive its failure modes. Every read fails closed: a read
// error returns `{ status: 'error' }`, never an empty panel, because "no
// service history" and "the service history did not load" are different facts
// and a family acts differently on each.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { describeReadError, settle, settleAll } from '@/lib/supabase/settle';

export type AssetRow = Tables<'home_assets'>;
export type AssetWarrantyRow = Tables<'home_warranties'>;
export type AssetDocumentRow = Tables<'documents'>;
export type AssetServiceRow = Tables<'home_service_records'>;
export type AssetTaskRow = Tables<'maintenance_tasks'>;
export type AssetProjectRow = Tables<'home_projects'>;

/** `documents.category` is plain `text` with no CHECK anywhere in the
 *  migrations (0002 defines it, 01090 only indexes it), so 'manual' needs no
 *  DDL — it is a value the column already admits. */
export const MANUAL_CATEGORY = 'manual';
export const WARRANTY_CATEGORY = 'warranty';

/** The project statuses that are still live (0246's CHECK list minus the two
 *  terminal ones). A finished project is not "in flight in this room". */
export const LIVE_PROJECT_STATUSES = [
  'idea', 'planning', 'quoting', 'scheduled', 'in_progress', 'on_hold',
] as const;

/** Open maintenance, in the same vocabulary the Home module writes. */
export const OPEN_TASK_STATUSES = ['todo', 'in_progress'] as const;

const DAY_MS = 86_400_000;
/** Bounded reads: a detail page is a summary, not an export. */
export const HISTORY_LIMIT = 50;

export type CoverageState = 'unknown' | 'active' | 'expiring' | 'expired';

/** Where a coverage date came from, so the page never implies a warranty row
 *  exists when all the family recorded was a date on the asset itself. */
export type CoverageSource = 'home_warranties' | 'home_assets';

export type CoverageView = {
  id: string;
  name: string | null;
  provider: string | null;
  warrantyType: string | null;
  expiresOn: string | null;
  claimPhone: string | null;
  state: CoverageState;
  /** Whole days from `today` to `expiresOn`; null when no date is recorded. */
  daysLeft: number | null;
  source: CoverageSource;
};

export type DocumentView = {
  id: string;
  title: string;
  category: string | null;
  storagePath: string;
  sizeBytes: number | null;
  expiresAt: string | null;
  createdAt: string;
};

export type ServiceView = {
  id: string;
  title: string;
  serviceDate: string;
  provider: string | null;
  cost: number | null;
  description: string | null;
  nextDueOn: string | null;
};

export type TaskView = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
};

export type ProjectView = {
  id: string;
  title: string;
  room: string | null;
  status: string;
  priority: string;
  targetStart: string | null;
  targetEnd: string | null;
};

export type AssetDetail = {
  asset: AssetRow;
  /** The soonest-expiring coverage, or the asset's own `warranty_until` when no
   *  `home_warranties` row exists. Null when neither is recorded. */
  coverage: CoverageView | null;
  coverages: CoverageView[];
  manuals: DocumentView[];
  warrantyDocuments: DocumentView[];
  otherDocuments: DocumentView[];
  serviceHistory: ServiceView[];
  openMaintenance: TaskView[];
  /** Live projects whose `room` matches this asset's `location`. Empty when the
   *  asset has no location — there is nothing to match on. */
  relatedProjects: ProjectView[];
  /** The room the projects were matched on, for the panel's heading. */
  roomLabel: string | null;
};

export type AssetDetailInput = {
  asset: AssetRow;
  warranties: AssetWarrantyRow[];
  documents: AssetDocumentRow[];
  serviceRecords: AssetServiceRow[];
  openTasks: AssetTaskRow[];
  projects: AssetProjectRow[];
  /** yyyy-mm-dd; defaults to today. Injected so coverage maths is testable. */
  today?: string;
};

// ── pure ────────────────────────────────────────────────────────────────────

function dayStart(day: string): number {
  return Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
}

/** Whole days from `today` to `expiresOn`, or null when either is unusable. */
export function daysUntilDate(expiresOn: string | null | undefined, today: string): number | null {
  if (!expiresOn) return null;
  const end = dayStart(expiresOn);
  const now = dayStart(today);
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null;
  return Math.round((end - now) / DAY_MS);
}

/**
 * Coverage state from an end date. 'expiring' is the 45-day window the Home
 * module already treats as "act now" (`lib/home/maintenance.ts`), kept the same
 * here so one asset does not read differently on two pages.
 *
 * No date is 'unknown', NOT 'active'. A missing expiry is an unanswered
 * question, and rendering it as covered is exactly the reassuring lie this
 * repository keeps having to remove.
 */
export function coverageState(expiresOn: string | null | undefined, today: string): CoverageState {
  const days = daysUntilDate(expiresOn, today);
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= 45) return 'expiring';
  return 'active';
}

/** Two room/location names are the same place: case- and space-insensitive. */
export function sameRoom(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  const right = (b ?? '').trim().toLowerCase();
  if (left === '' || right === '') return false;
  return left === right;
}

function toDocumentView(row: AssetDocumentRow): DocumentView {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    storagePath: row.storage_path,
    sizeBytes: row.size_bytes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function categoryIs(row: AssetDocumentRow, wanted: string): boolean {
  return (row.category ?? '').trim().toLowerCase() === wanted;
}

function coverageFromWarranty(row: AssetWarrantyRow, today: string): CoverageView {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    warrantyType: row.warranty_type,
    expiresOn: row.expires_on,
    claimPhone: row.claim_phone,
    state: coverageState(row.expires_on, today),
    daysLeft: daysUntilDate(row.expires_on, today),
    source: 'home_warranties',
  };
}

/** Soonest end date first; a coverage with no end date sorts last. */
function byExpiry(a: CoverageView, b: CoverageView): number {
  if (a.expiresOn === b.expiresOn) return 0;
  if (!a.expiresOn) return 1;
  if (!b.expiresOn) return -1;
  return a.expiresOn.localeCompare(b.expiresOn);
}

/**
 * Compose the asset view from rows that are already in hand. Pure: no clock
 * beyond the injected `today`, no client, no I/O.
 */
export function composeAssetDetail(input: AssetDetailInput): AssetDetail {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const { asset } = input;

  const coverages = input.warranties
    .filter((w) => w.deleted_at == null)
    .map((w) => coverageFromWarranty(w, today))
    .sort(byExpiry);

  // The asset's own `warranty_until` is a real persisted fact and the only
  // coverage most families record, so it stands in when no warranty row exists
  // — labelled as coming from the asset, not from a warranty policy.
  const assetCoverage: CoverageView | null = asset.warranty_until
    ? {
      id: `asset:${asset.id}`,
      name: null,
      provider: null,
      warrantyType: null,
      expiresOn: asset.warranty_until,
      claimPhone: null,
      state: coverageState(asset.warranty_until, today),
      daysLeft: daysUntilDate(asset.warranty_until, today),
      source: 'home_assets',
    }
    : null;

  const coverage = coverages[0] ?? assetCoverage;

  const manuals = input.documents.filter((d) => categoryIs(d, MANUAL_CATEGORY)).map(toDocumentView);
  const warrantyDocuments = input.documents.filter((d) => categoryIs(d, WARRANTY_CATEGORY)).map(toDocumentView);
  const otherDocuments = input.documents
    .filter((d) => !categoryIs(d, MANUAL_CATEGORY) && !categoryIs(d, WARRANTY_CATEGORY))
    .map(toDocumentView);

  const serviceHistory = input.serviceRecords
    .filter((r) => r.deleted_at == null)
    .slice()
    .sort((a, b) => b.service_date.localeCompare(a.service_date))
    .map((r) => ({
      id: r.id,
      title: r.title,
      serviceDate: r.service_date,
      provider: r.provider,
      cost: r.cost,
      description: r.description,
      nextDueOn: r.next_due_on,
    }));

  const openStatuses = new Set<string>(OPEN_TASK_STATUSES);
  const openMaintenance = input.openTasks
    .filter((t) => openStatuses.has(t.status))
    .slice()
    .sort((a, b) => {
      if (a.due_at === b.due_at) return a.title.localeCompare(b.title);
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return a.due_at.localeCompare(b.due_at);
    })
    .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueAt: t.due_at }));

  const roomLabel = (asset.location ?? '').trim() || null;
  const liveStatuses = new Set<string>(LIVE_PROJECT_STATUSES);
  const relatedProjects = input.projects
    .filter((p) => liveStatuses.has(p.status) && sameRoom(p.room, asset.location))
    .map((p) => ({
      id: p.id,
      title: p.title,
      room: p.room,
      status: p.status,
      priority: p.priority,
      targetStart: p.target_start,
      targetEnd: p.target_end,
    }));

  return {
    asset,
    coverage,
    coverages,
    manuals,
    warrantyDocuments,
    otherDocuments,
    serviceHistory,
    openMaintenance,
    relatedProjects,
    roomLabel,
  };
}

// ── read boundary ───────────────────────────────────────────────────────────

export type AssetDetailLoad =
  | { status: 'ok'; detail: AssetDetail }
  | { status: 'not_found' }
  | { status: 'error'; reason: string };

/**
 * Read one asset and everything hanging off it, family-scoped.
 *
 * Fail-closed contract, deliberately spelled out because every panel here has a
 * plausible-looking empty state: a read error returns `{ status: 'error' }` and
 * the page renders "could not load … try again". It never returns a detail with
 * a silently empty panel, because a family reading "no open maintenance" when
 * the table was unreachable is being told something untrue about their house.
 *
 * `settleAll` carries the batch so an unreachable table degrades like a query
 * error instead of rejecting the page. Only PostgREST-shaped queries ride in it
 * — no ServiceResult, no plain value — and the asset read is awaited BEFORE the
 * batch is built (it decides not-found, and its `location` is what the project
 * match needs), so no promise is left orphaned while the array literal is
 * evaluated.
 */
export async function loadAssetDetail(
  supabase: SupabaseClient<Database>,
  args: { familyId: string; assetId: string; today?: string },
): Promise<AssetDetailLoad> {
  const { familyId, assetId } = args;

  const assetRes = await settle(
    supabase
      .from('home_assets')
      .select('*')
      .eq('id', assetId)
      .eq('family_id', familyId)
      .maybeSingle(),
  );
  if (assetRes.error) {
    console.error('[home/asset-detail] asset read failed', assetRes.error);
    return { status: 'error', reason: describeReadError(assetRes.error) };
  }
  const asset = assetRes.data as AssetRow | null;
  if (!asset) return { status: 'not_found' };

  const [warrantiesRes, documentsRes, serviceRes, tasksRes, projectsRes] = await settleAll([
    supabase
      .from('home_warranties')
      .select('*')
      .eq('family_id', familyId)
      .eq('asset_id', assetId)
      .is('deleted_at', null)
      .order('expires_on', { ascending: true, nullsFirst: false }),
    supabase
      .from('documents')
      .select('*')
      .eq('family_id', familyId)
      .eq('asset_id', assetId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
    supabase
      .from('home_service_records')
      .select('*')
      .eq('family_id', familyId)
      .eq('asset_id', assetId)
      .is('deleted_at', null)
      .order('service_date', { ascending: false })
      .limit(HISTORY_LIMIT),
    supabase
      .from('maintenance_tasks')
      .select('*')
      .eq('family_id', familyId)
      .eq('asset_id', assetId)
      .in('status', [...OPEN_TASK_STATUSES])
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(HISTORY_LIMIT),
    // `home_projects` has no asset_id (0246), so this reads the family's live
    // projects and the composer keeps the ones in the same room.
    supabase
      .from('home_projects')
      .select('*')
      .eq('family_id', familyId)
      .in('status', [...LIVE_PROJECT_STATUSES])
      .order('updated_at', { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);

  const failures: [string, unknown][] = [
    ['home_warranties', warrantiesRes.error],
    ['documents', documentsRes.error],
    ['home_service_records', serviceRes.error],
    ['maintenance_tasks', tasksRes.error],
    ['home_projects', projectsRes.error],
  ];
  const failed = failures.find(([, error]) => error);
  if (failed) {
    console.error(`[home/asset-detail] ${failed[0]} read failed`, failed[1]);
    return { status: 'error', reason: describeReadError(failed[1]) };
  }

  return {
    status: 'ok',
    detail: composeAssetDetail({
      asset,
      warranties: (warrantiesRes.data ?? []) as AssetWarrantyRow[],
      documents: (documentsRes.data ?? []) as AssetDocumentRow[],
      serviceRecords: (serviceRes.data ?? []) as AssetServiceRow[],
      openTasks: (tasksRes.data ?? []) as AssetTaskRow[],
      projects: (projectsRes.data ?? []) as AssetProjectRow[],
      today: args.today,
    }),
  };
}
