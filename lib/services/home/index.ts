// Home & maintenance: the saved contractors, service history and open
// maintenance tasks behind "find a plumber", plus the pure inference that
// turns "the sink is leaking" into the trade that fixes it.
//
// WHAT IS REAL HERE AND WHAT IS NOT. Everything below reads and writes the
// family's own rows (`home_contractors`, `home_service_records`,
// `maintenance_tasks`, `home_assets` — migrations 0002/0036). There is no
// external provider directory: `app/api/ai/home/find-pro` generates hiring
// guidance from a model and by its own design never names a business, so it
// is not wrapped as a tool that "finds" anyone. The honest answer to "find me
// a plumber" is the plumber this family already used, and this service is
// how the assistant learns that.
//
// Soft deletes: 0036 tables carry `deleted_at`; every read filters it so a
// contractor the family removed does not come back as a recommendation.
import 'server-only';
import type { Priority, Tables } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { DEFAULT_CADENCES, TRADES, TRADE_FOR_CATEGORY } from '@/lib/home/maintenance';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { withIdempotency } from '../idempotency';
import { dayKeyInTz, scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type ContractorRow = Tables<'home_contractors'>;
export type ServiceRecordRow = Tables<'home_service_records'>;
export type MaintenanceTaskRow = Tables<'maintenance_tasks'>;
export type HomeProjectRow = Tables<'home_projects'>;
export type ProjectQuoteRow = Tables<'project_quotes'>;

const DAY_MS = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES: Priority[] = ['low', 'medium', 'high'];
const TRADE_VALUES = new Set(TRADES.map((t) => t.value));

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (m) => `\\${m}`);
}

// ── pure: issue → trade ───────────────────────────────────────────────────────

/**
 * Keyword evidence per trade. Order within a trade does not matter; the trade
 * with the most distinct hits wins, and a tie goes to the more specific trade
 * (listed first) rather than 'general'. Asset categories from
 * `TRADE_FOR_CATEGORY` are folded in so "the water heater is making noise"
 * resolves through the same table the Home module uses.
 */
const TRADE_KEYWORDS: Record<string, string[]> = {
  plumbing: ['sink', 'faucet', 'tap', 'toilet', 'drain', 'clog', 'clogged', 'leak', 'leaking', 'pipe', 'pipes', 'water heater', 'shower', 'bathtub', 'tub', 'sewer', 'sump', 'disposal', 'plumber', 'plumbing', 'dripping', 'no hot water', 'water pressure', 'softener'],
  electrical: ['outlet', 'socket', 'breaker', 'fuse', 'wiring', 'wire', 'light switch', 'switch', 'flickering', 'sparking', 'electric', 'electrical', 'electrician', 'generator', 'power out', 'no power', 'ceiling fan', 'smoke detector', 'panel'],
  hvac: ['furnace', 'boiler', 'heating', 'heater', 'no heat', 'air conditioner', 'air conditioning', 'ac ', 'a/c', 'hvac', 'thermostat', 'duct', 'vent', 'not cooling', 'not heating', 'compressor', 'filter'],
  roofing: ['roof', 'shingle', 'shingles', 'skylight', 'flashing', 'attic leak', 'ceiling leak', 'roofer'],
  appliance: ['dishwasher', 'refrigerator', 'fridge', 'freezer', 'washer', 'washing machine', 'dryer', 'oven', 'stove', 'range', 'microwave', 'ice maker', 'appliance'],
  pest: ['ants', 'ant ', 'mice', 'mouse', 'rat', 'rats', 'termite', 'termites', 'wasps', 'wasp', 'bees', 'roach', 'cockroach', 'bed bugs', 'pest', 'exterminator', 'rodent', 'squirrels in'],
  landscaping: ['lawn', 'grass', 'mow', 'mowing', 'hedge', 'tree', 'trees', 'garden', 'yard', 'sprinkler', 'irrigation', 'landscap', 'leaves', 'mulch'],
  // Gutters are 'general' here because that is where `TRADE_FOR_CATEGORY` and
  // `DEFAULT_CADENCES` already put them; the two tables must agree or the
  // saved gutter cleaner is never surfaced for a gutter job.
  general: ['door', 'window', 'drywall', 'paint', 'painting', 'fence', 'deck', 'cabinet', 'shelf', 'shelves', 'handyman', 'tile', 'grout', 'caulk', 'lock', 'garage door', 'floor', 'stairs', 'railing', 'gutter', 'gutters'],
};

export type TradeInference = {
  /** A `TRADES` value, or null when nothing in the text pointed at a trade. */
  trade: string | null;
  label: string | null;
  /** 0–1: how clearly the text pointed at this trade over the others. */
  confidence: number;
  /** The words that decided it, so the assistant can say why. */
  matched: string[];
};

/** "sink is leaking" → plumbing. Pure and deterministic; no model involved. */
export function tradeFromIssue(text: string): TradeInference {
  const haystack = ` ${(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
  if (haystack.trim().length === 0) return { trade: null, label: null, confidence: 0, matched: [] };

  const scores = new Map<string, Set<string>>();
  const hit = (trade: string, word: string) => {
    const set = scores.get(trade) ?? new Set<string>();
    set.add(word.trim());
    scores.set(trade, set);
  };
  for (const [trade, words] of Object.entries(TRADE_KEYWORDS)) {
    for (const word of words) if (haystack.includes(word)) hit(trade, word);
  }
  for (const [category, trade] of Object.entries(TRADE_FOR_CATEGORY)) {
    if (haystack.includes(` ${category.replace(/_/g, ' ')} `)) hit(trade, category.replace(/_/g, ' '));
  }

  const order = Object.keys(TRADE_KEYWORDS);
  const ranked = [...scores.entries()]
    .map(([trade, words]) => ({ trade, words: [...words] }))
    .sort((a, b) => b.words.length - a.words.length || order.indexOf(a.trade) - order.indexOf(b.trade));
  const best = ranked[0];
  if (!best) return { trade: null, label: null, confidence: 0, matched: [] };
  const runnerUp = ranked[1]?.words.length ?? 0;
  const total = ranked.reduce((s, r) => s + r.words.length, 0);
  // Confidence is the winner's share of all evidence, discounted when the
  // runner-up is close — "leaking roof" is plumbing-or-roofing, not certain.
  const share = best.words.length / total;
  const margin = (best.words.length - runnerUp) / best.words.length;
  const confidence = Math.round(Math.min(1, 0.4 + 0.6 * share * (0.5 + 0.5 * margin)) * 100) / 100;
  return {
    trade: best.trade,
    label: TRADES.find((t) => t.value === best.trade)?.label ?? best.trade,
    confidence,
    matched: best.words,
  };
}

/** Accept a trade value, or a trade label / keyword, and return the canonical value. */
export function normalizeTrade(input: string | null | undefined): string | null {
  const raw = input?.trim().toLowerCase();
  if (!raw) return null;
  if (TRADE_VALUES.has(raw)) return raw;
  const byLabel = TRADES.find((t) => t.label.toLowerCase() === raw || t.label.toLowerCase().startsWith(raw));
  if (byLabel) return byLabel.value;
  return tradeFromIssue(raw).trade;
}

// ── contractors ───────────────────────────────────────────────────────────────

/** Phone and email are for the adults who manage the family; the vendors context slice hides them the same way. */
export function canSeeContactDetails(scope: ServiceScope): boolean {
  return scope.role === 'system' || isManager(scope.role);
}

/** The row as a given caller may see it. */
export function contractorForViewer(scope: ServiceScope, c: ContractorRow): ContractorRow {
  return canSeeContactDetails(scope) ? c : { ...c, phone: null, email: null };
}

export async function listContractors(scope: ServiceScope, input: { trade?: string | null; limit?: number } = {}): Promise<ServiceResult<ContractorRow[]>> {
  const trade = input.trade ? normalizeTrade(input.trade) : null;
  if (input.trade && !trade) return fail(`"${input.trade}" is not a trade Bubaly knows.`, { code: SERVICE_CODES.invalidInput });
  let query = scope.db
    .from('home_contractors')
    .select('*')
    .eq('family_id', scope.familyId)
    .is('deleted_at', null)
    .order('is_preferred', { ascending: false })
    .order('last_used_on', { ascending: false, nullsFirst: false })
    .order('name', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  if (trade) query = query.eq('trade', trade);
  const { data, error } = await query;
  if (error) {
    console.error('[service:home] contractors read failed', error);
    return fail(describeDbError(error, 'Could not load your saved contractors.'), { code: SERVICE_CODES.db });
  }
  return ok((data ?? []).map((c) => contractorForViewer(scope, c)));
}

export type SaveContractorInput = {
  id?: string | null;
  name: string;
  trade?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  rating?: number | null;
  hourlyRate?: number | null;
  isPreferred?: boolean | null;
  notes?: string | null;
};

/**
 * Save a contractor. With an `id` it updates; without one it looks for a
 * live row with the same name (case-insensitive) first, because "save Bob
 * the plumber" said twice must not produce two Bobs to choose between later.
 */
export async function saveContractor(scope: ServiceScope, input: SaveContractorInput): Promise<ServiceResult<{ contractor: ContractorRow; created: boolean }>> {
  const name = input.name?.trim() ?? '';
  if (!name) return fail('A contractor needs a name.', { code: SERVICE_CODES.invalidInput });
  const trade = input.trade ? normalizeTrade(input.trade) : null;
  if (input.trade && !trade) return fail(`"${input.trade}" is not a trade Bubaly knows.`, { code: SERVICE_CODES.invalidInput });
  if (input.rating != null && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) {
    return fail('A rating is a whole number from 1 to 5.', { code: SERVICE_CODES.invalidInput });
  }

  const patch = {
    name,
    ...(trade !== null || input.trade === null ? { trade } : {}),
    ...(input.company !== undefined ? { company: input.company?.trim() || null } : {}),
    ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
    ...(input.email !== undefined ? { email: input.email?.trim() || null } : {}),
    ...(input.website !== undefined ? { website: input.website?.trim() || null } : {}),
    ...(input.rating !== undefined ? { rating: input.rating } : {}),
    ...(input.hourlyRate !== undefined ? { hourly_rate: input.hourlyRate } : {}),
    ...(input.isPreferred != null ? { is_preferred: input.isPreferred } : {}),
    ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
    updated_by: scope.userId,
  };

  let targetId = input.id ?? null;
  if (!targetId) {
    const { data: existing, error } = await scope.db
      .from('home_contractors')
      .select('id')
      .eq('family_id', scope.familyId)
      .is('deleted_at', null)
      .ilike('name', escapeLike(name))
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[service:home] contractor lookup failed', error);
      return fail(describeDbError(error, 'Could not check for an existing contractor.'), { code: SERVICE_CODES.db });
    }
    targetId = existing?.id ?? null;
  }

  if (targetId) {
    const { data, error } = await scope.db
      .from('home_contractors')
      .update(patch)
      .eq('id', targetId)
      .eq('family_id', scope.familyId)
      .select('*')
      .maybeSingle();
    if (error) {
      console.error('[service:home] contractor update failed', error);
      return fail(describeDbError(error, 'Could not save that contractor.'), { code: SERVICE_CODES.db });
    }
    if (!data) return fail('That contractor could not be found.', { code: SERVICE_CODES.notFound });
    await recordActivitySafely(scope, { action: 'update', agent: 'home', title: `Updated contractor ${data.name}`, href: '/dashboard/home/pros' });
    return ok({ contractor: data, created: false });
  }

  const { data, error } = await scope.db
    .from('home_contractors')
    .insert({ ...patch, trade, family_id: scope.familyId, created_by: scope.userId })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:home] contractor insert failed', error);
    return fail(describeDbError(error, 'Could not save that contractor.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, {
    agent: 'home',
    action: 'create',
    title: `Saved ${data.name}${data.trade ? ` (${TRADES.find((t) => t.value === data.trade)?.label ?? data.trade})` : ''} to your contractors`,
    href: '/dashboard/home/pros',
  });
  return ok({ contractor: data, created: true });
}

// ── service history ───────────────────────────────────────────────────────────

export type LastService = {
  record: ServiceRecordRow;
  contractor: ContractorRow | null;
  /** How the record was matched to the trade, so the answer can be explained. */
  matchedBy: 'contractor_trade' | 'asset_category' | 'text';
};

/**
 * The most recent service of a given trade, and who did it. Three ways a
 * record can belong to a trade, in order of trust: the linked contractor's
 * trade; the serviced asset's category (via `TRADE_FOR_CATEGORY`); or the
 * record's own title/provider text. Returns `ok(null)` when there is no
 * history — the honest input to "you have never used a plumber before".
 */
export async function lastServiceByTrade(scope: ServiceScope, tradeInput: string): Promise<ServiceResult<LastService | null>> {
  const trade = normalizeTrade(tradeInput);
  if (!trade) return fail(`"${tradeInput}" is not a trade Bubaly knows.`, { code: SERVICE_CODES.invalidInput });

  const [records, contractors, assets] = await Promise.all([
    scope.db.from('home_service_records').select('*').eq('family_id', scope.familyId).is('deleted_at', null)
      .order('service_date', { ascending: false }).limit(300),
    scope.db.from('home_contractors').select('*').eq('family_id', scope.familyId).is('deleted_at', null).limit(200),
    scope.db.from('home_assets').select('id, category').eq('family_id', scope.familyId).limit(500),
  ]);
  for (const [label, res] of [['service records', records], ['contractors', contractors], ['assets', assets]] as const) {
    if (res.error) {
      console.error(`[service:home] ${label} read failed`, res.error);
      return fail(describeDbError(res.error, 'Could not load your home service history.'), { code: SERVICE_CODES.db });
    }
  }

  const contractorById = new Map((contractors.data ?? []).map((c) => [c.id, c]));
  const assetTrade = new Map((assets.data ?? []).map((a) => [a.id, a.category ? TRADE_FOR_CATEGORY[a.category] ?? null : null]));
  const words = TRADE_KEYWORDS[trade] ?? [];

  for (const record of records.data ?? []) {
    const contractor = record.contractor_id ? contractorById.get(record.contractor_id) ?? null : null;
    if (contractor?.trade === trade) return ok({ record, contractor: contractor ? contractorForViewer(scope, contractor) : null, matchedBy: 'contractor_trade' });
    if (record.asset_id && assetTrade.get(record.asset_id) === trade) return ok({ record, contractor: contractor ? contractorForViewer(scope, contractor) : null, matchedBy: 'asset_category' });
    const text = ` ${[record.title, record.provider, record.description].filter(Boolean).join(' ').toLowerCase()} `;
    if (text.includes(trade) || words.some((w) => text.includes(w))) return ok({ record, contractor: contractor ? contractorForViewer(scope, contractor) : null, matchedBy: 'text' });
  }
  return ok(null);
}

export type CreateServiceRecordInput = {
  title: string;
  serviceDate?: string | null;
  assetId?: string | null;
  contractorId?: string | null;
  provider?: string | null;
  cost?: number | null;
  description?: string | null;
  nextDueOn?: string | null;
};

/**
 * Log a service visit. Mirrors the module's own action, including the
 * best-effort refresh of the asset's `last_serviced_on` that the life/forecast
 * maths reads, and the contractor's `last_used_on` so "who did we use last"
 * stays answerable.
 */
export async function createServiceRecord(scope: ServiceScope, input: CreateServiceRecordInput): Promise<ServiceResult<ServiceRecordRow>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A service record needs a title.', { code: SERVICE_CODES.invalidInput });
  const serviceDate = input.serviceDate ?? dayKeyInTz(scopeNow(scope), scope.tz);
  if (!DAY_KEY.test(serviceDate)) return fail('The service date must be YYYY-MM-DD.', { code: SERVICE_CODES.invalidInput });
  if (input.nextDueOn && !DAY_KEY.test(input.nextDueOn)) return fail('The next-due date must be YYYY-MM-DD.', { code: SERVICE_CODES.invalidInput });
  if (input.cost != null && (!Number.isFinite(input.cost) || input.cost < 0)) return fail('A cost must be zero or more.', { code: SERVICE_CODES.invalidInput });

  return withIdempotency<ServiceRecordRow>(
    scope,
    {
      operation: 'home.createServiceRecord',
      input: { title, serviceDate, assetId: input.assetId ?? null },
      find: async () => {
        const { data, error } = await scope.db
          .from('home_service_records')
          .select('*')
          .eq('family_id', scope.familyId)
          .is('deleted_at', null)
          .eq('title', title)
          .eq('service_date', serviceDate)
          .limit(1)
          .maybeSingle();
        if (error) {
          console.error('[service:home] service record probe failed', error);
          return fail(describeDbError(error, 'Could not check for a duplicate service record.'), { code: SERVICE_CODES.db });
        }
        return ok(data ?? null);
      },
    },
    async () => {
      const { data, error } = await scope.db
        .from('home_service_records')
        .insert({
          family_id: scope.familyId,
          title,
          service_date: serviceDate,
          asset_id: input.assetId ?? null,
          contractor_id: input.contractorId ?? null,
          provider: input.provider?.trim() || null,
          cost: input.cost ?? null,
          description: input.description?.trim() || null,
          next_due_on: input.nextDueOn ?? null,
          created_by: scope.userId,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:home] service record insert failed', error);
        return fail(describeDbError(error, 'Could not save that service record.'), { code: SERVICE_CODES.db });
      }

      // Both follow-up writes are best-effort: the record itself is saved, and
      // a stale "last used" date is a smaller wrong than losing the visit.
      if (input.assetId) {
        const { error: assetError } = await scope.db.from('home_assets').update({ last_serviced_on: serviceDate }).eq('id', input.assetId).eq('family_id', scope.familyId);
        if (assetError) console.error('[service:home] home_assets last_serviced_on update failed', assetError);
      }
      if (input.contractorId) {
        const { error: contractorError } = await scope.db.from('home_contractors').update({ last_used_on: serviceDate, updated_by: scope.userId }).eq('id', input.contractorId).eq('family_id', scope.familyId);
        if (contractorError) console.error('[service:home] home_contractors last_used_on update failed', contractorError);
      }

      await recordActivitySafely(scope, { action: 'create', agent: 'home', title: `Logged service: ${data.title}`, detail: data.service_date, href: '/dashboard/home/service' });
      return ok(data);
    },
  );
}

// ── maintenance tasks ─────────────────────────────────────────────────────────

export type CreateMaintenanceTaskInput = {
  title: string;
  description?: string | null;
  dueAt?: string | null;
  assetId?: string | null;
  assigneeId?: string | null;
  priority?: Priority | null;
  intervalDays?: number | null;
};

export async function createMaintenanceTask(scope: ServiceScope, input: CreateMaintenanceTaskInput): Promise<ServiceResult<MaintenanceTaskRow>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A maintenance task needs a title.', { code: SERVICE_CODES.invalidInput });
  let dueAt: string | null = null;
  if (input.dueAt) {
    const ms = Date.parse(input.dueAt);
    if (!Number.isFinite(ms)) return fail('That due date could not be understood.', { code: SERVICE_CODES.invalidInput });
    dueAt = new Date(ms).toISOString();
  }
  if (input.priority && !PRIORITIES.includes(input.priority)) return fail('Priority is low, medium or high.', { code: SERVICE_CODES.invalidInput });
  if (input.intervalDays != null && (!Number.isInteger(input.intervalDays) || input.intervalDays <= 0)) {
    return fail('A repeat interval is a whole number of days.', { code: SERVICE_CODES.invalidInput });
  }

  return withIdempotency<MaintenanceTaskRow>(
    scope,
    {
      operation: 'home.createMaintenanceTask',
      input: { title, dueAt, assetId: input.assetId ?? null },
      // An open task with the same title (and asset) is the duplicate a retry
      // would produce; a done one is history and does not block a new one.
      find: async () => {
        let query = scope.db
          .from('maintenance_tasks')
          .select('*')
          .eq('family_id', scope.familyId)
          .ilike('title', escapeLike(title))
          .neq('status', 'done')
          .limit(1);
        query = input.assetId ? query.eq('asset_id', input.assetId) : query.is('asset_id', null);
        const { data, error } = await query.maybeSingle();
        if (error) {
          console.error('[service:home] maintenance task probe failed', error);
          return fail(describeDbError(error, 'Could not check for a duplicate task.'), { code: SERVICE_CODES.db });
        }
        return ok(data ?? null);
      },
    },
    async () => {
      const { data, error } = await scope.db
        .from('maintenance_tasks')
        .insert({
          family_id: scope.familyId,
          title,
          description: input.description?.trim() || null,
          due_at: dueAt,
          asset_id: input.assetId ?? null,
          assignee_id: input.assigneeId ?? null,
          priority: input.priority ?? 'medium',
          interval_days: input.intervalDays ?? null,
          created_by: scope.userId,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:home] maintenance task insert failed', error);
        return fail(describeDbError(error, 'Could not create that maintenance task.'), { code: SERVICE_CODES.db });
      }
      await recordActivitySafely(scope, {
        agent: 'home',
        action: 'create',
        title: `Added maintenance task "${data.title}"`,
        detail: data.due_at,
        href: '/dashboard/home',
        memberId: data.assignee_id,
      });
      return ok(data);
    },
  );
}

export async function listOpenMaintenance(
  scope: ServiceScope,
  input: { dueBefore?: string | null; assetId?: string | null; limit?: number } = {},
): Promise<ServiceResult<MaintenanceTaskRow[]>> {
  let query = scope.db
    .from('maintenance_tasks')
    .select('*')
    .eq('family_id', scope.familyId)
    .neq('status', 'done')
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  if (input.dueBefore) {
    const ms = Date.parse(input.dueBefore);
    if (!Number.isFinite(ms)) return fail('That date could not be understood.', { code: SERVICE_CODES.invalidInput });
    query = query.lte('due_at', new Date(ms).toISOString());
  }
  if (input.assetId) query = query.eq('asset_id', input.assetId);
  const { data, error } = await query;
  if (error) {
    console.error('[service:home] maintenance read failed', error);
    return fail(describeDbError(error, 'Could not load maintenance tasks.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

/**
 * Create the recurring tasks `DEFAULT_CADENCES` recommends for one asset,
 * skipping any the family already has. Same rules as the Home module's
 * one-tap action, so the assistant and the button produce identical rows.
 */
export async function scheduleRecommendedTasks(scope: ServiceScope, assetId: string): Promise<ServiceResult<{ created: MaintenanceTaskRow[]; skipped: string[] }>> {
  const { data: asset, error: assetError } = await scope.db
    .from('home_assets')
    .select('id, name, category, last_serviced_on')
    .eq('id', assetId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (assetError) {
    console.error('[service:home] asset read failed', assetError);
    return fail(describeDbError(assetError, 'Could not load that asset.'), { code: SERVICE_CODES.db });
  }
  if (!asset) return fail('That asset could not be found.', { code: SERVICE_CODES.notFound });

  const cadences = DEFAULT_CADENCES[asset.category ?? ''] ?? [];
  if (cadences.length === 0) return fail(`There is no recommended schedule for ${asset.name} yet.`, { code: SERVICE_CODES.notFound });

  const { data: existing, error: existingError } = await scope.db
    .from('maintenance_tasks')
    .select('title')
    .eq('family_id', scope.familyId)
    .eq('asset_id', assetId);
  if (existingError) {
    console.error('[service:home] existing tasks read failed', existingError);
    return fail(describeDbError(existingError, 'Could not check existing tasks.'), { code: SERVICE_CODES.db });
  }
  const have = new Set((existing ?? []).map((t) => t.title.toLowerCase()));
  const base = asset.last_serviced_on ? Date.parse(`${asset.last_serviced_on}T12:00:00Z`) : scopeNow(scope).getTime();
  const skipped = cadences.filter((c) => have.has(c.task.toLowerCase())).map((c) => c.task);
  const rows = cadences
    .filter((c) => !have.has(c.task.toLowerCase()))
    .map((c) => ({
      family_id: scope.familyId,
      asset_id: assetId,
      title: c.task,
      description: `Recommended every ${c.intervalDays} days for ${asset.name}.`,
      interval_days: c.intervalDays,
      due_at: new Date(base + c.intervalDays * DAY_MS).toISOString(),
      created_by: scope.userId,
    }));
  if (rows.length === 0) return ok({ created: [], skipped });

  const { data, error } = await scope.db.from('maintenance_tasks').insert(rows).select('*');
  if (error) {
    console.error('[service:home] recommended tasks insert failed', error);
    return fail(describeDbError(error, 'Could not schedule the recommended tasks.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, { action: 'create', agent: 'home', title: `Scheduled ${rows.length} recommended maintenance tasks for ${asset.name}`, href: '/dashboard/home' });
  return ok({ created: data ?? [], skipped });
}

// ── home projects + the quotes on file (migration 0246) ──────────────────────
//
// Read-only. `project_quotes` are typed in by a parent; nothing here solicits
// one. These exist so `services.compareQuotes` (lib/ai/tools/providers.ts)
// ranks the same rows the projects module shows, under the same family scope,
// and fails closed the same way when the read does.

/** A project by id, or the best title match. Null when nothing matches; an error only when the read failed. */
export async function findHomeProject(scope: ServiceScope, input: { id?: string | null; title?: string | null }): Promise<ServiceResult<HomeProjectRow | null>> {
  const id = input.id?.trim() || null;
  const title = input.title?.trim() || null;
  if (!id && !title) return fail('Say which project, by id or by title.', { code: SERVICE_CODES.invalidInput });
  let query = scope.db.from('home_projects').select('*').eq('family_id', scope.familyId).limit(5);
  if (id) query = query.eq('id', id);
  else query = query.ilike('title', `%${escapeLike(title!)}%`).order('updated_at', { ascending: false });
  const { data, error } = await query;
  if (error) {
    console.error('[service:home] project read failed', error);
    return fail(describeDbError(error, 'Could not load that project.'), { code: SERVICE_CODES.db });
  }
  const rows = data ?? [];
  if (rows.length === 0) return ok(null);
  if (id) return ok(rows[0]);
  const exact = rows.find((p) => p.title.trim().toLowerCase() === title!.toLowerCase());
  return ok(exact ?? rows[0]);
}

/** The quotes on file, for one project or for the whole family. Cheapest first. */
export async function listProjectQuotes(scope: ServiceScope, input: { projectId?: string | null; limit?: number } = {}): Promise<ServiceResult<ProjectQuoteRow[]>> {
  let query = scope.db
    .from('project_quotes')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('amount_cents', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 600));
  if (input.projectId) query = query.eq('project_id', input.projectId);
  const { data, error } = await query;
  if (error) {
    console.error('[service:home] project quotes read failed', error);
    return fail(describeDbError(error, 'Could not load the quotes on file.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

/** The projects that have at least one quote, with the count — so a caller can ask "which project?" honestly. */
export async function listProjectsWithQuotes(scope: ServiceScope): Promise<ServiceResult<{ project: Pick<HomeProjectRow, 'id' | 'title' | 'status'>; quoteCount: number }[]>> {
  const quotes = await listProjectQuotes(scope, { limit: 600 });
  if (!quotes.ok) return quotes;
  const counts = new Map<string, number>();
  for (const q of quotes.data) counts.set(q.project_id, (counts.get(q.project_id) ?? 0) + 1);
  if (counts.size === 0) return ok([]);
  const { data, error } = await scope.db
    .from('home_projects')
    .select('id, title, status')
    .eq('family_id', scope.familyId)
    .in('id', [...counts.keys()]);
  if (error) {
    console.error('[service:home] projects read failed', error);
    return fail(describeDbError(error, 'Could not load your projects.'), { code: SERVICE_CODES.db });
  }
  return ok((data ?? [])
    .map((project) => ({ project, quoteCount: counts.get(project.id) ?? 0 }))
    .sort((a, b) => b.quoteCount - a.quoteCount || a.project.title.localeCompare(b.project.title)));
}
