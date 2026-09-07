// lib/purchases/advisor.ts — "Before you buy", the deterministic half.
//
// The gap this closes: nothing in the product ever checked what a family
// ALREADY OWNS before encouraging a purchase. `inventory_items`, `home_assets`
// and `wardrobe_items` all carry brand/model/serial and none of it was ever
// read at buying time, so "AI gift ideas" and "AI shopping tips" were generic
// model prose that could cheerfully suggest a second cordless drill.
//
// This module is PURE: rows in, advice out. No Supabase, no fetch, no DOM — the
// server action assembles the family's own rows (RLS-scoped, fail-closed) and
// this decides. Every claim it makes is traceable to a row it was handed: a
// duplicate names the item, a budget verdict names the budget, a preference
// names the fact. It never invents a product, a price or a place to buy.
//
// It returns CODES, not sentences: the panel renders them through the message
// catalogue, so the advice is as translated as the rest of the app.

import { searchItems, locationLabel, type ItemLike, type LocationLike, type SearchHit } from '@/lib/inventory/finder';
import { simulateDecision, type SimBudget } from '@/lib/twin/simulate';
import type { InventoryCategory } from '@/lib/database.types';

// ── Inputs ───────────────────────────────────────────────────────────────────

/** What the family is thinking of buying. */
export interface PurchaseCandidate {
  /** Free text as typed, or a wish's title. */
  text: string;
  url?: string | null;
  priceCents?: number | null;
  /** Explicit budget category, when the caller knows it. */
  budgetCategory?: string | null;
}

export type InventoryRow = ItemLike;

/** `home_assets` — the appliances and equipment the household runs on. */
export interface HomeAssetRow {
  id: string;
  name: string;
  category: string | null;
  location: string | null;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  purchase_price: number | null;
  warranty_until: string | null;
}

/** `wardrobe_items` — the closet. */
export interface WardrobeRow {
  id: string;
  member_id: string;
  name: string;
  category: string;
  brand: string | null;
  color: string | null;
  size: string | null;
  status: string;
  price_cents: number | null;
}

/** `wishlist_items` — what is already on somebody's list. */
export interface WishRow {
  id: string;
  member_id: string;
  title: string;
  price: number | null;
  is_purchased: boolean;
}

/** `family_facts` — the household's remembered preferences. */
export interface FactRow {
  id: string;
  member_id: string | null;
  category: string;
  label: string;
  value: string;
  is_pinned: boolean;
}

/** A budget plus what the period has already committed. */
export interface BudgetRow {
  category: string;
  limitCents: number;
  spentCents: number;
}

export interface AdviceInput {
  candidate: PurchaseCandidate;
  inventory?: InventoryRow[];
  locations?: LocationLike[];
  homeAssets?: HomeAssetRow[];
  wardrobe?: WardrobeRow[];
  wishes?: WishRow[];
  facts?: FactRow[];
  budgets?: BudgetRow[];
  /**
   * The wish this advice was opened FROM. A wish's own row matches its own
   * title every time, so without this the panel reports the very item the
   * family is looking at as "already on a wish list" — a finding with no
   * evidence behind it but itself.
   */
  excludeWishId?: string | null;
  /**
   * The `family_members` id of whoever is asking. Gift state is deliberately
   * hidden from the person a wish belongs to (0043/00431_wishlists.sql: "Hidden
   * from the owner in the UI so it stays a surprise"), so a match on the
   * viewer's OWN wish never carries whether someone has bought it.
   */
  viewerMemberId?: string | null;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export type PurchaseVerdict = 'clear' | 'tight' | 'conflict';

export type OwnedSource = 'inventory' | 'home_asset' | 'wardrobe';

export interface OwnedMatch {
  source: OwnedSource;
  id: string;
  name: string;
  /** Where it is, or what it is — already human-readable, never a code. */
  detail: string | null;
  brand: string | null;
  model: string | null;
  /** Which stored fields matched: name, brand, model, serial, tags, category, location. */
  matchedOn: string[];
  /** How many of the candidate's words this row accounted for. */
  matchedTokens: number;
  /** inventory/wardrobe only: in_place | lent | in_repair | … */
  status: string | null;
}

export interface BudgetOutlook {
  /** The budget this was checked against, or the guess we could not find. */
  category: string;
  limitCents: number;
  spentCents: number;
  remainingBeforeCents: number;
  remainingAfterCents: number;
  verdict: PurchaseVerdict;
  /** True when no budget row covers the category — headroom is unknown, not fine. */
  unbudgeted: boolean;
}

export interface PreferenceMatch {
  id: string;
  memberId: string | null;
  category: string;
  label: string;
  value: string;
  isPinned: boolean;
}

export interface WishMatch {
  id: string;
  memberId: string;
  title: string;
  priceCents: number | null;
  /**
   * Whether a gift has been bought — always false for the viewer's own wishes,
   * whatever the row says, because the surprise is the product's whole point.
   * It is a "we can tell you this" flag, never a claim that nobody bought it.
   */
  purchased: boolean;
}

/**
 * Why the verdict is what it is. Strongest driver wins; the panel turns this
 * into a sentence, so the reason travels as one key rather than as prose
 * assembled here in one language.
 */
export type AdviceReason =
  | 'over_budget'
  | 'owned_duplicate'
  | 'already_purchased'
  | 'budget_tight'
  | 'no_budget'
  | 'clear';

export interface PurchaseAdvice {
  verdict: PurchaseVerdict;
  reason: AdviceReason;
  /** Things the family already owns that answer this candidate. */
  duplicates: OwnedMatch[];
  /** Related kit whose brand/model matters for fit — batteries, filters, pods. */
  compatibility: OwnedMatch[];
  /** Remembered preferences that bear on this purchase. */
  preferences: PreferenceMatch[];
  /** The same thing already sitting on a wish list. */
  alreadyOnList: WishMatch[];
  budget: BudgetOutlook | null;
  /** The words the advice was matched on — shown as evidence, and used by tests. */
  tokens: string[];
  priceCents: number | null;
  /** Internal hint used to find a budget; not rendered. */
  categoryGuess: InventoryCategory | null;
}

// ── Tokenising ───────────────────────────────────────────────────────────────

/**
 * Request wording, quantities and marketing adjectives — none of them identify
 * an item, and leaving them in makes every match fail. Deliberately short: a
 * word that could name a product ("light", "case", "cover") stays.
 */
const FILLER = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
  'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'from', 'at', 'by',
  'should', 'shall', 'do', 'does', 'did', 'we', 'i', 'you', 'us', 'me',
  'buy', 'buying', 'purchase', 'purchasing', 'order', 'ordering', 'get', 'getting',
  'need', 'want', 'like', 'is', 'it', 'this', 'that', 'these', 'those',
  'worth', 'really', 'another', 'more', 'some', 'any', 'one', 'two',
  'new', 'used', 'second', 'spare', 'extra', 'cheap', 'cheaper', 'best', 'better',
  'good', 'great', 'nice', 'big', 'small', 'about', 'maybe', 'please',
]);

const normalize = (value: string) => value.normalize('NFKC').replace(/[‘’]/g, "'").toLowerCase();

/** The words worth matching an owned item against. Order preserved, deduped. */
export function candidateTokens(text: string): string[] {
  const raw = normalize(text ?? '').split(/[^\p{L}\p{N}+#'-]+/u);
  const out: string[] = [];
  for (const piece of raw) {
    const token = piece.replace(/^[-']+|[-']+$/g, '');
    if (!token || token.length < 2 || FILLER.has(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

// ── Category guessing (used only to find a budget, never rendered) ────────────

const CATEGORY_WORDS: [InventoryCategory, string[]][] = [
  ['electronics', ['laptop', 'computer', 'phone', 'iphone', 'tablet', 'ipad', 'tv', 'television', 'headphones', 'earbuds', 'airpods', 'camera', 'console', 'monitor', 'printer', 'charger', 'speaker', 'router', 'kindle']],
  ['tools', ['drill', 'saw', 'hammer', 'wrench', 'ladder', 'toolkit', 'screwdriver', 'sander', 'multimeter', 'compressor']],
  ['sports', ['bike', 'bicycle', 'helmet', 'skis', 'snowboard', 'racket', 'racquet', 'cleats', 'skates', 'kayak', 'treadmill', 'dumbbells']],
  ['toys', ['lego', 'puzzle', 'doll', 'boardgame', 'playset']],
  ['kitchen', ['blender', 'mixer', 'kettle', 'toaster', 'pan', 'pot', 'airfryer', 'fryer', 'espresso', 'microwave', 'cookware', 'dishwasher']],
  ['furniture', ['sofa', 'couch', 'armchair', 'desk', 'table', 'bed', 'mattress', 'bookshelf', 'dresser']],
  ['clothing', ['jacket', 'coat', 'shoes', 'boots', 'sneakers', 'dress', 'jeans', 'sweater', 'hoodie', 'gloves', 'backpack', 'snowsuit']],
  ['outdoor', ['mower', 'grill', 'bbq', 'hose', 'tent', 'trimmer', 'shovel']],
  ['seasonal', ['costume', 'wreath', 'ornaments']],
  ['medical', ['thermometer', 'humidifier', 'nebulizer']],
  ['jewelry', ['ring', 'necklace', 'bracelet', 'earrings']],
];

export function guessCategory(tokens: string[]): InventoryCategory | null {
  for (const [category, words] of CATEGORY_WORDS) {
    if (tokens.some((t) => words.includes(t))) return category;
  }
  return null;
}

// ── Matching owned things ────────────────────────────────────────────────────

/** Fields that mean "this IS the thing", as opposed to "this is near the thing". */
const IDENTITY_FIELDS = new Set(['name', 'model', 'serial']);
const STRONG_FIELDS = new Set(['name', 'brand', 'model', 'serial', 'tags']);

type Adapted = { row: ItemLike; source: OwnedSource; detail: string | null; status: string | null };

// Statuses that mean the family cannot use the thing any more. `outgrown` is a
// wardrobe status (0240_closet_outfits.sql: active|laundry|storage|outgrown|
// donated|lost) and belongs here for the same reason `donated` does: a coat
// that no longer fits is not a reason to refuse to buy one that does. Replacing
// an outgrown garment is precisely the purchase this must never block.
const NOT_OWNED = new Set(['disposed', 'lost', 'donated', 'sold', 'retired', 'outgrown']);

function adaptInventory(rows: InventoryRow[], locations: LocationLike[]): Adapted[] {
  return rows
    .filter((r) => !NOT_OWNED.has(r.status))
    .map((r) => ({ row: r, source: 'inventory' as const, detail: locationLabel(locations, r.location_id), status: r.status }));
}

function adaptAssets(rows: HomeAssetRow[]): Adapted[] {
  return rows.map((r) => ({
    source: 'home_asset' as const,
    detail: r.location ?? null,
    status: null,
    row: {
      id: r.id,
      name: r.name,
      category: 'other' as InventoryCategory,
      location_id: null,
      quantity: 1,
      value_cents: r.purchase_price != null ? Math.round(r.purchase_price * 100) : null,
      brand: r.brand,
      model: r.model,
      serial_number: r.serial_number,
      tags: [r.category ?? ''].filter(Boolean),
      status: 'in_place' as const,
      lent_to: null,
      lent_on: null,
      warranty_until: r.warranty_until,
    },
  }));
}

function adaptWardrobe(rows: WardrobeRow[]): Adapted[] {
  return rows
    .filter((r) => !NOT_OWNED.has(r.status))
    .map((r) => ({
      source: 'wardrobe' as const,
      detail: [r.color, r.size].filter(Boolean).join(' · ') || null,
      status: r.status,
      row: {
        id: r.id,
        name: r.name,
        category: 'clothing' as InventoryCategory,
        location_id: null,
        quantity: 1,
        value_cents: r.price_cents,
        brand: r.brand,
        model: null,
        serial_number: null,
        tags: [r.category, r.color, r.size].filter((v): v is string => Boolean(v)),
        status: 'in_place' as const,
        lent_to: null,
        lent_on: null,
        warranty_until: null,
      },
    }));
}

type Tally = { adapted: Adapted; fields: Set<string>; tokens: Set<string>; identityTokens: Set<string> };

/**
 * Every owned row that answers any of the candidate's words, tallied by how
 * much of the candidate it accounts for. `searchItems` does the matching, so
 * "where is it?" and "do we already own it?" agree on what a match is; this
 * only decides how much of a match is enough.
 */
function tallyMatches(all: Adapted[], locations: LocationLike[], tokens: string[]): Map<string, Tally> {
  const byRow = new Map<string, Tally>();
  const index = new Map(all.map((a) => [`${a.source}:${a.row.id}`, a]));
  const record = (hit: SearchHit, token: string, source: OwnedSource) => {
    const key = `${source}:${hit.item.id}`;
    const adapted = index.get(key);
    if (!adapted) return;
    const entry = byRow.get(key) ?? { adapted, fields: new Set<string>(), tokens: new Set<string>(), identityTokens: new Set<string>() };
    for (const field of hit.matched) {
      entry.fields.add(field);
      if (IDENTITY_FIELDS.has(field)) entry.identityTokens.add(token);
    }
    entry.tokens.add(token);
    byRow.set(key, entry);
  };

  for (const source of ['inventory', 'home_asset', 'wardrobe'] as const) {
    const rows = all.filter((a) => a.source === source).map((a) => a.row);
    if (!rows.length) continue;
    for (const token of tokens) {
      for (const hit of searchItems(rows, locations, token)) record(hit, token, source);
    }
  }
  return byRow;
}

function toOwnedMatch(entry: Tally): OwnedMatch {
  return {
    source: entry.adapted.source,
    id: entry.adapted.row.id,
    name: entry.adapted.row.name,
    detail: entry.adapted.detail,
    brand: entry.adapted.row.brand,
    model: entry.adapted.row.model,
    matchedOn: [...entry.fields].sort(),
    matchedTokens: entry.tokens.size,
    status: entry.adapted.status,
  };
}

const byStrength = (a: OwnedMatch, b: OwnedMatch) => b.matchedTokens - a.matchedTokens || a.name.localeCompare(b.name);

// ── Preferences and wishes ───────────────────────────────────────────────────

function matchPreferences(facts: FactRow[], tokens: string[]): PreferenceMatch[] {
  const out: PreferenceMatch[] = [];
  for (const fact of facts) {
    const hay = normalize(`${fact.label} ${fact.value} ${fact.category}`);
    if (!tokens.some((token) => hay.includes(token))) continue;
    out.push({
      id: fact.id,
      memberId: fact.member_id,
      category: fact.category,
      label: fact.label,
      value: fact.value,
      isPinned: fact.is_pinned,
    });
  }
  return out
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.label.localeCompare(b.label))
    .slice(0, 6);
}

function matchWishes(
  wishes: WishRow[],
  tokens: string[],
  opts: { excludeWishId?: string | null; viewerMemberId?: string | null },
): WishMatch[] {
  const out: WishMatch[] = [];
  for (const wish of wishes) {
    // The wish the family is looking at is not independent evidence about the
    // wish the family is looking at.
    if (opts.excludeWishId && wish.id === opts.excludeWishId) continue;
    const hay = normalize(wish.title);
    const hits = tokens.filter((token) => hay.includes(token));
    if (!hits.length) continue;
    // One short generic word is not "the same wish"; ask for more of the phrase.
    if (tokens.length > 1 && hits.length < 2 && hits[0].length < 5) continue;
    out.push({
      id: wish.id,
      memberId: wish.member_id,
      title: wish.title,
      priceCents: wish.price != null ? Math.round(wish.price * 100) : null,
      purchased: opts.viewerMemberId && wish.member_id === opts.viewerMemberId ? false : wish.is_purchased,
    });
  }
  return out.slice(0, 5);
}

// ── Budget ───────────────────────────────────────────────────────────────────

function pickBudget(
  budgets: BudgetRow[],
  tokens: string[],
  hint: string | null | undefined,
  guess: InventoryCategory | null,
): BudgetRow | null {
  if (hint) {
    const exact = budgets.find((b) => b.category.toLowerCase() === hint.toLowerCase());
    if (exact) return exact;
  }
  const wanted = new Set<string>(tokens);
  if (guess) wanted.add(guess);
  for (const budget of budgets) {
    const name = normalize(budget.category);
    if (!name) continue;
    if ([...wanted].some((word) => name === word || name.includes(word) || word.includes(name))) return budget;
  }
  return null;
}

const RANK: Record<PurchaseVerdict, number> = { clear: 0, tight: 1, conflict: 2 };
const worst = (a: PurchaseVerdict, b: PurchaseVerdict): PurchaseVerdict => (RANK[a] >= RANK[b] ? a : b);

// ── The advisor ──────────────────────────────────────────────────────────────

/**
 * Grounded "before you buy" advice. Deterministic and offline: the same rows
 * always give the same verdict, and it holds with no AI key configured at all.
 *
 * NO PAID BIAS. Nothing here ranks, favours or is paid for by a merchant. It
 * compares a candidate against the family's own rows only — there is no
 * affiliate link, no sponsored placement and no retailer feed anywhere in this
 * path, and the optional market suggestions layered on top (the
 * `purchase_advisor` insight in lib/ai/insights.ts) are told the same.
 */
export function adviseOnPurchase(input: AdviceInput): PurchaseAdvice {
  const tokens = candidateTokens(input.candidate?.text ?? '');
  const priceCents =
    typeof input.candidate?.priceCents === 'number' && input.candidate.priceCents > 0
      ? Math.round(input.candidate.priceCents)
      : null;
  const categoryGuess = guessCategory(tokens);

  const locations = input.locations ?? [];
  const all: Adapted[] = [
    ...adaptInventory(input.inventory ?? [], locations),
    ...adaptAssets(input.homeAssets ?? []),
    ...adaptWardrobe(input.wardrobe ?? []),
  ];

  const duplicates: OwnedMatch[] = [];
  const compatibility: OwnedMatch[] = [];

  if (tokens.length) {
    const tally = tallyMatches(all, locations, tokens);
    const best = Math.max(0, ...[...tally.values()].map((entry) => entry.tokens.size));
    // The head word is what the candidate IS — "18V battery" is a battery, not
    // an 18V anything — so a row that matches everything except the head noun
    // is related kit, not the same thing. Without this, owning a Bosch 18V
    // drill would read as "you already own an 18V battery".
    const head = tokens[tokens.length - 1];
    for (const entry of tally.values()) {
      const match = toOwnedMatch(entry);
      if (!match.matchedOn.some((field) => STRONG_FIELDS.has(field))) continue;
      const identifies = match.matchedOn.some((field) => IDENTITY_FIELDS.has(field));
      const answersTheWholeThing = entry.tokens.size === tokens.length || entry.identityTokens.has(head);
      if (entry.tokens.size === best && identifies && answersTheWholeThing) duplicates.push(match);
      else if (match.brand || match.model) compatibility.push(match);
    }
  }
  duplicates.sort(byStrength);
  compatibility.sort(byStrength);

  const preferences = tokens.length ? matchPreferences(input.facts ?? [], tokens) : [];
  const alreadyOnList = tokens.length
    ? matchWishes(input.wishes ?? [], tokens, {
        excludeWishId: input.excludeWishId ?? null,
        viewerMemberId: input.viewerMemberId ?? null,
      })
    : [];

  // Affordability — the twin's own spend simulator, so "can we afford it?"
  // answers the same way here as it does in the decision simulator.
  let budget: BudgetOutlook | null = null;
  if (priceCents !== null) {
    const picked = pickBudget(input.budgets ?? [], tokens, input.candidate.budgetCategory, categoryGuess);
    const category = picked?.category ?? input.candidate.budgetCategory ?? categoryGuess ?? '';
    const simBudgets: SimBudget[] = picked
      ? [{ category: picked.category, limitCents: picked.limitCents, spentCents: picked.spentCents }]
      : [];
    const sim = simulateDecision(
      { kind: 'spend', label: input.candidate.text?.trim() || category, category, amountCents: priceCents },
      { memberEvents: [], budgets: simBudgets },
    );
    const remainingBefore = picked ? picked.limitCents - picked.spentCents : 0;
    budget = {
      category,
      limitCents: picked?.limitCents ?? 0,
      spentCents: picked?.spentCents ?? 0,
      remainingBeforeCents: remainingBefore,
      remainingAfterCents: picked ? remainingBefore - priceCents : 0,
      verdict: sim.verdict,
      unbudgeted: !picked,
    };
  }

  let verdict: PurchaseVerdict = 'clear';
  if (budget) verdict = worst(verdict, budget.verdict);
  if (duplicates.length) verdict = worst(verdict, 'tight');
  const alreadyBought = alreadyOnList.some((wish) => wish.purchased);
  if (alreadyBought) verdict = worst(verdict, 'tight');

  const reason: AdviceReason =
    budget && !budget.unbudgeted && budget.verdict === 'conflict'
      ? 'over_budget'
      : duplicates.length
        ? 'owned_duplicate'
        : alreadyBought
          ? 'already_purchased'
          : budget?.unbudgeted
            ? 'no_budget'
            : budget?.verdict === 'tight'
              ? 'budget_tight'
              : 'clear';

  return { verdict, reason, duplicates, compatibility, preferences, alreadyOnList, budget, tokens, priceCents, categoryGuess };
}

/**
 * A compact plain-text rendering of the deterministic advice, used to GROUND a
 * model that may add market context. English on purpose: this is prompt
 * material, not UI copy — everything a person reads goes through the catalogue.
 */
export function describeAdvice(candidateText: string, advice: PurchaseAdvice): string {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const lines: string[] = [`Candidate: ${candidateText}`];
  if (advice.priceCents !== null) lines.push(`Asking price: ${money(advice.priceCents)}`);
  lines.push(`Deterministic verdict: ${advice.verdict} (${advice.reason})`);
  lines.push(
    advice.duplicates.length
      ? `Already owned (${advice.duplicates.length}): ${advice.duplicates
          .map((d) => `${d.name}${d.brand ? ` — ${d.brand}` : ''}${d.model ? ` ${d.model}` : ''}${d.detail ? ` (${d.detail})` : ''}`)
          .join('; ')}`
      : 'Already owned: nothing matching in the household inventory, home assets or closet.',
  );
  if (advice.compatibility.length) {
    lines.push(
      `Related kit to stay compatible with: ${advice.compatibility
        .map((c) => `${c.name}${c.brand ? ` — ${c.brand}` : ''}${c.model ? ` ${c.model}` : ''}`)
        .join('; ')}`,
    );
  }
  if (advice.preferences.length) {
    lines.push(`Remembered preferences: ${advice.preferences.map((p) => `${p.label}: ${p.value}`).join('; ')}`);
  }
  if (advice.alreadyOnList.length) {
    lines.push(
      `Already on a wish list: ${advice.alreadyOnList.map((w) => `${w.title}${w.purchased ? ' [already bought]' : ''}`).join('; ')}`,
    );
  }
  if (advice.budget) {
    lines.push(
      advice.budget.unbudgeted
        ? `Budget: no budget covers "${advice.budget.category || 'this'}" — headroom unknown.`
        : `Budget "${advice.budget.category}": ${money(advice.budget.spentCents)} of ${money(advice.budget.limitCents)} used, ${money(advice.budget.remainingAfterCents)} left after this purchase.`,
    );
  }
  return lines.join('\n');
}
