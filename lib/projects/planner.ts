// lib/projects/planner.ts — pure, deterministic home-project engine.
//
// The differentiator: a project is not a to-do, it is scope → materials →
// budget → quotes → schedule, and each of those has a next step the engine
// can name. Budget health counts what is already committed (purchased
// materials at actual cost, the accepted quote, labour) against the plan;
// quote comparison is arithmetic, not opinion; the AI adds the scope draft.

import type { HomeProjectKind, HomeProjectPriority, HomeProjectStatus, ProjectQuoteStatus } from '@/lib/database.types';

export const PROJECT_KINDS: { value: HomeProjectKind; label: string; emoji: string }[] = [
  { value: 'repair', label: 'Repair', emoji: '🔧' }, { value: 'renovation', label: 'Renovation', emoji: '🏗️' },
  { value: 'upgrade', label: 'Upgrade', emoji: '⚡' }, { value: 'outdoor', label: 'Outdoor / yard', emoji: '🌳' },
  { value: 'decor', label: 'Decor', emoji: '🎨' }, { value: 'safety', label: 'Safety', emoji: '🛡️' },
  { value: 'organization', label: 'Organization', emoji: '🗄️' }, { value: 'other', label: 'Other', emoji: '📝' },
];
export const PROJECT_STATUSES: { value: HomeProjectStatus; label: string }[] = [
  { value: 'idea', label: 'Idea' }, { value: 'planning', label: 'Planning' }, { value: 'quoting', label: 'Getting quotes' },
  { value: 'scheduled', label: 'Scheduled' }, { value: 'in_progress', label: 'In progress' }, { value: 'on_hold', label: 'On hold' },
  { value: 'done', label: 'Done' }, { value: 'cancelled', label: 'Cancelled' },
];
export const PRIORITIES: { value: HomeProjectPriority; label: string }[] = [
  { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' },
];
export const QUOTE_STATUSES: { value: ProjectQuoteStatus; label: string }[] = [
  { value: 'requested', label: 'Requested' }, { value: 'received', label: 'Received' }, { value: 'accepted', label: 'Accepted' },
  { value: 'declined', label: 'Declined' }, { value: 'expired', label: 'Expired' },
];

export const kindMeta = (k: HomeProjectKind) => PROJECT_KINDS.find((x) => x.value === k) ?? PROJECT_KINDS[PROJECT_KINDS.length - 1];
export const statusLabel = (s: HomeProjectStatus) => PROJECT_STATUSES.find((x) => x.value === s)?.label ?? s;

export type BoardColumn = 'ideas' | 'planning' | 'active' | 'done';
export const BOARD: { key: BoardColumn; label: string; statuses: HomeProjectStatus[] }[] = [
  { key: 'ideas', label: 'Ideas', statuses: ['idea'] },
  { key: 'planning', label: 'Planning & quotes', statuses: ['planning', 'quoting', 'on_hold'] },
  { key: 'active', label: 'Scheduled & in progress', statuses: ['scheduled', 'in_progress'] },
  { key: 'done', label: 'Done', statuses: ['done', 'cancelled'] },
];
export const columnFor = (s: HomeProjectStatus): BoardColumn => BOARD.find((c) => c.statuses.includes(s))?.key ?? 'ideas';

export type MaterialTemplate = { name: string; quantity: number; unit?: string; estCents: number };
export type ScopeTemplate = { key: string; match: string[]; kind: HomeProjectKind; diy: boolean; materials: MaterialTemplate[]; laborHint?: string };

/** Starter scopes: keyword-matched so "paint the kids' room" gets a real list in one tap. */
export const SCOPE_TEMPLATES: ScopeTemplate[] = [
  { key: 'paint-room', match: ['paint', 'repaint'], kind: 'decor', diy: true, materials: [
    { name: 'Interior paint (gallon)', quantity: 2, unit: 'gal', estCents: 4500 }, { name: 'Primer', quantity: 1, unit: 'gal', estCents: 2500 },
    { name: 'Roller + tray kit', quantity: 1, estCents: 1500 }, { name: 'Angled brush 2"', quantity: 1, estCents: 1200 },
    { name: 'Painter’s tape', quantity: 2, unit: 'roll', estCents: 700 }, { name: 'Drop cloths', quantity: 2, estCents: 800 },
  ], laborHint: 'One weekend for a bedroom; pros quote $300–600 per room' },
  { key: 'faucet', match: ['faucet', 'tap ', 'dripping'], kind: 'repair', diy: true, materials: [
    { name: 'Replacement faucet', quantity: 1, estCents: 12000 }, { name: 'Supply lines', quantity: 2, estCents: 900 }, { name: 'Plumber’s tape', quantity: 1, estCents: 300 },
  ], laborHint: 'About an hour; a plumber charges $150–250' },
  { key: 'shelves', match: ['shelf', 'shelves', 'shelving'], kind: 'organization', diy: true, materials: [
    { name: 'Shelf boards', quantity: 3, estCents: 2500 }, { name: 'Brackets', quantity: 6, estCents: 800 }, { name: 'Wall anchors + screws', quantity: 1, unit: 'pack', estCents: 900 },
  ] },
  { key: 'bathroom', match: ['bathroom', 'shower', 'vanity', 'toilet'], kind: 'renovation', diy: false, materials: [
    { name: 'Vanity + sink', quantity: 1, estCents: 45000 }, { name: 'Faucet', quantity: 1, estCents: 15000 }, { name: 'Tile', quantity: 60, unit: 'sq ft', estCents: 400 },
    { name: 'Grout + thinset', quantity: 1, estCents: 4000 }, { name: 'Toilet', quantity: 1, estCents: 25000 }, { name: 'Exhaust fan', quantity: 1, estCents: 9000 },
  ], laborHint: 'Get three quotes; a refresh runs $3k–8k in labour' },
  { key: 'kitchen', match: ['kitchen', 'countertop', 'cabinet', 'backsplash'], kind: 'renovation', diy: false, materials: [
    { name: 'Cabinet hardware', quantity: 20, estCents: 600 }, { name: 'Backsplash tile', quantity: 30, unit: 'sq ft', estCents: 800 }, { name: 'Countertop', quantity: 1, estCents: 250000 }, { name: 'Sink', quantity: 1, estCents: 30000 },
  ], laborHint: 'Countertop installers quote by the slab; get the template measured first' },
  { key: 'deck', match: ['deck', 'stain', 'fence', 'pergola'], kind: 'outdoor', diy: true, materials: [
    { name: 'Deck stain / sealer', quantity: 2, unit: 'gal', estCents: 5500 }, { name: 'Deck cleaner', quantity: 1, estCents: 2000 }, { name: 'Stain pad + pole', quantity: 1, estCents: 2500 }, { name: 'Replacement boards', quantity: 4, estCents: 2200 },
  ], laborHint: 'Two dry days: clean, dry, stain' },
  { key: 'garden', match: ['garden', 'raised bed', 'planter', 'lawn', 'mulch'], kind: 'outdoor', diy: true, materials: [
    { name: 'Lumber for beds', quantity: 6, estCents: 1800 }, { name: 'Garden soil', quantity: 10, unit: 'bag', estCents: 900 }, { name: 'Mulch', quantity: 6, unit: 'bag', estCents: 500 }, { name: 'Drip irrigation kit', quantity: 1, estCents: 4500 },
  ] },
  { key: 'thermostat', match: ['thermostat', 'smart home', 'doorbell', 'camera'], kind: 'upgrade', diy: true, materials: [
    { name: 'Smart device', quantity: 1, estCents: 18000 }, { name: 'C-wire adapter', quantity: 1, estCents: 2500 },
  ], laborHint: 'Half an hour if there is a C-wire; an electrician otherwise' },
  { key: 'lighting', match: ['light', 'lighting', 'fixture', 'ceiling fan', 'outlet', 'switch'], kind: 'upgrade', diy: false, materials: [
    { name: 'Fixture / fan', quantity: 1, estCents: 15000 }, { name: 'Dimmer switch', quantity: 1, estCents: 3000 }, { name: 'Wire nuts + mounting bracket', quantity: 1, estCents: 800 },
  ], laborHint: 'Licensed electrician for anything beyond a like-for-like swap' },
  { key: 'safety', match: ['smoke', 'carbon', 'detector', 'childproof', 'baby gate', 'railing', 'grab bar'], kind: 'safety', diy: true, materials: [
    { name: 'Smoke / CO detectors', quantity: 3, estCents: 3500 }, { name: 'Cabinet latches', quantity: 1, unit: 'pack', estCents: 1500 }, { name: 'Baby gate', quantity: 1, estCents: 6000 }, { name: 'Anti-tip furniture straps', quantity: 1, unit: 'pack', estCents: 1200 },
  ] },
  { key: 'closet', match: ['closet', 'garage storage', 'pantry', 'mudroom'], kind: 'organization', diy: true, materials: [
    { name: 'Closet system kit', quantity: 1, estCents: 22000 }, { name: 'Bins', quantity: 6, estCents: 1200 }, { name: 'Hooks', quantity: 8, estCents: 400 }, { name: 'Labels', quantity: 1, unit: 'pack', estCents: 800 },
  ] },
  { key: 'flooring', match: ['floor', 'carpet', 'laminate', 'vinyl plank', 'hardwood'], kind: 'renovation', diy: false, materials: [
    { name: 'Flooring', quantity: 200, unit: 'sq ft', estCents: 350 }, { name: 'Underlayment', quantity: 200, unit: 'sq ft', estCents: 40 }, { name: 'Transition strips + trim', quantity: 1, estCents: 8000 },
  ], laborHint: 'Installers quote per square foot; ask if removal is included' },
  { key: 'gutter', match: ['gutter', 'roof', 'downspout', 'leak'], kind: 'repair', diy: false, materials: [
    { name: 'Gutter guards', quantity: 4, estCents: 2500 }, { name: 'Sealant', quantity: 1, estCents: 900 }, { name: 'Downspout extension', quantity: 2, estCents: 1500 },
  ], laborHint: 'Roof work: get quotes, check insurance on the pro' },
];

/** Templates whose keywords appear in the title/description, best match first. */
export function suggestScope(text: string): ScopeTemplate[] {
  const t = ` ${text.toLowerCase()} `;
  return SCOPE_TEMPLATES
    .map((tpl) => ({ tpl, hits: tpl.match.filter((m) => t.includes(m)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((x) => x.tpl);
}

export type ProjectLike = { id: string; title: string; status: HomeProjectStatus; priority: HomeProjectPriority; kind: HomeProjectKind; is_diy: boolean; budget_cents: number | null; labor_cents: number; target_start: string | null; target_end: string | null; completed_at: string | null };
export type MaterialLike = { id: string; project_id: string; name: string; quantity: number; est_cost_cents: number | null; actual_cost_cents: number | null; is_purchased: boolean };
export type QuoteLike = { id: string; project_id: string; contractor_name: string; amount_cents: number; includes_materials: boolean; lead_time_days: number | null; valid_until: string | null; status: ProjectQuoteStatus };

const DAY_MS = 86_400_000;
const dateOnly = (v: string | Date) => (typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : new Date(v.getFullYear(), v.getMonth(), v.getDate()));
export const dayDiff = (from: string | Date, to: string | Date) => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS);
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A material's cost: actual when purchased, estimate otherwise. Per line = unit cost × quantity. */
export const materialLineCents = (m: Pick<MaterialLike, 'quantity' | 'est_cost_cents' | 'actual_cost_cents' | 'is_purchased'>) =>
  Math.round((m.is_purchased && m.actual_cost_cents !== null ? m.actual_cost_cents : (m.est_cost_cents ?? 0)) * m.quantity);

export type MaterialsTotals = { count: number; purchased: number; estimatedCents: number; actualCents: number; remainingCents: number };

export function materialsTotals(materials: MaterialLike[], projectId: string): MaterialsTotals {
  const mine = materials.filter((m) => m.project_id === projectId);
  const estimatedCents = mine.reduce((a, m) => a + Math.round((m.est_cost_cents ?? 0) * m.quantity), 0);
  const actualCents = mine.filter((m) => m.is_purchased).reduce((a, m) => a + Math.round((m.actual_cost_cents ?? m.est_cost_cents ?? 0) * m.quantity), 0);
  const remainingCents = mine.filter((m) => !m.is_purchased).reduce((a, m) => a + Math.round((m.est_cost_cents ?? 0) * m.quantity), 0);
  return { count: mine.length, purchased: mine.filter((m) => m.is_purchased).length, estimatedCents, actualCents, remainingCents };
}

export type QuoteRow<T extends QuoteLike = QuoteLike> = T & { isLowest: boolean; isExpired: boolean; vsLowestPct: number | null };
export type QuoteComparison<T extends QuoteLike = QuoteLike> = { rows: QuoteRow<T>[]; received: number; accepted: T | null; lowest: T | null; spreadPct: number | null; awaiting: number };

/** Compare live quotes: cheapest first, expired flagged, spread between low and high. Generic so full DB rows keep their fields. */
export function compareQuotes<T extends QuoteLike>(quotes: T[], projectId: string, today: Date): QuoteComparison<T> {
  const mine = quotes.filter((q) => q.project_id === projectId);
  const todayIso = isoDate(today);
  const isExpired = (q: T) => q.status === 'expired' || (q.status === 'received' && !!q.valid_until && q.valid_until < todayIso);
  const live = mine.filter((q) => (q.status === 'received' || q.status === 'accepted') && !isExpired(q));
  const lowest = [...live].sort((a, b) => a.amount_cents - b.amount_cents)[0] ?? null;
  const highest = [...live].sort((a, b) => b.amount_cents - a.amount_cents)[0] ?? null;
  const rows = [...mine]
    .sort((a, b) => {
      const rank = (q: T) => (q.status === 'accepted' ? 0 : q.status === 'received' && !isExpired(q) ? 1 : q.status === 'requested' ? 2 : 3);
      return rank(a) - rank(b) || a.amount_cents - b.amount_cents;
    })
    .map((q) => ({ ...q, isLowest: !!lowest && q.id === lowest.id, isExpired: isExpired(q), vsLowestPct: lowest && lowest.amount_cents > 0 && live.some((l) => l.id === q.id) ? Math.round(((q.amount_cents - lowest.amount_cents) / lowest.amount_cents) * 100) : null }));
  return {
    rows, received: live.length, accepted: mine.find((q) => q.status === 'accepted') ?? null, lowest,
    spreadPct: lowest && highest && lowest.amount_cents > 0 && live.length > 1 ? Math.round(((highest.amount_cents - lowest.amount_cents) / lowest.amount_cents) * 100) : null,
    awaiting: mine.filter((q) => q.status === 'requested').length,
  };
}

export type BudgetHealth = { status: 'no_budget' | 'under' | 'near' | 'over'; committedCents: number; forecastCents: number; remainingCents: number | null; pct: number | null };

/**
 * Committed = purchased materials at actual + accepted quote + labour paid.
 * Forecast adds the estimates for what is still to buy (and the lowest live
 * quote when nothing is accepted yet on a hired job).
 */
export function budgetHealth(project: ProjectLike, materials: MaterialLike[], quotes: QuoteLike[], today: Date): BudgetHealth {
  const mt = materialsTotals(materials, project.id);
  const qc = compareQuotes(quotes, project.id, today);
  const quoteCents = qc.accepted?.amount_cents ?? 0;
  const committedCents = mt.actualCents + quoteCents + project.labor_cents;
  const pendingQuote = !qc.accepted && !project.is_diy && qc.lowest ? qc.lowest.amount_cents : 0;
  const forecastCents = committedCents + mt.remainingCents + pendingQuote;
  if (!project.budget_cents) return { status: 'no_budget', committedCents, forecastCents, remainingCents: null, pct: null };
  const pct = Math.round((forecastCents / project.budget_cents) * 100);
  return { status: pct > 100 ? 'over' : pct >= 85 ? 'near' : 'under', committedCents, forecastCents, remainingCents: project.budget_cents - forecastCents, pct };
}

export type Schedule = 'none' | 'upcoming' | 'due_soon' | 'overdue' | 'done';

export function schedule(project: ProjectLike, today: Date): { state: Schedule; days: number | null } {
  if (project.status === 'done' || project.status === 'cancelled') return { state: 'done', days: null };
  const end = project.target_end ?? project.target_start;
  if (!end) return { state: 'none', days: null };
  const days = dayDiff(today, end);
  return { state: days < 0 ? 'overdue' : days <= 7 ? 'due_soon' : 'upcoming', days };
}

/** The single next thing to do on this project, from its own data. */
export function nextAction(project: ProjectLike, materials: MaterialLike[], quotes: QuoteLike[], today: Date): string {
  if (project.status === 'done') return 'Done — add the after photo';
  if (project.status === 'cancelled') return 'Cancelled';
  if (project.status === 'on_hold') return 'On hold — set a date to revisit';
  const mt = materialsTotals(materials, project.id);
  const qc = compareQuotes(quotes, project.id, today);
  const bh = budgetHealth(project, materials, quotes, today);
  if (project.status === 'idea') return 'Decide: DIY or hire, then set a budget';
  if (!project.budget_cents) return 'Set a budget';
  if (!project.is_diy) {
    if (qc.accepted) {
      if (!project.target_start) return `Schedule with ${qc.accepted.contractor_name}`;
      return project.status === 'in_progress' ? 'Track progress against the quote' : `Starts ${project.target_start}`;
    }
    if (qc.received === 0 && qc.awaiting === 0) return 'Request three quotes';
    if (qc.received < 2) return `Chase quotes (${qc.received} received, ${qc.awaiting} waiting)`;
    return `Compare ${qc.received} quotes and accept one`;
  }
  if (mt.count === 0) return 'List the materials';
  if (bh.status === 'over') return 'Over budget — trim materials or raise the budget';
  if (mt.purchased < mt.count) return `Buy the ${mt.count - mt.purchased} remaining material${mt.count - mt.purchased === 1 ? '' : 's'}`;
  if (!project.target_start) return 'Pick a weekend';
  if (project.status !== 'in_progress') return `Start ${project.target_start}`;
  return 'Finish and mark done';
}

export type ProjectsSummary = { active: number; ideas: number; budgetCents: number; forecastCents: number; over: number; overdue: number; dueSoon: number; quotesWaiting: number; text: string };

export function projectsSummary(projects: ProjectLike[], materials: MaterialLike[], quotes: QuoteLike[], today: Date): ProjectsSummary {
  const live = projects.filter((p) => p.status !== 'done' && p.status !== 'cancelled');
  const active = live.filter((p) => p.status !== 'idea');
  let budgetCents = 0, forecastCents = 0, over = 0, overdue = 0, dueSoon = 0, quotesWaiting = 0;
  for (const p of active) {
    const bh = budgetHealth(p, materials, quotes, today);
    budgetCents += p.budget_cents ?? 0; forecastCents += bh.forecastCents;
    if (bh.status === 'over') over += 1;
    const s = schedule(p, today);
    if (s.state === 'overdue') overdue += 1; else if (s.state === 'due_soon') dueSoon += 1;
    quotesWaiting += compareQuotes(quotes, p.id, today).awaiting;
  }
  const text = live.length === 0 ? 'No projects yet' : overdue ? `${overdue} project${overdue === 1 ? '' : 's'} past due` : over ? `${over} over budget` : active.length ? `${active.length} active · ${money(forecastCents)} of ${money(budgetCents)} planned` : `${live.length} idea${live.length === 1 ? '' : 's'} waiting`;
  return { active: active.length, ideas: live.length - active.length, budgetCents, forecastCents, over, overdue, dueSoon, quotesWaiting, text };
}

export const money = (cents: number | null | undefined) => cents === null || cents === undefined ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
